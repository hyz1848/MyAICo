// Test: 工具层（本地三件套 + 搜索联网）
// 运行: node test_tools.js
const { getToolDefs, executeTool } = require('./tools/index');

let pass = 0, fail = 0;
const failures = [];
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`✓ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; failures.push(name + ' ' + extra); console.log(`✗ ${name} — ${extra}`); }
}

(async () => {
  console.log('[1] 工具定义');
  const defs = getToolDefs();
  check('至少 3 个工具', defs.length >= 3, defs.map(d => d.name).join(','));
  check('每个都有 name/description/parameters', defs.every(d => d.name && d.description && d.parameters && d.parameters.type === 'object'));

  console.log('\n[2] 时间工具');
  {
    const r = await executeTool('get_current_datetime', {});
    check('返回本地时间', !!r.local, JSON.stringify(r.local));
    check('返回星期', !!r.weekday, r.weekday);
    check('ISO 合理', !!r.iso && !Number.isNaN(Date.parse(r.iso)), r.iso);
    const r2 = await executeTool('get_current_datetime', { timezone: 'UTC' });
    check('支持时区', !!r2.local && !r2.error, r2.local);
    const r3 = await executeTool('get_current_datetime', { timezone: 'Bad/Zone' });
    check('非法时区返回 error', !!r3.error, r3.error);
  }

  console.log('\n[3] 计算器工具');
  {
    const r = await executeTool('calculator', { expression: '(1+2)*3^2' });
    check('(1+2)*3^2 = 27', r.result === 27, JSON.stringify(r));
    const r2 = await executeTool('calculator', { expression: '123*456' });
    check('123*456 = 56088', r2.result === 56088, JSON.stringify(r2));
    const r3 = await executeTool('calculator', { expression: '1/0' });
    check('除零返回 error', !!r3.error, r3.error);
  }

  console.log('\n[4] 日期计算');
  {
    const r = await executeTool('date_math', { op: 'add', base: '今天', value: 3, unit: 'day' });
    const expect = new Date(Date.now() + 3 * 86400000);
    check('今天+3天', r.result && r.result.includes(String(expect.getDate())) && r.result.includes(String(expect.getMonth() + 1)),
      `${r.result} (期望 ${expect.getMonth() + 1}月${expect.getDate()}日)`);
    const d = await executeTool('date_math', { op: 'diff', base: '今天', target: '2027-01-01' });
    check('日期差为正数并有周数', d.days > 0 && d.weeks > 0, `${d.days}天 / ${d.weeks}周`);
    const bad = await executeTool('date_math', { op: 'add', base: '不是日期', value: 1, unit: 'day' });
    check('非法日期返回 error', !!bad.error, bad.error);
  }

  console.log('\n[5] 单位换算');
  {
    const r1 = await executeTool('unit_convert', { value: 180, from: '磅', to: '斤' });
    check('180磅 ≈ 163.29斤', Math.abs(r1.result - 163.293) < 0.01, r1.display);
    const r2 = await executeTool('unit_convert', { value: 30, from: '摄氏度', to: '华氏度' });
    check('30℃ = 86℉', r2.result === 86, r2.display);
    const r3 = await executeTool('unit_convert', { value: 100, from: '千米', to: '英里' });
    check('100km ≈ 62.14mi', Math.abs(r3.result - 62.137) < 0.01, r3.display);
    const bad = await executeTool('unit_convert', { value: 1, from: '斤', to: '摄氏度' });
    check('跨类换算返回 error', !!bad.error, bad.error);
  }

  console.log('\n[6] 提醒（含到点触发）');
  {
    const made = await executeTool('set_reminder', { text: '__测试提醒__', when: '2秒后' });
    check('创建提醒', made.ok === true, JSON.stringify(made));
    const lst = await executeTool('list_reminders', {});
    check('列表包含它', lst.items.some((x) => x.text === '__测试提醒__'), `共 ${lst.count} 条`);
    const cancelled = await executeTool('cancel_reminder', { text: '__测试提醒__' });
    check('按关键词取消', cancelled.removed === 1, JSON.stringify(cancelled));
    const bad = await executeTool('set_reminder', { text: 'x', when: '不要瞎编的时间' });
    check('无法理解的时间返回 error', !!bad.error, bad.error);
  }

  console.log('\n[7] 未知工具');
  {
    const r = await executeTool('nope', {});
    check('返回 error 而非抛出', !!r.error, r.error);
  }

  console.log('\n[5] 搜索工具（联网）');
  {
    const r = await executeTool('web_search', { query: '今天有什么科技新闻', max_results: 3 });
    check('搜索成功', !r.error, r.error || `结果 ${r.results ? r.results.length : 0} 条`);
    if (r.results) {
      check('结果含标题与摘要', r.results.length > 0 && r.results.every(x => x.title && x.snippet), JSON.stringify(r.results[0]).slice(0, 120));
    }
    const bad = await executeTool('web_search', { query: '' });
    check('空查询返回 error', !!bad.error, bad.error);
  }

  console.log(`\n通过: ${pass}  失败: ${fail}`);
  if (fail) { console.log('失败项:'); failures.forEach(f => console.log('  ✗ ' + f)); process.exit(1); }
  console.log('全部通过 ✓');
})();
