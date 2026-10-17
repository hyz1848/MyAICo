'use strict';
/**
 * test_chunker.js — tts-chunker 大量用例验证
 * 运行: node test_chunker.js
 */
const { TtsChunker, ttsClean, isSpeakable, cleanChunk } = require('./tts-chunker');

let pass = 0, fail = 0;
const failures = [];

function check(name, actual, expected) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; }
  else { fail++; failures.push(`${name}\n   期望: ${e}\n   实际: ${a}`); }
}

function feedAll(text, opts) {
  const c = new TtsChunker(opts);
  return c.push(text).concat(c.flush());
}

function feedIncremental(text, size, opts) {
  const c = new TtsChunker(opts);
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(...c.push(text.slice(i, i + size)));
  out.push(...c.flush());
  return out;
}

// ========== 1. 基础分句 ==========
check('单句', feedAll('你好。'), ['你好。']);
check('两句', feedAll('今天天气不错。我们出去走走吧。'), ['今天天气不错。', '我们出去走走吧。']);
check('问号感叹号', feedAll('你吃饭了吗？我吃了！'), ['你吃饭了吗？', '我吃了！']);
check('分号', feedAll('第一点；第二点。'), ['第一点；', '第二点。']);
check('换行分句', feedAll('第一行\n第二行'), ['第一行', '第二行']);
check('英文两句', feedAll('Hello world. This is fine!'), ['Hello world.', 'This is fine!']);

// ========== 2. 增量与整段一致（核心不变量：不丢字/不重复） ==========
const invCases = [
  '你好。今天天气不错。我们出去走走吧！',
  '雨夜里，小猫躲在屋檐下，浑身湿透。路过的老奶奶把它抱回家，用旧毛巾擦干，又端来热牛奶。小猫轻轻叫了一声，蜷在她脚边睡着了。',
  '**加粗**和*斜体*混在一起。第二句在这里。',
  '圆周率是3.14，很重要。下一句。',
  'Hello world. This is fine! Mixed 中文 too.',
  'a'.repeat(120) + '。结尾。',
  '这是很长很长的一句话没有句号只有逗号，一直写下去写下去，然后终于结束了',
];
for (const [idx, text] of invCases.entries()) {
  const bulk = feedAll(text);
  for (const size of [1, 2, 3, 7]) {
    check(`不变量#${idx} 分块${size}字节 = 整段`, feedIncremental(text, size), bulk);
  }
}

// ========== 3. Markdown 清洗 ==========
check('加粗', feedAll('**重要**的事情。'), ['重要的事情。']);
check('标题', feedAll('# 标题\n正文内容。'), ['标题', '正文内容。']);
check('列表', feedAll('- 第一项\n- 第二项\n'), ['第一项', '第二项']);
check('有序列表', feedAll('1. 打开门\n2. 走进去\n'), ['打开门', '走进去']);
check('行内代码', feedAll('用 `console.log` 打印。'), ['用 console.log 打印。']);
check('链接', feedAll('见[百度](https://www.baidu.com)首页。'), ['见百度首页。']);
check('图片', feedAll('图![猫](http://x.png)在这。'), ['图猫在这。']);
check('删除线', feedAll('~~删掉~~保留。'), ['删掉保留。']);
check('引用', feedAll('> 引用的话\n下文。'), ['引用的话', '下文。']);
check('分隔线', feedAll('上文。\n---\n下文。'), ['上文。', '下文。']);

// ========== 4. 代码块整体丢弃 ==========
check('围栏代码块', feedAll('看代码：\n```js\nconst a = 1;\n```\n好了。'), ['看代码：', '好了。']);
check('未闭合代码块', feedAll('前面。\n```python\nprint("x")\n'), ['前面。']);
check('代码块后继续', feedAll('```\ncode\n```\n之后的话。'), ['之后的话。']);
check('增量代码块', feedIncremental('开始。\n```js\nlet x = 1;\n```\n结束。', 1), ['开始。', '结束。']);

// ========== 5. 不该朗读的内容 ==========
check('纯标点', feedAll('。。。！！！'), []);
check('空字符串', feedAll(''), []);
check('纯空白', feedAll('   \n\t  '), []);
check('纯 emoji', feedAll('😀🎉👍'), []);
check('emoji 混排', feedAll('你好😀世界。'), ['你好世界。']);

// ========== 6. 数字与英文细节 ==========
check('小数点不切', feedAll('圆周率是3.14，很重要。'), ['圆周率是3.14，很重要。']);
check('版本号', feedAll('升级到 v1.2.3 版本。'), ['升级到 v1.2.3 版本。']);
check('缩写不切', feedAll('用 e.g. 这个例子。'), ['用 e.g. 这个例子。']);
check('英文句号后无空格不切', feedAll('访问 a.b.c 即可。'), ['访问 a.b.c 即可。']);
check('时间冒号不切', feedAll('时间：2026-10-17 10:00。'), ['时间：2026-10-17 10:00。']);
check('百分比', feedAll('增长了 15.5% 。'), ['增长了 15.5% 。']);

// ========== 7. 超长句强制切分 ==========
{
  const long = '这'.repeat(100);
  const out = feedAll(long, { maxLen: 48 });
  const total = out.join('').length;
  check('超长无标点不丢字', total, 100);
  check('超长无标点切成多段', out.length >= 2, true);
  check('超长每段<=maxLen', out.every(s => s.length <= 48), true);
}
{
  const longClause = '内容内容内容内容内容内容，'.repeat(3) + '结尾。';
  const out = feedAll(longClause, { maxLen: 32 });
  check('长句在逗号处切', out[0].endsWith('，'), true);
  check('逗号切分不丢字', out.join('').length, longClause.length);
}
{
  const long = '词'.repeat(60) + '。';
  const out = feedAll(long, { maxLen: 20 });
  check('硬切分保尾标点', out.join('').endsWith('。'), true);
  check('硬切分总量', out.join('').length, 61);
}

// ========== 8. 边界与异常输入 ==========
check('HTML 标签', feedAll('<b>粗体</b>文字。'), ['粗体文字。']);
check('中文引号内不断句', feedAll('他说：「你好。」然后走了。'), ['他说：「你好。」然后走了。']);
check('引号结束后可断句', feedAll('他说：「你好。」。然后走了。'), ['他说：「你好。」。', '然后走了。']);
check('连续句末', feedAll('真的吗？！我不信。'), ['真的吗？！', '我不信。']);
check('省略号', feedAll('让我想想……算了。'), ['让我想想……', '算了。']);
check('超长空白', feedAll('甲。' + ' '.repeat(50) + '乙。'), ['甲。', '乙。']);
check('null 输入', feedAll(''), []);

// ========== 9. 复用同一实例（多轮对话） ==========
{
  const c = new TtsChunker();
  const r1 = c.push('第一轮回答。');
  const r2 = c.push('第二轮回答。');
  const r3 = c.flush();
  check('实例多轮 r1', r1, ['第一轮回答。']);
  check('实例多轮 r2', r2, ['第二轮回答。']);
  check('实例多轮 r3', r3, []);
}

// ========== 10. 清洗函数单测 ==========
check('ttsClean 加粗', ttsClean('**粗**'), '粗');
check('ttsClean 反引号', ttsClean('`code`'), 'code');
check('ttsClean emoji', ttsClean('a😀b'), 'ab');
check('ttsClean 多空白', ttsClean('a   \n  b'), 'a b');
check('ttsClean 空', ttsClean(''), '');
check('isSpeakable 汉字', isSpeakable('你好'), true);
check('isSpeakable 标点', isSpeakable('。！？'), false);
check('isSpeakable 数字', isSpeakable('3.14'), true);
check('isSpeakable 空', isSpeakable(''), false);
check('cleanChunk 纯标点', cleanChunk('。。。'), '');

// ========== 11. 真实 LLM 输出样本 ==========
const realSamples = [
  ['让我帮你分析一下。\n\n首先，这个问题的**核心**在于 `数据结构` 的选择。\n\n1. 数组适合随机访问\n2. 链表适合频繁插入\n\n总结：视场景而定。',
   ['让我帮你分析一下。', '首先，这个问题的核心在于 数据结构 的选择。', '数组适合随机访问', '链表适合频繁插入', '总结：视场景而定。']],
  ['```python\ndef hello():\n    print("hi")\n```\n这段代码会输出 hi。',
   ['这段代码会输出 hi。']],
  ['好的！我来介绍一下红楼梦。它是中国古典四大名著之一，作者是曹雪芹。故事以贾宝玉和林黛玉的爱情为主线。',
   ['好的！', '我来介绍一下红楼梦。', '它是中国古典四大名著之一，作者是曹雪芹。', '故事以贾宝玉和林黛玉的爱情为主线。']],
];
for (const [i, [input, expected]] of realSamples.entries()) {
  check(`真实样本#${i+1}`, feedAll(input), expected);
  check(`真实样本#${i+1} 增量一致`, feedIncremental(input, 1), expected);
}

// ========== 结果 ==========
console.log(`\n通过: ${pass}  失败: ${fail}\n`);
if (fail) {
  console.log('失败用例:');
  failures.forEach(f => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('全部通过 ✓');
