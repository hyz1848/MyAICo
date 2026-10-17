// Test: 提示词的长度策略（闲聊要短、要求详细要长）
// 运行: node test_prompt.js
const ws = new (require('ws'))('ws://localhost:8214');
const t0 = Date.now();

const CASES = [
  { name: '问候（应短）', ask: '你好', min: 0, max: 80 },
  { name: '简单是非（应短）', ask: '你会说英语吗', min: 0, max: 80 },
  { name: '要求详细介绍（应长）', ask: '介绍一下海洋的深度分层', min: 300 },
  { name: '追问要详细（应长，带上下文）', ask: '再详细点，刚才太简单了', min: 250, keepHistory: true },
  { name: '要求讲历史（应长）', ask: '详细讲讲中国茶文化的历史', min: 300 },
  { name: '要求讲原理（应长）', ask: '为什么天空是蓝色的，讲清楚原理', min: 300 },
  { name: '日常闲聊（应短）', ask: '今天天气不错啊', min: 0, max: 80 },
];

function ask(text, keepHistory) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('超时: ' + text)), 120000);
    const onMsg = (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === 'llm_done') {
        clearTimeout(timer); ws.off('message', onMsg);
        resolve(m.fullText);
      } else if (m.type === 'error') {
        clearTimeout(timer); ws.off('message', onMsg);
        reject(new Error(m.error));
      }
    };
    ws.on('message', onMsg);
    if (!keepHistory) ws.send(JSON.stringify({ type: 'clear_history' }));
    setTimeout(() => ws.send(JSON.stringify({ type: 'text', text })), 120);
  });
}

(async () => {
  await new Promise((res) => ws.on('open', res));
  let pass = 0, fail = 0;
  for (const c of CASES) {
    const text = await ask(c.ask, c.keepHistory);
    const len = text.replace(/\s/g, '').length;
    const ok = len >= c.min && (c.max === undefined || len <= c.max);
    if (ok) pass++; else fail++;
    console.log(`${ok ? '✓' : '✗'} ${c.name}: ${len} 字 (要求 ${c.min}~${c.max ?? '∞'})`);
    console.log(`    问: ${c.ask}`);
    console.log(`    答: ${text.slice(0, 90).replace(/\n/g, ' ')}${text.length > 90 ? '…' : ''}`);
  }
  console.log(`\n通过: ${pass}  失败: ${fail}`);
  process.exit(fail ? 1 : 0);
})();
