// Test: 逐工具调用稳定性（重复多轮，统计调用率 / 正确率 / 延迟）
// 运行: node test_tools_stability.js [每例轮数]
//
// 为什么需要：本地小模型不是每次都会调工具（可能凭记忆答、或漏调），
// 所以"跑通一次"没有意义，必须统计多次的成功率，并覆盖"不该调工具"的反例。
const WebSocket = require('ws');

const ROUNDS = parseInt(process.argv[2] || '4', 10);
const ws = new WebSocket('ws://localhost:8214');
let toolCalls = [];

function ask(text, timeout = 90000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('超时')), timeout);
    const onMsg = (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === 'llm_done') { clearTimeout(timer); ws.off('message', onMsg); resolve(m.fullText); }
      else if (m.type === 'error') { clearTimeout(timer); ws.off('message', onMsg); reject(new Error(m.error)); }
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ type: 'clear_history' }));
    setTimeout(() => ws.send(JSON.stringify({ type: 'text', text })), 150);
  });
}

const CN = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
const cn = (n) => (n <= 10 ? CN[n] : n < 20 ? '十' + (n % 10 ? CN[n % 10] : '') : CN[Math.floor(n / 10)] + '十' + (n % 10 ? CN[n % 10] : ''));
const numForms = (v) => {
  const digits = String(v);
  const s = digits.replace(/\.?0+$/, '');
  return [digits, s];
};

// 每例：{ name, ask, expectTool?, verify(text) }
function buildCases() {
  const now = new Date();
  const hh = now.getHours(), h12 = hh % 12 === 0 ? 12 : hh % 12;
  return [
    {
      name: '计算器·乘法', ask: () => '帮我算一下 123 乘以 456 等于多少？',
      expectTool: 'calculator', verify: (t) => /56088|五万六千零八十八/.test(t),
    },
    {
      name: '计算器·带小数', ask: () => '圆周率乘以 2，保留三位小数是多少？',
      expectTool: 'calculator', verify: (t) => /6\.28[0-9]?|六点二八/.test(t),
    },
    {
      name: '计算器·除法', ask: () => '100 除以 7 等于多少？保留两位小数。',
      expectTool: 'calculator', verify: (t) => /14\.29|十四点二九/.test(t),
    },
    {
      name: '计算器·复合表达式', ask: () => '算一下 (15+25)*3-20 等于多少',
      expectTool: 'calculator', verify: (t) => /100|一百/.test(t),
    },
    {
      name: '时间（注入）', ask: () => '现在几点了？只回答时间。',
      expectTool: null, verify: (t) => [String(hh), cn(hh), cn(h12)].some((f) => f && t.includes(f)),
    },
    {
      name: '时间·指定时区', ask: () => '纽约现在几点？只回答时间。',
      // 模型也可能用注入的本地时间自己推算（算对即可）；用"回答里的小时 ∈ 纽约小时±1"判定
      expectTool: 'get_current_datetime', minToolRate: 0.4,
      verify: (t) => {
        const nyHour = (new Date().getUTCHours() - 4 + 24) % 24;   // 夏令时 EDT
        const hours = new Set([nyHour, (nyHour + 1) % 24, (nyHour + 23) % 24]);
        const cnH = [...hours].map((h) => cn(h)).concat([...hours].map((h) => String(h)));
        const ampm = [...hours].map((h) => cn(h % 12 === 0 ? 12 : h % 12));
        return [...cnH, ...ampm].some((f) => f && t.includes(f) && /点|:/.test(t));
      },
    },
    {
      name: '搜索·实时信息', ask: () => '搜一下今天有什么科技新闻，一句话概括。',
      expectTool: 'web_search', verify: (t) => t.length >= 10,
    },
    {
      name: '搜索·具体查询', ask: () => '帮我搜一下 Node.js 最新版本是多少，直接告诉我版本号。',
      // 搜到就给版本号；搜索失败时"明确说查不到、不猜版本号"同样是正确行为
      expectTool: 'web_search',
      verify: (t) => /v?\d+\.\d+/.test(t) || /查不了|查不到|搜不到|额度|失败|暂时|稍后|不猜|无法/.test(t),
    },
    {
      name: '反例·不该调工具（闲聊）', ask: () => '今天心情不错，随便聊两句呗。',
      expectTool: null, verify: (t) => t.length >= 5, expectNoTool: true,
    },
    {
      name: '反例·不该调工具（常识）', ask: () => '中国的首都是哪里？',
      expectTool: null, verify: (t) => /北京/.test(t), expectNoTool: true,
    },
    {
      name: '日期·三天后', ask: () => '三天后是几号？只回答日期。',
      // 模型也可能用注入的当前日期直接推算（算对即可），调用率只要不低到说明工具不可用
      expectTool: 'date_math', minToolRate: 0.3,
      verify: (t) => {
        const d = new Date(Date.now() + 3 * 86400000);
        return [String(d.getDate()), String(d.getMonth() + 1), cn(d.getMonth() + 1), cn(d.getDate())].some((f) => f && t.includes(f));
      },
    },
    {
      name: '日期·还有多少天', ask: () => '距离 2027 年 1 月 1 日还有多少天？',
      expectTool: 'date_math',
      verify: (t) => {
        const days = Math.round((new Date(2027, 0, 1).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86400000);
        const num = t.match(/(\d+)\s*天/);
        const cnNum = t.match(/([一二两三四五六七八九十百]+)\s*天/);
        const toNum = (s) => {   // 支持 七十六 / 一百 等
          let n = 0, cur = 0;
          for (const ch of s) {
            if (ch === '百') { cur = (cur || 1) * 100; n += cur; cur = 0; }
            else if (ch === '十') { cur = (cur || 1) * 10; n += cur; cur = 0; }
            else cur = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }[ch] || 0;
          }
          return n + cur;
        };
        const got = num ? Number(num[1]) : (cnNum ? toNum(cnNum[1]) : NaN);
        return Number.isFinite(got) && Math.abs(got - days) <= 1;
      },
    },
    {
      name: '单位·磅换斤', ask: () => '180 磅是多少斤？',
      expectTool: 'unit_convert', verify: (t) => /163|一百六十三/.test(t),
    },
    {
      name: '单位·温度', ask: () => '30 摄氏度等于多少华氏度？',
      expectTool: 'unit_convert', verify: (t) => /86|八十六/.test(t),
    },
    {
      name: '提醒·设置', ask: () => '20 秒后提醒我喝水。',
      expectTool: 'set_reminder', verify: (t) => t.length >= 2,
    },
    {
      name: '提醒·查询', ask: () => '我现在有哪些提醒？',
      expectTool: 'list_reminders', verify: (t) => t.length >= 2,
    },
    {
      name: '组合·先算后说', ask: () => '先算 12*34，然后告诉我结果是不是大于 400。',
      expectTool: 'calculator', verify: (t) => /408|四百零八/.test(t) && /比.{0,3}(400|四百)?大|大于|超过|是/.test(t),
    },
    {
      name: '错误自愈·除零', ask: () => '帮我算一下 5 除以 0 等于多少？',
      // 正确行为：说明"没有意义/无解/不存在/不能做除数/趋于无穷"；错误行为：编一个具体数字
      expectTool: null,
      verify: (t) => /没有意义|无意义|没有结果|没有答案|未定义|不存在|不能做除数|不能为零|不能除以零|无法计算|不能计算|无效|不成立|无解|无穷/.test(t)
        && !/(等于|结果(是|为))\s*(0|5)\b/.test(t),
    },
  ];
}

(async () => {
  await new Promise((r) => ws.on('open', r));
  const c_minToolRate = (r) => r.minToolRate;
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString());
    if (m.type === 'tool_call') toolCalls.push(m.name);
  });

  const cases = buildCases();
  const results = [];
  console.log(`每个用例重复 ${ROUNDS} 轮\n`);

  for (const c of cases) {
    const rows = [];
    for (let i = 0; i < ROUNDS; i++) {
      toolCalls = [];
      const t0 = Date.now();
      let text = '', err = null;
      try { text = await ask(c.ask()); } catch (e) { err = e.message; }
      const ms = Date.now() - t0;
      const called = c.expectTool ? toolCalls.includes(c.expectTool) : false;
      const anyTool = toolCalls.length > 0;
      const correct = !err && c.verify(text);
      rows.push({ called, anyTool, correct, ms, text, err });
      process.stdout.write(`  ${c.name} #${i + 1}: ${err ? 'ERR ' + err : (correct ? '正确' : '内容不符')}${anyTool ? ` [工具:${toolCalls.join('+')}]` : ' [无工具]'} ${ms}ms\n`);
    }
    const toolRate = c.expectTool ? rows.filter((r) => r.called).length / ROUNDS : 0;
    const correctRate = rows.filter((r) => r.correct).length / ROUNDS;
    const overCallRate = rows.filter((r) => r.anyTool).length / ROUNDS;
    const avgMs = Math.round(rows.reduce((a, r) => a + r.ms, 0) / rows.length);
    results.push({ name: c.name, expectTool: c.expectTool, expectNoTool: !!c.expectNoTool, minToolRate: c.minToolRate, toolRate, correctRate, overCallRate, avgMs, rows });
  }

  console.log('\n================ 稳定性汇总 ================');
  console.log('用例                        期望工具           调用率  正确率  平均耗时');
  for (const r of results) {
    console.log(
      `${r.name.padEnd(26)} ${(r.expectTool || (r.expectNoTool ? '(不该调用)' : '(可选)')).padEnd(18)} ` +
      `${(r.expectTool ? (r.toolRate * 100).toFixed(0) + '%' : '—').padStart(6)}  ` +
      `${(r.correctRate * 100).toFixed(0).padStart(5)}%  ${String(r.avgMs).padStart(6)}ms`
    );
  }

  // 判定标准（保守，避免把偶发抖动当回归）
  const fails = [];
  for (const r of results) {
    if (r.correctRate < 1) fails.push(`${r.name}: 正确率 ${(r.correctRate * 100).toFixed(0)}% < 100%`);
    if (r.expectTool && r.toolRate < (c_minToolRate(r) ?? 0.75)) fails.push(`${r.name}: 工具调用率 ${(r.toolRate * 100).toFixed(0)}% < ${Math.round((c_minToolRate(r) ?? 0.75) * 100)}%`);
    if (r.expectNoTool && r.overCallRate > 0.25) fails.push(`${r.name}: 不该调工具却调了 ${(r.overCallRate * 100).toFixed(0)}%`);
  }
  if (fails.length) {
    console.log('\n未达标:');
    fails.forEach((f) => console.log('  ✗ ' + f));
    console.log('\n存在未达标项 ✗');
    process.exit(1);
  }
  console.log('\n全部达标 ✓');
})();
