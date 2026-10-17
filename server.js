const express = require('express');

// 从 WSL/Git-Bash 启动 Windows node.exe 时 Linux 环境变量不会转发过来（见 STATE.md），
// 所以支持命令行注入配置：--set=KEY=VALUE（可重复），等价于环境变量。
for (const a of process.argv.slice(2)) {
  if (a.startsWith('--set=')) {
    const eq = a.indexOf('=', 6);
    if (eq > 6) process.env[a.slice(6, eq)] = a.slice(eq + 1);
  }
}

const { cfg, CONF_PATH } = require('./config');
const { log } = require('./logger');

const http = require('http');
const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// 采集来源：server（Python sounddevice，默认）| browser（浏览器 getUserMedia + WebRTC AEC）
// 可用 --capture=browser 或环境变量 VOICEAI_CAPTURE 指定
// （注意：从 WSL 启动 Windows node.exe 时 Linux 环境变量不会自动转发，用 CLI 参数最稳）
const ARG_CAPTURE = (process.argv.find((a) => a.startsWith('--capture=')) || '').split('=')[1];
const CAPTURE_MODE = (ARG_CAPTURE || cfg.capture || 'server').toLowerCase();
const AUDIO_FRAME_MAX_PENDING = cfg.worker.audioMaxPending;
let audioPending = 0;   // 已入队/在飞音频帧数，超限丢弃以保持低延迟
let statRecv = 0, statDrop = 0, statAck = 0, statWin = Date.now();

function sendAudioFrame(buf) {
  if (CAPTURE_MODE !== 'browser') return;
  if (!worker || !worker.stdin || !worker.stdin.writable) return;
  statRecv++;
  if (audioPending >= AUDIO_FRAME_MAX_PENDING) { statDrop++; return; }   // 背压：丢帧保实时
  audioPending++;
  // 音频帧直写 worker stdin，不走 workerBusy 闩锁：
  // 闩锁一次只放行一条命令且要等回执，合成繁忙时往返 >80ms，音频会追不上而被丢
  // （worker 的 stdin 读取线程直接处理音频帧，与命令队列无关，顺序无所谓）
  try {
    worker.stdin.write(JSON.stringify({ cmd: 'audio', pcm: buf.toString('base64') }) + '\n');
  } catch (e) {
    audioPending = Math.max(0, audioPending - 1);
    statDrop++;
  }
}

// 音频链路统计（每 5 秒有活动就报一次，便于定位"丢帧/卡顿"）
setInterval(() => {
  if (statRecv || statDrop || statAck) {
    log.info(`[audio] 收=${statRecv} 丢弃=${statDrop} ack=${statAck} 在飞=${audioPending}`);
    statRecv = statDrop = statAck = 0; statWin = Date.now();
  }
}, 5000);

const PORT = cfg.port;
const LLM_BASE_URL = cfg.llm.baseUrl;
const LLM_MODEL = cfg.llm.model;

function toWinPath(p) {
  const m = p.match(/^\/mnt\/([a-z])\/(.*)$/i);
  return m ? `${m[1].toUpperCase()}:/${m[2]}` : p;
}
function resolvePython() {
  const base = path.join(__dirname, 'venv', 'Scripts', 'python.exe');
  for (const c of [base, toWinPath(base)]) {
    try { if (fs.existsSync(c)) return c; } catch (e) {}
  }
  return base;
}
const PYTHON_PATH = cfg.worker.python || resolvePython();
const WORKER_PATH = toWinPath(path.join(__dirname, 'worker.py'));

let currentBackend = String(cfg.tts.backend || 'piper').toLowerCase();
// 当前生效的音色：kokoro 用 kokoroVoiceName，其它用 voice
let currentVoice = currentBackend === 'kokoro'
  ? (cfg.tts.kokoroVoiceName || 'zf_001')
  : cfg.tts.voice;

function persistVoice(backend, voice) {
  // 写回 conf.json：worker 侧 conf() 读的是启动时的快照，重启后才会从文件生效
  try {
    const c = JSON.parse(fs.readFileSync(CONF_PATH, 'utf8'));
    c.tts = c.tts || {};
    c.tts.backend = backend;
    if (backend === 'kokoro') c.tts.kokoroVoiceName = voice; else c.tts.voice = voice;
    fs.writeFileSync(CONF_PATH, JSON.stringify(c, null, 2), 'utf8');
    log.info(`[TTS] 音色已持久化：${backend} / ${voice}`);
  } catch (e) {
    log.warn('[TTS] 音色持久化失败', e.message);
  }
}
let playbackUntil = 0;
let speakingUntil = 0;   // 由音频真实时长推算的"正在出声"窗口（不依赖浏览器心跳）
let playbackState = false;   // 已下发给 worker 的播放状态，用于去重
let playbackOffTimer = null; // OFF 防抖：合成稍慢导致的播放空档不该立刻清采集队列

const STOP_WORDS = ['别说了', '别说', '停止', '停下', '停一下', '闭嘴', '安静', '不用说了', '不要说了', '够了', '退出', '暂停',
  'stop', 'shut up', 'shutup', 'quiet', 'be quiet', 'enough', 'pause', 'quit', 'exit', 'cancel'];
function isStopWord(text) {
  const t = text.toLowerCase().trim();
  return t.length <= 10 && STOP_WORDS.some((w) => t.includes(w));
}
function playbackActiveNow() {
  return Date.now() < Math.max(playbackUntil, speakingUntil);
}

/** 最近是否在出声（含刚结束的余音窗）：只有此时才可能产生声学回声 */
function audioRecentlyActive() {
  return Date.now() < Math.max(playbackUntil, speakingUntil) + ECHO_TAIL_MS * 1.5;
}

/** 疑似自问自答：识别文本与我们上一轮回答的重合度（宽松阈值，用于熔断而非丢弃） */
function echoSimilarity(text) {
  if (!lastAssistantText || !text) return 0;
  const a = normalize(text);
  const b = normalize(lastAssistantText);
  if (!a || !b) return 0;
  return longestCommonSubstring(a, b) / Math.min(a.length, b.length);
}

/** 熔断：停止聆听，避免无限自答 */
function tripLoopBreaker(reason) {
  if (loopBroken) return;
  loopBroken = true;
  log.warn('[LoopBreaker] 触发:', reason, '— 停止聆听以免自问自答');
  interrupt();
  sendToWorker({ cmd: 'stop_listen' });
  broadcast({ type: 'notice', text: '检测到回声自问自答，已暂停聆听（再点一下麦克风即可继续）' });
  broadcast({ type: 'vad_state', state: 'off' });
  setTimeout(() => { loopBroken = false; suspiciousTurns = 0; }, 5000);
}

app.use(express.static(path.join(__dirname, 'public')));
app.use('/temp', express.static(path.join(__dirname, 'temp')));

// ========== 音色列表 + 试听样本（web 设置面板用）==========
// Kokoro 音色名从模型目录动态读（zf_/zm_ 中文 + af_/bf_ 英文 ✓）；
// 试听样本是离线预生成的 wav/mp3（temp/voices/ ✓），没有样本的音色也能选，只是听不了。
const KOKORO_VOICES_DIR = path.join(__dirname, 'models', 'kokoro-torch', 'voices');
const VOICE_SAMPLES_DIR = path.join(__dirname, 'temp', 'voices');
const EDGE_VOICES = [
  'zh-CN-XiaoxiaoNeural', 'zh-CN-XiaoyiNeural', 'zh-CN-YunxiNeural', 'zh-CN-YunyangNeural',
  'zh-CN-YunjianNeural', 'zh-CN-XiaohanNeural', 'zh-CN-XiaomoNeural', 'zh-CN-XiaoruiNeural',
  'zh-CN-XiaoxuanNeural', 'zh-CN-liaoning-XiaobeiNeural', 'zh-CN-shaanxi-XiaoniNeural',
  'zh-HK-HiuMaanNeural', 'zh-HK-WanLungNeural', 'zh-TW-HsiaoChenNeural', 'zh-TW-YunJheNeural',
];

function isKokoroVoice(v) { return /^(z[fm]|a[fm]|b[fm])_[a-z0-9]+$/i.test(v); }

app.get('/api/voices', (req, res) => {
  let kokoro = [];
  try {
    kokoro = fs.readdirSync(KOKORO_VOICES_DIR)
      .filter((f) => f.endsWith('.pt'))
      .map((f) => f.replace(/\.pt$/, ''))
      .filter(isKokoroVoice)
      .sort();
  } catch (e) { log.warn('[voices] 读 Kokoro 音色目录失败', e.message); }
  const samples = {};
  const pick = (key, file) => {
    if (fs.existsSync(path.join(VOICE_SAMPLES_DIR, file))) samples[key] = '/temp/voices/' + file;
  };
  for (const v of kokoro) pick('kokoro:' + v, `kokoro_${v}.wav`);
  for (const v of EDGE_VOICES) pick('edge:' + v, `edge_${v}.mp3`);
  const backend = isKokoroVoice(currentVoice) ? 'kokoro' : currentBackend;
  res.json({ kokoro, edge: EDGE_VOICES, samples, current: { voice: currentVoice, backend } });
});

// ========== Python Worker (recording + VAD + ASR + TTS) ==========
let worker = null;
let workerBusy = false;
let workerQueue = [];
let workerHandshake = null;
let workerExpectedExit = false;
let workerGen = 0;

function startWorker() {
  const gen = ++workerGen;
  const proc = spawn(PYTHON_PATH, [WORKER_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });
  worker = proc;

  // 子进程刚死时写入 stdin 会异步抛 EPIPE。没有 error 监听 = 未捕获异常 = 整个服务崩掉，
  // 语音助手静默死亡。这里必须兜住（崩溃/自愈交给 close 事件处理）。
  proc.stdin.on('error', (e) => {
    if (gen !== workerGen) return;
    log.error('[Worker] stdin 错误:', e.code || e.message, '（worker 可能已退出，等待自愈）');
  });

  let stderrBuf = '';
  proc.stderr.on('data', (d) => {
    stderrBuf += d.toString();
    const lines = stderrBuf.split('\n');
    stderrBuf = lines.pop();
    lines.forEach(l => log.info('[Worker]', l));
  });

  proc.stdout.on('data', (data) => {
    if (gen !== workerGen) return;   // 旧进程的迟到数据，忽略
    lastWorkerOutput = Date.now();
    const lines = data.toString().split('\n').filter(l => l.trim());
    for (const line of lines) {
      try {
        const result = JSON.parse(line);
        let suppressBroadcast = false;
        if (result.type === 'error') {
          log.error('[Worker Error]', result.error);
          broadcast({ type: 'error', error: result.error });
        } else {
          if (result.type === 'pong' && workerHandshake) {
            clearTimeout(workerHandshake);
            workerHandshake = null;
            log.info('[Worker] Handshake OK');
            prewarmPhrases();   // worker 就绪后预生成常用短语音
          }
          if (result.type === 'tts_prewarmed') {
            prewarmPaths[result.text] = result.audio_path;
            log.info(`[TTS] 已预生成「${result.text}」(${result.backend || "?"})`);
          }
          if (result.type === 'playback_start' || result.type === 'playback_end') {
            // 服务端放音（Python 端）：worker 精确知道播报起止，用它维护"正在出声"窗口，
            // 比浏览器心跳可靠（浏览器此时只显示文字，不播放任何音频）
            if (result.type === 'playback_start') {
              const durMs = Math.round((Number(result.duration) || 0) * 1000);
              speakingUntil = Math.max(Date.now(), speakingUntil) + durMs + ECHO_TAIL_MS;
              log.info(`[TTS] 服务端放音开始 #${result.id}（${(Number(result.duration) || 0).toFixed(2)}s）`);
            } else {
              log.info(`[TTS] 服务端放音结束 #${result.id}`);
            }
          }
          if (result.type === 'aec_calibrated') {
            if (result.applied) log.info('[AEC] 已应用标定延迟，后续按下发值工作');
            log.info(`[AEC] 就地标定完成：delay=${result.delay} 样本（${(result.delay / 16).toFixed(0)}ms） `
              + `ERLE=${result.erle}dB  候选=${JSON.stringify(result.top)}`);
          }
          if (result.type === 'tts_audio') {
            log.info(`[TTS] #${result.id} 就绪(${result.backend || '?'}): ${(result.text || '').slice(0, 22)}`);
            // 用音频真实时长推算播报窗口：即使浏览器心跳丢了，服务端也知道还在出声。
            // 但打断后仍在飞的旧段不会被播放，绝不能再用它延长窗口。
            const live = ttsBuffers.has(result.id) || result.id === currentTtsId;
            if (live) {
              const durMs = Math.round((Number(result.duration) || 0) * 1000);
              speakingUntil = Math.max(Date.now(), speakingUntil) + durMs + ECHO_TAIL_MS;
            }
            const buf = ttsBuffers.get(result.id);
            if (buf) { buf.inflight = Math.max(0, buf.inflight - 1); pumpTts(result.id); }
          }
          if (result.type === 'asr_result') {
            log.info(`[ASR] playing=${playbackActiveNow()} llm=${!!activeLLM} rms=${result.rms ?? '?'} dur=${result.duration ?? '?'} asr=${result.asr_ms ?? '?'}ms`, JSON.stringify(result.text));
            if (result.text) {
              emptyAsrStreak = 0;
              const verdict = handleUserText(result.text, true);
              // 回声/播报期杂音/熔断 不回显，否则用户会看到自己的回声上屏
              if (verdict !== 'accepted' && verdict !== 'stop') suppressBroadcast = true;
            } else if (result.duration >= 0.4) {
              // 有声音但识别不出内容：麦克风增益过低 / 被降噪&回声消除压掉 / 设备异常
              emptyAsrStreak++;
              const lvl = Number(result.rms) || 0;
              log.info(`[ASR] 空结果 streak=${emptyAsrStreak} rms=${lvl} gain=${result.gain ?? 1}`);
              if (emptyAsrStreak === 3) {
                broadcast({
                  type: 'notice',
                  text: lvl < 0.05
                    ? `麦克风信号很弱（电平 ${lvl.toFixed(3)}，正常说话应 >0.1）：请靠近麦克风说话，或在 ⚙️ 设置里关掉"降噪/自动增益"（保留回声消除），或把麦克风来源切换为"服务器麦克风"`
                    : '麦克风有声音但识别不出内容：试试设置里关掉"降噪"，或改用服务器麦克风',
                });
              }
            }
          }
          if (result.type === 'vad_state') log.info('[VAD]', result.state);
          if (result.type === 'ack' && result.cmd === 'audio') {
            statAck++;
            audioPending = Math.max(0, audioPending - 1);
          }
          if (result.type !== 'ack' && !suppressBroadcast) broadcast(result);   // 回执只用于释放闩锁；被丢弃的识别结果不回显
        }
      } catch (e) {}
    }
    workerBusy = false;
    processWorkerQueue();
  });

  proc.on('error', (e) => {
    if (gen !== workerGen) return;
    log.error('[Worker] SPAWN FAILED:', e.message, '| path:', PYTHON_PATH);
    broadcast({ type: 'error', error: 'worker spawn failed: ' + e.message });
  });

  proc.on('close', (code) => {
    if (gen !== workerGen) return;   // 已被新 worker 取代，不要污染当前状态
    log.info(`[Worker] Exited: ${code}`);
    worker = null;
    workerBusy = false;
    workerQueue = [];
    audioPending = 0;        // 在飞的音频帧不会再有回执，不复位就会永久丢帧（麦克风"失灵"）
    ttsBuffers.clear();
    currentTtsId = null;
    if (!workerExpectedExit) setTimeout(() => { if (!worker) startWorker(); }, 1000);
  });

  // 启动握手：worker 哑掉/挂掉要吵闹地暴露出来，而不是静默失效
  setTimeout(() => {
    if (gen === workerGen && worker) sendToWorker({ cmd: 'ping' });
  }, 1500);
  workerHandshake = setTimeout(() => {
    if (gen !== workerGen) return;
    log.error('[Worker] HANDSHAKE FAILED: no pong from worker (platform=' + process.platform + ', py=' + PYTHON_PATH + ')');
    broadcast({ type: 'notice', text: '语音引擎未就绪，正在重启…' });
  }, 15000);
}

function processWorkerQueue() {
  if (workerBusy || workerQueue.length === 0) return;
  if (!worker || !worker.stdin || !worker.stdin.writable) return;   // 无 worker：留队列，等自愈后重放
  workerBusy = true;
  const msg = workerQueue.shift();
  try {
    worker.stdin.write(JSON.stringify(msg) + '\n');
  } catch (e) {
    // 写入失败（管道已断）：不要把闩锁卡死，交给 close 自愈
    log.error('[Worker] 写入失败:', e.code || e.message);
    workerBusy = false;
  }
}

function sendToWorker(msg) {
  workerQueue.push(msg);
  processWorkerQueue();
}

// ========== Worker 自愈 ==========
// worker 主循环可能被阻塞（例如 edge-tts 网络挂起）。有活干却长时间
// 毫无输出 → 判定卡死，直接重启，避免语音功能静默失效。
let lastWorkerOutput = Date.now();
const WORKER_STALL_MS = cfg.worker.stallMs;

function ttsPending() {
  let n = 0;
  for (const buf of ttsBuffers.values()) n += buf.inflight;
  return n;
}

function restartWorker(reason) {
  log.error('[Worker] RESTART:', reason);
  broadcast({ type: 'notice', text: '语音引擎无响应，正在重启…' });
  workerExpectedExit = true;
  try { if (worker) worker.kill(); } catch (e) {}
  worker = null;
  workerBusy = false;
  workerQueue = [];
  audioPending = 0;
  workerHandshake = null;
  ttsBuffers.clear();
  currentTtsId = null;
  playbackUntil = 0;
  setTimeout(() => { workerExpectedExit = false; startWorker(); }, 500);
}

setInterval(() => {
  if (!worker) return;
  const silent = Date.now() - lastWorkerOutput;
  const pending = workerQueue.length > 0 || ttsPending() > 0;
  if (pending && silent > WORKER_STALL_MS) {
    restartWorker(`no worker output for ${Math.round(silent / 1000)}s with pending work`);
  }
}, 5000);

// ========== LLM Client (pi-ai 适配层) ==========
const { createPiClient } = require('./agent/pi-client');
const { TtsChunker } = require('./tts-chunker');
const { getSystemPrompt } = require('./prompt');
const { createEchoGuard, normalize, longestCommonSubstring } = require('./echo-guard');
const { createWakeGate, isSleepPhrase } = require('./wake');
const { getToolDefs, executeTool } = require('./tools');
const reminders = require('./tools/reminders');

// 提醒意图的确定性兜底：模型有时只回"好的，20 秒后提醒你"却不调工具 → 提醒根本不存在。
// 有副作用的动作不能依赖模型自觉，这里直接创建。
const REMINDER_INTENT_RE = /(提醒我|提醒一下|叫我|叫醒我|喊我|别忘了提醒|设(?:个|一个)?提醒|设(?:个|一个)?闹钟|定(?:个|一个)?闹钟)/;
const REMINDER_WHEN_RE = /(\d+\s*(?:秒|分钟|分|小时|钟头|天|周|个月)\s*(?:后|之后|以后)|(?:今天|明天|后天)?\s*(?:早上|上午|中午|下午|晚上|凌晨)?\s*(?:\d{1,2}|[一二两三四五六七八九十]{1,3})\s*[点:：时]\s*(?:\d{0,2}|半)?\s*分?)/;

function tryReminderFallback(text) {
  if (!REMINDER_INTENT_RE.test(text)) return null;
  const whenMatch = text.match(REMINDER_WHEN_RE);
  if (!whenMatch) return null;
  const when = whenMatch[0].trim();
  // 提醒内容 = 去掉时间说法与提醒触发词后剩下的部分
  let content = text.replace(whenMatch[0], '')
    .replace(REMINDER_INTENT_RE, '')
    .replace(/^(要|去|来|帮我|麻烦|请|记得|一会儿|等下)+/g, '')
    .replace(/[，,。.!！?？]+$/g, '')
    .trim();
  if (!content) return null;
  const r = reminders.addReminder({ text: content, when });
  if (r.error) return null;
  log.info(`[Reminder] 兜底创建: ${r.text} @ ${r.at}`);
  return r;
}
const TOOL_MAX_ROUNDS = cfg.llm.toolMaxRounds;

// 唤醒词门控：默认需要说"潞潞同学"才进入会话，空闲超时自动回到待命
const WAKE_REQUIRED = cfg.wake.enabled;
const IDLE_TIMEOUT_MS = cfg.wake.idleMs;
const WAKE_ACK = cfg.wake.ack;
const wakeGate = createWakeGate({
  idleMs: IDLE_TIMEOUT_MS,
  required: WAKE_REQUIRED,
  minChars: cfg.wake.minChars,
});
// 预生成的短语音（唤醒应答等）：text → 已合成好的音频路径
const prewarmPaths = Object.create(null);

// 空闲超时 → 回到待命
setInterval(() => {
  if (wakeGate.shouldSleep()) {
    wakeGate.sleep();
    log.info(`[Wake] 空闲 ${Math.round(IDLE_TIMEOUT_MS / 1000)}s，回到待命`);
    broadcast({ type: 'wake_state', awake: false });
  }
}, 2000);

// 内容级回声识别：TTS 被自家麦克风听回去时，靠"我们刚说过什么"来丢弃
const echoGuard = createEchoGuard({
  windowMs: cfg.echo.windowMs,
  minMatch: cfg.echo.minMatch,
});
// 播报结束后的尾巴/混响窗（喇叭余音还在响，此时仍要压制）
const ECHO_TAIL_MS = cfg.echo.tailMs;
// 自问自答熔断：连续多次"用户话"都像我们刚说过的内容 → 停聆听，避免无限自答
const LOOP_BREAKER_HITS = cfg.loopBreaker.hits;
const LOOP_BREAKER_SIMILARITY = cfg.loopBreaker.similarity;
let lastAssistantText = '';
let suspiciousTurns = 0;
let loopBroken = false;
let stopWordStreak = 0;    // 空闲状态连续收到停止词的次数
let lastStopAt = 0;
let emptyAsrStreak = 0;    // 连续"有声音但识别为空"的次数（麦克风/降噪异常）
// 播报中听到真人说话（非回声）是否直接打断并处理（VOICEAI_BARGE_IN=0 可关闭，回到"只认停止词"）
const BARGE_IN = cfg.bargeIn.enabled;
// 播报中打断所需的最短字数：环境里的短碎片（"是不是""接电话"）不该打断
const BARGE_IN_MIN_CHARS = cfg.bargeIn.minChars;
// 放音方式：server = Python 端放音（配合 AEC），browser = 浏览器播放
const SERVER_PLAYBACK = String(cfg.tts.playback || 'server').toLowerCase() === 'server';

let piClientPromise = null;
function getLLM() {
  if (!piClientPromise) {
    piClientPromise = createPiClient({
      baseUrl: LLM_BASE_URL,
      modelId: LLM_MODEL,
      apiKey: cfg.llm.apiKey,
      maxTokens: cfg.llm.maxTokens,
      disableThinking: !cfg.llm.thinking,
      contextWindow: cfg.llm.contextWindow,
      firstEventTimeoutMs: cfg.llm.firstEventTimeoutMs,
      idleTimeoutMs: cfg.llm.idleTimeoutMs,
    })
      .catch((e) => { piClientPromise = null; throw e; });
    log.info(`[LLM] pi-client → ${LLM_BASE_URL} (model=${LLM_MODEL})`);
  }
  return piClientPromise;
}

// ========== TTS pipeline (有界前瞻 + 背压) ==========
// LLM 可达 50+ tok/s，远快于播放速度；若不限流，worker 会把整篇合成为音频，
// 既浪费 CPU 又让打断变慢。这里只允许提前合成 TTS_LOOKAHEAD 句，
// 其余句留在 server 侧队列，等 tts_audio 返回后再放下一句。
const TTS_LOOKAHEAD = cfg.tts.lookahead;
const ttsBuffers = new Map();   // replyId -> { queue:[], inflight:0, voice, done }
let currentTtsId = null;

function enqueueSpeech(id, text) {
  if (!text) return;
  if (id !== currentTtsId) { currentTtsId = id; ttsBuffers.clear(); }  // 新一轮回复丢弃旧的
  let buf = ttsBuffers.get(id);
  if (!buf) { buf = { queue: [], inflight: 0, voice: currentVoice, done: false }; ttsBuffers.set(id, buf); }
  buf.queue.push(text);
  pumpTts(id);
}

function pumpTts(id) {
  const buf = ttsBuffers.get(id);
  if (!buf) return;
  while (buf.inflight < TTS_LOOKAHEAD && buf.queue.length) {
    const t = buf.queue.shift();
    buf.inflight++;
    echoGuard.remember(t);   // 记住播报内容，供回声识别比对
    log.info(`[TTS] #${id} 合成: ${t.slice(0, 22)}`);
    sendToWorker({ cmd: 'tts', text: t, voice: buf.voice, id });
  }
  if (buf.done && buf.inflight === 0 && buf.queue.length === 0) {
    ttsBuffers.delete(id);
    if (currentTtsId === id) currentTtsId = null;
  }
}

function finishSpeech(id) {
  const buf = ttsBuffers.get(id);
  if (buf) { buf.done = true; pumpTts(id); }
}

// 清理过期的 TTS 临时 mp3
function sweepTempFiles(maxAgeMs = 15 * 60 * 1000) {
  const dir = path.join(__dirname, 'temp');
  fs.readdir(dir, (err, files) => {
    if (err) return;
    const now = Date.now();
    for (const f of files) {
      if (!f.endsWith('.mp3') && !f.endsWith('.wav')) continue;
      const p = path.join(dir, f);
      fs.stat(p, (e, st) => {
        if (!e && now - st.mtimeMs > maxAgeMs) fs.unlink(p, () => {});
      });
    }
  });
}
setInterval(sweepTempFiles, 5 * 60 * 1000);

// ========== 会话管理（多轮上下文 + 超长压缩 + 落盘） ==========
const DATA_DIR = cfg.dataDir || path.join(__dirname, 'data');
const HISTORY_FILE = path.join(DATA_DIR, 'conversation.json');
const CTX_LIMIT = cfg.llm.contextWindow;      // 模型上下文窗口
const CTX_COMPRESS_AT = cfg.history.compressAt; // 超过即压缩
const CTX_KEEP_RECENT = cfg.history.keepRecent;     // 压缩时保留最近若干条
const HISTORY_MAX_MESSAGES = cfg.history.maxMessages;

let history = [];   // [{ role: 'user'|'assistant', content }] —— 显示/逻辑历史（原文，不含注入）
let summary = '';   // 早期对话的压缩摘要

// ========== 线上序列（wire）==========
// KV 前缀缓存按 token 前缀命中，所以"实际发给模型的消息序列"必须**只追加、逐字节稳定**。
// 显示历史 history 存的是用户原文，但发出去时最后一条会拼上动态上下文（时间戳等）；
// 若下一轮直接用 history 重建请求，那条消息少了注入前缀 → 从第一条 user 消息就分叉，
// 缓存只剩 system 那一段。工具轮同理（finalMessage/toolResult 只进当次请求）。
// 因此线上序列单独维护：每次真正发出去的那串 + 模型回答，逐轮追加。
let wireMessages = [];

function resetWire() {
  wireMessages = history.map((m) => ({ role: m.role, content: m.content }));
}

/** 粗略 token 估算：中日韩字符≈1 token/字，其余≈1 token/3.5 字符 */
function estimateTokens(text) {
  if (!text) return 0;
  let cjk = 0;
  for (const ch of text) if (/[\u3400-\u9FFF\uF900-\uFAFF\u3040-\u30FF]/.test(ch)) cjk++;
  const rest = text.length - cjk;
  return Math.ceil(cjk + rest / 3.5);
}

function historyTokens() {
  let n = estimateTokens(summary) + 200;   // 摘要 + 系统提示词余量
  for (const m of history) n += estimateTokens(m.content) + 4;
  return n;
}

/** 线上序列的 token 估算（真正发给模型的量：含注入、含工具往返） */
function wireTokens() {
  let n = estimateTokens(summary) + 200;
  for (const m of wireMessages) {
    const c = m.content;
    n += estimateTokens(typeof c === 'string' ? c : JSON.stringify(c)) + 4;
  }
  return n;
}

/** 日志用：tokens 与 **KV 缓存命中**（服务端在 usage.cacheRead 里回传，命中越高说明前缀复用越好） */
function usageLine(u) {
  if (!u) return '';
  const fresh = u.input || 0, cached = u.cacheRead || 0;
  const total = fresh + cached;
  const pct = total > 0 ? Math.round((cached / total) * 100) : 0;
  return `(新 ${fresh}tok / 出 ${u.output || 0}tok，缓存命中 ${cached}/${total} ≈${pct}%)`;
}

/** 审计：把"真正发出去的请求体"（pi 的 onPayload 捕获）+ 结果落到文件
 *  （VOICEAI_LLM_DUMP=/path/to/x.jsonl）——用于核对 KV 前缀、max_tokens、缓存命中 */
const LLM_DUMP = cfg.llm.dump || '';
function dumpLLMRequest(meta, result) {
  if (!LLM_DUMP) return;
  try {
    fs.appendFileSync(LLM_DUMP, JSON.stringify({
      at: Date.now(),
      ...(meta || {}),
      stopReason: (result && result.stopReason) || null,
      usage: (result && result.usage) || null,
      text: ((result && result.text) || '').slice(0, 120),
      payload: (result && result.payload) || null,
    }) + '\n');
  } catch (e) { /* 审计失败不影响主流程 */ }
}

function saveHistory() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFile(HISTORY_FILE, JSON.stringify({ summary, history, updatedAt: Date.now() }), () => {});
  } catch (e) { log.error('[History] save failed:', e.message); }
}

function loadHistory() {
  try {
    const raw = fs.readFileSync(HISTORY_FILE, 'utf8');
    const data = JSON.parse(raw);
    if (Array.isArray(data.history)) history = data.history.filter(m => m && m.role && typeof m.content === 'string');
    if (typeof data.summary === 'string') summary = data.summary;
    resetWire();   // 重启后线上序列从显示历史重建（这一次会丢缓存，之后逐轮追加）
    log.info(`[History] loaded ${history.length} messages, summary ${summary.length} chars, ~${historyTokens()} tokens`);
  } catch (e) { /* 首次运行无文件 */ }
}

function pushMessage(msg) {
  history.push(msg);
  if (history.length > HISTORY_MAX_MESSAGES) history.splice(0, history.length - HISTORY_MAX_MESSAGES);
  saveHistory();
}

function buildSystemMessage() {
  // 注意：这里必须保持"逐轮稳定"，否则会打掉本地模型的前缀 KV cache。
  // 实测：system 里带时间戳时每轮缓存命中 0（2000 token 提示词 ≈2.4s）；
  //      静态 system 时命中 ~2017/2022（≈0.5s）。所以动态内容一律放最后一条用户消息。
  const base = getSystemPrompt();
  return summary ? `${base}\n\n【历史会话摘要】（你和用户的早期对话已压缩成要点，供参考）\n${summary}` : base;
}

/** 本轮动态上下文（时间/指令）—— 拼到 user 消息里，保住前缀缓存 */
function dynamicContext(text) {
  const now = new Date();
  const stamp = `${now.getFullYear()}年${now.getMonth() + 1}月${now.getDate()}日 ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')} ${['周日', '周一', '周二', '周三', '周四', '周五', '周六'][now.getDay()]}`;
  let s = `【当前时间】${stamp}（服务器本地时区）。回答时间日期时以此为准，不要依赖记忆或历史消息里的旧时间。`;
  const dir = detailDirective(text);
  if (dir) s += `\n${dir.trim()}`;
  return s;
}

// 详细意图 → 本轮强制指令（放在系统消息里对模型最有效；不污染会话历史）
const DETAIL_INTENT_RE = /(详细|展开|具体|讲清楚|说清楚|介绍|解释|为什么|原理|原因|历史|过程|怎么做|步骤|方法|区别|对比|分析|写一篇|多说点|再详细|继续|然后呢|说说)/;
function detailDirective(text) {
  if (!DETAIL_INTENT_RE.test(text || '')) return '';
  return '\n\n【本轮要求·必须遵守】用户要的是详细回答：请输出**至少 300 字**，分成 3~5 个方面，'
    + '先给结论再逐条展开，每方面要有具体内容（数字、例子、原因、影响）。'
    + '不要用两三句话打发，也不要使用 Markdown 符号。';
}

/** 用 LLM 把「已有摘要 + 较老的消息」合并成新摘要 */
async function summarizeInto(oldSummary, msgs) {
  const transcript = msgs.map(m => `${m.role === 'user' ? '用户' : '你'}：${m.content}`).join('\n');
  const client = await getLLM();
  const r = await client.complete({
    systemPrompt: '你是对话摘要器。把对话压缩成简洁的事实要点：保留用户身份、偏好、目标、决定、待办、关键数字与结论。去掉寒暄和重复，不要评价，不要用 Markdown，用短句列点。',
    messages: [{ role: 'user', content: `${oldSummary ? `已有的早期摘要：\n${oldSummary}\n\n` : ''}需要合并的新对话：\n${transcript}\n\n请输出合并后的完整摘要。` }],
  });
  if (r.stopReason !== 'stop' && r.stopReason !== 'length') {
    throw new Error(`summarize ${r.stopReason}: ${r.errorMessage || ''}`);
  }
  return r.text.trim();
}

/** 历史过长时压缩：把较早的消息折叠进摘要，只保留最近若干条 */
async function compressHistoryIfNeeded() {
  // 线上序列（含注入与工具往返）才是真正占上下文的部分，两者都要看
  if (historyTokens() < CTX_COMPRESS_AT && wireTokens() < CTX_COMPRESS_AT) return;
  const keep = Math.max(2, Math.min(CTX_KEEP_RECENT, Math.floor(history.length / 2)));
  if (history.length - keep < 1) return;
  const old = history.slice(0, history.length - keep);
  log.info(`[History] compressing ${old.length} messages (~${historyTokens()} tokens)`);
  try {
    const merged = await summarizeInto(summary, old);
    if (!merged) throw new Error('empty summary');
    summary = merged;
    history = history.slice(history.length - keep);
    resetWire();                 // 前面被折叠了，线上序列必须重建（这一次会重算前缀）
    saveHistory();
    log.info(`[History] compressed → summary ${summary.length} chars, kept ${history.length}, ~${historyTokens()} tokens`);
    broadcast({ type: 'history_summarized', summary });
  } catch (e) {
    // 压缩失败就丢弃最老的一半，至少不让上下文无限增长
    log.error('[History] compress failed:', e.message, '— dropping oldest half');
    history = history.slice(Math.floor(history.length / 2));
    resetWire();
    saveHistory();
  }
}

// ========== LLM Client (streaming, interruptible, sentence-level TTS) ==========
let replySeq = 0;
let activeLLM = null; // { controller, id }

function interrupt() {
  if (activeLLM) activeLLM.controller.abort();
  activeLLM = null;
  ttsBuffers.clear();          // 丢弃未合成的句子
  currentTtsId = null;
  playbackUntil = 0;           // 播放已停：租约与"正在出声"窗口都要清零，
  speakingUntil = 0;           // 否则后续真人说话会被当成"播报中的回声"全部吞掉
  sendToWorker({ cmd: 'clear' });      // 丢弃待合成 + 停掉服务端正在播的音频（worker 侧实现）
  broadcast({ type: 'stop_tts' });
}

/**
 * 处理一条用户输入
 * @returns {'accepted'|'stop'|'echo'|'ignored'|'loop'} 处理结论（供上层决定是否回显）
 */
function handleUserText(text, fromVoice) {
  lastUserActivity = Date.now();     // 会话仍有活动 → 保温窗口有效
  let input = text;
  const stop = isStopWord(input);
  const active = playbackActiveNow() || !!activeLLM;

  // 语音输入先过内容级回声识别：喇叭里的自家人声不该被当成用户说话。
  // 关键：只在"正在出声/刚结束"时才检查——否则用户追问同一话题会被误判成回声丢掉
  if (fromVoice && audioRecentlyActive()) {
    const echo = echoGuard.isEcho(input);
    if (echo.echo) {
      log.info(`[Echo] 丢弃（${echo.reason} lcs=${echo.lcs} age=${echo.ageMs}ms）:`, JSON.stringify(input.slice(0, 30)));
      // 连"停止词"一起丢：否则我们会听自己的话把自己打断
      return 'echo';
    }
    // 熔断：识别文本和我们刚说过的高度重合 → 疑似自问自答
    const sim = echoSimilarity(input);
    if (input.length >= 4 && sim >= LOOP_BREAKER_SIMILARITY) {
      suspiciousTurns++;
      log.info(`[LoopBreaker] 疑似自答 ${suspiciousTurns}/${LOOP_BREAKER_HITS}（相似度 ${sim.toFixed(2)}）:`, JSON.stringify(input.slice(0, 30)));
      if (suspiciousTurns >= LOOP_BREAKER_HITS) {
        suspiciousTurns = 0;
        tripLoopBreaker(`连续 ${LOOP_BREAKER_HITS} 次识别结果与上一轮回答高度重合`);
        return 'loop';
      }
    } else {
      suspiciousTurns = 0;
    }
  }

  // 唤醒词门控：待命时任何人的话都不该触发回复（电视/旁人/回声残留）
  if (fromVoice) {
    const gate = wakeGate.handle(input);
    if (!gate.accept) {
      if (gate.woke) {
        log.info('[Wake] 已唤醒:', JSON.stringify(gate.reason));
        broadcast({ type: 'wake_state', awake: true });
        announce(WAKE_ACK);
        return 'wake';
      }
      // 未唤醒：仍允许播报中说"停止"（否则会出现"停不下来"）
      if (stop && playbackActiveNow()) {
        log.info('[StopWord] interrupt (voice, 待命期播报中)');
        interrupt();
        return 'stop';
      }
      log.info('[Wake] 待命中，忽略:', JSON.stringify(input.slice(0, 24)), `(${gate.reason})`);
      return 'ignored';
    }
    if (gate.woke) {
      log.info(`[Wake] 唤醒并执行指令: ${JSON.stringify(gate.text.slice(0, 24))}`);
      broadcast({ type: 'wake_state', awake: true });
      // 带指令时不播"在呢"：直接处理指令，省掉一次应答（更快听到答案）
    }
    input = gate.text;   // 唤醒词后的指令正文
    if (!input) return 'wake';
    // 明确的结束语 → 立即回到待命
    if (isSleepPhrase(input)) {
      log.info('[Wake] 收到结束语，回到待命:', JSON.stringify(input));
      broadcast({ type: 'user_text', text: input });
      announce('好，我先待命，需要就喊我');
      wakeGate.sleep();
      broadcast({ type: 'wake_state', awake: false });
      return 'sleep';
    }
    // 唤醒词后面只粘了个碎音（实测 ASR 常把"潞潞同学"识别成"陆露露同学""呃露露同学""露露露同学"，
    // 唤醒词前面多粘一个字）→ 这**不是指令**，必须当纯唤醒处理并出声应答；
    // 否则用户喊了、系统醒了、却一声不吭，会以为"没识别到"。
    if (gate.woke && !wakeGate.isLongEnough(input) && !isStopWord(input)) {
      log.info(`[Wake] 仅唤醒（尾音 ${JSON.stringify(input)} 当碎音丢弃）→ 播应答`);
      announce(WAKE_ACK);
      return 'wake';
    }
    // 过短碎片不当指令（环境闲聊常被切成一两个词，实测"是不是""接电话"）
    if (!wakeGate.isLongEnough(input) && !isStopWord(input)) {
      log.info(`[Wake] 过短碎片忽略（<${wakeGate.minChars}字）:`, JSON.stringify(input.slice(0, 20)));
      return 'ignored';
    }
  } else {
    wakeGate.touch();    // 打字输入视为有效活动，刷新空闲计时
  }

  // 停止词永远按"停止指令"处理，绝不进 LLM：
  // 否则没在播报时会变成普通提问（"好呀，不说了"），配合持续识别的回声就是一个死循环
  if (stop) {
    log.info('[StopWord] interrupt', fromVoice ? '(voice)' : '(text)', active ? '' : '(空闲，仅清空队列)');
    if (fromVoice) broadcast({ type: 'user_text', text: input });   // 让用户看到自己被听到的内容
    // 空闲时连续收到停止词 → 麦克风输入异常（例如设备卡在固定音频上）
    const now = Date.now();
    if (active) {
      stopWordStreak = 0;
    } else if (fromVoice) {
      stopWordStreak = (now - lastStopAt < 10000) ? stopWordStreak + 1 : 1;
      lastStopAt = now;
      if (stopWordStreak >= 3) {
        stopWordStreak = 0;
        tripLoopBreaker('连续收到空闲状态的停止指令（麦克风输入疑似异常）');
        return 'loop';
      }
    }
    interrupt();
    return 'stop';
  }
  // 生成中 / 播报中又来了新输入 → 先收掉当前一轮，再按新问题处理。
  // 必须显式 interrupt()：否则两轮 LLM 会并发流式（旧 controller 被覆盖 → 停止词也管不住它），
  // TTS 缓冲会被两个 id 来回清空，界面文字交错。
  if (playbackActiveNow() || activeLLM) {
    const longEnough = input.length >= BARGE_IN_MIN_CHARS;
    if (!fromVoice || (BARGE_IN && longEnough)) {
      log.info('[BargeIn] 打断当前一轮并处理新输入:', JSON.stringify(input.slice(0, 30)));
      interrupt();
    } else {
      log.info('[ASR] ignored during playback/generation:', JSON.stringify(input.slice(0, 20)),
        longEnough ? '(barge-in 关闭)' : `(过短 <${BARGE_IN_MIN_CHARS}字)`);
      return 'ignored';
    }
  }
  // 用户消息必须在 llm_start 之前发出，否则界面会出现"回答排在问题前面"
  broadcast({ type: 'user_text', text: input });
  sendToLLM(input);
  return 'accepted';
}

async function sendToLLM(text) {
  const id = ++replySeq;
  const controller = new AbortController();
  activeLLM = { controller, id };
  broadcast({ type: 'llm_start', id });

  pushMessage({ role: 'user', content: text });

  let fullText = '';
  const chunker = new TtsChunker();

  try {
    const client = await getLLM();
    const sendSystem = buildSystemMessage();     // 一轮内恒定（一轮可能多次请求：工具轮）
    // 线上序列只追加：本轮用户消息（含动态上下文）接在"上一次真正发出去的内容"之后。
    // 这样 [system + 历史 + 本轮] 逐字节是上轮请求的前缀 → KV 缓存全命中。
    const requestMessages = wireMessages.concat([
      { role: 'user', content: `${dynamicContext(text)}\n\n${text}` },
    ]);
    // 立刻提交：即使本轮马上被打断，下一轮也能看到这条用户消息
    wireMessages = requestMessages;
    const appendWireAssistant = (t) => {
      // 只有仍是当前这轮才追加（被打断后被新一轮取代时不能污染新序列）
      if (t && activeLLM && activeLLM.id === id) wireMessages.push({ role: 'assistant', content: t });
    };

    const toolDefs = getToolDefs();
    let toolRounds = 0;
    let retried = false;
    let fillerSpoken = false;   // 填充语一轮回复只播一次（模型可能多次搜索，之前会重复播报）
    let result;
    while (true) {
      const roundStart = fullText.length;          // 本轮起始位置，便于丢弃"调用工具前的草稿"
      result = await client.chat({
        systemPrompt: sendSystem,
        messages: requestMessages,
        tools: toolDefs,
        signal: controller.signal,
        onDelta: (delta) => {
          // 已被停止词打断 / 已被新问题取代：在途增量必须丢弃，否则会插进新一轮的气泡与语音
          if (controller.signal.aborted || (activeLLM && activeLLM.id !== id)) return;
          fullText += delta;
          broadcast({ type: 'llm_stream', content: delta, id });
          for (const c of chunker.push(delta)) enqueueSpeech(id, c);
        },
      });
      markLLMActivity();                                        // 顺延保温窗口
      dumpLLMRequest({ replyId: id, round: toolRounds }, result);  // 审计（含真实载荷）

      // 一个字都没吐出来就失败（服务端忙/连接瞬断）→ 静默重试一次；
      // 已经吐过字就不重试（用户已经听到/看到一半，重来会重复播报）
      if (result.stopReason === 'error' && !retried && !controller.signal.aborted && !fullText.trim()) {
        retried = true;
        log.warn('[LLM] 请求失败，500ms 后重试一次:', result.errorMessage);
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }

      const calls = result.toolCalls || [];
      if (calls.length && result.stopReason !== 'aborted' && result.stopReason !== 'error') {
        // 模型在调用工具前常输出"思考/计划"（如"用户问的是…我试试调计算器"），
        // 这不是给用户听的内容：撤回已流式的文字，并丢弃这段时间的 TTS。
        const scratch = fullText.slice(roundStart);
        if (scratch.trim()) {
          log.info('[Tools] 丢弃工具前草稿:', JSON.stringify(scratch.slice(0, 60)));
          fullText = fullText.slice(0, roundStart);
          broadcast({ type: 'llm_retract', chars: scratch.length, id });
          sendToWorker({ cmd: 'clear' });          // 丢掉草稿的待合成语音
          broadcast({ type: 'drop_queued_audio' }); // 浏览器：停当前音频并清队列（保留本轮 id）
        }
      } else {
        // 模型没调工具时，对"有副作用的动作"做确定性兜底（否则它只说"好的"却没真的设置）
        if (!calls.length && toolRounds === 0) {
          const made = tryReminderFallback(text);
          if (made) {
            broadcast({ type: 'tool_call', name: 'set_reminder', args: { text: made.text, when: made.when }, fallback: true });
            broadcast({ type: 'tool_result', name: 'set_reminder', ok: true, fallback: true });
          }
        }
        break;
      }
      if (++toolRounds > TOOL_MAX_ROUNDS) {
        log.warn('[Tools] 超过最大轮数，停止调用');
        break;
      }

      // 执行工具并把结果回灌给模型（结果不进会话历史，避免上下文被搜索结果撑爆）
      if (result.finalMessage) requestMessages.push(result.finalMessage);
      for (const call of calls) {
        log.info(`[Tools] 调用 ${call.name}(${JSON.stringify(call.arguments)})`);
        broadcast({ type: 'tool_call', name: call.name, args: call.arguments });
        if (call.name === 'web_search' && !fillerSpoken && !fullText.trim()) {
          // 搜索有延迟，先说一句免得静默；但一轮只播一次，且模型已经开口就不再插话
          fillerSpoken = true;
          enqueueSpeech(id, '让我搜一下');
        }
        const out = await executeTool(call.name, call.arguments);
        const brief = JSON.stringify(out);
        log.info(`[Tools] ${call.name} → ${brief.slice(0, 160)}`);
        broadcast({ type: 'tool_result', name: call.name, ok: !out.error });
        requestMessages.push({
          role: 'toolResult',
          toolCallId: call.id,
          toolName: call.name,
          isError: !!out.error,
          content: [{ type: 'text', text: brief }],
        });
      }
    }

    for (const c of chunker.flush()) enqueueSpeech(id, c);

    if (result.stopReason === 'aborted') {
      log.info('[LLM] interrupted');
      const partial = fullText.trim();
      if (partial.length >= 10) pushMessage({ role: 'assistant', content: `${partial}（被打断）` });
      broadcast({ type: 'llm_interrupted', id });
      return;
    }

    if (result.stopReason === 'error') {
      log.error('[LLM]', result.errorMessage);
      broadcast({ type: 'error', error: result.errorMessage || 'LLM 请求失败' });
      return;
    }

    log.info('[LLM] done,', fullText.length, 'chars', usageLine(result.usage));
    lastAssistantText = fullText.trim();
    if (fullText.trim()) pushMessage({ role: 'assistant', content: fullText.trim() });
    appendWireAssistant(fullText.trim());        // 线上序列追加同一份回答（只追加 → 下轮前缀稳定）
    broadcast({ type: 'llm_done', fullText, id });
    finishSpeech(id);
    compressHistoryIfNeeded();
  } catch (e) {
    // 适配层已把请求失败转成 stopReason，这里只兜住意外异常
    if (e.name === 'AbortError') {
      log.info('[LLM] interrupted');
      const partial = fullText.trim();
      if (partial.length >= 10) pushMessage({ role: 'assistant', content: `${partial}（被打断）` });
      broadcast({ type: 'llm_interrupted', id });
    } else {
      log.error('[LLM]', e.message);
      broadcast({ type: 'error', error: e.message });
    }
  } finally {
    if (activeLLM && activeLLM.id === id) activeLLM = null;
  }
}

// ========== WebSocket ==========
const clients = new Set();

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(data);
  }
}

wss.on('connection', (ws) => {
  clients.add(ws);
  log.info('[WS] Client connected');

  // 新连接（含刷新页面）恢复既有会话 + 告知采集模式
  if (ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'history', summary, messages: history, tokens: historyTokens() }));
    ws.send(JSON.stringify({ type: 'hello', capture: CAPTURE_MODE, playback: SERVER_PLAYBACK ? 'server' : 'browser', sampleRate: 16000, frameSamples: 1280, wakeWord: cfg.wake.word, wakeRequired: WAKE_REQUIRED, awake: wakeGate.awake }));
  }

  ws.on('message', (data, isBinary) => {
    if (isBinary) {           // 浏览器采集的 PCM 帧
      sendAudioFrame(Buffer.isBuffer(data) ? data : Buffer.from(data));
      return;
    }
    try {
      const msg = JSON.parse(data.toString());
      switch (msg.type) {
        case 'listen': {
          audioPending = 0;
          const source = msg.source || CAPTURE_MODE;
          log.info('[capture] listen 请求来源:', source);
          sendToWorker({ cmd: 'listen', source: source === 'browser' ? 'browser' : 'server' });
          break;
        }
        case 'stop_listen':
          sendToWorker({ cmd: 'stop_listen' });
          break;
        case 'playback': {
          // 服务端放音模式：播放由 worker 自己驱动（并会回报 playback_start/end），
          // 浏览器不再播放音频，也就不该再用它的心跳去覆盖门控状态
          if (SERVER_PLAYBACK) break;
          // 播放中：租约 TTL；播放结束：仍保留一段尾巴窗（喇叭余音/混响还会被麦克风听到）
          playbackUntil = msg.on ? Date.now() + 1500 : Date.now() + ECHO_TAIL_MS;
          const want = !!msg.on;
          if (want) {
            if (playbackOffTimer) { clearTimeout(playbackOffTimer); playbackOffTimer = null; }
            if (!playbackState) {
              playbackState = true;
              sendToWorker({ cmd: 'playback', on: true });
            }
          } else if (playbackState && !playbackOffTimer) {
            // 防抖 800ms：合成稍慢时播放队列会短暂空档，立即下发 OFF 会清空采集队列
            playbackOffTimer = setTimeout(() => {
              playbackOffTimer = null;
              if (playbackState) {
                playbackState = false;
                sendToWorker({ cmd: 'playback', on: false });
              }
            }, 800);
          }
          break;
        }
        case 'set_voice': {
          const v = String(msg.voice || '').trim();
          if (v && v !== currentVoice) {
            // Kokoro 音色（zf_*/zm_*/af_*/bf_*）→ 切 kokoro 后端；其余按 edge 处理
            const backend = isKokoroVoice(v) ? 'kokoro' : 'edge';
            if (backend !== currentBackend) {
              currentBackend = backend;
              sendToWorker({ cmd: 'set_backend', backend });   // 热切换，不重启 worker
            }
            currentVoice = v;
            persistVoice(backend, v);
            for (const k of Object.keys(prewarmPaths)) delete prewarmPaths[k];
            prewarmPhrases();   // 换音色后重新预生成
          }
          break;
        }
        case 'text':
          if (msg.text) handleUserText(msg.text, false);
          break;
        case 'aec_calibrate':
          // 调试/现场标定：让 worker 在真实管线上测播放→麦克风延迟并应用
          sendToWorker({ cmd: 'aec_calibrate' });
          log.info('[AEC] 触发就地标定…');
          break;
        case 'asr_sim':
          // 调试/测试：直接注入一条"识别结果"，走与真实 ASR 完全相同的下行处理
          // （唤醒门控/停止词/回声判定都真实生效）。需 conf: debug.asrSim = true
          if (cfg.debug.asrSim && typeof msg.text === 'string') {
            log.info('[ASR·注入]', JSON.stringify(msg.text));
            const verdict = handleUserText(msg.text, true);
            log.info('[ASR·注入] 判定:', verdict);
            if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'asr_sim_verdict', text: msg.text, verdict }));
          }
          break;
        case 'clear_history':
          interrupt();
          history = [];
          summary = '';
          wireMessages = [];        // 线上序列一起清空
          saveHistory();
          log.info('[History] cleared');
          broadcast({ type: 'history', summary: '', messages: [], tokens: 0 });
          break;
      }
    } catch (e) {
      log.error('[WS]', e.message);
    }
  });

  ws.on('error', (e) => {
    // WebSocket 无 error 监听时，socket 层错误（ECONNRESET 等）会变成未捕获异常 → 崩服务
    log.error('[WS] socket error:', e.code || e.message);
    clients.delete(ws);
  });

  ws.on('close', () => {
    clients.delete(ws);
    log.info('[WS] Client disconnected');
  });
});

/** 主动播报（提醒到点、唤醒应答等）：像一轮回复那样推给前端并朗读 */
function announce(text) {
  const id = ++replySeq;
  log.info('[Announce]', text);
  broadcast({ type: 'llm_start', id });
  broadcast({ type: 'llm_done', fullText: text, id });
  const cached = prewarmPaths[text];
  if (cached) {
    // 预生成过的短句：直接播已合成的音频，省掉 1~2 秒合成延迟
    broadcast({ type: 'tts_audio', audio_path: cached, text, id });
  } else {
    enqueueSpeech(id, text);
    finishSpeech(id);
  }
  pushMessage({ role: 'assistant', content: text });
  // 主动播报（提醒/唤醒应答）也要进线上序列，否则下一轮请求会在这条消息处分叉
  wireMessages.push({ role: 'assistant', content: text });
  markLLMActivity();
}

// 预生成常用短语音（唤醒应答）：worker 就绪后请求一次，语音切换时重做
function prewarmPhrases() {
  for (const t of [WAKE_ACK]) sendToWorker({ cmd: 'prewarm_tts', text: t, voice: currentVoice });
}

// ========== KV 缓存保温 ==========
// 服务端（LM Studio/llama.cpp）会置换掉不活跃会话的 KV 缓存：用户隔一两分钟再说话，
// 整段历史都要重新 prefill（实测 2022 token ≈ 2.4s，缓存命中只要 0.53s）。
// 空闲达阈值时把"当前线上序列"原样再发一次（max_tokens=1，只要 prefill 不要输出）把缓存加热回来。
//
// 三个必须成立的前提（否则白加热甚至有害）：
//   ① 内容与下一次真实请求**逐字节同前缀**（用同一个 wireMessages + 同一个 system + 同一套 tools）
//   ② 只在真空闲时做，不能和真实生成抢服务端（activeLLM/正在说话/正在播报都要让路）
//   ③ 不能每 10s 重复加热：真实活动或上一次加热后都要顺延一个空闲窗口
const KV_WARM = cfg.kvWarm.enabled;
const KV_WARM_IDLE_MS = cfg.kvWarm.idleMs;    // 空闲多久开始加热
const KV_WARM_KEEP_MS = cfg.kvWarm.keepMs;  // 多久无活动就不再保温
const KV_WARM_MIN_MESSAGES = cfg.kvWarm.minMessages;
const KV_WARM_TICK_MS = cfg.kvWarm.tickMs;

let lastUserActivity = Date.now();   // 启动即视为刚有活动，否则开机后会被当成会话早凉、永不保温
let lastLLMActivity = 0;
let nextWarmAt = 0;      // 下次允许加热的时刻
let warming = false;

/** 记录"刚和 LLM 打过交道"：把保温窗口整体顺延 */
function markLLMActivity() {
  lastLLMActivity = Date.now();
  nextWarmAt = lastLLMActivity + KV_WARM_IDLE_MS;
}

function warmReason(now) {
  if (!KV_WARM) return 'disabled';
  if (warming) return 'already-warming';
  if (activeLLM) return 'generating';
  if (wireMessages.length < KV_WARM_MIN_MESSAGES) return 'not-enough-context';
  if (now < nextWarmAt) return 'recent-activity';
  if (playbackActiveNow()) return 'speaking';
  if (audioRecentlyActive()) return 'user-speaking';
  if (now - lastUserActivity > KV_WARM_KEEP_MS) return 'session-cold';
  return null;
}

async function warmKvCache() {
  const now = Date.now();
  const why = warmReason(now);
  if (why) return why;
  warming = true;
  const t0 = Date.now();
  try {
    const client = await getLLM();
    const msgs = wireMessages.slice();          // 与下一次真实请求逐字节同前缀
    const r = await client.chat({
      systemPrompt: buildSystemMessage(),       // 与真实请求一致（system 必须逐轮稳定）
      messages: msgs,
      tools: getToolDefs(),                     // 工具 schema 也是提示词的一部分，必须一致
      maxTokens: 1,                             // 只要 prefill，不要输出
    });
    if (r.stopReason === 'error') throw new Error(r.errorMessage || 'warm failed');
    const ms = Date.now() - t0;
    dumpLLMRequest({ warm: true, ms, wireMsgs: msgs.length, wireTokens: wireTokens() }, r);
    log.info(`[KV] 缓存已加热 ${ms}ms（${msgs.length} 条消息 ~${wireTokens()} tokens）${usageLine(r.usage)}`);
    return null;
  } catch (e) {
    log.warn('[KV] 缓存加热失败:', e.message);
    return 'error:' + e.message;
  } finally {
    warming = false;
    markLLMActivity();   // 成功/失败都顺延，避免每 tick 重试刷屏
  }
}

setInterval(() => { warmKvCache(); }, KV_WARM_TICK_MS);

// ========== 进程级兜底 ==========
// 语音助手是"常驻设备"：任何漏网的异步异常都不该让服务静默死掉（用户会觉得"它突然不理我了"）。
// 故：记日志 + 通知前端，保持运行；崩溃自愈交给 worker/WS 各自的处理器。
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? (reason.stack || reason.message) : String(reason);
  log.error('[unhandledRejection]', msg);
  broadcast({ type: 'notice', text: '内部异常已忽略，服务继续运行' });
});
process.on('uncaughtException', (err) => {
  log.error('[uncaughtException]', (err && (err.stack || err.message)) || String(err));
  broadcast({ type: 'notice', text: '内部异常，已尝试恢复运行' });
});

// ========== Start ==========
loadHistory();
reminders.start((line) => announce(line));
// 隔离测试（如 KV 保温算法）可以只起服务不拉语音 worker
if (cfg.debug.noWorker) log.info('[Worker] 跳过启动（conf: debug.noWorker）');
else startWorker();

server.listen(PORT, () => {
  log.info(`VoiceAI server running at http://localhost:${PORT}`);
  log.info(`LLM endpoint: ${LLM_BASE_URL}`);
  log.info(`Python worker: ${PYTHON_PATH}`);
  log.info(`Node: ${process.execPath} (${process.platform})`);
  log.info(`采集模式: ${CAPTURE_MODE}${CAPTURE_MODE === 'browser' ? '（浏览器麦克风 + WebRTC AEC）' : '（Python sounddevice）'}`);
});
