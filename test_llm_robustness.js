// test_llm_robustness.js — LLM 调用链路的可靠性回归
//
// 覆盖三类"会静默坏掉"的故障：
//   A. LLM 服务端卡死（TCP 连着但不出数据）→ 必须有看门狗中止，不能永久挂住语音助手
//   B. 生成中又来一句（barge-in / 连问）→ 必须收掉旧一轮，不能并发两轮（旧 controller 丢失、
//      TTS 缓冲被来回清空、界面文字交错）
//   C. 事件归属：旧一轮的收尾事件不能污染新一轮（llm_interrupted 必须带 id）
//
// 运行：node test_llm_robustness.js          （需要本地服务在 8214，B/C 部分依赖它）
//       node test_llm_robustness.js --no-ws  （只跑不依赖真实服务的 A 部分）

'use strict';
const http = require('http');
const WebSocket = require('ws');
const { createPiClient } = require('./agent/pi-client');

let pass = 0, fail = 0;
function check(name, ok, info = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}${info ? '  ' + info : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${info ? '  ' + info : ''}`); }
  return ok;
}

// ---------- A. 看门狗：黑洞服务端（接受请求，永不响应） ----------
async function testWatchdog() {
  console.log('\n[A] 看门狗：LLM 服务端卡死必须被中止');
  const blackhole = http.createServer(() => { /* 故意不响应，也不关闭连接 */ });
  await new Promise((r) => blackhole.listen(0, '127.0.0.1', r));
  const port = blackhole.address().port;

  const client = await createPiClient({
    baseUrl: `http://127.0.0.1:${port}`,
    modelId: 'blackhole',
    firstEventTimeoutMs: 1200,
    idleTimeoutMs: 1200,
  });

  const t0 = Date.now();
  const r = await client.chat({ messages: [{ role: 'user', content: '你好' }] });
  const elapsed = Date.now() - t0;

  check('stopReason=error（不是 aborted/silent）', r.stopReason === 'error', r.stopReason);
  check('errorMessage 说明是"无响应"', /无响应/.test(r.errorMessage || ''), r.errorMessage);
  check('看门狗在 4s 内生效', elapsed < 4000, `${elapsed}ms`);
  check('timedOut 标记为真', r.timedOut === true, String(r.timedOut));

  // 用户主动打断仍必须报 aborted（不能被看门狗逻辑误判成 error）
  const c2 = new AbortController();
  const t1 = Date.now();
  const r2p = client.chat({ messages: [{ role: 'user', content: '你好' }], signal: c2.signal });
  setTimeout(() => c2.abort(), 300);
  const r2 = await r2p;
  check('用户打断 → stopReason=aborted', r2.stopReason === 'aborted', r2.stopReason);
  check('打断后 2s 内返回', Date.now() - t1 < 2000, `${Date.now() - t1}ms`);

  blackhole.close();
  return { port };
}

// ---------- B/C. 真实服务：并发生成与事件归属 ----------
function testConcurrent(wsUrl) {
  console.log('\n[B/C] 生成中再问一句：必须串行化，且事件带 id');
  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    const events = [];
    let q2SentAt = 0;
    let textAfterQ2 = '';
    let done = null;
    let idA = null, idB = null;   // 第一轮/第二轮的真实 id（replySeq 不随清空历史复位，不能写死）
    const finish = () => { try { ws.close(); } catch (e) {} resolve(); };

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'clear_history' }));
      // 明显更长的第一轮，保证第二句到来时它还在生成
      setTimeout(() => ws.send(JSON.stringify({ type: 'text', text: '请从 1 数到 300，用中文数字，用顿号分隔，中间不要停。' })), 200);
    });

    ws.on('message', (data) => {
      const m = JSON.parse(data.toString());
      if (!['llm_start', 'llm_stream', 'llm_done', 'llm_interrupted', 'error', 'notice'].includes(m.type)) return;
      if (m.type === 'llm_start') {
        if (idA === null) idA = m.id;
        else if (idB === null && m.id > idA) idB = m.id;
      }
      events.push({ type: m.type, id: m.id });
      if (m.type === 'llm_stream') {
        if (q2SentAt) textAfterQ2 += m.content;
        // 第一轮已流出内容 → 立刻问第二句（模拟"边生成边追问"）
        else {
          q2SentAt = Date.now();
          ws.send(JSON.stringify({ type: 'text', text: '你好' }));
        }
      }
      if (m.type === 'llm_done' && idB !== null && m.id === idB) {
        done = m;
        setTimeout(() => {
          check('第一轮被中止（有 llm_interrupted）', events.some((e) => e.type === 'llm_interrupted'), '');
          check('llm_interrupted 带 id（=第一轮 id）',
            events.some((e) => e.type === 'llm_interrupted' && e.id === idA),
            `idA=${idA} idB=${idB} → ${JSON.stringify(events.filter((e) => e.type === 'llm_interrupted'))}`);
          check('第二轮正常完成（llm_done 为第二轮 id）', !!done, `idB=${idB}`);
          check('两轮 id 递增 1', idB === idA + 1, `${idA} → ${idB}`);
          check('没有第三轮 llm_start', !events.some((e) => e.type === 'llm_start' && e.id > idB), '');
          // 关键：第二轮开始后收到的增量必须全部属于第二轮（无旧流泄漏）
          const got = (textAfterQ2 || '').trim();
          const want = (done.fullText || '').trim();
          check('中断后的增量即为第二轮全文（无旧流泄漏）', got === want,
            `收到 ${got.length} 字 / 期望 ${want.length} 字`);
          check('未出现错误事件', !events.some((e) => e.type === 'error'), '');
          finish();
        }, 400);
      }
    });
    ws.on('error', (e) => { check('WS 连接', false, e.message); finish(); });
    setTimeout(() => { check('整体超时', false, '60s 内未完成'); finish(); }, 60000);
  });
}

(async () => {
  await testWatchdog();
  if (!process.argv.includes('--no-ws')) {
    await testConcurrent(process.env.WS_URL || 'ws://localhost:8214');
  }
  console.log(`\n通过: ${pass}  失败: ${fail}`);
  process.exit(fail ? 1 : 0);
})();
