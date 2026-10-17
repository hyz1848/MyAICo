// Test: 唤醒延迟量化（说完 → ASR → 应答可播放）
// 运行: node test_wake_latency.js
// 说明：把音频按实时节奏喂入（模拟麦克风），并记录"最后一个语音帧发出"的时刻为基准。
// 测试音频由 edge-tts 合成（只需一次）：
//   venv/Scripts/python.exe -c "import asyncio,edge_tts;asyncio.run(edge_tts.Communicate('潞潞同学','zh-CN-XiaoxiaoNeural').save('testdata/wake.mp3'))"
//   再用 soundfile 转 16k 单声道 PCM16 存为 testdata/wake16k.wav
const fs = require('fs');
const WebSocket = require('ws');
const ws = new WebSocket('ws://localhost:8214');

const WAV = 'testdata/wake16k.wav';
const raw = fs.readFileSync(WAV).slice(44);
const samples = new Int16Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 2));
// 找语音段（|x|>0.01 的首尾样本）
const thr = 0.01 * 32768;
let first = 0, last = samples.length - 1;
while (first < samples.length && Math.abs(samples[first]) < thr) first++;
while (last > first && Math.abs(samples[last]) < thr) last--;
const speechBytes = (last + 1) * 2;          // 含前导静音的语音段长度
console.log(`音频: 共 ${(samples.length / 16000).toFixed(2)}s，语音段结束于 ${((last + 1) / 16000).toFixed(2)}s`);

const FRAME = 1280 * 2;
let tSpeechEnd = 0, tAsr = 0, tVad = 0;

function feed(msPerFrame = 80, tailMs = 2500) {
  const tail = Buffer.alloc(FRAME * Math.ceil(tailMs / msPerFrame));
  const all = Buffer.concat([raw, tail]);
  let i = 0;
  const t0 = Date.now();
  return new Promise((resolve) => {
    const tick = () => {
      if (i >= all.length) { resolve(); return; }
      const should = Math.floor((Date.now() - t0) / msPerFrame) + 1;
      let sent = 0;
      while (i < all.length && sent < should - Math.floor(i / FRAME) && sent < 3) {
        ws.send(all.slice(i, i + FRAME), { binary: true });
        i += FRAME;
        if (!tSpeechEnd && i >= speechBytes) tSpeechEnd = Date.now();
        sent++;
      }
      setTimeout(tick, Math.max(4, msPerFrame - ((Date.now() - t0) % msPerFrame)));
    };
    tick();
  });
}

ws.on('message', (d) => {
  const m = JSON.parse(d.toString());
  if (m.type === 'vad_state' && m.state === 'transcribing' && !tVad) tVad = Date.now();
  if (m.type === 'asr_result') {
    tAsr = Date.now();
    console.log(`\n  ASR: ${JSON.stringify(m.text)}  (识别耗时 ${m.asr_ms}ms, 段长 ${m.duration}s)`);
  }
  if (m.type === 'tts_audio') {
    const tAck = Date.now();
    console.log(`  应答音频下发: ${JSON.stringify(m.text)}`);
    console.log('\n== 唤醒延迟分解（基准=语音说完那一刻）==');
    console.log(`  VAD 句末判定     : ${tVad ? tVad - tSpeechEnd : '?'}ms`);
    console.log(`  ASR 识别         : ${tAsr ? tAsr - tVad : '?'}ms`);
    console.log(`  ASR → 音频可播放 : ${tAck - tAsr}ms${m.text === '在呢' ? '（预生成缓存）' : ''}`);
    console.log(`  ── 总计 ──       : ${tAck - tSpeechEnd}ms`);
    process.exit(0);
  }
});

(async () => {
  await new Promise((r) => ws.on('open', r));
  ws.send(JSON.stringify({ type: 'clear_history' }));
  ws.send(JSON.stringify({ type: 'listen', source: 'browser' }));
  await new Promise((r) => setTimeout(r, 700));
  console.log('说唤醒词「潞潞同学」…');
  await feed();
  setTimeout(() => { console.log('超时'); process.exit(2); }, 20000);
})();
