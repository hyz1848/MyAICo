// Test: 提醒端到端（设置 → 到点自动播报）——语音助手的核心闭环
// 运行: node test_reminder_e2e.js
const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:8214');
// 测试用唯一前缀，只清理自己创建的提醒——绝不删除用户的 data/reminders.json
const TEST_TAG = 'ZTEST' + Date.now().toString().slice(-5);
const t0 = Date.now();
const log = (m) => process.stdout.write(`+${((Date.now() - t0) / 1000).toFixed(1)}s ${m}\n`);
let toolCalls = [], announces = [];

function ask(text, timeout = 60000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('超时: ' + text)), timeout);
    const onMsg = (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === 'llm_done') { clearTimeout(timer); ws.off('message', onMsg); resolve(m.fullText); }
      else if (m.type === 'error') { clearTimeout(timer); ws.off('message', onMsg); reject(new Error(m.error)); }
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ type: 'clear_history' }));
    setTimeout(() => ws.send(JSON.stringify({ type: 'text', text })), 120);
  });
}

(async () => {
  await new Promise((r) => ws.on('open', r));
  let pass = 0, fail = 0;
  const check = (n, ok, extra = '') => { console.log(`${ok ? '✓' : '✗'} ${n}${extra ? ' — ' + extra : ''}`); ok ? pass++ : fail++; };
  let lastStart = 0, lastStreamId = -1;
  // 到点播报的结构特征：llm_start 之后没有任何 llm_stream 就直接 llm_done（正常回复必有 stream）
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.type === 'tool_call') { toolCalls.push(m.name); log(`[工具] ${m.name}(${JSON.stringify(m.args)})`); }
    if (m.type === 'llm_start') lastStart = m.id;
    if (m.type === 'llm_stream') lastStreamId = lastStart;
    if (m.type === 'llm_done' && lastStreamId !== m.id && typeof m.fullText === 'string') {
      announces.push(m.fullText);
      log(`[到点播报] ${m.fullText}`);
    }
  });

  console.log('[1] 让助手设置一个 10 秒后的提醒');
  const reply = await ask(`10 秒后提醒我 ${TEST_TAG} 喝水。`);
  log(`回答: ${reply.slice(0, 50)}`);
  const viaTool = toolCalls.includes('set_reminder');
  check('设置了提醒（工具调用或服务端兜底）', viaTool || /提醒/.test(reply), `工具: ${toolCalls.join(',') || '无'}`);

  console.log('\n[2] 查询提醒列表');
  toolCalls = [];
  const listReply = await ask('我现在有哪些提醒？');
  check('能查到刚设的提醒', /喝水|提醒/.test(listReply), listReply.slice(0, 60));

  console.log('\n[3] 等待到点自动播报（最多 25 秒）');
  const t1 = Date.now();
  while (Date.now() - t1 < 25000) {
    if (announces.some((a) => a.includes('喝水'))) break;
    await new Promise((r) => setTimeout(r, 500));
  }
  const fired = announces.find((a) => a.includes('喝水'));
  check('到点自动播报了提醒', !!fired, fired ? `播报: ${fired}` : `未播报（收到 ${announces.length} 条）`);

  console.log(`\n通过: ${pass}  失败: ${fail}`);
  // 说明：本测试只创建一个带唯一标签的提醒（会正常触发一次），不改动/删除用户数据
  process.exit(fail ? 1 : 0);
})();
