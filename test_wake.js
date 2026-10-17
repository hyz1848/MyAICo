'use strict';
/**
 * test_wake.js — 唤醒词门控用例（唤醒词：潞潞同学，拼音匹配）
 * 运行: node test_wake.js
 *
 * 三类同等重要：
 *  1) 同音字/谐音/英文写法都能唤醒（潞潞/璐璐/露露/路路/卢璐/鲁鲁/鹿鹿/陆陆/噜噜/lulu）
 *  2) 带指令的形式能只取指令部分
 *  3) 无关的话、同音词（陆陆续续/露西/卢克/路由）不能误唤醒
 */
const { createWakeGate, detectWake, isSleepPhrase } = require('./wake');

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(`${name} ${detail}`); console.log(`  ✗ ${name} ${detail}`); }
}

console.log('[1] 同音字/写法都能唤醒');
{
  const yes = [
    '潞潞同学', '璐璐同学', '露露同学', '路路同学', '卢璐同学', '鲁鲁同学', '鹿鹿同学', '陆陆同学', '噜噜同学',
    '潞潞', '璐璐', '露露', '路路', 'lulu', 'LuLu', 'LULU',
    '嗨 潞潞', '嘿，璐璐同学', '喂，露露', '你好 潞潞',
    '潞露同学', '璐潞', '路璐同学',
  ];
  for (const t of yes) check(`认出「${t}」`, detectWake(t).woke, JSON.stringify(detectWake(t)));
}

console.log('\n[2] 不能误唤醒（同音词/无关话）');
{
  const no = [
    '今天天气怎么样', '帮我算一下 123 乘 456', '现在几点了', '露西同学', '卢克是谁',
    '路由器的密码是什么', '路上了', '随机播放音乐', '陆陆续续地把活干完了', '一路顺风',
    '卢沟桥在哪儿', '鹿角有什么功效', '录音笔放哪了',
  ];
  for (const t of no) check(`不误唤醒「${t}」`, !detectWake(t).woke, JSON.stringify(detectWake(t)));
}

console.log('\n[3] 唤醒词带指令 → 只执行指令部分');
{
  const cases = [
    ['潞潞同学现在几点了', '现在几点了'],
    ['璐璐，帮我算一下 1+1', '帮我算一下 1+1'],
    ['露露同学，10秒后提醒我喝水', '10秒后提醒我喝水'],
    ['lulu 今天天气怎么样', '今天天气怎么样'],
    ['嗨 潞潞 说一下李白', '说一下李白'],
    ['喂，璐璐同学，搜一下科技新闻', '搜一下科技新闻'],
  ];
  for (const [input, expectRest] of cases) {
    const d = detectWake(input);
    check(`「${input}」→「${expectRest}」`, d.woke && d.rest === expectRest, JSON.stringify(d));
  }
}

console.log('\n[4] 门控状态机');
{
  const g = createWakeGate({ idleMs: 20000 });
  const t0 = 1_000_000;
  check('初始为待命', g.awake === false);
  check('待命时无关语音被拒', g.handle('今天天气怎么样', t0).accept === false);
  const w = g.handle('潞潞同学', t0 + 1000);
  check('说唤醒词后进入会话', w.woke && g.awake === true, JSON.stringify(w));
  check('唤醒词本身不作为指令', w.accept === false);
  check('会话中正常输入被接受', g.handle('现在几点了', t0 + 2000).accept === true);
  check('空闲未超时仍是会话', g.shouldSleep(t0 + 21000) === false);
  check('空闲超时回到待命', g.shouldSleep(t0 + 30000) === true, `remaining=${g.remainingMs(t0 + 30000)}`);
}
{
  const g = createWakeGate({ idleMs: 5000 });
  const t0 = 2_000_000;
  g.handle('璐璐同学', t0);
  g.handle('第一句', t0 + 1000);
  check('每轮输入刷新计时', g.shouldSleep(t0 + 5500) === false, `remaining=${g.remainingMs(t0 + 5500)}`);
  g.handle('第二句', t0 + 4000);
  check('继续刷新', g.shouldSleep(t0 + 8000) === false);
  check('再次超时才睡', g.shouldSleep(t0 + 12000) === true);
}
{
  const g = createWakeGate({ idleMs: 20000 });
  const t0 = 3_000_000;
  g.handle('潞潞', t0);
  const r = g.handle('璐璐，现在几点', t0 + 5000);
  check('会话中再次唤醒并带指令', r.woke && r.accept && r.text === '现在几点', JSON.stringify(r));
}
{
  const g = createWakeGate({ required: false });
  check('关闭唤醒词时直接放行', g.handle('随便说点什么').accept === true && g.awake === true);
}

console.log('\n[5] 结束语与过短碎片');
{
  for (const t of ['退下', '再见', '拜拜', '不聊了', '先这样', '没事了', '结束对话', '晚点聊']) {
    check(`认出结束语「${t}」`, isSleepPhrase(t), t);
  }
  for (const t of ['再见面的时候', '结束了这个任务', '再见识一下你的能力', '今天天气怎么样']) {
    check(`不是结束语「${t}」`, !isSleepPhrase(t), t);
  }
  const g = createWakeGate({ idleMs: 20000, minChars: 4 });
  check('长度不足的碎片不算指令', g.isLongEnough('是不是') === false && g.isLongEnough('接电话') === false);
  check('正常长度算指令', g.isLongEnough('今天天气怎么样') === true);
}

console.log('\n[6] 边界');
{
  const g = createWakeGate({ idleMs: 20000 });
  check('空文本被拒', g.handle('   ').accept === false);
  check('空文本不误唤醒', g.handle('').woke === false);
  const t0 = 4_000_000;
  g.handle('潞潞同学', t0);
  g.sleep();
  check('sleep() 后回到待命', g.awake === false && g.handle('再说一句', t0 + 1000).accept === false);
  g.forceWake();
  check('forceWake() 恢复会话', g.awake === true && g.handle('你好', Date.now()).accept === true);
}

console.log(`\n通过: ${pass}  失败: ${fail}`);
if (fail) { console.log('失败项:'); failures.forEach(f => console.log('  ✗ ' + f)); process.exit(1); }
console.log('全部通过 ✓');
