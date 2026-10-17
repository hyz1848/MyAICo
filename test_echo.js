'use strict';
/**
 * test_echo.js — 回声识别用例（能量门限挡不住喇叭声，只能靠内容）
 * 运行：node test_echo.js
 *
 * 两类用例同等重要：
 *  - 真回声必须拦住（否则自问自答成环）
 *  - 用户真实说话不能被误杀（否则问什么都听不见）
 */
const { createEchoGuard, classifyEcho, normalize, longestCommonSubstring } = require('./echo-guard');

let pass = 0, fail = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; failures.push(`${name} ${detail}`); console.log(`  ✗ ${name} ${detail}`); }
}

// ========== 1. 纯函数：归一化 / LCS ==========
console.log('[1] 基础工具');
check('normalize 去标点空白', normalize('你好，世界！ A B') === '你好世界ab', normalize('你好，世界！ A B'));
check('LCS 完全一样', longestCommonSubstring('你好世界', '你好世界') === 4);
check('LCS 部分重合', longestCommonSubstring('今天天气不错', '天气不错啊') === 4);
check('LCS 无重合', longestCommonSubstring('abc', 'xyz') === 0);
check('LCS 空串', longestCommonSubstring('', 'abc') === 0);

// ========== 2. 真回声必须拦 ==========
console.log('\n[2] 真回声（喇叭放出来被麦克风听回去）');
const spoken = '中国茶文化历史悠久，最早可以追溯到神农尝百草的传说。';
const echoCases = [
  ['逐字回声', spoken],
  ['ASR 只回了一部分', '中国茶文化历史悠久'],
  ['ASR 有错字但主体一致', '中国茶文化历史悠久最早可以追溯道神农尝百草的传说'],
  ['带标点差异', '中国茶文化历史悠久，最早可以追溯到神农尝百草的传说'],
  ['回声尾巴（句子后半）', '最早可以追溯到神农尝百草的传说'],
  ['两端都截断', '茶文化历史悠久，最早可以追溯到神农'],
  ['短回声（8字重合）', '最早可以追溯到神农尝百草'],
];
for (const [name, asr] of echoCases) {
  const r = classifyEcho(asr, spoken);
  check(name, r.echo, JSON.stringify(r));
}

// ========== 3. 用户真实说话不能误杀 ==========
console.log('\n[3] 真实用户语音（不能误判为回声）');
const notEchoCases = [
  ['完全无关的新问题', '帮我设一个明天早上八点的闹钟'],
  ['简短指令', '打开客厅的灯'],
  ['同主题但不同内容', '那唐朝的茶是怎么喝的'],
  ['时间相关追问', '现在几点了'],
  ['只说一个词（单字不判回声）', '嗯'],
  ['重复用词但句子不同', '茶文化是什么'],
  ['英文新指令', 'play some music'],
];
for (const [name, asr] of notEchoCases) {
  const r = classifyEcho(asr, spoken);
  check(name, !r.echo, JSON.stringify(r));
}

// ========== 4. 有状态守门器：时间窗 ==========
console.log('\n[4] 时间窗与生命周期');
{
  const g = createEchoGuard({ windowMs: 20000 });
  const t0 = 1_000_000;
  g.remember('欢迎回来，今天想聊点什么？', t0);
  check('窗口内回声被拦', g.isEcho('欢迎回来今天想聊点什么', t0 + 5000).echo);
  check('窗口外不再拦（当作新语音）', !g.isEcho('欢迎回来今天想聊点什么', t0 + 25000).echo);
  check('无关语音窗口内也不拦', !g.isEcho('帮我查一下天气', t0 + 5000).echo);
}
{
  const g = createEchoGuard();
  g.remember('第一句');
  g.remember('第二句内容在这里');
  check('多条目匹配第二条', g.isEcho('第二句内容在这里').echo);
  check('clear 后不再拦', (g.clear(), !g.isEcho('第二句内容在这里').echo));
}
{
  const g = createEchoGuard({ maxEntries: 3 });
  for (let i = 0; i < 10; i++) g.remember(`句子${i}内容够长了`);
  check('条目数上限生效', g.size === 3, `size=${g.size}`);
  check('最老的已淘汰', !g.isEcho('句子0内容够长了').echo);
  check('最新的仍在', g.isEcho('句子9内容够长了').echo);
}

// ========== 5. 与"停止词"的相互影响 ==========
console.log('\n[5] 与停止词的边界');
{
  // 助手说过含"停止"的话，随后 ASR 把回声识别成"停止" → 应判回声，避免自己把自己打断
  const g = createEchoGuard();
  g.remember('好的，我会停止播放音乐。');
  check('回声中的停止词被判为回声（不触发自打断）', g.isEcho('好的我会停止播放音乐').echo);
  check('用户真说停止（未被说过）不判回声', !g.isEcho('停止').echo);
}

// ========== 6. 长播报拼接场景 ==========
console.log('\n[6] 长播报（多句拼接后的回声）');
{
  const g = createEchoGuard();
  const chunks = ['海洋按深度分成好几层。', '最上面是透光层，阳光充足。', '往下是弱光层，生物开始变少。', '最深处是黑暗的深渊区。'];
  chunks.forEach(c => g.remember(c));
  check('回声命中其中一句', g.isEcho('最上面是透光层，阳光充足').echo);
  check('回声跨句拼接也命中（子串规则）', g.isEcho('往下是弱光层').echo);
  check('新问题不命中', !g.isEcho('深渊区有多深').echo);
}

console.log(`\n通过: ${pass}  失败: ${fail}`);
if (fail) { console.log('失败项:'); failures.forEach(f => console.log('  ✗ ' + f)); process.exit(1); }
console.log('全部通过 ✓');
