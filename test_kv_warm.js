// test_kv_warm.js — KV 缓存保温算法的独立验证（不依赖真实 LLM）
//
// 算法：空闲达阈值时，把"当前线上序列"原样再发一次（max_tokens=1，只要 prefill），
//       把服务端可能已被置换掉的 KV 缓存加热回来，让下一次真实提问不必重新 prefill。
//
// 本测试自带一个**模拟 LLM 服务端**，它实现了：
//   - OpenAI 兼容的流式响应（含 usage.prompt_tokens_details.cached_tokens）
//   - 前缀缓存 + 空闲置换（超过 MOCK_TTL_MS 没有请求就当作缓存被置换）
//   - 每次请求记录：是否保温请求(max_tokens=1)、提示词长度、与缓存的重合前缀长度、消息数组
// 然后起一个**隔离的服务实例**（独立端口/数据目录，不拉 Python worker）跑两个阶段：
//   A. 保温开（空闲 2s 即加热）   B. 保温关
// 对照指标 = 第二次提问时"与缓存重合的提示词字符数"（= 省掉的 prefill）。
//
// 跑法：node test_kv_warm.js

'use strict';
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const MOCK_TTL_MS = 5000;        // 模拟服务端的缓存置换空闲时间
const WARM_IDLE_MS = 2000;       // 被测服务的保温空闲阈值
const IDLE_BEFORE_Q2_MS = 9000;  // 阶段内两次提问之间的空闲（> TTL 且 > 保温阈值）
const SERVER_PORT = 8299;

let pass = 0, fail = 0;
const check = (name, ok, info = '') => {
  if (ok) { pass++; console.log(`  ✓ ${name}${info ? '  ' + info : ''}`); }
  else { fail++; console.log(`  ✗ ${name}${info ? '  ' + info : ''}`); }
  return ok;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 模拟 LLM ----------
function startMockLLM() {
  const log = [];
  let cache = null;              // { text, at }
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      let payload = null;
      try { payload = JSON.parse(body); } catch (e) { /* 非 JSON 忽略 */ }
      const now = Date.now();
      const msgs = (payload && payload.messages) || [];
      const promptText = msgs.map((m) => JSON.stringify(m)).join('|');
      // 前缀缓存模拟：TTL 内视为命中，超时视为已被服务端置换
      const alive = !!cache && (now - cache.at) <= MOCK_TTL_MS;
      let common = 0;
      if (alive) {
        const a = cache.text, b = promptText;
        const n = Math.min(a.length, b.length);
        while (common < n && a[common] === b[common]) common++;
      }
      const isWarm = payload != null && payload.max_tokens === 1;
      log.push({
        at: now, warm: isWarm, maxTokens: payload ? payload.max_tokens : null,
        nMessages: msgs.length, promptChars: promptText.length,
        commonChars: common, cacheAlive: alive,
        thinkingOff: !!(payload && payload.chat_template_kwargs && payload.chat_template_kwargs.enable_thinking === false),
        messages: msgs,
      });
      cache = { text: promptText, at: now };

      const maxTokens = payload && Number.isFinite(payload.max_tokens) ? payload.max_tokens : 64;
      const content = isWarm ? '嗯' : '好的，我明白了。这是模拟回答。';
      const cachedTokens = Math.round(common / 4);
      const promptTokens = Math.round(promptText.length / 4);
      const outTokens = Math.min(isWarm ? 1 : 12, maxTokens);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const chunk = (delta, finish) => JSON.stringify({
        id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: Math.floor(now / 1000),
        model: (payload && payload.model) || 'mock',
        choices: [{ index: 0, delta, finish_reason: finish || null }],
      });
      res.write(`data: ${chunk({ role: 'assistant' })}\n\n`);
      res.write(`data: ${chunk({ content })}\n\n`);
      res.write(`data: ${chunk({}, 'stop')}\n\n`);
      res.write(`data: ${JSON.stringify({
        id: 'chatcmpl-mock', object: 'chat.completion.chunk', created: Math.floor(now / 1000),
        model: (payload && payload.model) || 'mock', choices: [],
        usage: {
          prompt_tokens: promptTokens, completion_tokens: outTokens,
          total_tokens: promptTokens + outTokens,
          prompt_tokens_details: { cached_tokens: cachedTokens },
        },
      })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, log }));
  });
}

// ---------- 隔离的服务实例 ----------
async function startServer({ mockPort, warm }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voiceai-kv-'));
  const env = {
    ...process.env,
    PORT: String(SERVER_PORT),
    LLM_BASE_URL: `http://127.0.0.1:${mockPort}`,
    LLM_MODEL: 'mock-model',
    VOICEAI_NO_WORKER: '1',
    VOICEAI_DATA_DIR: dataDir,
    VOICEAI_CAPTURE: 'browser',
    VOICEAI_KV_WARM: warm ? '1' : '0',
    VOICEAI_KV_WARM_IDLE_MS: String(WARM_IDLE_MS),
    VOICEAI_KV_WARM_TICK_MS: '500',
    VOICEAI_LOG_FILE: '0',          // 别把测试请求写进项目日志
    VOICEAI_LLM_IDLE_MS: '20000',
    VOICEAI_LLM_FIRST_MS: '20000',
  };
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js'), '--capture=browser'], {
    env, cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  let exited = false;
  child.stdout.on('data', (d) => { out += d.toString(); });
  child.stderr.on('data', (d) => { out += d.toString(); });
  child.on('exit', () => { exited = true; });
  const t0 = Date.now();
  while (!out.includes('VoiceAI server running')) {
    if (exited) throw new Error('服务进程提前退出:\n' + out);
    if (Date.now() - t0 > 20000) throw new Error('服务启动超时:\n' + out);
    await sleep(100);
  }
  return { child, getLog: () => out, dataDir, waitExit: () => new Promise((r) => child.on('exit', r)) };
}

function openWs(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    ws.on('open', () => resolve(ws));
    ws.on('error', reject);
  });
}

function askOnce(ws, text, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.off('message', onMsg); reject(new Error('等 llm_done 超时: ' + text)); }, timeoutMs);
    const onMsg = (d) => {
      const m = JSON.parse(d.toString());
      if (m.type === 'llm_done') { clearTimeout(timer); ws.off('message', onMsg); resolve(m); }
      if (m.type === 'error') { clearTimeout(timer); ws.off('message', onMsg); reject(new Error(m.error)); }
    };
    ws.on('message', onMsg);
    ws.send(JSON.stringify({ type: 'text', text }));
  });
}

async function runPhase({ label, warm, mockPort, mockLog }) {
  console.log(`\n===== 阶段 ${label}（保温${warm ? '开' : '关'}）=====`);
  const srv = await startServer({ mockPort, warm });
  const startIdx = mockLog.length;
  let ws = null;
  try {
    ws = await openWs(SERVER_PORT);
    ws.send(JSON.stringify({ type: 'clear_history' }));
    await sleep(300);

    console.log('  Q1: 先聊一句');
    await askOnce(ws, '你好');

    // 生成刚结束，绝不能立刻加热（不能和真实生成抢）
    await sleep(1000);
    const warmsRightAfter = mockLog.slice(startIdx).filter((r) => r.warm).length;
    check('真实生成结束后 1s 内不加热（不抢资源）', warmsRightAfter === 0, `加热次数=${warmsRightAfter}`);

    console.log(`  空闲 ${IDLE_BEFORE_Q2_MS / 1000}s（模拟用户走开一会儿）…`);
    await sleep(IDLE_BEFORE_Q2_MS);
    const warmsBeforeQ2 = mockLog.slice(startIdx).filter((r) => r.warm).length;

    console.log('  Q2: 回来后立刻再问一句');
    await askOnce(ws, '接着说');

    const recs = mockLog.slice(startIdx);
    const q2 = recs[recs.length - 1];
    const warms = recs.filter((r) => r.warm);
    const lastWarm = warms[warms.length - 1];

    if (warm) check('空闲期间发生了保温请求', warmsBeforeQ2 > 0, `保温请求 ${warmsBeforeQ2} 次`);
    else check('保温关闭时空闲期间不发任何请求', warmsBeforeQ2 === 0, `请求 ${warmsBeforeQ2} 次`);
    if (warms.length) {
      check('保温请求 max_tokens=1（只要 prefill）', warms.every((r) => r.maxTokens === 1),
        `取值 ${[...new Set(warms.map((r) => r.maxTokens))].join(',')}`);
      check('保温请求也关闭思维链（须与真实请求一致）', warms.every((r) => r.thinkingOff), '');
      check('多次保温内容零漂移（长度一致）',
        new Set(warms.map((r) => r.promptChars)).size === 1,
        `长度集合 ${[...new Set(warms.map((r) => r.promptChars))].join(',')}`);
      // 决定性前提：保温内容必须是下一次真实请求的**逐字节前缀**
      const samePrefix = lastWarm.messages.every((m, i) => JSON.stringify(m) === JSON.stringify(q2.messages[i]));
      check('保温请求的消息是 Q2 请求的逐字节前缀', samePrefix,
        `保温 ${lastWarm.nMessages} 条 → Q2 ${q2.nMessages} 条`);
    }
    check('Q1 请求带有完整提示词', recs[0].promptChars > 100, `${recs[0].promptChars} 字符`);

    const log = srv.getLog();
    const doneLines = log.split('\n').filter((l) => l.includes('[LLM] done'));
    const warmLines = log.split('\n').filter((l) => l.includes('[KV] 缓存已加热'));
    check('服务端日志记录了缓存命中数', doneLines.some((l) => l.includes('缓存命中')),
      (doneLines[doneLines.length - 1] || '(无)').trim());
    if (warm) check('服务端日志记录了保温动作', warmLines.length > 0, (warmLines[0] || '').trim());

    return {
      q2Common: q2.commonChars,
      q2Prompt: q2.promptChars,
      warms: warms.length,
      cachedTokens: q2.commonChars / 4,
    };
  } finally {
    if (ws) { try { ws.close(); } catch (e) { /* 忽略 */ } }
    srv.child.kill();
    await srv.waitExit().catch(() => {});
    try { fs.rmSync(srv.dataDir, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
    await sleep(600);   // 等端口释放
  }
}

(async () => {
  console.log(`节点: ${process.version}`);
  const mock = await startMockLLM();
  try {
    const a = await runPhase({ label: 'A', warm: true, mockPort: mock.port, mockLog: mock.log });
    const b = await runPhase({ label: 'B', warm: false, mockPort: mock.port, mockLog: mock.log });

    console.log('\n===== A/B 对照（第二次提问时省掉的 prefill）=====');
    console.log('            提示词字符   与缓存重合    重合率');
    console.log(`  保温开   ${String(a.q2Prompt).padStart(9)}  ${String(a.q2Common).padStart(9)}   ${(a.q2Common / a.q2Prompt * 100).toFixed(1)}%`);
    console.log(`  保温关   ${String(b.q2Prompt).padStart(9)}  ${String(b.q2Common).padStart(9)}   ${(b.q2Common / b.q2Prompt * 100).toFixed(1)}%`);

    console.log('\n[结论校验]');
    check('保温开：Q2 几乎全量命中缓存', a.q2Common / a.q2Prompt > 0.9,
      `${(a.q2Common / a.q2Prompt * 100).toFixed(1)}%`);
    check('保温关：缓存被置换后近乎全量重算', b.q2Common / b.q2Prompt < 0.5,
      `${(b.q2Common / b.q2Prompt * 100).toFixed(1)}%`);
    check('A 明显优于 B（省下的 prefill）', a.q2Common - b.q2Common > a.q2Prompt * 0.5,
      `+${a.q2Common - b.q2Common} 字符`);
  } finally {
    mock.server.close();
  }
  console.log(`\n通过: ${pass}  失败: ${fail}`);
  process.exit(fail ? 1 : 0);
})();
