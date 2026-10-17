// Test: 唤醒词端到端（真实音频喂入 → 未唤醒不响应 → 唤醒后响应 → 空闲回到待命）
// 运行: node test_wake_e2e.js
const fs = require('fs');
const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:8214');

const pcm = (p) => fs.readFileSync(p).slice(44);   // 跳过 WAV 头
const WAKE = pcm('testdata/wake16k.wav');             // "潞潞同学"
const WAKE_CMD = pcm('temp/_wakecmd16k.wav');      // "潞潞同学，现在几点了"
const CHAT = pcm('temp/_chat16k.wav');             // "今天天气怎么样"（无唤醒词）

const events = [];
const log = (m) => console.log(m);
ws.on('message', (d) => {
  const m = JSON.parse(d.toString());
  events.push(m);
  if (m.type === 'wake_state') log(`  [事件] wake_state awake=${m.awake}`);
  if (m.type === 'user_text') log(`  [事件] user_text "${m.text}"`);
  if (m.type === 'asr_result' && m.text) log(`  [事件] asr_result "${m.text}"`);
  if (m.type === 'tool_call') log(`  [事件] tool_call ${m.name}`);
  if (m.type === 'llm_start') log(`  [事件] llm_start id=${m.id}`);
  if (m.type === 'llm_done') log(`  [事件] llm_done "${(m.fullText || '').slice(0, 40)}"`);
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function sendAudio(buf, msPerFrame = 80) {
  const frame = 1280 * 2;
  const silence = Buffer.alloc(frame * Math.ceil(2500 / msPerFrame));
  const all = Buffer.concat([buf, silence]);
  let i = 0;
  const t0 = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      if (i >= all.length) return resolve();
      const should = Math.floor((Date.now() - t0) / msPerFrame) + 1;
      let sent = 0;
      while (i < all.length && sent < should - Math.floor(i / frame) && sent < 3) { ws.send(all.slice(i, i + frame), { binary: true }); i += frame; sent++; }
      setTimeout(tick, Math.max(4, msPerFrame - ((Date.now() - t0) % msPerFrame)));
    };
    tick();
  });
}
const has = (type, pred = () => true) => events.some((e) => e.type === type && pred(e));
const since = (idx) => events.slice(idx);

(async () => {
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'clear_history' }));
  ws.send(JSON.stringify({ type: 'listen', source: 'browser' }));
  await wait(800);

  let pass = 0, fail = 0;
  const check = (n, ok, extra = '') => { console.log(`${ok ? '✓' : '✗'} ${n}${extra ? ' — ' + extra : ''}`); ok ? pass++ : fail++; };

  // 1) 待命时说无关的话 → 不该有回复
  console.log('\n[1] 未唤醒时说无关的话（应被忽略）');
  let mark = events.length;
  await sendAudio(CHAT);
  await wait(1500);
  check('没有产生回复', !has('llm_start') || !since(mark).some((e) => e.type === 'llm_start'));

  // 2) 说唤醒词 → 应答
  console.log('\n[2] 说「潞潞同学」（应唤醒并应答）');
  mark = events.length;
  await sendAudio(WAKE);
  await wait(2500);
  check('收到唤醒事件', since(mark).some((e) => e.type === 'wake_state' && e.awake === true));
  check('唤醒后有应答语音', since(mark).some((e) => e.type === 'tts_audio'));

  // 3) 唤醒后直接说话 → 正常回复
  console.log('\n[3] 唤醒后说一句（应正常回复）');
  mark = events.length;
  await sendAudio(CHAT);
  await wait(2000);
  const gotReply = await new Promise((res) => {
    const t = setTimeout(() => res(since(mark).some((e) => e.type === 'llm_start')), 25000);
    const h = (d) => { const m = JSON.parse(d.toString()); if (m.type === 'llm_done') { clearTimeout(t); ws.off('message', h); res(true); } };
    ws.on('message', h);
  });
  check('产生了回复', gotReply);

  console.log(`\n通过: ${pass}  失败: ${fail}（超时回待命需等 ${process.env.VOICEAI_IDLE_MS || 25000}ms，未在此测）`);
  ws.send(JSON.stringify({ type: 'stop_listen' }));
  process.exit(fail ? 1 : 0);
})();
