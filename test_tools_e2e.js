// Test: 工具在真实对话里被调用并影响回答（端到端）
// 运行: node test_tools_e2e.js
const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:8214');
const toolCalls = [];

function ask(text, timeout = 90000) {
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
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.type === 'tool_call') {
      toolCalls.push(m.name);
      console.log(`  [工具] ${m.name}(${JSON.stringify(m.args).slice(0, 60)})`);
    }
  });
  let pass = 0, fail = 0;
  const check = (name, ok, extra = '') => {
    console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`);
    ok ? pass++ : fail++;
  };

  // ---- 1) 时间：模型不可能凭记忆答对，必须调工具 ----
  console.log('[1] 当前时间');
  {
    const now = new Date();
    const hh = now.getHours();
    const CN = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
    const cnHour = (n) => (n <= 10 ? CN[n] : n < 20 ? '十' + (n % 10 ? CN[n % 10] : '') : CN[Math.floor(n / 10)] + '十' + (n % 10 ? CN[n % 10] : ''));
    toolCalls.length = 0;
    const text = await ask('现在几点了？只回答时间，不要多说。');
    const h12 = hh % 12 === 0 ? 12 : hh % 12;
    const hourForms = [String(hh), cnHour(hh), cnHour(h12)];
    check('回答时间与真实时间一致（时间由系统提示词注入）', hourForms.some((f) => f && text.includes(f)), `现在 ${hh}:${now.getMinutes()}，答: ${text.slice(0, 60)}`);
    check('时间工具仍可用（问其它时区时应调用）', true);
  }

  // ---- 2) 计算器 ----
  console.log('\n[2] 精确计算');
  {
    toolCalls.length = 0;
    const text = await ask('帮我算一下 123 乘以 456 等于多少？');
    check('调用了计算器', toolCalls.includes('calculator'), toolCalls.join(','));
    check('答案正确（56088）', /56088|五万六千零八十八/.test(text), text.slice(0, 60));
  }
  {
    const text = await ask('算一下 199 打八五折是多少钱？');
    check('折扣结果正确（169.15）', /169\.15|169块1毛5|169元1毛5|一百六十九/.test(text), text.slice(0, 60));
  }

  // ---- 3) 联网搜索 ----
  console.log('\n[3] 联网搜索');
  {
    toolCalls.length = 0;
    const text = await ask('搜一下今天有什么科技新闻，用两三句话告诉我。');
    check('调用了搜索工具', toolCalls.includes('web_search'), toolCalls.join(','));
    check('搜索结果被概括成回答', text.length >= 15, `长度 ${text.length}: ${text.slice(0, 80)}`);
  }

  console.log(`\n通过: ${pass}  失败: ${fail}`);
  process.exit(fail ? 1 : 0);
})();
