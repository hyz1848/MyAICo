// Test: 多轮上下文记忆 + 会话恢复 + 新会话清空
const ws = new (require('ws'))('ws://localhost:8214');
const t0 = Date.now();
const send = (o) => ws.send(JSON.stringify(o));
let phase = 0, replies = [], histTokens = 0, histLen = 0;

function waitReply(expectedLabel, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${expectedLabel} 超时`)), timeoutMs);
    const handler = (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === 'llm_done') {
        clearTimeout(timer);
        ws.off('message', handler);
        console.log(`+${Date.now() - t0}ms ${expectedLabel}: 「${m.fullText.trim().slice(0, 50)}」`);
        resolve(m.fullText);
      } else if (m.type === 'error') {
        clearTimeout(timer);
        ws.off('message', handler);
        reject(new Error(m.error));
      }
    };
    ws.on('message', handler);
  });
}

ws.on('message', (d) => {
  const m = JSON.parse(d.toString());
  if (m.type === 'history') { histLen = (m.messages || []).length; histTokens = m.tokens || 0; }
});

ws.on('open', async () => {
  try {
    console.log('--- 第一轮：告知姓名 ---');
    send({ type: 'text', text: '记住，我叫小明，我是做语音识别的工程师。' });
    await waitReply('回答1');

    console.log('--- 第二轮：考察记忆 ---');
    send({ type: 'text', text: '我叫什么名字？我是做什么工作的？' });
    const r2 = await waitReply('回答2');
    const remembered = r2.includes('小明');

    console.log('--- 清空会话 ---');
    send({ type: 'clear_history' });
    await new Promise(r => setTimeout(r, 500));

    console.log('--- 第三轮：清空后应不记得 ---');
    send({ type: 'text', text: '我叫什么名字？' });
    const r3 = await waitReply('回答3');
    const forgotten = !r3.includes('小明');

    console.log(`\n记忆保持: ${remembered} | 清空生效: ${forgotten} | 清空前历史条数: ${histLen} tokens≈${histTokens}`);
    console.log(remembered && forgotten ? '--- OK: 多轮上下文 + 会话管理正常 ---' : '--- FAIL ---');
    process.exit(remembered && forgotten ? 0 : 2);
  } catch (e) {
    console.log('ERROR:', e.message);
    process.exit(1);
  }
});
setTimeout(() => { console.log('GLOBAL TIMEOUT'); process.exit(2); }, 180000);
