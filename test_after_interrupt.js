// Test: 打断（worker clear）之后，TTS 管线必须还能出声
// 回归目标：worker 静默处理 clear → server workerBusy 闩锁永久卡住 → 后续 tts 再也发不进去
const ws = new (require('ws'))('ws://localhost:8214');
const t0 = Date.now();
const log = (m) => process.stdout.write(`+${Date.now() - t0}ms ${m}\n`);
let phase = 'first';

ws.on('open', () => {
  log('第一问（长回答）');
  ws.send(JSON.stringify({ type: 'clear_history' }));
  ws.send(JSON.stringify({ type: 'text', text: '写一篇800字的文章，介绍中国茶文化的历史' }));
});

let stopSent = false;

let secondDone = null;
let audioAfterInterrupt = 0;
let interrupted = false;
let currentReplyId = null;
let secondId = null;

ws.on('message', (d) => {
  const m = JSON.parse(d.toString());
  if (m.type === 'llm_start') { currentReplyId = m.id; }
  // 确认生成已开始（收到首 token）后再发停止词，避免与"生成太快"竞争
  if (m.type === 'llm_stream' && !stopSent) {
    stopSent = true;
    setTimeout(() => { log('发停止词（中断 + clear）'); ws.send(JSON.stringify({ type: 'text', text: '别说了' })); }, 300);
  }
  if (m.type === 'llm_interrupted') {
    interrupted = true;
    log('llm_interrupted 收到');
    // 打断后立刻问一个短问题：必须还能合成音频
    phase = 'second';
    setTimeout(() => { log('第二问（打断后必须还能出声）'); ws.send(JSON.stringify({ type: 'text', text: '说一句你好。' })); }, 500);
  }
  if (m.type === 'tts_audio') {
    // 严格：只统计第二轮的音频（第一轮在途的旧音频由浏览器按 id 丢弃）
    if (phase === 'second' && (secondId === null || m.id === secondId) && m.text.includes('你好')) {
      if (secondId === null) secondId = m.id;
      audioAfterInterrupt++;
      log(`第二问音频 #${audioAfterInterrupt}: 「${m.text}」 (id=${m.id})`);
    }
  }
  if (m.type === 'llm_done' && phase === 'second') {
    secondDone = Date.now() - t0;
    log('第二问完成');
  }
});

setTimeout(() => {
  log(`中断发生=${interrupted} 第二问音频段数=${audioAfterInterrupt}`);
  const ok = interrupted && audioAfterInterrupt >= 1;
  log(ok ? '--- OK: 打断后 TTS 管线仍然可用 ---' : '--- FAIL: 打断后不再出声 ---');
  process.exit(ok ? 0 : 2);
}, 30000);
