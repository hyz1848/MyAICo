// test_wake_service.js — 唤醒门控的"服务端端到端"回归（用日志里真实出现过的 ASR 变体）
//
// 背景（真实故障）：用户喊"潞潞同学"多次，系统其实**匹配到了唤醒词**，但 ASR 把唤醒词
// 识别成"陆露露同学""米露鲁同学""呃露露同学""露露露同学"（前面多粘一个音）→ 那个残留碎音
// 被当成"指令"→ 因过短被丢弃 → **既不处理也不播"在呢"** → 用户以为"没识别到"。
//
// 做法：隔离实例 + 内置 mock LLM + `debug.asrSim` 注入通道，断言：
//   · 各种"唤醒词+碎音"变体 → 必须进唤醒态 **且播出应答（llm_done "在呢"）**
//   · "唤醒词+真实指令" → 进唤醒态并真的回答（不走应答）
//   · 未唤醒时的普通话 → 忽略（不误唤醒）
//
// 跑法：node test_wake_service.js

'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const PORT = 8298;
let pass = 0, fail = 0;
const check = (name, ok, info = '') => {
  if (ok) { pass++; console.log(`  ✓ ${name}${info ? '  ' + info : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${info ? '  ' + info : ''}`); }
  return ok;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- mock LLM（固定回答，避免依赖真实模型） ----------
function startMockLLM() {
  const server = http.createServer((req, res) => {
    let b = '';
    req.on('data', (d) => { b += d; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const chunk = (delta, finish) => JSON.stringify({
        id: 'x', object: 'chat.completion.chunk', created: 0, model: 'mock',
        choices: [{ index: 0, delta, finish_reason: finish || null }],
      });
      res.write(`data: ${chunk({ role: 'assistant' })}\n\n`);
      res.write(`data: ${chunk({ content: '这是模拟回答。' })}\n\n`);
      res.write(`data: ${chunk({}, 'stop')}\n\n`);
      res.write(`data: ${JSON.stringify({
        id: 'x', object: 'chat.completion.chunk', created: 0, model: 'mock', choices: [],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, port: server.address().port })));
}

async function startServer(mockPort) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceai-wake-'));
  const env = {
    ...process.env,
    PORT: String(PORT),
    LLM_BASE_URL: `http://127.0.0.1:${mockPort}`,
    LLM_MODEL: 'mock',
    VOICEAI_NO_WORKER: '1',
    VOICEAI_ASR_SIM: '1',
    VOICEAI_LOG_FILE: '0',
    VOICEAI_KV_WARM: '0',
    VOICEAI_DATA_DIR: dataDir,
    VOICEAI_CAPTURE: 'browser',
  };
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env, cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  const t0 = Date.now();
  while (!out.includes('VoiceAI server running')) {
    if (Date.now() - t0 > 20000) throw new Error('服务启动超时:\n' + out);
    await sleep(100);
  }
  return { child, log: () => out, dataDir };
}

/** 注入一条 ASR 结果，收集随后 2.5s 内的事件 */
function injectAndCollect(ws, text, ms = 2500) {
  return new Promise((resolve) => {
    const events = [];
    const onMsg = (d) => events.push(JSON.parse(d.toString()));
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ type: 'asr_sim', text }));
    setTimeout(() => { ws.off('message', onMsg); resolve(events); }, ms);
  });
}

(async () => {
  const mock = await startMockLLM();
  const srv = await startServer(mock.port);
  let ws = null;
  try {
    ws = await new Promise((res, rej) => {
      const w = new WebSocket(`ws://127.0.0.1:${PORT}`);
      w.on('open', () => res(w));
      w.on('error', rej);
    });
    const ackOf = (evs) => evs.filter((e) => e.type === 'llm_done' && (e.fullText || '').includes('在呢')).length;
    const woke = (evs) => evs.some((e) => e.type === 'wake_state' && e.awake === true);
    const verdictOf = (evs) => (evs.find((e) => e.type === 'asr_sim_verdict') || {}).verdict;

    console.log('\n[1] 日志里真实出现过的唤醒词变体（关键回归）');
    for (const text of ['陆露露同学', '米露鲁同学', '呃露露同学', '露露露同学', '露露同学', '潞潞同学']) {
      // 用注入的结束语回到待命（打字输入不经过唤醒门控的 sleep 分支）
      await injectAndCollect(ws, '潞潞同学，再见', 1200);
      const evs = await injectAndCollect(ws, text);
      const ok = woke(evs) && ackOf(evs) >= 1;
      check(`"${text}" → 唤醒并应答`, ok,
        `判定=${verdictOf(evs)} 应答次数=${ackOf(evs)} 唤醒=${woke(evs)}`);
    }

    console.log('\n[2] 唤醒词 + 真实指令 → 应直接回答（不播应答）');
    await injectAndCollect(ws, '潞潞同学，再见', 1200);
    let evs = await injectAndCollect(ws, '潞潞同学，介绍一下你自己', 4000);
    const answered = evs.some((e) => e.type === 'llm_done' && (e.fullText || '').includes('模拟回答'));
    check('带指令 → 走回答', answered, `判定=${verdictOf(evs)}`);
    check('带指令 → 不播"在呢"', ackOf(evs) === 0, `应答次数=${ackOf(evs)}`);

    console.log('\n[3] 待命中的普通话 → 忽略（不误唤醒）');
    await injectAndCollect(ws, '潞潞同学，再见', 1200);   // 确保处于待命
    evs = await injectAndCollect(ws, '今天天气不错');
    check('待命中 → 忽略', !woke(evs) && ackOf(evs) === 0 && verdictOf(evs) === 'ignored',
      `判定=${verdictOf(evs)}`);

    console.log('\n[4] 已唤醒状态下的普通指令 → 直接回答');
    await injectAndCollect(ws, '潞潞同学', 2000);
    evs = await injectAndCollect(ws, '那杭州有什么好玩的', 4000);
    check('已唤醒 → 直接回答', evs.some((e) => e.type === 'llm_done' && (e.fullText || '').includes('模拟回答')),
      `判定=${verdictOf(evs)}`);

    const log = srv.log();
    check('日志能看到"仅唤醒…播应答"', log.includes('仅唤醒'), '');
  } finally {
    if (ws) { try { ws.close(); } catch (e) { /* 忽略 */ } }
    srv.child.kill();
    try { fs.rmSync(srv.dataDir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
    mock.server.close();
  }
  console.log(`\n通过: ${pass}  失败: ${fail}`);
  process.exit(fail ? 1 : 0);
})();
