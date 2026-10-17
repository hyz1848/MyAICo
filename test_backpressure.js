// Test: TTS 有界前瞻（背压）
//
// 观测点：LLM 远快于语音合成，若把整篇句子都塞给 worker 预合成，
// 打断时会有大量"已经/正在合成但用户听不到"的浪费。
// 有界前瞻（TTS_LOOKAHEAD=2）下，打断后仍会到达的旧音频应 <= 3 段，
// 而此时回答本身已经有 >= 6 句。
const ws = new (require('ws'))('ws://localhost:8214');
const t0 = Date.now();
const log = (m) => process.stdout.write(`+${Date.now() - t0}ms ${m}\n`);

let streamed = '';
let beforeStop = 0, afterStop = 0, sentencesAtStop = 0;
let stopSent = false, interrupted = false;
let firstAudioSeen = false;

ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'clear_history' }));
  ws.send(JSON.stringify({ type: 'text', text: '写一篇1000字的文章，详细介绍世界海洋的深度分层与各层生物，尽量展开' }));
});

ws.on('message', (d) => {
  const m = JSON.parse(d.toString());
  if (m.type === 'llm_stream') streamed += m.content;
  if (m.type === 'tts_audio') {
    if (stopSent) afterStop++; else beforeStop++;
    firstAudioSeen = true;
  }
  if (m.type === 'llm_interrupted') interrupted = true;
});

// 等到"已经开始出音频"且"回答还有很多句没合成"时打断
const tick = setInterval(() => {
  if (stopSent || !firstAudioSeen) return;
  const sentences = streamed.split(/[。！？\n]/).map(s => s.trim()).filter(s => s.length >= 6).length;
  if (sentences >= 6) {
    sentencesAtStop = sentences;
    stopSent = true;
    clearInterval(tick);
    log(`发停止词（已生成 ${streamed.length} 字 / ${sentences} 句，已合成 ${beforeStop} 段）`);
    ws.send(JSON.stringify({ type: 'text', text: '别说了' }));
    setTimeout(() => {
      log(`打断后仍到达的旧音频: ${afterStop} 段（有界前瞻上限 ${2 + 1}）`);
      const ok = interrupted && sentencesAtStop >= 6 && afterStop <= 3;
      log(ok ? '--- OK: 有界前瞻生效（打断时浪费的合成受限于前瞻窗口） ---' : '--- FAIL ---');
      process.exit(ok ? 0 : 2);
    }, 6000);
  }
}, 200);

setTimeout(() => { log('GLOBAL TIMEOUT'); process.exit(2); }, 90000);
