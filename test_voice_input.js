// Test: 播报中的真人语音必须被响应（打断 + barge-in），不能默默吞掉
//
// 不依赖浏览器：直接按 80ms 节奏把 16k int16 PCM 帧当二进制 WS 消息喂给服务端，
// 服务端在 browser 采集模式下会转发给 worker 走正常 VAD/ASR 链路。
//
// 覆盖：
//  1) 播报中说停止词 → 中断（stop_tts + llm_interrupted）
//  2) 播报中说普通问题 → barge-in：打断并作为新一轮处理（新的 llm_start）
//  3) 打断后立刻说话 → 必须被接受（验证 speakingUntil 已清零，不会再被当成回声吞掉）
const fs = require('fs');
const WebSocket = require('ws');

const url = 'ws://localhost:8214';
const wav = (p) => {
  const buf = fs.readFileSync(p);
  // 跳过 44 字节 WAV 头（本项目生成的 PCM_16 单声道文件）
  return buf.slice(44);
};
const STOP = wav('temp/_stop16k.wav');
const BARGE = wav('temp/_barge16k.wav');

const events = [];
let ws;

function sendAudio(pcm) {
  const frame = 1280 * 2;   // 80ms @16k int16
  for (let i = 0; i < pcm.length; i += frame) {
    const chunk = pcm.slice(i, i + frame);
    ws.send(chunk, { binary: true });
  }
}
function sendAudioRealtime(pcm, msPerFrame = 80) {
  const frame = 1280 * 2;
  // 末尾补静音帧：真实麦克风会持续送静音，VAD 才能"等够静音时长"闭合句子
  const tail = Buffer.alloc(frame * Math.ceil(2500 / msPerFrame));
  const all = Buffer.concat([pcm, tail]);
  let i = 0;
  const t0 = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      if (i >= all.length) { resolve(); return; }
      const now = Date.now() - t0;
      const shouldBeFrames = Math.floor(now / msPerFrame) + 1;
      let sent = 0;
      while (i < all.length && sent < shouldBeFrames - Math.floor((i / frame))) {
        ws.send(all.slice(i, i + frame), { binary: true });
        i += frame;
        sent++;
        if (sent >= 3) break;   // 一次最多补 3 帧，避免突发
      }
      setTimeout(tick, Math.max(4, msPerFrame - (Date.now() - t0 - now)));
    };
    tick();
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
function waitFor(type, timeout = 30000, filter = () => true) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      const hit = events.find((e) => e.type === type && filter(e));
      if (hit) { clearInterval(timer); resolve(hit); }
      else if (Date.now() - t0 > timeout) { clearInterval(timer); resolve(null); }
    }, 100);
  });
}

(async () => {
  ws = new WebSocket(url);
  ws.on('message', (d, isBinary) => {
    if (isBinary) return;
    const m = JSON.parse(d.toString());
    events.push(m);
    if (m.type === 'llm_start') console.log(`  [事件] llm_start id=${m.id}`);
    if (m.type === 'llm_interrupted') console.log('  [事件] llm_interrupted');
    if (m.type === 'stop_tts') console.log('  [事件] stop_tts');
    if (m.type === 'asr_result' && m.text) console.log(`  [事件] asr_result "${m.text}" (rms=${m.rms})`);
  });
  await new Promise((r) => ws.on('open', r));

  let pass = 0, fail = 0;
  const check = (name, ok, extra = '') => {
    console.log(`${ok ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`);
    ok ? pass++ : fail++;
  };

  ws.send(JSON.stringify({ type: 'clear_history' }));
  ws.send(JSON.stringify({ type: 'listen', source: 'browser' }));
  await wait(600);

  // ---- 1) 播报中说话 → barge-in（普通问题也要有反应）----
  console.log('\n[1] 播报中说普通问题（应 barge-in 成新一轮）');
  events.length = 0;
  ws.send(JSON.stringify({ type: 'text', text: '详细介绍一下李白的生平' }));
  const firstStart = await waitFor('llm_start', 15000);
  await waitFor('tts_audio', 45000);            // 等第一段音频就绪（说明在"播报窗口"内）
  await wait(500);
  await sendAudioRealtime(BARGE);
  const newStart = await waitFor('llm_start', 40000, (e) => e.id > firstStart.id);
  const asr = events.find((e) => e.type === 'asr_result' && e.text && e.text.includes('李白'));
  check('识别到了这句真人语音', !!asr, asr ? `"${asr.text}"` : '没识别出来');
  check('barge-in 产生新的一轮（新的 llm_start）', !!newStart, newStart ? `id=${newStart.id}` : '没有新轮次');

  // ---- 2) 播报中说停止词 → 中断 ----
  console.log('\n[2] 播报中说停止词（应中断）');
  events.length = 0;
  ws.send(JSON.stringify({ type: 'text', text: '详细介绍一下杜甫的生平' }));
  await waitFor('llm_start', 15000);
  await waitFor('tts_audio', 45000);
  await wait(500);
  await sendAudioRealtime(STOP);
  const interrupted = await waitFor('llm_interrupted', 25000);
  check('停止词触发中断', !!interrupted);

  // ---- 3) 打断后立刻说话 → 必须被接受 ----
  console.log('\n[3] 打断后立刻说话（验证播报窗口已清零）');
  events.length = 0;
  await wait(300);
  await sendAudioRealtime(BARGE);
  const afterStart = await waitFor('llm_start', 40000);
  check('打断后的语音被正常处理', !!afterStart, afterStart ? `id=${afterStart.id}` : '被吞掉了');
  const iUser = events.findIndex((e) => e.type === 'user_text');
  const iStart = events.findIndex((e) => e.type === 'llm_start');
  check('user_text 在 llm_start 之前（界面顺序正确）', iUser >= 0 && iStart >= 0 && iUser < iStart,
    `user_text@${iUser} llm_start@${iStart}`);

  ws.send(JSON.stringify({ type: 'stop_listen' }));
  console.log(`\n通过: ${pass}  失败: ${fail}`);
  process.exit(fail ? 1 : 0);
})();
