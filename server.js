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
const https = require('https');
const { WebSocketServer } = require('ws');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// ★ 单实例保护 ✓
//   之前能同时起多个 server ✗ → 每个都拉一套渲染进程 ✗ → 抢显卡 + 端口打架 ✗
//   （实测同时活着两个 `node server.js` ✗ 老的占着 8214 ✗ 新的照样生成渲染进程 ✗）
const LOCKFILE = path.join(__dirname, 'temp', 'server.lock');
try {
  const prev = parseInt((fs.existsSync(LOCKFILE) ? fs.readFileSync(LOCKFILE, 'utf8') : '0').trim(), 10) || 0;
  const alive = process.platform === 'linux' ? fs.existsSync('/proc/' + prev) : false;
  if (prev && prev !== process.pid && alive) {
    console.error(`[启动] 已有实例在运行 (pid ${prev}) ✗ 本次退出 ✓ 换端口请用 --port=`);
    process.exit(3);
  }
  fs.writeFileSync(LOCKFILE, String(process.pid));
} catch (e) {}
process.on('exit', () => {
  try { if ((fs.readFileSync(LOCKFILE, 'utf8') || '').trim() === String(process.pid)) fs.unlinkSync(LOCKFILE); } catch (e) {}
});

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ★ 自签 HTTPS ✓（默认 8443 ✓ 证书在 certs/ 才启用）：浏览器只在安全上下文给麦克风 ✓
//   → Windows 机远程用 http://166:8214 收不到麦 ✗ 改开 https://166:8443 就通 ✓
//   ws 走同一套 upgrade 逻辑 ✓（前端按 location.protocol 自动选 wss ✓）
if (fs.existsSync(path.join(__dirname, 'certs', 'key.pem')) && fs.existsSync(path.join(__dirname, 'certs', 'cert.pem'))) {
  const HTTPS_PORT = Number(cfg.httpsPort || process.env.VOICEAI_HTTPS_PORT || 8443);
  const httpsServer = https.createServer({
    key: fs.readFileSync(path.join(__dirname, 'certs', 'key.pem')),
    cert: fs.readFileSync(path.join(__dirname, 'certs', 'cert.pem')),
  }, app);
  httpsServer.on('upgrade', (req, socket, head) => {
    try { wss.handleUpgrade(req, socket, head, (c) => wss.emit('connection', c, req)); }
    catch (e) { socket.destroy(); }
  });
  httpsServer.on('error', (e) => log.warn(`[HTTPS] 监听 ${HTTPS_PORT} 失败: ${e.message}`));
  httpsServer.listen(HTTPS_PORT, () => log.info(`VoiceAI HTTPS: https://localhost:${HTTPS_PORT}（自签证书 ✓ 浏览器警告点"继续访问"一次即可 ✓）`));
}

// 采集来源：server（Python sounddevice，默认）| browser（浏览器 getUserMedia + WebRTC AEC）
// 可用 --capture=browser 或环境变量 VOICEAI_CAPTURE 指定
// （注意：从 WSL 启动 Windows node.exe 时 Linux 环境变量不会自动转发，用 CLI 参数最稳）
const ARG_CAPTURE = (process.argv.find((a) => a.startsWith('--capture=')) || '').split('=')[1];
const CAPTURE_MODE = (ARG_CAPTURE || cfg.capture || 'server').toLowerCase();
const AUDIO_FRAME_MAX_PENDING = cfg.worker.audioMaxPending;
let audioPending = 0;   // 已入队/在飞音频帧数，超限丢弃以保持低延迟
let statRecv = 0, statDrop = 0, statAck = 0, statWin = Date.now();
// 当前会话**实际**使用的采集源：listen 时由浏览器上报的 source 决定 ✓
// ✗ 不能用 CAPTURE_MODE（启动配置）：网页选"浏览器麦克风"时服务端配置仍是 server，
//   两边门控不一致会让浏览器音频在这里被整帧丢弃，而 worker 又在等浏览器喂音频
//   → 电平条在动（浏览器侧）但识别永远是空（服务端只听到服务器麦克风的静音）✓
let activeSource = CAPTURE_MODE;

function sendAudioFrame(buf) {
  if (activeSource !== 'browser') return;
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
let LLM_BASE_URL = cfg.llm.baseUrl;      // ★ 可切换 ✓（多套预设 ✓）
let LLM_MODEL = cfg.llm.model;

// ★ 路径归一化 ✓ **跨平台** ✓
//   配置里写哪种形式都认 ✓：`/mnt/i/xxx`（WSL 形式）/ `I:/xxx`（Windows 形式）
//   规则：**哪个候选真实存在就用哪个** ✓ 不猜 ✓ 都不存在就按原样传 ✓（让错误信息自己说清 ✓）
//   这段代码在 Windows / Linux / WSL 上行为一致 ✓ 不含平台分支 ✓
function nativePath(p) {
  if (!p || typeof p !== 'string') return p;
  const cands = [p];
  const mWsl = p.match(/^\/mnt\/([a-z])\/(.*)$/i);
  const mWin = p.match(/^([a-z]):[\\/](.*)$/i);
  if (mWsl) cands.push(`${mWsl[1].toUpperCase()}:/${mWsl[2]}`);
  if (mWin) cands.push(`/mnt/${mWin[1].toLowerCase()}/${mWin[2]}`);
  for (const c of cands) {
    try { if (fs.existsSync(c)) return c; } catch (e) {}
  }
  return p;
}
function resolvePython() {
  // 与 nativePath 同一哲学：哪个候选存在用哪个 ✓（Linux: venv/bin/python / Win: venv/Scripts/python.exe）
  const cands = [
    path.join(__dirname, 'venv', 'bin', 'python'),
    path.join(__dirname, 'venv', 'Scripts', 'python.exe'),
  ];
  for (const c of cands) {
    try { if (fs.existsSync(c)) return c; } catch (e) {}
  }
  return 'python3';
}
// ★ MIOpen solver 表的位置 ✓（跨平台 ✓ 用 nativePath ✓）
//   渲染进程用它 ✓ 预热脚本写它 ✓ → 搜过的 solver 直接命中 ✓（见 duix/wav2lip_prewarm.py ✓）
const MIOPEN_DB = nativePath(path.join(__dirname, 'duix', 'models', 'miopen_db_w2l'));

const PYTHON_PATH = cfg.worker.python || resolvePython();
const WORKER_PATH = nativePath(path.join(__dirname, 'worker.py'));

let currentBackend = String(cfg.tts.backend || 'piper').toLowerCase();
// 当前生效的音色：在线 edge 与本地 Piper 共用一个字段 ✓（Kokoro 已淘汰 ✗ 不再分流）
let currentVoice = cfg.tts.voice;

// ★ 把**运行时**状态推给工具层 ✓：env_info 要答"现在用的是哪个引擎/音色/模型"✓，
//   读 conf 默认值不够准 ✗（你在界面里换过引擎 ✓ 内存里的才是真的 ✓）
function pushRuntimeInfo() {
  try {
    setRuntimeInfo({
      ttsBackend: currentBackend, ttsVoice: currentVoice,
      ttsSpeed: Number(cfg.tts.speed) || 1,
      asrModel: cfg.asr.model, llmModel: LLM_MODEL, llmBaseUrl: cfg.llm.baseUrl,
      capture: CAPTURE_MODE, playback: String(cfg.tts.playback || 'server').toLowerCase(),
      wakeWord: cfg.wake.word,
    });
  } catch (e) { try { log.warn('[Tools] 运行时状态推送失败:', e.message); } catch (e2) {} }
}

function persistVoice(backend, voice) {
  // 写回 conf.json：worker 侧 conf() 读的是启动时的快照，重启后才会从文件生效
  try {
    const c = JSON.parse(fs.readFileSync(CONF_PATH, 'utf8'));
    c.tts = c.tts || {};
    c.tts.backend = backend;
    c.tts.voice = voice;
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

// ★ 固定说法（「别说了」「重启会话」…）直接处理、不进 LLM ✓：一条 filter 链 ✓
//   每个 filter 自己判别该不该它处理 ✓ 认领了就把动作做掉 ✓（插件性质 ✓ 加一条只写一个对象 ✓）
//   原先停词表 + isStopWord 写在这里 ✗ 且判断散在 handleUserText 三处（播中/唤醒后/打字 ✓）→ 现收进 filters.js ✓
const filters = require('./filters');
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

// ★ 前端资源禁用强缓存 ✓（否则改了 css 用户刷新也看不到 ✗ 实测踩过 ✓）
// ★ 诊断：记录页面/CSS 请求 ✓（确认用户的刷新到底有没有打到本服务 ✓）
app.use((req, res, next) => {
  if (req.path === '/' || req.path === '/style.css' || req.path === '/app.js') {
    log.info(`[HTTP] ${req.method} ${req.path} ip=${req.ip} ua=${String(req.headers['user-agent'] || '').slice(0, 50)}`);
  }
  next();
});
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (/\.(html|css|js|json)$/i.test(filePath)) res.setHeader('Cache-Control', 'no-cache, must-revalidate');
  },
}));
app.use('/temp', express.static(path.join(__dirname, 'temp')));
// 2D 数字人素材包列表（前端下拉框用 ✓）
// 官方 14 个免费模特的**中文名**（README 里的对应关系 ✓ 界面显示这个，别显示目录名 ✗）
const DUIX_NAMES = {
  bendi1_0329: '知心姐姐', sufei_20240409: '苏菲', murongxiao_20240410: '慕容晓',
  lengyan_20240407: '冷焱', amelia_20240411: 'Amelia', zhaoya_20240411: '赵雅',
  yiyao_20240418: '忆瑶', xinyan_20240411: '心妍', xiaoxuan_20240418: '晓萱',
  siyao_20240418: '思瑶', shiya_20240409: '诗雅',
  airuike_20240409: '艾瑞克', zixuan_20240411v2: '子轩', mingxuan_20240624: '明轩',
};
// ✗ 这几个素材喂给 Wav2Lip 会**生成蓝紫牙齿 + 大洞嘴**（模型先验 + 素材美颜过重 ✗）
//   实测 14 个包的同一句对比：只有它们坏 ✗ 其余正常 ✓ → 先从下拉框隐藏 ✓（要试可以手动写 conf）
// 诗雅也在里面 ✗：牙齿会被模型生成成"灰色色块+空洞"✗（结构就坏了，调色救不回来 ✓ 实测）
const DUIX_BAD = new Set([
  'xiaoxuan_20240418', 'amelia_20240411', 'sufei_20240409', 'yiyao_20240418', 'shiya_20240409', 'zhaoya_20240411',
  // 绿幕拍摄 ✗ 合成后会露出绿底 ✗（实测 mingxuan / airuike 背景整片绿 ✗）
  'mingxuan_20240624', 'airuike_20240409',
]);
app.get('/api/duix/packs', (req, res) => {
  try {
    const packs = DUIX.listPacks().filter((id) => !DUIX_BAD.has(id))
      .map((id) => ({ id, name: DUIX_NAMES[id] || id }));
    res.json({ packs, current: DUIX.pack, enabled: DUIX.enabled });
  } catch (e) { res.json({ packs: [], current: '', enabled: false }); }
});
// ★ 3D 数字人（TalkingHead）用 three.js ✓：裸前端没有打包器 ✗ 又要用 importmap 引 ESM ✓
//   → 直接把本地 node_modules/three 挂出来 ✓（只挂这一个包 ✓ 不是把 node_modules 全暴露 ✗）
//   ★ 不依赖任何 CDN ✓：断网/内网也能用 ✓（本地优先 ✓）
app.use('/vendor/three', express.static(path.join(__dirname, 'node_modules', 'three')));

// ★ 数字人形象列表 ✓（设置面板的下拉框用 ✓）：扫目录列出可选的 GLB ✓ 带体积 ✓
//   用户实测讨厌"要手改 URL 才能换脸" ✗ → 让他自己在下拉框里挑 ✓（含 vrm2glb 转出来的 ✓）
app.get('/api/avatars', (req, res) => {
  const dir = path.join(__dirname, 'public', 'vendor', 'talkinghead', 'avatars');
  try {
    const items = fs.readdirSync(dir)
      .filter((f) => /\.glb$/i.test(f))
      .map((f) => {
        const st = fs.statSync(path.join(dir, f));
        return { id: f.replace(/\.glb$/i, ''), mb: Math.round(st.size / 104857.6) / 10 };   // 0.1MB 精度 ✓
      })
      .filter((x) => x.mb > 0.5)               // 半截/坏文件直接不列 ✓（上面踩过多次下载中断 ✗）
      .sort((a, b) => a.mb - b.mb);
    res.json({ avatars: items });
  } catch (e) {
    res.json({ avatars: [], error: e.message });
  }
});

// ========== 音色列表 + 试听样本（web 设置面板用）==========
// 试听样本是离线预生成的（temp/voices/ ✓），没有样本的音色也能选，只是听不了。
const VOICE_SAMPLES_DIR = path.join(__dirname, 'temp', 'voices');
// ★ edge 音色：**必须来自端点实时列表** ✓（`{cmd:'list_voices'}` → worker 调 `edge_tts.list_voices()` ✓）
//   微软会下架音色 ✗：原先写死的 15 个里有 4 个端点已无（Xiaohan/Xiaomo/Xiaorui/Xiaoxuan ✓）
//   → 选中就 `NoAudioReceived` ✗ → 白等两次重试 → 兜底 Piper ✗（症状：明明选了微软音色 ✓ 听到的却是小雅 ✓）
//   这里只作**离线兜底** ✓（拉取失败时沿用 ✓）；内容 = 本次对端点逐个核验为"存在"的 14 个 ✓
let EDGE_VOICES = [
  'zh-CN-XiaoxiaoNeural', 'zh-CN-XiaoyiNeural', 'zh-CN-YunxiNeural', 'zh-CN-YunyangNeural',
  'zh-CN-YunjianNeural', 'zh-CN-YunxiaNeural',
  'zh-CN-liaoning-XiaobeiNeural', 'zh-CN-shaanxi-XiaoniNeural',
  'zh-HK-HiuMaanNeural', 'zh-HK-HiuGaaiNeural', 'zh-HK-WanLungNeural',
  'zh-TW-HsiaoChenNeural', 'zh-TW-HsiaoYuNeural', 'zh-TW-YunJheNeural',
];

// 端点只给英文名（`FriendlyName` ✗ 无中文字段 ✓）→ 中文名本地一张表 ✓（微软官方昵称 ✓）
const EDGE_VOICE_CN = {
  'zh-CN-XiaoxiaoNeural': '晓晓 · 女（标准普通话 · 最自然）',
  'zh-CN-XiaoyiNeural': '晓伊 · 女（活泼）',
  'zh-CN-YunxiNeural': '云希 · 男（开朗）',
  'zh-CN-YunyangNeural': '云扬 · 男（新闻播报腔）',
  'zh-CN-YunjianNeural': '云健 · 男（激情）',
  'zh-CN-YunxiaNeural': '云夏 · 男（少年音）',
  'zh-CN-liaoning-XiaobeiNeural': '晓北 · 女（东北话）',
  'zh-CN-shaanxi-XiaoniNeural': '晓妮 · 女（陕西话）',
  'zh-HK-HiuMaanNeural': '晓曼 · 女（粤语）',
  'zh-HK-HiuGaaiNeural': '晓佳 · 女（粤语）',
  'zh-HK-WanLungNeural': '云龙 · 男（粤语）',
  'zh-TW-HsiaoChenNeural': '晓臻 · 女（台湾普通话）',
  'zh-TW-HsiaoYuNeural': '晓雨 · 女（台湾普通话）',
  'zh-TW-YunJheNeural': '云哲 · 男（台湾普通话）',
};


// ===== Piper 本地音色注册表 =====
// 一个"音色" = 一个模型目录（+ 可选说话人 id ✓）。发给 worker 的音色串格式：
//   piper:<模型目录名>[:<说话人id>]
// 现状：中文官方 huayan 需专属前端(G2PW) ✗ 未接 → 用 sherpa 版 xiao_ya（实测能听 ✓）
const PIPER_VOICES = (() => {
  const out = [];
  const simple = [
    ['vits-piper-zh_CN-xiao_ya-medium-int8', '中文·小雅（女 · DirectML 最快）'],
    // ✗ huayan 暂时不列：它的音素集与我们离线音素化不匹配 —— 走翻译路径会得到"过短/空音频" ✗，
    //   需要接它的专属前端（G2PW）才可恢复 ✓；在接好之前不给用户选，避免踩坑 ✓
    // ['vits-piper-zh_CN-huayan-medium', '中文·华言（女 · Piper 官方）'],
    ['vits-piper-en_US-lessac-medium', '英文·lessac（男 · 最快）'],
    ['vits-piper-en_US-amy-medium', '英文·amy（女）'],
    ['vits-piper-en_US-ryan-medium', '英文·ryan（男）'],
    ['vits-piper-en_US-lessac-high', '英文·lessac high（音质最高 · 慢 30 倍）'],
  ];
  for (const [dir, label] of simple) {
    if (fs.existsSync(path.join(__dirname, 'models', dir))) out.push({ id: `piper:${dir}`, label });
  }
  // ✗ 曾把 aishell3 的 174 个说话人全列进下拉框（"中文·AISHELL3 说话人 #0…#173"✗）：
  //   实测那些音色**根本听不清说的啥** x（我们的离线音素化与该模型的音素 id 对不上 ✗）
  //   → 已从注册表与模型目录一并删除 ✓，中文只保留实测能听的 小雅 ✓
  return out;
})();


app.get('/api/voices', (req, res) => {
  const samples = {};
  const pick = (key, file) => {
    if (fs.existsSync(path.join(VOICE_SAMPLES_DIR, file))) samples[key] = '/temp/voices/' + file;
  };
  for (const v of EDGE_VOICES) pick('edge:' + v, `edge_${v}.mp3`);
  // 引擎分组（界面用 ✓）：在线微软 edge vs 本地 Piper，各自列出可选音色 ✓
  const engines = {
    edge: {
      label: '在线微软 edge（音质最好 · 需联网 · ~1.5s/句）',
      voices: EDGE_VOICES.map((v) => ({ id: v, label: EDGE_VOICE_CN[v] || v })),
    },
    piper: {
      label: '本地 Piper（离网可用 · 最快 0.03~0.3 RTF）',
      voices: PIPER_VOICES.map((v) => ({ id: v.id, label: v.label })),
    },
  };
  res.json({
    engines,
    edge: EDGE_VOICES, piper: PIPER_VOICES.map((v) => v.id),
    samples, current: { voice: currentVoice, backend: currentBackend },
  });
});

// 试听：用当前音色合成一句（走正常 TTS 通路 → 浏览器播放 ✓）
app.get('/api/preview', (req, res) => {
  const text = String(req.query.text || '').trim() || '你好，这是当前音色的试听。';
  enqueueSpeech('preview-' + Date.now(), text);
  res.json({ ok: true, voice: currentVoice, backend: currentBackend });
});

// ========== Python Worker (recording + VAD + ASR + TTS) ==========
let worker = null;
let workerBusy = false;
let workerQueue = [];
let workerHandshake = null;
let workerExpectedExit = false;
let workerGen = 0;

// ★ worker 的 pid 追踪 ✓：重启/重生时先把上一个杀掉 ✓
//   否则会攒出多个 worker ✗（实测同时活着 2 个 ✗ → 重复 ASR/TTS ✗ 抢 CPU ✗）
const WORKER_PIDFILE = path.join(__dirname, 'temp', 'worker.pid');
function killPid(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      require('child_process').execFileSync('C:\\Windows\\System32\\taskkill.exe',
        ['/F', '/PID', String(pid)], { stdio: 'ignore', timeout: 5000 });
    } else { process.kill(pid, 'SIGKILL'); }
  } catch (e) {}
}
function killOrphanWorker() {
  try {
    const pid = parseInt((fs.readFileSync(WORKER_PIDFILE, 'utf8') || '').trim(), 10) || 0;
    if (pid) { killPid(pid); log.info(`[Worker] 清理上一轮遗留 worker (pid ${pid})`); }
    fs.writeFileSync(WORKER_PIDFILE, '');
  } catch (e) {}
}

function startWorker() {
  const gen = ++workerGen;
  killOrphanWorker();                       // ★ 先清旧的 ✓
  const proc = spawn(PYTHON_PATH, [WORKER_PATH], { stdio: ['pipe', 'pipe', 'pipe'] });
  try { fs.writeFileSync(WORKER_PIDFILE, String(proc.pid)); } catch (e) {}
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
        // ★ 必须在下面 pumpTts 清掉 buffer 之前判定 ✓（否则最后一段永远被当 stale 丢掉 ✗）
        let ttsLiveTurn = false;
        if (result.type === 'error') {
          log.error('[Worker Error]', result.error);
          broadcast({ type: 'error', error: result.error });
        } else {
          if (result.type === 'pong' && workerHandshake) {
            clearTimeout(workerHandshake);
            workerHandshake = null;
            log.info('[Worker] Handshake OK');
            for (const k of Object.keys(prewarmPaths)) delete prewarmPaths[k];   // ★ 新 worker = 新文件：旧路径丢掉 ✓ 让旧文件重新变得可清扫（否则每重启一次泄漏一个受保护文件 ✗）
            prewarmPhrases();   // worker 就绪后预生成常用短语音 ✓
            sendToWorker({ cmd: 'list_voices' });   // ★ 拉一次微软端点的实时音色表 ✓（写死清单会因下架而骗人 ✗）
          }
          if (result.type === 'tts_prewarmed') {
            prewarmPaths[result.text] = ttsBaseName(result.audio_path);   // ★ 存 basename ✓（原先存 Windows 全路径 ✗ 见 ttsBaseName 注释）
            log.info(`[TTS] 已预生成「${result.text}」(${result.backend || "?"})`);
          }
          if (result.type === 'edge_voices') {
            const ids = (Array.isArray(result.voices) ? result.voices : []).map((v) => v && v.id).filter(Boolean);
            if (ids.length) {
              EDGE_VOICES = ids;                                    // 界面下拉立刻换成"真能用的"✓
              log.info(`[Voices] edge 实时音色 ${ids.length} 个（微软端点 ✓）`);
            } else {
              log.warn(`[Voices] edge 音色列表为空（${result.error ? '拉取失败，沿用现有清单 ✓' : '端点返回空 ✗'}）`);
            }
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
            // ★ 在 pumpTts 之前判定 ✓：最后一段返回时 pumpTts 会删 buffer + currentTtsId=null
            //   若等到下面第 534 行再判 → 最后一句永远被当 stale 丢掉 → 用户听到"只播一半" ✗
            ttsLiveTurn = ttsBuffers.has(result.id) || result.id === currentTtsId;
            if (ttsLiveTurn) {
              const durMs = Math.round((Number(result.duration) || 0) * 1000);
              speakingUntil = Math.max(Date.now(), speakingUntil) + durMs + ECHO_TAIL_MS;
            }
            const buf = ttsBuffers.get(result.id);
            if (buf) { buf.inflight = Math.max(0, buf.inflight - 1); pumpTts(result.id); }
          }
          if (result.type === 'asr_result') {
            // ★ 把录音文件名一起打出来 ✓：开着 debug.recordUserAudio 时日志直接告诉你"这句的录音在哪"✓
            //   识别错时不用翻 temp/ ✓ 界面点用户气泡（▶）就能回听 ✓
            log.info(`[ASR] playing=${playbackActiveNow()} llm=${!!activeLLM} rms=${result.rms ?? '?'} dur=${result.duration ?? '?'} asr=${result.asr_ms ?? '?'}ms`,
                     JSON.stringify(result.text),
                     result.audio_url ? `🎤 ${String(result.audio_url).split('/').pop()}` : '🎤(未录 ✓)');
            if (result.text) {
              emptyAsrStreak = 0;
              const verdict = handleUserText(result.text, true, result.rms, result.audio_url, result.conf, result.conf_parts);
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
            // ★ 这段没被当成有效插话（噪声/回声/碎片/空）→ 恢复刚才暂停的播音 ✓
            //   真插话的话 handleUserText → interrupt() 已把 bargeHold 清掉 → 这里 no-op ✓
            releaseBargeHold(true);
          }
          // ★ 快速打断 ✓：播报/生成中确认"人声开口" → 立刻暂停播音（不等 900ms 静音窗 + ASR ✗）
          //   ✗ 不能直接用 vad_state=speech：播报期自己声音的回声也会触发 ✗
          //     实测 18 次 hold → 回答被反复暂停又续播 → 听起来卡顿 ✗
          //   ✓ worker 侧已做"持续 400ms 且平均电平够高"的确认 → 这里收到 barge_onset 才暂停 ✓
          //   ASR 确认真插话才彻底 interrupt ✓；判成噪声/回声 → releaseBargeHold(true) 自动续播 ✓
          if (result.type === 'barge_onset' && !bargeHold
              && (playbackActiveNow() || activeLLM)) {
            bargeHold = true;
            broadcast({ type: 'hold_tts' });
            log.info('[Barge] 检测到开口 → 暂停播音（等 ASR 确认）');
            if (bargeHoldTimer) clearTimeout(bargeHoldTimer);
            bargeHoldTimer = setTimeout(() => {
              if (!bargeHold) return;
              log.info('[Barge] 8s 未见识别结果 → 恢复播音');
              releaseBargeHold(true);
            }, 8000);
          }
          if (result.type === 'vad_state') log.info('[VAD]', result.state);
          if (result.type === 'ack' && result.cmd === 'audio') {
            statAck++;
            audioPending = Math.max(0, audioPending - 1);
          }
          // clear 回执 = worker 已把 clear 之前及紧随其后入队的 tts 全部丢弃：
          // 此时才解除撤回草稿时的暂停，只合成"撤回之后"的句子。
          if (result.type === 'ack' && result.cmd === 'clear' && currentTtsId !== null) {
            const cbuf = ttsBuffers.get(currentTtsId);
            if (cbuf && cbuf.paused) { cbuf.paused = false; pumpTts(currentTtsId); }
          }
          // ★ 口型序列挂在**这条唯一出口**上 ✓：worker 每段 TTS 都回 {type:'tts_audio', text} ✓
          //   文本→拼音必须在服务端算 ✓（`pinyin-pro` 是服务端依赖 ✓ 前端没有拼音表 ✗）
          //   预生成「在呢」那条另走一个广播 ✓ 也补上 ✓ 前端只管渲染 ✓
          // ★ 打断/换轮后仍在途的 tts_audio ✓：不渲嘴形、不转发 ✗
          //   （延迟 700ms 的广播 + 已合成在途的段落，否则"界面断了声音还在响" ✓ 已实测）
          // ★ 用"到达那一刻"的归属判定 ✓（上面 ttsLiveTurn 已算好，早于 buffer 清理 ✓）
          //   原来在这里直接比 currentTtsId ✗ → 最后一段返回时它已被置 null → 整句不播 ✗
          const ttsStale = result.type === 'tts_audio' && !ttsLiveTurn;
          if (!ttsStale) {
            if (result.type === 'tts_audio' && result.text && !result.visemes) {
              result.visemes = textToVisemes(result.text);
            }
            if (result.type === 'tts_audio' && !suppressBroadcast && DUIX.enabled) {
              // ★ 先让渲染器起跑 ✓ 再发音频 ✓
              //   实测：新段开始时 clip.ready=0 ✗ → 前 1~2 秒画面是空的 ✗（用户："开始不动" ✓）
              //   等 450ms（12fps ≈ 5 帧）✓ 就能盖住开头 ✓ 用户感知不到 ✓
              DUIX.render(result);
              // ★ 用 epoch 守门 ✓：不能用 currentTtsId ✗（最后一段 700ms 后它已变 null → 不播 ✗）
              //   epoch 只在"打断"或"新一轮"时 +1 ✓ 期间本轮各段互不影响 ✓
              const _ep = ttsEpoch;
              setTimeout(() => { try { if (_ep === ttsEpoch) broadcast(result); } catch (e) {} }, 700);
            } else if (result.type !== 'ack' && !suppressBroadcast) {
              broadcast(result);   // 回执只用于释放闩锁；被丢弃的识别结果不回显
            }
            // ★ DUIX 数字人 ✓：每段 TTS 一渲 ✓（异步、排队 ✓ 不阻塞语音链路 ✓）
            if (result.type === 'tts_audio' && !suppressBroadcast && !DUIX.enabled) DUIX.render(result);
          }
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
    try { if ((fs.readFileSync(WORKER_PIDFILE, 'utf8') || '').trim() === String(proc.pid)) fs.writeFileSync(WORKER_PIDFILE, ''); } catch (e) {}
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
  }, Number(cfg.worker.handshakeMs) || 15000);   // ✓ 这个键此前无人读 ✗（超时写死 15000 ✓）→ 接上配置 ✓
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
const { getToolDefs, executeTool, setRuntimeInfo } = require('./tools');
pushRuntimeInfo();   // ★ 必须放在 require('./tools') 之后 ✓：setRuntimeInfo 是 const ✓ 放模块顶部会撞 TDZ ✗（实测报 "Cannot access 'setRuntimeInfo' before initialization" ✓）
const reminders = require('./tools/reminders');
const { textToVisemes } = require('./viseme');   // ★ 文本→口型序列 ✓（数字先展开 ✓ 拼音→库的 15 个口型键 ✓）

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
// 唤醒的最低电平（RMS）：低于此值视为噪声碎片 · 实测真实呼唤 0.05~0.09 ✓ 噪声 0.009 ✗
const WAKE_MIN_RMS = Number(cfg.wake.minRms ?? 0.02);
// ★ 待命时收到"完整句子"就直接接话 ✓（实测：用户对着待命的助手说"今天感觉怎么样能不能多说两句" ✓
//   识别全对 ✓ 却被 not-awake 整条丢掉 ✗ 界面零反应 ✓）；0 = 关闭 ✓ 退回"必须先喊唤醒词"✓
const STANDBY_SENT_CHARS = Number(cfg.wake.standbySentenceChars ?? 5);
// ★ 数"字数"时剔掉空白与标点 ✓：否则 `你在哪个城市？` 只算 7 字 ✗ 被 8 字门槛挡在待命外 ✓（实测发生过 ✓）
const SPEAK_STRIP_RE = /[\s。，,！!？?、；;：:·…~\-"'""''()\[\]（）【】]/g;
const speakChars = (s) => String(s || '').replace(SPEAK_STRIP_RE, '').length;
const wakeGate = createWakeGate({
  idleMs: IDLE_TIMEOUT_MS,
  required: WAKE_REQUIRED,
  minChars: cfg.wake.minChars,
});
// 预生成的短语音（唤醒应答等）：text → 已合成好的音频路径
const prewarmPaths = Object.create(null);
// ★ worker 是 **Windows 进程** ✓ 回的音频路径形如 `H:\voiceai\temp\tts_x.wav` ✓
//   而服务跑在 **WSL 的 node** ✓（启动日志 `Node: /usr/bin/node (linux)` ✓）→ 那里 `path` 是 **POSIX** ✗
//   POSIX 的 `path.basename` **不认反斜杠** ✓ → 整串被当成一个文件名 ✗✗
//   后果（实测 ✓）：`announce()` 的存在性检查永远 false → **预生成的「在呢」从来没命中过** ✓
//   每次唤醒应答都要现合成 edge ~1.1s ✓；清扫器的保护名单也是那串怪名 ✗ → 预生成文件 15 分钟被扫走 ✓
//   所以这里统一转成 **basename** ✓（缓存只存 basename ✓ 一种形状 ✗ 不留 Windows/POSIX 两套 ✓）
function ttsBaseName(p) { return path.basename(String(p || '').replace(/\\/g, '/')); }

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
// （停词连击计数已搬进 filters.js ✓ 由 pause_rply 自己管 ✓ 状态离行为最近 ✓）
let emptyAsrStreak = 0;    // 连续"有声音但识别为空"的次数（麦克风/降噪异常）
// 播报中听到真人说话（非回声）是否直接打断并处理（VOICEAI_BARGE_IN=0 可关闭，回到"只认停止词"）
const BARGE_IN = cfg.bargeIn.enabled;
// 播报中打断所需的最短字数：环境里的短碎片（"是不是""接电话"）不该打断
const BARGE_IN_MIN_CHARS = cfg.bargeIn.minChars;
// ★ 打断所需的最低电平（RMS）：低于它 = 播放期残余回声被 ASR 幻觉成的句子 ✗（实测回声 0.0269 ✗ / 真人 0.047~0.087 ✓）
const BARGE_IN_MIN_RMS = Number(cfg.bargeIn.minRms ?? 0.035);
// 放音方式：server = Python 端放音（配合 AEC），browser = 浏览器播放
const PLAYBACK_MODE = String(cfg.tts.playback || 'server').toLowerCase();   // server|browser|both|auto
const SERVER_PLAYBACK = ['server', 'both', 'auto'].includes(PLAYBACK_MODE);

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

// ========== LLM 预设（多套可热切换）============
// conf.json 里 `llm.presets` 列多套 ✓ `llm.active` 指定当前那套 ✓
// 切换是**热切换** ✓：改 cfg + 重建客户端 ✓ 不重启 ✓（下一轮对话就用新的 ✓）
const LLMPresets = Array.isArray(cfg.llm.presets) ? cfg.llm.presets : [];
function llmPresetList() {
  return LLMPresets.map((p) => ({ id: p.id, name: p.name || p.id, model: p.model, baseUrl: p.baseUrl }));
}
function applyLLMPreset(id, persist) {
  const p = LLMPresets.find((x) => x.id === id);
  if (!p) return false;
  cfg.llm.baseUrl = p.baseUrl;
  cfg.llm.model = p.model;
  if (p.apiKey) cfg.llm.apiKey = p.apiKey;
  if (p.contextWindow) cfg.llm.contextWindow = p.contextWindow;
  if (p.maxTokens) cfg.llm.maxTokens = p.maxTokens;
  cfg.llm.active = p.id;
  LLM_BASE_URL = p.baseUrl;
  LLM_MODEL = p.model;
  piClientPromise = null;                       // ★ 换客户端 ✓（下次请求重建 ✓）
  if (persist) {
    try {
      const c = JSON.parse(fs.readFileSync(CONF_PATH, 'utf8'));
      c.llm = c.llm || {};
      c.llm.baseUrl = p.baseUrl; c.llm.model = p.model;
      if (p.apiKey) c.llm.apiKey = p.apiKey;
      if (p.contextWindow) c.llm.contextWindow = p.contextWindow;
      if (p.maxTokens) c.llm.maxTokens = p.maxTokens;
      c.llm.active = p.id;
      fs.writeFileSync(CONF_PATH, JSON.stringify(c, null, 2), 'utf8');
    } catch (e) { log.warn('[LLM] 预设持久化失败', e.message); }
  }
  log.info(`[LLM] 切到预设 ${p.id} → ${p.baseUrl} (${p.model})`);
  try { broadcast({ type: 'llm_switched', id: p.id, name: p.name || p.id, model: p.model }); } catch (e) {}
  return true;
}
app.use(express.json());
app.get('/api/llm/presets', (req, res) => {
  res.json({ active: cfg.llm.active || '', presets: llmPresetList() });
});
app.post('/api/llm/switch', (req, res) => {
  const id = (req.body && req.body.id) || '';
  if (!applyLLMPreset(id, true)) return res.status(400).json({ error: 'unknown preset: ' + id });
  res.json({ ok: true, active: cfg.llm.active, presets: llmPresetList() });
});

// ========== TTS pipeline (有界前瞻 + 背压) ==========
// LLM 可达 50+ tok/s，远快于播放速度；若不限流，worker 会把整篇合成为音频，
// 既浪费 CPU 又让打断变慢。这里只允许提前合成 TTS_LOOKAHEAD 句，
// 其余句留在 server 侧队列，等 tts_audio 返回后再放下一句。
const TTS_LOOKAHEAD = cfg.tts.lookahead;
const ttsBuffers = new Map();   // replyId -> { queue:[], inflight:0, voice, done, paused }
let currentTtsId = null;
// ★ 播报世代 ✓：打断/换轮时 +1，用来作废"700ms 延迟广播"的在途段 ✓
//   不能拿 currentTtsId 判断 ✗：最后一段返回后 buffer 被清、currentTtsId=null ✗
let ttsEpoch = 0;

function enqueueSpeech(id, text) {
  if (!text) return;
  if (id !== currentTtsId) { ttsEpoch++; currentTtsId = id; ttsBuffers.clear(); }  // 新一轮回复丢弃旧的
  let buf = ttsBuffers.get(id);
  if (!buf) { buf = { queue: [], inflight: 0, voice: currentVoice, done: false, paused: false }; ttsBuffers.set(id, buf); }
  buf.queue.push(text);
  pumpTts(id);
}

function pumpTts(id) {
  const buf = ttsBuffers.get(id);
  if (!buf) return;
  // 撤回工具前草稿后、worker 的 clear 回执到来前，暂停派发：此时发出去的 tts
  // 会被 worker 的 clear 一起丢掉，那条 tts_audio 永远不回 → inflight 泄漏 → 整段回答静音。
  if (buf.paused) return;
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
  // ★ 预生成的短句（唤醒应答「在呢」…）不能当过期删掉 ✗：prewarmPaths 里存的是**路径** ✓
  //   文件一删缓存就变死链 → 唤醒应答"只上屏不出声"✓（实测 06:56 预生成的「在呢」到 07:16 已被扫掉 ✗）
  //   浏览器只 fetch /temp/<basename> ✓（app.js:553 ✓）→ 这里也按 basename 比 ✓
  const keep = new Set(Object.values(prewarmPaths).filter(Boolean));   // 存的就是 basename ✓（与 readdir 的粒度一致 ✓）
  fs.readdir(dir, (err, files) => {
    if (err) return;
    const now = Date.now();
    for (const f of files) {
      if (!f.endsWith('.mp3') && !f.endsWith('.wav')) continue;
      if (keep.has(f)) continue;
      const p = path.join(dir, f);
      fs.stat(p, (e, st) => {
        if (!e && now - st.mtimeMs > maxAgeMs) fs.unlink(p, () => {});
      });
    }
  });
}
setInterval(sweepTempFiles, 5 * 60 * 1000);

// ========== DUIX 2D 数字人（Wav2Lip 驱动真人素材） ==========
// 每段 TTS 音频渲一序列 JPEG，前端按 `audio.currentTime` 取帧 → 结构上不会音画不同步 ✓
// 纯离线 ✓ 无云服务 ✓。渲染走**常驻进程池** ✓：
//   · 现开进程每次重载素材包+权重 ~1.3s ✗ 短句等不起
//   · 单进程实测 ~30ms/帧（≈ 1.1× 实时 ✓ 但和 TTS/ASR 抢 CPU 时会掉到 30fps ✗）
//     → 长回答时队列越积越多、每段都比播放慢 ✗ ⇒ 默认 2 个进程并行 ✓
const DUIX = (() => {
  const c = (cfg.duix && typeof cfg.duix === 'object') ? cfg.duix : {};
  const enabled = c.enabled !== false;
  let packDir = path.join(__dirname, 'duix', 'models', c.pack || 'bendi1_0329');
  // ★ 路径要转成 Windows 形式 ✓（服务跑在 **Windows node** ✓ 不是 WSL ✓）
  const py = nativePath(c.python || process.env.VOICEAI_PYTHON || 'python');
  const script = path.join(__dirname, 'duix', 'render_server.py');
  const root = path.join(__dirname, 'temp', 'duix');
  const N = Math.max(1, Number(c.workers) || 2);
  const queue = [];
  const pool = [];
  let posterUrl = '';
  // ★ 播放游标（毫秒）✓：TTS 合成比播放快得多（1.2s/段 vs 3s/段）✗
  //   拿"合成完成时刻"判过期 → 队列里还没播的段会被当成过期丢掉 ✗
  //   实测：长回复只有 55% 的播放时间有帧 ✗ 就是这条造成的
  let playCursor = 0;
  // ★ 渲染前瞻上限 ✓：只渲到"预计播放时间 + LOOKAHEAD_MS"为止，更远的段先排队 ✓
  //   嘴形渲染是最贵的一步（单段 5s GPU 满载）→ 长回答被打断时最多浪费这 10 秒的帧 ✓
  const LOOKAHEAD_MS = Math.max(2000, Number(c.lookaheadMs) || 10000);
  let pumpTimer = null;
  // ★ 底帧游标 ✓：素材是 240 帧的循环视频，每段都从第 0 帧开渲 ✗
  //   → 上一段停在第 79 帧、下一段突然回到第 0 帧 = 肉眼可见的"抽搐"✗
  //   用全局游标接着往下走 ✓ 段与段之间连得上 ✓
  let packCursor = 0;
  let packFrames = 240;
  let lastSwitchAt = 0;          // 防空转 ✓：1.5 秒内重复切同一批 → 忽略

  function send(slot, obj) {
    if (!slot.child) return;
    try { slot.child.stdin.write(JSON.stringify(obj) + '\n'); } catch (e) {}
  }

  // ★ 错峰加载 ✓：两个渲染进程同时加载模型（各 ~2.5GB + HIP 初始化）会触发
  //   amdgpu KFD/SVM 抖动 → 实测 Strata 的 conversation-cache parking 从 100ms
  //   涨到 47s，紧贴引擎 60s 自杀线 → 引擎自尽重启（今天 15 次）✗
  //   改成"前一个就绪后再拉下一个" ✓ 峰值减半 ✓（启动总时长变长，但不会打死 LLM ✓）
  function startNextSlot() {
    const next = pool.find((s) => !s.started);
    if (next) startProc(next);
  }

  function startProc(slot) {
    if (slot.child || !enabled) return;
    slot.started = true;
    // 渲染器路径统一走 nativePath ✓ 跨平台 ✓（配置写哪种形式都认 ✓）
    const child = spawn(py, [nativePath(script)], {
      cwd: __dirname, windowsHide: true,
      env: { ...process.env,
              DUIX_THREADS: String(Math.max(2, Math.floor((os.cpus() || []).length / N))),
              DUIX_SR: c.sr === false ? '0' : '1',
              // 换人时重载素材包的耗时（1500 帧的包实测 3s ✗ → 只取前 150 帧，约 1.2s ✓）
              DUIX_MAX_FRAMES: String(c.maxFrames || 150),
              // ★ 帧缩放 ✓ 配置里 duix.scale 决定 ✓（1.0 = 原尺寸 540×960 ✓ 大图 ✓）
              DUIX_SCALE: String(c.scale == null ? 1 : c.scale),
              DUIX_ZOOM: String(c.zoom == null ? 1 : c.zoom),
              DUIX_FPS: String(c.fps || 15),
              DUIX_WEIGHTS: c.weights || 'wav2lip.pth',
              // ★ MIOpen 的 solver 表落盘 ✓（和 MuseTalk 那套同一个道理 ✓）
              //   不落盘 → 每次都靠启发式挑 kernel ✗ 实测 78ms/帧 ✗
              //   落盘 + 预热 → 实测 ~30ms/帧 ✓（见 duix/wav2lip_prewarm.py ✓）
              MIOPEN_USER_DB_PATH: MIOPEN_DB,
              MIOPEN_CUSTOM_CACHE_DIR: MIOPEN_DB,
              // ★ 引擎切换 ✓ musetalk = 256×256（嘴更清晰 ✓ 30ms/帧 ✓）/ wav2lip = 96×96
              DUIX_ENGINE: c.engine || 'wav2lip' },
    });
    slot.child = child;
    child.stdout.on('data', (buf) => {
      for (const line of buf.toString().split('\n')) {
        if (!line.trim()) continue;
        let msg; try { msg = JSON.parse(line); } catch (e) { continue; }
        if (msg.type === 'ready') {
          slot.ready = true;
          packFrames = Number(msg.frames) || packFrames;
          log.info(`[Duix] 进程${slot.id} 就绪 ${msg.pack} ${msg.frames} 帧 / ${msg.ms}ms · 推理设备 ${msg.device || '?'}`);
          if (msg.poster) {
            posterUrl = '/duix_poster.jpg?v=' + Date.now();
            log.info('[Duix] 海报已生成 → ' + posterUrl);
            broadcast({ type: 'duix_poster', url: posterUrl, idle: '/duix_idle' });
          }
          startNextSlot();   // ★ 前一个就绪后才加载下一个 ✓ 错峰 ✓
          pump();
        } else if (msg.type === 'packed') {
          slot.ready = true;
          packFrames = Number(msg.frames) || packFrames;
          log.info(`[Duix] 进程${slot.id} 换包完成 ${msg.pack} ${msg.frames} 帧 / ${msg.ms}ms`);
          posterUrl = '/duix_poster.jpg?v=' + Date.now();
          broadcast({ type: 'duix_poster', url: posterUrl, idle: '/duix_idle' });   // 立刻把新脸推给前端 ✓
          startNextSlot();
          pump();
        } else if (msg.type === 'start') {
          const job = slot.current;
          if (job && !job.cancelled) {
            broadcast({ type: 'duix_clip', id: job.id, text: job.text, audio: path.basename(job.src),
                        dir: `/temp/duix/${path.basename(job.dir)}`, count: msg.count, fps: msg.fps });
          }
        } else if (msg.type === 'done') {
          const job = slot.current; slot.current = null;
          if (job) {
            if (msg.cancelled) log.info(`[Duix] 进程${slot.id} #${job.id} 已取消（打断）`);
            else log.info(`[Duix] 进程${slot.id} #${job.id} 渲染完成 ${msg.count} 帧 / ${msg.ms}ms`);
          }
          pump();
        } else if (msg.type === 'error') {
          log.warn(`[Duix] 进程${slot.id} 出错:`, msg.message);
          slot.current = null;
          pump();
        }
      }
    });
    child.stderr.on('data', (d) => {
      const t = d.toString().trim();
      if (t) log.warn('[Duix] py:', t.split('\n').slice(-1)[0].slice(0, 300));
    });
    // ★ 启动失败也把 started 清掉 ✓：否则该槽永远被 startNextSlot 跳过 ✗
    //   （close 事件通常会再来一次自愈；这里只保证槽不被永久排除 ✓）
    child.on('error', (e) => { log.error('[Duix] 启动失败:', e.message); slot.child = null; slot.ready = false; slot.started = false; });
    child.on('spawn', () => { trackPid(child.pid); });
    child.on('close', (code) => {
      slot.child = null; slot.ready = false; slot.started = false;
      if (slot.current) { log.warn(`[Duix] 进程${slot.id} 退出 code=${code}`); slot.current = null; }
      if (enabled) setTimeout(() => startProc(slot), 3000);   // 自愈 ✓
    });
    send(slot, { cmd: 'load', pack: nativePath(packDir),
                 // ★ 引擎必须走命令 ✗ 环境变量在 WSL→Windows 之间会丢 ✗（实测 DUIX_ENGINE 失效 ✗）
                 engine: c.engine || 'wav2lip',
                 poster: nativePath(path.join(__dirname, 'public', 'duix_poster.jpg')) });
  }

  function render(msg) {
    if (!enabled || !msg || !msg.audio_path) return;
    const src = path.join(__dirname, 'temp', ttsBaseName(msg.audio_path));
    if (!fs.existsSync(src)) return;
    if (!fs.existsSync(packDir)) { log.warn('[Duix] 素材包不存在:', packDir); return; }
    const dur = Math.max(0.5, Number(msg.duration) || 3);
    const now = Date.now();
    if (playCursor < now) playCursor = now;          // 队列空了 → 从现在开始算
    // ★ 每段之间浏览器还会插一小段停顿（gapFor 按标点 200~500ms ✗ 我没算进去）
    //   → 游标比真实播放**越来越提前** ✗ 长回答到后几段就被判"过期"丢掉 ✗
    //   实测症状：最后几句嘴不动 ✗
    const GAP_MS = 400;
    queue.push({ id: msg.id, text: msg.text, src, dur, playAt: playCursor });
    playCursor += dur * 1000 + GAP_MS;
    // ★ 不要按"丢最老"截断 ✗：最老的那段正是**马上要播**的 ✗
    //   只做一个防爆上限 ✓ 真正该丢的是"已经播过去的"（下面 pump 里判 ✓）
    if (queue.length > 40) queue.pop();   // ★ 超限丢**最远的**（队尾）✓ 队首是马上要播的 ✗
    pump();
  }

  function pump() {
    if (pumpTimer) { clearTimeout(pumpTimer); pumpTimer = null; }
    // ★ 先把"已经播过去"的队首清掉 ✓（按**预计播放时间**判，不是合成时间 ✗）
    //   ✗ 不能放在派发循环里 shift+continue：workers=1 时本轮就结束了 → 下一段要等新事件才派发 ✗
    while (queue.length) {
      const h = queue[0];
      const late = Date.now() - h.playAt;
      if (late <= h.dur * 1000 + 1500) break;
      log.info(`[Duix] 跳过已播过的片段 #${h.id}（晚了 ${(late / 1000).toFixed(1)}s）`);
      queue.shift();
    }
    for (const slot of pool) {
      if (!slot.ready || slot.current || !queue.length) continue;
      // ★ 前瞻上限：离预计播放还早的段先不渲 ✓（等播放进度推进到 10 秒内再渲 ✓）
      const ahead = queue[0].playAt - Date.now();
      if (ahead > LOOKAHEAD_MS) {
        pumpTimer = setTimeout(pump, Math.min(ahead - LOOKAHEAD_MS + 30, 2000));
        break;
      }
      const job = queue.shift();
      // ★ 目录必须每次唯一 ✓：回复 id 每轮重置 ✓ 同目录会让新旧帧混写（实测 ready 98/0/56/50 乱跳 ✗）
      job.dir = path.join(root, `${job.id ?? 'x'}-${Date.now()}-${slot.id}`);
      try { fs.mkdirSync(job.dir, { recursive: true }); } catch (e) {}
      slot.current = job;
      const nFrames = Math.max(1, Math.round(job.dur * 25));
      send(slot, { cmd: 'render', id: job.id, audio: nativePath(job.src), out: nativePath(job.dir),
                   start: packCursor });
      packCursor = (packCursor + nFrames) % packFrames;   // 下一段接着走 ✓
    }
  }

  // ★ 打断即取消 ✓：清空待渲队列 + 通知正在渲的进程立刻丢弃当前段（SIGUSR1）
  //   嘴形渲染最贵 → 不取消的话打断后还要把整段渲完（实测最多 5s GPU 满载）✗
  function cancel() {
    queue.length = 0;
    playCursor = 0;
    if (pumpTimer) { clearTimeout(pumpTimer); pumpTimer = null; }
    for (const slot of pool) {
      if (!slot.current) continue;
      slot.current.cancelled = true;
      try { if (slot.child && slot.child.pid) process.kill(slot.child.pid, 'SIGUSR1'); } catch (e) {}
    }
  }

  // 帧目录清扫：30 分钟没用过就删（temp/ 的清扫只管 .wav/.mp3 ✗）
  setInterval(() => {
    fs.readdir(root, (e, dirs) => {
      if (e) return;
      const now = Date.now();
      for (const d of dirs) {
        const p = path.join(root, d);
        fs.stat(p, (e2, st) => { if (!e2 && now - st.mtimeMs > 30 * 60 * 1000) fs.rm(p, { recursive: true, force: true }, () => {}); });
      }
    });
  }, 10 * 60 * 1000).unref();

  // ★ 启动自清理 ✓：上一轮服务被杀时，渲染子进程会变成孤儿 ✗
  //   实测累积到 6 个抢一块显卡 → 每帧 26ms 掉到 39ms ✗ → 数字人卡住 ✗
  const PIDFILE = path.join(root, '..', 'duix_workers.json');
  function taskkill(pid) {
    try {
      const { execFileSync } = require('child_process');
      // ★ WSL 里没有 powershell ✗ 但可以直接调 Windows 的 taskkill.exe ✓
      execFileSync('/mnt/c/Windows/System32/taskkill.exe', ['/F', '/PID', String(pid)],
                   { stdio: 'ignore', timeout: 5000 });
    } catch (e) {}
  }
  // ★ 累积记录 ✓：每次重启前把上一轮 pid 也留着 ✓ 启动时按名单全杀 ✗
  //   （服务被 SIGKILL 时 exit 钩子不执行 ✗ 只覆盖写会丢掉上一轮的 pid ✗）
  function trackPid(pid) {
    if (!pid) return;
    try {
      let list = [];
      try { list = JSON.parse(fs.readFileSync(PIDFILE, 'utf8') || '[]'); } catch (e) {}
      if (!list.includes(pid)) list.push(pid);
      fs.writeFileSync(PIDFILE, JSON.stringify(list));
    } catch (e) {}
  }
  function killOrphans() {
    try {
      const pids = JSON.parse(fs.readFileSync(PIDFILE, 'utf8') || '[]');
      if (pids.length) log.info(`[Duix] 清理遗留渲染进程 ${pids.length} 个`);
      for (const pid of pids) taskkill(pid);      // 上一轮遗留 ✓
      fs.writeFileSync(PIDFILE, '[]');            // 清空名单 ✓
    } catch (e) {}
  }
  killOrphans();

  if (enabled && fs.existsSync(script)) {
    for (let i = 0; i < N; i++) {
      const slot = { id: i + 1, child: null, ready: false, started: false, current: null };
      pool.push(slot);
    }
    startNextSlot();   // ★ 只先拉第一个 ✓ 就绪后再拉下一个（见 startNextSlot 注释）✓
  }
  /** 可用素材包（目录里有 config.j 的才算 ✓）*/
  function listPacks() {
    try {
      return fs.readdirSync(path.join(__dirname, 'duix', 'models'), { withFileTypes: true })
        .filter((d) => d.isDirectory() && fs.existsSync(path.join(__dirname, 'duix', 'models', d.name, 'config.j')))
        .map((d) => d.name);
    } catch (e) { return []; }
  }

  /** 运行时换人 ✓：杀掉渲染进程 → 用新素材包自动重启 ✓ 海报重生成 ✓ */
  function switchPack(name) {
    const dir = path.join(__dirname, 'duix', 'models', String(name || ''));
    if (!name || !fs.existsSync(path.join(dir, 'config.j'))) return false;
    if (dir === packDir) return true;      // 已经是这个包 → 幂等 ✓ 不重复重载 ✗
    // ★ 防抖 ✓：旧页面/多个标签页可能同时发切换指令 ✗ 1.5 秒内只执行一次 ✓
    if (Date.now() - lastSwitchAt < 1500) {
      log.warn('[Duix] 忽略过快的重复切换:', name);
      return false;
    }
    lastSwitchAt = Date.now();
    packDir = dir;
    packCursor = 0;
    queue.length = 0;
    log.info('[Duix] 切换素材包 →', name);
    // ★ 记住选择 ✓：写回 conf.json（重启服务/重开页面都还是这个人 ✓）
    try {
      const raw = fs.readFileSync(CONF_PATH, 'utf8');
      const j = JSON.parse(raw);
      j.duix = Object.assign({}, j.duix, { pack: name });
      fs.writeFileSync(CONF_PATH, JSON.stringify(j, null, 2));
    } catch (e) { log.warn('[Duix] 写回 conf 失败:', e.message); }
    // ★ 只让渲染进程**重载素材包** ✓ 不动模型 ✓
    //   杀进程重启要 3.5s（重新加载权重 ✗）；换包实测 ~1.5s ✓
    for (const slot of pool) {
      if (slot.child) { slot.ready = false; send(slot, { cmd: 'pack', pack: nativePath(packDir) }); }
    }
    return true;
  }

  // 服务退出（含被 kill）时带走子进程 ✗ 否则每重启一次多一批孤儿 ✓
  const killAll = () => { for (const slot of pool) { if (slot.child && slot.child.pid) taskkill(slot.child.pid); } };
  process.on('exit', killAll);
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    try { process.on(sig, () => { killAll(); process.exit(0); }); } catch (e) {}
  }

  return { enabled, render, cancel, listPacks, switchPack, cleanup: killAll,
           get pack() { return path.basename(packDir); },
           get poster() { return posterUrl; },
           // ★ 渲染进程是否全部就绪 ✓：加载期间不要发 KV 保温请求 ✗
           //   实测：DUIX 加载模型时 Strata parking 100ms → 47s，保温请求正好会撞上 ✗
           //   空池（脚本缺失/DUIX 未真正启用）→ 没有要等的进程 → true ✓
           //   （写成 pool.length>0 && ... 会让空池永远 false → KV 保温被永久抑制 ✗）
           get allReady() { return pool.every((s) => s.ready); } };
})();

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
      // ★ 工具调用必须进审计 ✓：光看 stopReason 分不出"模型想调工具"与"我们真收到 tool_calls"✗
      //   实测踩过 ✓：端点 finish_reason=tool_calls ✓ 但界面把模型调工具前的英文腹稿当答案念了出来 ✓
      toolCalls: ((result && result.toolCalls) || []).map((t) => (t && (t.name || (t.function && t.function.name))) || '?'),
      toolArgs: ((result && result.toolCalls) || []).map((t) => JSON.stringify((t && (t.args || t.arguments)) || {}).slice(0, 60)),
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

// ★ 运行时事实 ✓：一律**从 config 现取** ✓（写死会过期 ✗）→ 模型不必猜"我用的是什么"✓ 也不许编 ✗
//   实测教训 ✗：没有这段时它答过「大脑在 MiniMax」✓，而端点 `/v1/models` 明明是 `qwen3.8-27b` ✓
//   必须放这里（稳定前缀 ✓）：带时间戳会打掉本地模型的前缀 KV cache ✗（实测每轮命中 0 ✓）
let _runtimeFacts = null;
function runtimeFacts() {
  if (_runtimeFacts) return _runtimeFacts;   // 每轮同一串 ✓ 保住 KV 前缀 ✓（改配置要重启 ✓）
  const lan = /^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(cfg.llm.baseUrl || '');
  const parts = [
    `大模型 ${cfg.llm.model || '未知'}（端点 ${cfg.llm.baseUrl || '未知'}，${lan ? '局域网/本机 → **本地部署** ✓ 不是云端' : '远程端点'}）`,
    `语音识别 ${cfg.asr.model || '未知'}`,
    `语音合成 ${cfg.tts.backend || '未知'}${cfg.tts.voice ? ' · ' + cfg.tts.voice : ''}`,
    `麦克风采集 ${CAPTURE_MODE === 'browser' ? '浏览器（带 WebRTC 回声消除）' : '服务器'}`,
  ];
  if (cfg.env && cfg.env.city) parts.push(`所在城市 ${cfg.env.city}`);
  return (_runtimeFacts = `【你的运行环境】以这里为准 ✓ 不许凭记忆改 ✗；要更细的（负载 / 局域网 IP / 精确时间 / 天气）就调 env_info ✓：${parts.join('；')}。用户叫你「${cfg.wake.word}」。`);
}

function buildSystemMessage() {
  // 注意：这里必须保持"逐轮稳定"，否则会打掉本地模型的前缀 KV cache。
  // 实测：system 里带时间戳时每轮缓存命中 0（2000 token 提示词 ≈2.4s）；
  //      静态 system 时命中 ~2017/2022（≈0.5s）。所以动态内容一律放最后一条用户消息。
  const base = getSystemPrompt();
  const facts = runtimeFacts();
  return summary ? `${base}\n\n${facts}\n\n【历史会话摘要】（你和用户的早期对话已压缩成要点，供参考）\n${summary}` : `${base}\n\n${facts}`;
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
// ★ 快速打断 ✓：VAD 一报"speech"就先**暂停**播音（不等 ASR ✗ 那要 1~2s）
//   ASR 确认真插话 → interrupt() 彻底停；判成噪声/碎片 → resume 自动续播 ✓
let bargeHold = false;
let bargeHoldTimer = null;

function releaseBargeHold(resume) {
  if (!bargeHold) return;
  bargeHold = false;
  if (bargeHoldTimer) { clearTimeout(bargeHoldTimer); bargeHoldTimer = null; }
  if (resume) broadcast({ type: 'resume_tts' });
}

function interrupt() {
  if (activeLLM) activeLLM.controller.abort();
  activeLLM = null;
  ttsBuffers.clear();          // 丢弃未合成的句子
  ttsEpoch++;                  // ★ 作废所有在途的 700ms 延迟广播（被中断的段不能出声 ✗）
  currentTtsId = null;
  playbackUntil = 0;           // 播放已停：租约与"正在出声"窗口都要清零，
  speakingUntil = 0;           // 否则后续真人说话会被当成"播报中的回声"全部吞掉
  sendToWorker({ cmd: 'clear' });      // 丢弃待合成 + 停掉服务端正在播的音频（worker 侧实现）
  DUIX.cancel();                       // 丢弃待渲染段 + 中止正在渲的嘴形（最贵的一步 ✓）
  releaseBargeHold(false);             // 已经彻底停了：不再发 resume ✗（stop_tts 会清播放队列）
  broadcast({ type: 'stop_tts' });
}

// ★ 调试录音热开关 ✓：初值取 conf 的 debug.recordUserAudio ✓；界面「🎙 录音留证」勾选框可实时改 ✓（不重启 ✓）
let RECORD_AUDIO = Boolean(cfg.debug && cfg.debug.recordUserAudio);
// ★ 本轮"用户语音"的录音 URL ✓：开着 debug.recordUserAudio 时 worker 随 asr_result 一起带上来 ✓
//   界面用户气泡点一下就能回听自己当时说了什么 ✓（识别错时不用再靠日志猜 ✗）
let lastUserAudio = null;
let lastUserConf = null, lastUserParts = null;   // 「可信度」+ 分项 ✓（worker 算的 ✓ 服务端只转发 ✓）
const broadcastUserText = (text) => broadcast({ type: 'user_text', text, audio: lastUserAudio || undefined, conf: lastUserConf === null ? undefined : lastUserConf, conf_parts: lastUserParts || undefined });

/** 新会话 ✓：清逻辑历史 + 摘要 + 线上序列 ✓ 存盘 ✓ 并广播空 history（界面 renderHistory 会清空气泡 ✓） */
function resetSession() {
  history = [];
  summary = '';
  wireMessages = [];        // 线上序列一起清空 ✓（否则 KV 前缀还挂着旧对话 ✗）
  saveHistory();
  log.info('[History] cleared（新会话 ✓）');
  broadcast({ type: 'history', summary: '', messages: [], tokens: 0 });
}

/**
 * 给 filter 链准备上下文 ✓：**依赖从外面注入** ✓（filters.js 不许 require server.js ✗
 * 这样它是纯逻辑 ✓ 测试不用起服务 ✓）
 * @param {'pre'|'voice'|'text'} phase 调用点 ✓：pre=剥唤醒词前 ✓ voice=剥完之后 ✓ text=打字输入
 */
function filterCtx(phase, fromVoice, rms) {
  return {
    phase, fromVoice, rms,
    active: playbackActiveNow() || !!activeLLM,   // 正在播报或正在生成 ✓（pause_rply 在 pre 阶段要看它 ✓）
    log, broadcast, broadcastUserText, interrupt, announce,
    wakeGate, tripLoopBreaker, resetSession,
  };
}

/**
 * 处理一条用户输入
 * @returns {'accepted'|'stop'|'echo'|'ignored'|'loop'|'reset'|'sleep'|'wake'} 处理结论（供上层决定是否回显）
 */
function handleUserText(text, fromVoice, rms, audioUrl, conf, confParts) {
  lastUserAudio = audioUrl || null;
  lastUserConf = (typeof conf === 'number') ? conf : null;
  lastUserParts = confParts || null;
  lastUserActivity = Date.now();     // 会话仍有活动 → 保温窗口有效
  let input = text;
  // （停词判断不再写在这里 ✗：统一交给 filters 链 ✓ 见下方三个调用点 ✓）
  // ★ 唤醒电平下限 ✓：待命时，极低电平的碎片不该唤醒 ✗
  //   实证：噪声片段 rms=0.009 被识别成"嘟嘟"→ 命中(name 近音) → 触发 [Wake] + "在呢" ✗；
  //   用户真实呼唤实测 rms 0.05~0.09 ✓ → 用 0.02 作闸门 ✓（只限制唤醒 ✓ 已唤醒后的轻声指令不受影响 ✓）
  if (fromVoice && !wakeGate.awake && rms !== undefined && rms !== null && Number(rms) < WAKE_MIN_RMS) {
    log.info(`[Wake] 电平过低(${Number(rms).toFixed(4)} < ${WAKE_MIN_RMS})，不唤醒:`, JSON.stringify(String(input).slice(0, 16)));
    return 'ignored';
  }

  // ★ 这里曾有一道"播放期间除停词外一律丢弃"的硬门控 ✗ —— 已删除 ✓
  //   原因（实测反证 ✓）：播放期间 ASR 仍能正确认出用户的话（日志里 "别说了"/"别再说了"
  //   都是 playing=true 时识别正确的 ✓）→ 宁可交给下面"按内容比对"的回声守卫精确判断 ✓，
  //   也不能把用户真正的指令当回声丢掉 ✗。

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
    // ★ 调用点①：剥唤醒词**之前** ✓（播中/生成中听到停词 → 立刻收掉这一轮 ✓ 不等剥词 ✓）
    //   为什么必须在这里 ✓：唤醒状态下喊「别说了」时 gate.text 会被剥成空串 ✗
    //   随即被 `if (!input) return 'wake'` 静默丢掉 → 表现就是"喊停没反应"✓（实测踩过 ✗）
    const pre = filters.applyFilters(input, filterCtx('pre', fromVoice, rms));
    if (pre.handled) {
      log.info(`[Filter:${pre.id}] 处理（pre ✓）:`, JSON.stringify(String(input).slice(0, 20)), `→ ${pre.verdict}`);
      return pre.verdict;
    }
    if (!gate.accept) {
      if (gate.woke) {
        log.info('[Wake] 已唤醒:', JSON.stringify(gate.reason));
        broadcast({ type: 'wake_state', awake: true });
        announce(WAKE_ACK);
        return 'wake';
      }
      // 停止词已在上方统一处理（待命态/唤醒态都生效 ✓），这里不再重复
      // ★ 待命态收到**完整句子**（≥STANDBY_SENT_CHARS 字 ✓）→ 视为在跟它说话 ✓ 直接接话 ✓
      //   短碎片（"嗯"/"那个" ✓）仍按忽略处理 ✓（防环境闲聊误唤醒 ✓）
      if (STANDBY_SENT_CHARS > 0 && speakChars(input) >= STANDBY_SENT_CHARS) {
        log.info(`[Wake] 待命但收到完整句子（${speakChars(input)}字 ≥ ${STANDBY_SENT_CHARS}字 ✓）→ 直接接话:`,
                  JSON.stringify(input.slice(0, 24)));
        // 用户气泡由下方正常流程广播 user_text ✓（这里再广播一次会出现两个一样的气泡 ✗ 实测 ✓）
        wakeGate.forceWake();                                   // 会话转为已唤醒 ✓ 后续轮次正常续话 ✓
        broadcast({ type: 'wake_state', awake: true });
        gate.text = input;                                      // 整句当指令 ✓（下面取 gate.text ✓）
      } else {
        log.info('[Wake] 待命中，忽略:', JSON.stringify(input.slice(0, 24)), `(${gate.reason})`);
        // ★ 识别出来了就必须让界面有反应 ✓：原先这里只写日志 ✗ → 用户以为"我说了它一动不动"✓
        broadcastUserText(input);
        if (input.length >= 4) {
          broadcast({ type: 'notice', text: `💤 待命中 · 听到「${input.slice(0, 12)}」· 喊「${cfg.wake.word}」唤醒` });
        }
        return 'ignored';
      }
    }
    if (gate.woke) {
      log.info(`[Wake] 唤醒并执行指令: ${JSON.stringify(gate.text.slice(0, 24))}`);
      broadcast({ type: 'wake_state', awake: true });
      // 带指令时不播"在呢"：直接处理指令，省掉一次应答（更快听到答案）
    }
    input = gate.text;   // 唤醒词后的指令正文
    if (!input) return 'wake';
    // ★ 调用点②：剥唤醒词**之后** ✓（「露露同学，重启会话」→ 剥完正好命中 ✓）
    //   必须赶在"过短碎片忽略"之前 ✓：「拜拜」只有 2 字 ✗ 晚一步就被 minChars 吃掉了 ✓
    const post = filters.applyFilters(input, filterCtx('voice', fromVoice, rms));
    if (post.handled) {
      log.info(`[Filter:${post.id}] 处理（voice ✓）:`, JSON.stringify(String(input).slice(0, 20)), `→ ${post.verdict}`);
      return post.verdict;
    }
    // 唤醒词后面只粘了个碎音（实测 ASR 常把"潞潞同学"识别成"陆露露同学""呃露露同学""露露露同学"，
    // 唤醒词前面多粘一个字）→ 这**不是指令**，必须当纯唤醒处理并出声应答；
    // 否则用户喊了、系统醒了、却一声不吭，会以为"没识别到"。
    const shortCmd = filters.isShortCommand(input);   // 「说点话」这类短指令不受字数闸限制 ✓
    if (gate.woke && !wakeGate.isLongEnough(input) && !shortCmd) {
      log.info(`[Wake] 仅唤醒（尾音 ${JSON.stringify(input)} 当碎音丢弃）→ 播应答`);
      announce(WAKE_ACK);
      return 'wake';
    }
    // 过短碎片不当指令（环境闲聊常被切成一两个词，实测"是不是""接电话"）
    if (!wakeGate.isLongEnough(input) && !shortCmd) {
      log.info(`[Wake] 过短碎片忽略（<${wakeGate.minChars}字）:`, JSON.stringify(input.slice(0, 20)));
      return 'ignored';
    }
  } else {
    wakeGate.touch();    // 打字输入视为有效活动，刷新空闲计时
  }

  // ★ 调用点③：打字输入 / 上面都没认领的残余 ✓（停词永远按"停止指令"处理 ✓ 绝不进 LLM ✓
  //   否则空闲时会变成普通提问（"好呀，不说了"✓）+ 配合持续识别的回声就是一个死循环 ✗）
  const byText = filters.applyFilters(input, filterCtx('text', fromVoice, rms));
  if (byText.handled) {
    log.info(`[Filter:${byText.id}] 处理（text ✓）:`, JSON.stringify(String(input).slice(0, 20)), `→ ${byText.verdict}`);
    return byText.verdict;
  }
  // 生成中 / 播报中又来了新输入 → 先收掉当前一轮，再按新问题处理。
  // 必须显式 interrupt()：否则两轮 LLM 会并发流式（旧 controller 被覆盖 → 停止词也管不住它），
  // TTS 缓冲会被两个 id 来回清空，界面文字交错。
  if (playbackActiveNow() || activeLLM) {
    const longEnough = input.length >= BARGE_IN_MIN_CHARS || filters.isShortCommand(input);
    // ★ 打断电平闸 ✓：播放/生成期间的**低电平碎片**多半是残余回声被 ASR **幻觉成的句子** ✗
    //   实测铁证 ✗："那我终于走了" rms=0.0269 ✓、"我是一在的一个"同类 ✓ —— 都不是用户说的 ✓
    //   而用户真实插话实测 rms 0.047~0.087 ✓✓ → 0.035 正好卡在两者中间 ✓
    //   只卡"打断"这一条路 ✓：空闲时轻声说话不受影响 ✓；停止词在上面已处理 ✓ 永远不会被这道闸卡住 ✓
    const quietEcho = fromVoice && rms !== undefined && rms !== null && Number(rms) < BARGE_IN_MIN_RMS;
    if (quietEcho) {
      log.info(`[BargeIn] 忽略低电平碎片(rms=${Number(rms).toFixed(4)} < ${BARGE_IN_MIN_RMS})，疑似回声幻觉:`,
        JSON.stringify(input.slice(0, 20)));
      return 'echo';   // ✓ 不上屏（'echo' 会被上层抑制回显 ✓）→ 用户不会再看到"自己没说过的话"✓
    }
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
  broadcastUserText(input);
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
    // ★ 流式增量处理抽成函数 ✓：工具轮数超限时还要再请求一次"强制作答" ✓ 共用同一套逻辑 ✓
    const streamDelta = (delta) => {
      // 已被停止词打断 / 已被新问题取代：在途增量必须丢弃，否则会插进新一轮的气泡与语音
      if (controller.signal.aborted || (activeLLM && activeLLM.id !== id)) return;
      fullText += delta;
      broadcast({ type: 'llm_stream', content: delta, id });
      for (const c of chunker.push(delta)) enqueueSpeech(id, c);
    };

    // ★ 思考填充语 ✓：prefill 慢（实测 3.1k 提示词冷缓存 31s）时用户干等 = "没反应" ✗
    //   2.5s 还没出字 → 先说一句；12s 还没出字 → 再垫一句 ✓ 出字后不再插话 ✓
    let thinkFillerSpoken = false;
    const armThinkFiller = () => {
      const alive = () => !controller.signal.aborted && activeLLM && activeLLM.id === id;
      const t1 = setTimeout(() => {
        if (!alive() || fullText.trim() || thinkFillerSpoken) return;
        thinkFillerSpoken = true;
        enqueueSpeech(id, '嗯，我想一下。');
      }, 2500);
      const t2 = setTimeout(() => {
        if (!alive() || fullText.trim()) return;
        enqueueSpeech(id, '稍等，我在整理资料。');
      }, 12000);
      return () => { clearTimeout(t1); clearTimeout(t2); };
    };

    let result;
    while (true) {
      const roundStart = fullText.length;
      if (typeof scratchRetried === 'undefined') var scratchRetried = false;
      const disarmFiller = toolRounds === 0 ? armThinkFiller() : null;
      result = await client.chat({
        systemPrompt: sendSystem,
        messages: requestMessages,
        tools: toolDefs,
        signal: controller.signal,
        onDelta: streamDelta,
      });
      if (disarmFiller) disarmFiller();
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
          // 撤回草稿必须同时重置服务端 TTS 状态：不然队列里超出前瞻窗的草稿句还会被继续合成
          // （用户听到已撤回的内容），且 worker 的 clear 会连带丢掉 clear 之后才入队的句子，
          // 那些 tts_audio 永不返回 → inflight 永不归零 → 本轮剩余回答不再合成（整段静音）。
          const rbuf = ttsBuffers.get(id);
          if (rbuf) { rbuf.queue.length = 0; rbuf.inflight = 0; rbuf.paused = true; }
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
        // ★ 超限必须**强制作答** ✓：原来直接 break → 若最后一轮是工具调用 → 一个字都没有 ✗
        //   实测：「介绍一下苏东坡」连搜 3 次撞上限 → [LLM] done, 0 chars → 用户以为"不回答" ✗
        //   这里不带 tools 再请求一次 ✓ 逼它用已拿到的搜索结果给出最终答复 ✓
        log.warn('[Tools] 超过最大轮数 → 禁用工具，强制给出最终答复');
        result = await client.chat({
          systemPrompt: sendSystem,
          messages: requestMessages,
          tools: undefined,          // pi-client：tools 为空则不发送该字段 ✓
          signal: controller.signal,
          onDelta: streamDelta,
        });
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
        log.info(`[Tools] ${call.name} → ${brief.slice(0, 320)}`);   // 160 太短 ✗ 连 location/time 都看不全 ✓（截断曾让人误判"字段没填"✓）
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

    // 打断/被新问题取代后，旧 id 已经作废：此时还 flush 会让 enqueueSpeech 把新一轮的
    // 待合成队列清空（id 不匹配 → ttsBuffers.clear()），且残余半句仍会被合成播出。
    if (!controller.signal.aborted && activeLLM && activeLLM.id === id) {
      for (const c of chunker.flush()) enqueueSpeech(id, c);
    }

    if (result.stopReason === 'aborted') {
      log.info('[LLM] interrupted');
      const partial = fullText.trim();
      if (partial.length >= 10) pushMessage({ role: 'assistant', content: `${partial}（被打断）` });
      // ★ 线上序列也必须追加这份残句 ✓：本模块的前提是"[system+历史+本轮] 逐字节是上轮请求的前缀"
      //   ✗ 原实现在打断时只写 history、不写 wireMessages → 下轮前缀与上轮实际发出的内容不再一致
      //   → KV 前缀失配 ✓（缓存白丢）+ 模型下一轮不记得自己刚说过的半句 ✓
      //   残句本身是稳定文本 ✓ 追加后前缀依旧单调增长 ✓ 不会被改写 ✓
      appendWireAssistant(partial);
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
      appendWireAssistant(partial);              // 同上 ✓ 打断也要保住线上序列的前缀一致性 ✓
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
    ws.send(JSON.stringify({ type: 'hello', capture: CAPTURE_MODE, playback: PLAYBACK_MODE, sampleRate: 16000, frameSamples: 1280, wakeWord: cfg.wake.word, wakeRequired: WAKE_REQUIRED, awake: wakeGate.awake, recordAudio: RECORD_AUDIO }));
    // ★ 刚打开/刷新页面就把真人海报推过去 ✓（数字人面板不用等第一句话 ✓）
    // ★ 海报用**磁盘上的**也行 ✓：池子就绪要 30 秒 ✗（MuseTalk ✓）那段时间会先显示 3D ✗
    //   文件在 public/ 里 ✓ 刷新就能立刻切 2D ✓
    if (DUIX.enabled) {
      let url = DUIX.poster;
      if (!url) {
        const pj = path.join(__dirname, 'public', 'duix_poster.jpg');
        const idleOk = fs.existsSync(path.join(__dirname, 'public', 'duix_idle', 'manifest.json'));
        if (fs.existsSync(pj) && idleOk) {
          url = '/duix_poster.jpg?v=' + Math.floor(fs.statSync(pj).mtimeMs);
        }
      }
      if (url) ws.send(JSON.stringify({ type: 'duix_poster', url, idle: '/duix_idle' }));
    }
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
          activeSource = source === 'browser' ? 'browser' : 'server';   // 与下面转发给 worker 的 source 保持一致 ✓
          // ★ 放音端自动配对：浏览器采集 → 浏览器播放（Chrome WebRTC AEC 才有完整参考 ✓）
          //                       服务端采集 → 服务端喇叭（服务端 AEC 才有参考 ✓）
          // ✗ 混用（如浏览器采集 + 服务端播放）→ 两边都没有参考信号 = 完全没有回声消除（用户实测过 ✗）
          sendToWorker({ cmd: 'set_playback', server: activeSource !== 'browser' });
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
          if (!v) break;
          // 引擎：显式传优先 ✓；否则按音色串推断（piper: 前缀 → 本地 Piper，其余按在线 edge ✓）
          const engine = (String(msg.engine || '').toLowerCase()
            || (v.startsWith('piper:') ? 'piper' : 'edge'));
          if (v === currentVoice && engine === currentBackend) break;
          if (engine !== currentBackend) {
            currentBackend = engine;
            sendToWorker({ cmd: 'set_backend', backend: engine });   // 热切换，不重启 worker
          }
          currentVoice = v;
          persistVoice(engine, v);
          for (const k of Object.keys(prewarmPaths)) delete prewarmPaths[k];
          prewarmPhrases();   // 换音色后重新预生成
          log.info(`[TTS] 已切换：${engine} / ${v}`);
          pushRuntimeInfo();   // 引擎/音色换了 ✓ 工具里的状态要跟着换 ✓（否则 env_info 报旧音色 ✗）
          break;
        }
        case 'record_audio': {
          // ★ 界面勾选框 → worker 热开关 ✓（worker 回 record_ack ✓ 只写日志 ✗ 界面不重复提示）
          RECORD_AUDIO = !!msg.on;
          sendToWorker({ cmd: 'set_record', on: RECORD_AUDIO });
          log.info(`[Debug] 调试录音 → ${RECORD_AUDIO ? '开 ✓（每句存 temp/asr_kept/ ✓ 气泡可回放 ▶）' : '关 ✗（不再存盘 ✓）'}`);
          break;
        }
        case 'set_speed': {
          const sp = Math.max(0.5, Math.min(2.0, Number(msg.speed) || 1.0));
          sendToWorker({ cmd: 'set_speed', speed: sp });     // 热调，不用重启 ✓
          try {
            const c = JSON.parse(fs.readFileSync(CONF_PATH, 'utf8'));
            c.tts = c.tts || {}; c.tts.speed = sp;
            fs.writeFileSync(CONF_PATH, JSON.stringify(c, null, 2), 'utf8');
            log.info(`[TTS] 语速已持久化：${sp}`);
          } catch (e) { log.warn('[TTS] 语速持久化失败', e.message); }
          break;
        }
        case 'client_info':
          // 浏览器上报的真实采集参数（回声消除/降噪/AGC 实际是否生效 ✓）
          log.info('[capture·client] ' + JSON.stringify(msg.capture || {}));
          break;
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
            // 注入路径也带上录音 URL / 可信度 ✓：这样**不用麦克风**也能验用户气泡的 ▶ 与「可信度」渲染 ✓
            const verdict = handleUserText(msg.text, true, msg.rms, msg.audio_url, msg.conf, msg.conf_parts);
            log.info('[ASR·注入] 判定:', verdict);
            if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'asr_sim_verdict', text: msg.text, verdict }));
          }
          break;
        case 'duix_switch':
          if (DUIX.switchPack(msg.pack)) {
            const nm = (typeof DUIX_NAMES !== 'undefined' && DUIX_NAMES[msg.pack]) || msg.pack;
            broadcast({ type: 'notice', text: `数字人已切换为「${nm}」（约 1 秒）` });
          }
          break;
        case 'clear_history':
          interrupt();
          resetSession();   // ★ 与「重启会话」filter 共用一份实现 ✓（清历史/摘要/线上序列 + 存盘 + 广播 ✓）
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
  // ★ 缓存里存的是 **basename** ✓（见 `ttsBaseName` ✓）；但 `temp/` 有 15 分钟过期清扫 ✓（每 5 分钟一次 ✓）
  //   不验存在性就会广播一个 404 → 表现为"喊了唤醒词，界面有字，但没有声音"✓
  const cached = prewarmPaths[text];                 // basename ✓（见 ttsBaseName 注释 ✓）
  const cachedFile = cached ? path.join(__dirname, 'temp', cached) : '';
  const cacheUsable = !!cached && fs.existsSync(cachedFile);
  if (cached && !cacheUsable) {          // 自愈：丢掉死缓存 + 重新预生成 → 下一次唤醒就是热的 ✓
    log.info('[Announce] 预生成音频已失效，重新预热:', cached);
    delete prewarmPaths[text];
    prewarmPhrases();
  }
  if (cacheUsable && !SERVER_PLAYBACK) {
    // 预生成短句目前只服务浏览器播放（缓存里只有文件路径，没有时长，也无从让 worker 直接播）：
    // speakingUntil 用字数估算（中文约 4.5 字/秒，与 worker 侧估值一致），否则回声门控
    // 会把喇叭/浏览器的播报当成用户说话；server|both|auto 时浏览器不播放，必须走下面的
    // 正常管线，否则唤醒应答只上屏不出声。缓存因此暂不覆盖服务端放音。
    const estMs = Math.round((text.length / 4.5) * 1000);
    speakingUntil = Math.max(Date.now(), speakingUntil) + estMs + ECHO_TAIL_MS;
    broadcast({ type: 'tts_audio', audio_path: cached, text, id, play_mode: PLAYBACK_MODE,
                visemes: textToVisemes(text) });
    DUIX.render({ id, text, audio_path: cached });   // 预生成的「在呢」也要出数字人 ✓
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
  // ★ 渲染进程加载模型期间别去撞 Strata ✓：实测 parking 会从 100ms 涨到 47s ✗
  if (DUIX.enabled && !DUIX.allReady) return 'duix-loading';
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

// 端口被占 = 已经有实例在跑 ✗ 必须把子进程带走 ✗ 否则留下孤儿渲染进程 ✗
server.on('error', (e) => {
  log.error(`[启动] 监听 ${PORT} 失败: ${e.message}`);
  try { DUIX.cleanup(); } catch (x) {}
  process.exit(1);
});

server.listen(PORT, () => {
  log.info(`VoiceAI server running at http://localhost:${PORT}`);
  log.info(`LLM endpoint: ${LLM_BASE_URL}`);
  log.info(`Python worker: ${PYTHON_PATH}`);
  log.info(`Node: ${process.execPath} (${process.platform})`);
  log.info(`采集模式: ${CAPTURE_MODE}${CAPTURE_MODE === 'browser' ? '（浏览器麦克风 + WebRTC AEC）' : '（Python sounddevice）'}`);
});
