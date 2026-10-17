// Test: 验证 KV cache 前缀复用 —— system 变化是否导致每轮全量重算
// 运行: node test_kvcache.js
//
// 背景：我们把「当前时间」「详细指令」拼进 system，而 system 在最前面。
// 若前缀不匹配，本地模型（LM Studio）每轮都要重新 prefill 整段 prompt。
const BASE = process.env.LLM_BASE_URL || 'http://192.168.3.166:1234';
const MODEL = process.env.LLM_MODEL || 'qwen3.8-27b';

// 造一段长历史（约 2000+ tokens），让 prefill 成本可见
function longHistory() {
  const filler = '这是一段用于填充上下文的测试文本，内容本身没有意义，只用来把提示词撑长，以便观察预填充与缓存复用的差异。';
  const msgs = [
    { role: 'system', content: '你是一个简洁的中文助手。' },
    { role: 'user', content: filler.repeat(30) },
    { role: 'assistant', content: '好的，我明白了。' },
    { role: 'user', content: filler.repeat(30) },
    { role: 'assistant', content: '好的，已记录。' },
  ];
  return msgs;
}

async function measure(label, messages, temperature = 0.7) {
  const t0 = Date.now();
  let ttft = null, text = '', usage = null;
  const res = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: MODEL, messages, stream: true, temperature, max_tokens: 24, stream_options: { include_usage: true } }),
  });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const line of dec.decode(value).split('\n')) {
      if (!line.startsWith('data: ')) continue;
      const d = line.slice(6);
      if (d === '[DONE]') continue;
      try {
        const j = JSON.parse(d);
        if (j.usage) usage = j.usage;
        const c = j.choices?.[0]?.delta?.content;
        if (c) { if (ttft === null) ttft = Date.now() - t0; text += c; }
      } catch (e) {}
    }
  }
  const total = Date.now() - t0;
  console.log(`  ${label.padEnd(34)} 首字 ${String(ttft).padStart(5)}ms  总 ${String(total).padStart(5)}ms  prompt=${usage?.prompt_tokens ?? '?'} tokens${usage?.prompt_tokens_details?.cached_tokens !== undefined ? ` (缓存命中 ${usage.prompt_tokens_details.cached_tokens})` : ''}`);
  return { ttft, total, usage };
}

(async () => {
  const history = longHistory();
  const ask = { role: 'user', content: '用一句话说明什么是缓存。' };
  const SYS_STATIC = '你是一个简洁的中文助手。';
  const SYS_T1 = `${SYS_STATIC}\n\n【当前时间】2026年10月17日 14:30 周六。回答时间日期时以此为准。`;
  const SYS_T2 = `${SYS_STATIC}\n\n【当前时间】2026年10月17日 14:31 周六。回答时间日期时以此为准。`;

  console.log('实验设计：同一段长历史，只改 system 里的时间戳\n');
  await measure('① system=静态（第 1 次，冷）', [{ role: 'system', content: SYS_STATIC }, ...history.slice(1), ask]);
  await measure('② system=静态（第 2 次，应命中缓存）', [{ role: 'system', content: SYS_STATIC }, ...history.slice(1), ask]);
  await measure('③ system=带时间戳 T1（前缀变了）', [{ role: 'system', content: SYS_T1 }, ...history.slice(1), ask]);
  await measure('④ system=带时间戳 T1（再问一次）', [{ role: 'system', content: SYS_T1 }, ...history.slice(1), ask]);
  await measure('⑤ system=带时间戳 T2（时间又变）', [{ role: 'system', content: SYS_T2 }, ...history.slice(1), ask]);
  console.log('\n解读：② 若明显快于 ① → 前缀缓存生效；③⑤ 若回到 ① 的量级 → 改 system 会打掉整段缓存。');
})();
