/**
 * config.js — 统一配置加载（Node 侧）
 *
 * 优先级（后者覆盖前者）：内置默认 < conf.json < 环境变量 < 命令行 --set=KEY=VALUE
 * 命令行与环境变量都保留，是为了：
 *   - 从 WSL 启动 Windows node.exe 时 Linux 环境变量不转发 → 用 --set=
 *   - 一次性实验/测试不必改 conf.json
 *
 * Python worker 读同一份 conf.json（见 worker.py 的 load_conf），保证全系统一个真相。
 * 取不到值时才回落到内置默认，所以 conf.json 里少写几个键也不会出问题。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const CONF_PATH = process.env.VOICEAI_CONF || process.argv.slice(2).find((a) => a.startsWith('--conf='))?.slice(7)
  || path.join(__dirname, 'conf.json');

/** 内置默认（conf.json 缺失/缺键时的兜底，与 conf.json 保持同构） */
const DEFAULTS = {
  port: 8214,
  capture: 'browser',
  dataDir: '',
  log: { level: 'info', dir: '', file: true },
  llm: {
    baseUrl: 'http://192.168.3.166:1234',
    model: 'qwen3.8-27b',
    apiKey: 'local',
    thinking: false,
    maxTokens: 2048,
    contextWindow: 256000,
    firstEventTimeoutMs: 90000,
    idleTimeoutMs: 30000,
    toolMaxRounds: 3,
    dump: '',
  },
  history: { compressAt: 160000, keepRecent: 12, maxMessages: 400 },
  kvWarm: { enabled: true, idleMs: 60000, keepMs: 1800000, minMessages: 2, tickMs: 10000 },
  tts: {
    backend: 'piper', playback: 'server', provider: 'auto', piperDir: '', kokoroDir: '', kokoroProvider: 'cpu', kokoroVoice: 0, kokoroVoiceName: 'zf_001', kokoroSidecarPython: '', kokoroSidecarPath: '', voice: 'zh-CN-XiaoxiaoNeural', modelDir: '', outputDevice: '', outputRate: 0, outputChannels: 0,
    threads: 4, timeoutSec: 15, retries: 2, failLimit: 3, lookahead: 2,
  },
  aec: { enabled: true, taps: 2048 },
  asr: { model: 'paraformer-zh', vadModel: 'fsmn-vad', device: 'cpu', targetRms: 0.1, maxGain: 8.0 },
  vad: {
    energyMin: 0.02, floorMax: 0.025, mult: 3.0, silenceMs: 1200, shortSilenceMs: 500,
    shortUtteranceS: 2.5, preRollBlocks: 5, maxUtteranceS: 30,
    playbackGateMult: 1.8, playbackSilenceMs: 900, playbackMaxUtteranceS: 12.0,
  },
  wake: { enabled: true, word: '潞潞同学', ack: '在呢', idleMs: 25000, minChars: 3 },
  echo: { tailMs: 900, windowMs: 25000, minMatch: 6 },
  bargeIn: { enabled: true, minChars: 5 },
  loopBreaker: { similarity: 0.5, hits: 2 },
  worker: { python: '', stallMs: 45000, audioMaxPending: 25, handshakeMs: 15000 },
  tools: { timeoutMs: 30000, configPath: 'config/tools.json' },
  debug: { noWorker: false, emptyAsrDump: false, asrSim: false },
};

/** 环境变量 → 配置路径（保留既有变量名，不破坏已有用法与测试） */
const ENV_MAP = {
  PORT: ['port', 'int'],
  VOICEAI_CAPTURE: ['capture', 'str'],
  VOICEAI_DATA_DIR: ['dataDir', 'str'],
  VOICEAI_CONF: null,                       // 只用于定位文件
  VOICEAI_LOG_LEVEL: ['log.level', 'str'],
  VOICEAI_LOG_DIR: ['log.dir', 'str'],
  VOICEAI_LOG_FILE: ['log.file', 'bool'],
  LLM_BASE_URL: ['llm.baseUrl', 'str'],
  LLM_MODEL: ['llm.model', 'str'],
  LLM_API_KEY: ['llm.apiKey', 'str'],
  VOICEAI_THINKING: ['llm.thinking', 'bool'],
  VOICEAI_CTX_LIMIT: ['llm.contextWindow', 'int'],
  VOICEAI_LLM_FIRST_MS: ['llm.firstEventTimeoutMs', 'int'],
  VOICEAI_LLM_IDLE_MS: ['llm.idleTimeoutMs', 'int'],
  VOICEAI_LLM_DUMP: ['llm.dump', 'str'],
  VOICEAI_TOOL_MAX_ROUNDS: ['llm.toolMaxRounds', 'int'],
  VOICEAI_CTX_COMPRESS_AT: ['history.compressAt', 'int'],
  VOICEAI_CTX_KEEP_RECENT: ['history.keepRecent', 'int'],
  VOICEAI_KV_WARM: ['kvWarm.enabled', 'bool'],
  VOICEAI_KV_WARM_IDLE_MS: ['kvWarm.idleMs', 'int'],
  VOICEAI_KV_WARM_KEEP_MS: ['kvWarm.keepMs', 'int'],
  VOICEAI_KV_WARM_MIN_MSGS: ['kvWarm.minMessages', 'int'],
  VOICEAI_KV_WARM_TICK_MS: ['kvWarm.tickMs', 'int'],
  VOICEAI_TTS: ['tts.backend', 'str'],
  VOICEAI_TTS_PROVIDER: ['tts.provider', 'str'],
  VOICEAI_PLAYBACK: ['tts.playback', 'str'],
  VOICEAI_AEC: ['aec.enabled', 'bool'],
  VOICEAI_PIPER_MODEL: ['tts.piperDir', 'str'],
  VOICEAI_KOKORO_MODEL: ['tts.kokoroDir', 'str'],
  VOICEAI_KOKORO_PROVIDER: ['tts.kokoroProvider', 'str'],
  VOICEAI_KOKORO_SIDECAR_PY: ['tts.kokoroSidecarPython', 'str'],
  VOICEAI_KOKORO_SIDECAR_PATH: ['tts.kokoroSidecarPath', 'str'],
  VOICEAI_TTS_OUT_DEVICE: ['tts.outputDevice', 'str'],
  VOICEAI_TTS_OUT_RATE: ['tts.outputRate', 'int'],
  VOICEAI_TTS_OUT_CH: ['tts.outputChannels', 'int'],
  VOICEAI_TTS_MODEL: ['tts.modelDir', 'str'],
  VOICEAI_TTS_THREADS: ['tts.threads', 'int'],
  VOICEAI_TTS_TIMEOUT: ['tts.timeoutSec', 'float'],
  VOICEAI_TTS_RETRIES: ['tts.retries', 'int'],
  VOICEAI_TTS_FAIL_LIMIT: ['tts.failLimit', 'int'],
  VOICEAI_AUDIO_MAX_PENDING: ['worker.audioMaxPending', 'int'],
  VOICEAI_WAKE: ['wake.enabled', 'bool'],
  VOICEAI_WAKE_WORD: ['wake.word', 'str'],
  VOICEAI_WAKE_ACK: ['wake.ack', 'str'],
  VOICEAI_IDLE_MS: ['wake.idleMs', 'int'],
  VOICEAI_MIN_UTTERANCE_CHARS: ['wake.minChars', 'int'],
  VOICEAI_ECHO_TAIL_MS: ['echo.tailMs', 'int'],
  VOICEAI_ECHO_WINDOW_MS: ['echo.windowMs', 'int'],
  VOICEAI_ECHO_MIN_MATCH: ['echo.minMatch', 'float'],
  VOICEAI_BARGE_IN: ['bargeIn.enabled', 'bool'],
  VOICEAI_BARGE_IN_MIN_CHARS: ['bargeIn.minChars', 'int'],
  VOICEAI_LOOP_BREAKER_SIM: ['loopBreaker.similarity', 'float'],
  VOICEAI_LOOP_BREAKER_HITS: ['loopBreaker.hits', 'int'],
  VOICEAI_TOOL_TIMEOUT_MS: ['tools.timeoutMs', 'int'],
  VOICEAI_NO_WORKER: ['debug.noWorker', 'bool'],
  VOICEAI_ASR_SIM: ['debug.asrSim', 'bool'],
};

const cast = (raw, type) => {
  if (raw === undefined) return undefined;
  if (type === 'int') { const n = parseInt(raw, 10); return Number.isFinite(n) ? n : undefined; }
  if (type === 'float') { const n = parseFloat(raw); return Number.isFinite(n) ? n : undefined; }
  if (type === 'bool') return !['0', 'false', 'no', 'off', ''].includes(String(raw).toLowerCase());
  return String(raw);
};

function setPath(obj, dotted, value) {
  const parts = dotted.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
}

function getPath(obj, dotted) {
  let cur = obj;
  for (const p of dotted.split('.')) {
    if (cur === null || typeof cur !== 'object' || !(p in cur)) return undefined;
    cur = cur[p];
  }
  return cur;
}

function deepMerge(base, over) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  for (const [k, v] of Object.entries(over || {})) {
    if (k.startsWith('_')) continue;                       // _readme 之类的注释键
    if (v && typeof v === 'object' && !Array.isArray(v) && base && typeof base[k] === 'object' && base[k] !== null) {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

let fileCfg = {};
let fileError = null;
try {
  if (fs.existsSync(CONF_PATH)) fileCfg = JSON.parse(fs.readFileSync(CONF_PATH, 'utf8'));
  else fileError = `未找到 ${CONF_PATH}（用内置默认值）`;
} catch (e) {
  fileError = `解析 ${CONF_PATH} 失败: ${e.message}（用内置默认值）`;
}

const cfg = deepMerge(deepMerge(DEFAULTS, fileCfg), {});

// 环境变量覆盖（值来自 process.env；server.js 已把 --set=KEY=VALUE 写进 process.env）
const applied = [];
for (const [envKey, spec] of Object.entries(ENV_MAP)) {
  if (!spec) continue;
  const [dotted, type] = spec;
  const raw = process.env[envKey];
  if (raw === undefined) continue;
  const val = cast(raw, type);
  if (val === undefined) continue;
  if (getPath(cfg, dotted) === val) continue;              // 与默认相同就不记
  setPath(cfg, dotted, val);
  applied.push(`${envKey} → ${dotted}=${JSON.stringify(val)}`);
}

cfg.__meta = { path: CONF_PATH, fileError, overrides: applied };

module.exports = { cfg, CONF_PATH, ENV_MAP, getPath, setPath };
