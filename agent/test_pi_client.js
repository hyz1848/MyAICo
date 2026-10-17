'use strict';
/**
 * agent/test_pi_client.js — pi 适配层独立验证（不依赖 server.js）
 * 运行：node agent/test_pi_client.js
 *
 * 覆盖 5 条不变式：
 *  1. 流式增量（多个 text_delta）
 *  2. abort 中断（stopReason=aborted，保留部分文本）
 *  3. 多轮历史生效
 *  4. 出错不抛穿
 *  5. 与旧 fetch 路径结果可比（同一提示词两边都通）
 */
const { createPiClient } = require('./pi-client');

const BASE_URL = process.env.LLM_BASE_URL || 'http://192.168.3.166:1234';
const MODEL_ID = process.env.LLM_MODEL || 'qwen3.8-27b';
const SYSTEM = '你是一个简洁的中文助手，回答口语化，不超过两句话，不要用 Markdown。';

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(`${name} ${detail}`); console.log(`  ✗ ${name} ${detail}`); }
}

async function legacyFetchChat({ messages, systemPrompt, signal }) {
  const res = await fetch(`${BASE_URL.replace(/\/+$/, '')}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL_ID, stream: true, temperature: 0.7,
      messages: [{ role: 'system', content: systemPrompt }, ...messages.map(m => ({ role: m.role, content: m.content }))],
    }),
    signal,
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = '', deltas = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    for (const line of decoder.decode(value).split('\n')) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6);
      if (data === '[DONE]') continue;
      try {
        const c = JSON.parse(data).choices?.[0]?.delta?.content || '';
        if (c) { text += c; deltas++; }
      } catch (e) {}
    }
  }
  return { text, deltas };
}

(async () => {
  console.log(`pi-client → ${BASE_URL} (model=${MODEL_ID})\n`);
  const client = await createPiClient({ baseUrl: BASE_URL, modelId: MODEL_ID });

  // ---- 1. 流式增量 ----
  console.log('[1] 流式增量');
  {
    let deltas = 0, firstDeltaAt = null, text = '';
    const t0 = Date.now();
    const r = await client.chat({
      systemPrompt: SYSTEM,
      messages: [{ role: 'user', content: '从1数到50，用中文，数字之间用顿号隔开。' }],
      onDelta: (d) => { deltas++; if (firstDeltaAt === null) firstDeltaAt = Date.now() - t0; text += d; },
    });
    const total = Date.now() - t0;
    // LM Studio 可能批量吐 token，故不硬性要求很多次回调，而是要求"分多次 + 首包显著早于完成"
    check('多次增量回调（>=2）', deltas >= 2, `deltas=${deltas}`);
    check('首包显著早于完成', firstDeltaAt !== null && firstDeltaAt < Math.max(1000, total * 0.7), `${firstDeltaAt}ms / ${total}ms`);
    check('文本非空', r.text.length > 0, `len=${r.text.length}`);
    check('onDelta 累计 == 返回文本', text === r.text, `${text.length} vs ${r.text.length}`);
    check('stopReason=stop', r.stopReason === 'stop', r.stopReason);
    console.log(`    文本: 「${r.text.trim().slice(0, 60)}」 deltas=${deltas} 首包=${firstDeltaAt}ms 总=${total}ms usage=${r.usage?.input ?? '?'}/${r.usage?.output ?? '?'}`);
  }

  // ---- 2. abort ----
  console.log('\n[2] abort 中断');
  {
    const controller = new AbortController();
    let deltas = 0;
    const t0 = Date.now();
    let abortedAt = null;
    const r = await client.chat({
      systemPrompt: SYSTEM,
      // 保证足够长的输出（约 1000+ token），否则模型可能在中断计时器触发前就答完 → 测试假失败
      messages: [{ role: 'user', content: '请从 1 数到 500，用阿拉伯数字，每个数字后用逗号分隔，一直数完不要停。' }],
      signal: controller.signal,
      onDelta: () => {
        deltas++;
        // 收到首个增量后立刻中断（0ms），避免"还没开始生成就掐"的时序偶然
        if (deltas === 1) setTimeout(() => { abortedAt = Date.now(); controller.abort(); }, 0);
      },
    });
    const elapsed = Date.now() - t0;
    check('stopReason=aborted', r.stopReason === 'aborted', r.stopReason);
    check('保留部分文本', r.text.length > 0, `len=${r.text.length}`);
    check('中断后及时结束（<2s）', abortedAt !== null && elapsed - (abortedAt - t0) < 2000, `${elapsed}ms`);
    console.log(`    部分文本: 「${r.text.trim().slice(0, 40)}」 deltas=${deltas} ${elapsed}ms`);
  }

  // ---- 3. 多轮历史 ----
  console.log('\n[3] 多轮历史');
  {
    const r = await client.chat({
      systemPrompt: SYSTEM,
      messages: [
        { role: 'user', content: '我叫小明，我做语音识别。' },
        { role: 'assistant', content: '好的，小明。' },
        { role: 'user', content: '我叫什么？做什么工作？' },
      ],
    });
    check('记住姓名', r.text.includes('小明'), r.text.slice(0, 40));
    check('记住职业', /语音识别/.test(r.text), r.text.slice(0, 40));
    console.log(`    回答: 「${r.text.trim().slice(0, 50)}」`);
  }

  // ---- 4. 出错不抛穿 ----
  console.log('\n[4] 错误处理');
  {
    let threw = false;
    let r = null;
    try {
      const bad = await createPiClient({ baseUrl: 'http://127.0.0.1:59999', modelId: MODEL_ID });
      r = await bad.chat({ systemPrompt: SYSTEM, messages: [{ role: 'user', content: '你好' }] });
    } catch (e) { threw = true; console.log('    (抛出:', e.message, ')'); }
    check('不抛穿调用方', !threw);
    check('stopReason=error', r && r.stopReason === 'error', r && r.stopReason);
    check('带 errorMessage', !!(r && r.errorMessage), r && r.errorMessage);
    console.log(`    errorMessage: ${r && r.errorMessage}`);
  }

  // ---- 5. 与旧 fetch 路径对比 ----
  console.log('\n[5] 与旧 fetch 路径对比（同提示词）');
  {
    const q = '用一句话介绍杭州。';
    // 串行：本地模型单并发，并行请求会互相排队导致时序抖动
    const piRes = await client.chat({ systemPrompt: SYSTEM, messages: [{ role: 'user', content: q }] });
    const legacy = await legacyFetchChat({ systemPrompt: SYSTEM, messages: [{ role: 'user', content: q }] });
    check('两条路径都返回非空', piRes.text.length > 0 && legacy.text.length > 0);
    check('旧路径也是增量的', legacy.deltas >= 3, `deltas=${legacy.deltas}`);
    console.log(`    pi:     「${piRes.text.trim().slice(0, 44)}」`);
    console.log(`    legacy: 「${legacy.text.trim().slice(0, 44)}」`);
  }

  console.log(`\n通过: ${pass}  失败: ${fail}`);
  if (fail) { console.log('失败项:'); failures.forEach(f => console.log('  ✗ ' + f)); process.exit(1); }
  console.log('全部通过 ✓');
})();
