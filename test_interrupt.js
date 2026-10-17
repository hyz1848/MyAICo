// Test: 停止词在 LLM 生成过程中必须中断生成 + 清空未播音频
const ws = new (require('ws'))('ws://localhost:8214');
const t0 = Date.now();
const log = (m) => process.stdout.write(`+${Date.now() - t0}ms ${m}\n`);
let streams = 0, ttsBefore = 0, ttsAfter = 0, interruptedAt = null, lastId = null, stopSent = false;
ws.on('open', () => {
  log('ask long question');
  ws.send(JSON.stringify({ type: 'clear_history' }));
  ws.send(JSON.stringify({ type: 'text', text: '写一篇800字左右的说明文，介绍中国茶文化的历史' }));
});
ws.on('message', (d) => {
  const m = JSON.parse(d.toString());
  if (m.type === 'llm_stream') {
    streams++; lastId = m.id || lastId;
    // 确认生成已开始后再发停止词（生成可能比固定延时更快，避免竞态）
    if (!stopSent) {
      stopSent = true;
      setTimeout(() => {
        log(`发送停止（此时已收到 ${streams} 个 token, ${ttsBefore} 段音频）`);
        ws.send(JSON.stringify({ type: 'text', text: '别说了' }));
      }, 300);
    }
  }
  if (m.type === 'llm_start') lastId = m.id;
  if (m.type === 'tts_audio') { if (interruptedAt === null) ttsBefore++; else ttsAfter++; }
  if (m.type === 'stop_tts') log('stop_tts 收到（浏览器将清空播放队列）');
  if (m.type === 'llm_interrupted') {
    interruptedAt = Date.now() - t0;
    const tokensAtInterrupt = streams;
    setTimeout(() => {
      log(`中断时 token=${tokensAtInterrupt}，中断后新增 token=${streams - tokensAtInterrupt}`);
      log(`中断后仍到达的旧音频段=${ttsAfter}（id=${lastId}，浏览器端按 id 丢弃）`);
      const genStopped = streams - tokensAtInterrupt === 0;
      log(genStopped ? '--- OK: LLM 生成立即停止 ---' : '--- FAIL: 中断后仍在生成 ---');
      process.exit(genStopped ? 0 : 2);
    }, 2500);
  }
  if (m.type === 'llm_done') log(`llm_done（回答 ${m.fullText.length} 字）—— 生成太快，未能打断`);
});
setTimeout(() => { log('GLOBAL TIMEOUT'); process.exit(2); }, 40000);
