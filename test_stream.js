// Test: 流式分句 TTS —— 长回答下，播音必须在生成结束前就开始
const ws = new (require('ws'))('ws://localhost:8214');
const t0 = Date.now();
let ttsCount = 0, firstTts = null, lastTts = 0, done = null, ids = new Set(), fullText = '';
ws.on('open', () => {
  ws.send(JSON.stringify({ type: 'clear_history' }));
  // 要长回答：生成明显慢于单句合成，才能稳定验证"边说边播"
  ws.send(JSON.stringify({ type: 'text', text: '请写一篇1500字左右的科普长文，系统讲解光合作用的原理、两个阶段、影响因素和生态意义' }));
});
ws.on('message', (d) => {
  const m = JSON.parse(d.toString());
  if (m.type === 'llm_stream') fullText += m.content;
  if (m.type === 'tts_audio') {
    ttsCount++; ids.add(m.id);
    lastTts = Date.now() - t0;
    if (firstTts === null) {
      firstTts = Date.now() - t0;
      console.log(`+${firstTts}ms 第一段音频: 「${m.text.slice(0, 18)}」 id=${m.id}`);
    } else {
      console.log(`+${Date.now() - t0}ms 第${ttsCount}段: 「${m.text.slice(0, 18)}」`);
    }
  }
  if (m.type === 'llm_done') {
    done = Date.now() - t0;
    console.log(`+${done}ms llm_done（共 ${fullText.length} 字）`);
    const afterDone = m.fullText.length >= 300 ? 45000 : 10000;   // 长回答的合成需要更久
    setTimeout(() => {
      // 真正的流式不变量：首段音频必须在生成结束之前就到（整篇丢给 TTS 时做不到）
      const ok = ttsCount >= 3 && ids.size === 1 && firstTts !== null && firstTts < done;
      console.log(`\n分段=${ttsCount} 同一id=${[...ids].join(',')} 生成结束=${done}ms 首段=${firstTts}ms 末段=${lastTts}ms 提前=${done - firstTts}ms`);
      console.log(ok ? '--- OK: 分句流式（首段早于生成结束） ---' : '--- FAIL ---');
      process.exit(ok ? 0 : 2);
    }, afterDone);
  }
  if (m.type === 'error') { console.log('ERROR', m.error); process.exit(1); }
});
setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(2); }, 120000);
