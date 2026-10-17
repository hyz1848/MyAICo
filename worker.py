#!/usr/bin/env python3
"""
VoiceAI Python Worker - recording + streaming VAD + ASR + TTS.
Protocol: JSON lines via stdin/stdout.

Input commands:
  {"cmd": "listen"}                     - start continuous listening (VAD auto-detects utterances)
  {"cmd": "stop_listen"}                - stop listening
  {"cmd": "playback", "on": true|false} - browser TTS playing (gate echo-triggered speech)
  {"cmd": "tts", "text": "...", "voice": "..."}
  {"cmd": "ping"}

Output events:
  {"type": "vad_state", "state": "listening|speech|transcribing|off"}
  {"type": "audio_level", "level": 0.05}
  {"type": "asr_result", "text": "..."}
  {"type": "tts_audio", "audio_path": "...", "text": "..."}
  {"type": "error", "error": "..."}
  {"type": "ready"}
"""

import sys
import os
import json
import threading
import queue
import time
import uuid
import base64
from collections import deque

sys.stdin.reconfigure(encoding='utf-8')
sys.stdout.reconfigure(encoding='utf-8')
sys.stderr.reconfigure(encoding='utf-8')

import numpy as np
import sounddevice as sd
import soundfile as sf

# ========== 统一配置（与 Node 侧共用 conf.json）==========
import json as _json
import os as _os

CONF_PATH = _os.environ.get("VOICEAI_CONF") or _os.path.join(
    _os.path.dirname(_os.path.abspath(__file__)), "conf.json")
try:
    with open(CONF_PATH, "r", encoding="utf-8") as _f:
        _CONF = _json.load(_f)
except Exception as _e:      # 缺失/损坏就用下面代码里的默认值
    _CONF = {}
    print(f"[conf] 读取 {CONF_PATH} 失败，使用内置默认: {_e}", file=sys.stderr, flush=True)


def conf(path, default=None):
    """按 'a.b.c' 取值；缺失则用默认"""
    cur = _CONF
    for part in str(path).split("."):
        if not isinstance(cur, dict) or part not in cur:
            return default
        cur = cur[part]
    return cur


def conf_num(path, default):
    try:
        return float(conf(path, default))
    except (TypeError, ValueError):
        return float(default)


def conf_int(path, default):
    try:
        return int(float(conf(path, default)))
    except (TypeError, ValueError):
        return int(default)


def conf_bool(path, default):
    v = conf(path, default)
    if isinstance(v, bool):
        return v
    return str(v).lower() not in ("0", "false", "no", "off", "")


def cenv(env_name, path, default, cast=str):
    """环境变量 > conf.json > 内置默认（保留旧的环境变量用法）"""
    raw = _os.environ.get(env_name)
    if raw is not None:
        try:
            return cast(raw)
        except (TypeError, ValueError):
            pass
    return cast(conf(path, default))


SAMPLE_RATE = 16000
CHANNELS = 1
BLOCK_SIZE = 1280  # 80ms

VAD_ENERGY_MIN = conf_num("vad.energyMin", 0.02)    # absolute RMS floor for the gate
VAD_FLOOR_MAX = conf_num("vad.floorMax", 0.025)    # 噪声底硬上限：超过这个值就可能把正常说话判成静音
VAD_MULT = conf_num("vad.mult", 3.0)           # onset threshold = max(MIN, noise_floor * MULT)
SILENCE_MS = conf_int("vad.silenceMs", 1200)       # trailing silence that closes an utterance
SHORT_SILENCE_MS = conf_int("vad.shortSilenceMs", 500)  # 短句（<SHORT_UTTERANCE_S）用更短静音窗，减少等待感
SHORT_UTTERANCE_S = conf_num("vad.shortUtteranceS", 2.5) # 判定"短句"的时长阈值
PRE_ROLL = conf_int("vad.preRollBlocks", 5)            # blocks kept before onset (~400ms)
MAX_UTTERANCE_S = conf_num("vad.maxUtteranceS", 30)     # segments longer than this are treated as ambient noise
PLAYBACK_TAIL_S = cenv("VOICEAI_ECHO_TAIL_MS", "echo.tailMs", 900, float) / 1000.0  # 播报结束后的余音压制窗
PLAYBACK_GATE_MULT = conf_num("vad.playbackGateMult", 1.8) # 播报中/余音期的起始门限倍数（配合内容过滤，门限不宜过狠否则听不到打断）
PLAYBACK_SILENCE_MS = conf_int("vad.playbackSilenceMs", 900)   # 播报期的静音窗（比正常 1200ms 略短，兼顾"说停能较快生效"）
PLAYBACK_MAX_UTTERANCE_S = conf_num("vad.playbackMaxUtteranceS", 12.0)  # 播报期最长片段：留足空间，避免把用户的话切碎（回声交给内容过滤）

TMP_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "temp")
os.makedirs(TMP_DIR, exist_ok=True)

_print_lock = threading.Lock()
_cmd_queue = queue.Queue()
_asr_queue = queue.Queue()     # 待识别音频段（VAD 线程 → 识别线程）
_level_queue = queue.Queue()
_block_queue = queue.Queue()

_listen_active = False
_playback_active = False
_playback_since = 0.0
_playback_off_at = 0.0
_feed_mode = False        # 采集来自浏览器（浏览器端 WebRTC AEC），而非本地 sounddevice
_empty_dump_idx = 0       # 空识别结果音频的循环存盘序号（诊断用）
_stream = None


# ========== 服务端放音 + AEC ==========
# 为什么必须同进程：AEC 的参考信号 = 我们喂给声卡的样本，要与麦克风严格同源同时间轴。
# 浏览器放音时参考信号在浏览器里，Python 侧拿不到 → 只能靠能量门限/内容比对硬扛（就是之前的状态）。
TTS_PLAYBACK = cenv("VOICEAI_PLAYBACK", "tts.playback", "server", str).lower()   # server|browser|both|auto
# server = 只服务器喇叭（可做 AEC ✓）；browser = 只有浏览器（纯远程 ✓，服务器不吵）
# both = 两边都放；auto = 服务器照常放 ✓ + 远程浏览器也放 ✓（本地浏览器不播，避免同屋双响 ✗）
PLAY_SERVER = TTS_PLAYBACK in ("server", "both", "auto")
PLAY_BROWSER = TTS_PLAYBACK in ("browser", "both", "auto")
AEC_ENABLED = conf_bool("aec.enabled", True) and PLAY_SERVER

_aec = None
if AEC_ENABLED:
    try:
        from aec import EchoCanceller
        _aec = EchoCanceller(sample_rate=SAMPLE_RATE,
                             taps=conf_int("aec.taps", 2048),
                             delay_samples=conf_int("aec.delaySamples", 0),
                             mu=conf_num("aec.mu", 0.4))
        print(f"[aec] 已启用 taps={conf_int('aec.taps', 2048)} "
              f"delay={conf_int('aec.delaySamples', 0)} 样本 mu={conf_num('aec.mu', 0.4)}",
              file=sys.stderr, flush=True)
    except Exception as _e:
        _aec = None
        print(f"[aec] 初始化失败，退回无 AEC: {_e}", file=sys.stderr, flush=True)

_player = None
_aec_report = type('R', (), {})()


def resample(data, sr, target):
    """线性插值重采样（TTS 多为 22.05k/24k，够用且不依赖 scipy ✗）"""
    if sr == target or len(data) == 0:
        return data
    n = max(1, int(round(len(data) * target / float(sr))))
    idx = np.linspace(0, len(data) - 1, n, dtype=np.float64)
    return np.interp(idx, np.arange(len(data), dtype=np.float64), data).astype(np.float32)


class Player:
    """服务端放音（sounddevice 输出流）。回调里把输出样本喂给 AEC 作为参考信号。

    输出率**不能**沿用采集的 16kHz ✗：那会让所有 TTS 降到电话音质（发闷），
    某些端点（MME/HDMI）在 16k 单声道下甚至直接静音 ✗ → 默认用设备原生率。
    """

    def __init__(self, aec=None, samplerate=None, blocksize=BLOCK_SIZE,
                 device=None, aec_rate=None, channels=None):
        dev = device if device is not None else (conf("tts.outputDevice") or None)
        if isinstance(dev, str):
            dev = dev.strip()
            if not dev:
                dev = None
            elif dev.lstrip('+-').isdigit():
                dev = int(dev)      # 纯数字按索引解析 ✗ 否则 "9" 会被当名字子串，撞上 MU900 里的 9
        self.device = dev
        self.aec_rate = int(aec_rate or SAMPLE_RATE)
        self.sr = int(samplerate or conf_int("tts.outputRate", 0) or self._device_rate())
        self.ch = int(channels or conf_int("tts.outputChannels", 0) or self._device_channels())
        self.bs = int(blocksize)
        self.aec = aec
        self._lock = threading.Lock()
        self._items = deque()          # 待播 [(id, 输出率数组, 采集率参考数组)]
        self._cur = None               # [id, out, ref, pos]
        self._stream = None
        self._events = queue.Queue()   # 回调线程投递，交给上报线程发（回调里不能阻塞写 stdout）
        self.playing_id = None
        self.dropped = 0               # 中断丢弃的段数（诊断用）

    def _device_rate(self):
        try:
            return int(sd.query_devices(self.device, kind='output')['default_samplerate'])
        except Exception:
            return 48000

    def _device_channels(self):
        """输出声道数：**不能**用 1 ✗（本机实测：单声道流在该端点打开成功但完全不出声 ✓）
        → 用设备能力上限，通常 2；单声道内容在回调里复制到每个声道。"""
        try:
            n = int(sd.query_devices(self.device, kind='output')['max_output_channels'])
            return max(1, min(2, n))
        except Exception:
            return 2

    def _ensure_stream(self):
        if self._stream is None:
            self._stream = sd.OutputStream(samplerate=self.sr, channels=self.ch, dtype="float32",
                                           blocksize=self.bs, device=self.device,
                                           callback=self._callback)
            self._stream.start()
            try:
                name = sd.query_devices(self.device, kind='output')['name']
            except Exception:
                name = str(self.device)
            print(f"[tts] 服务端放音已启动（{self.sr}Hz × {self.ch}声道 → {name[:34]}，"
                  f"AEC 参考 {self.aec_rate}Hz，AEC={'开' if self.aec else '关'}）",
                  file=sys.stderr, flush=True)

    def enqueue(self, path, item_id=None):
        data, sr = sf.read(path, dtype="float32")
        if data.ndim > 1:
            data = data.mean(axis=1)
        out = resample(data, sr, self.sr)
        # AEC 参考必须与麦克风同率同时间轴（环形缓冲按样本计数对齐）
        ref = out if self.sr == self.aec_rate else resample(data, sr, self.aec_rate)
        with self._lock:
            self._items.append((item_id, out, ref))
        self._ensure_stream()

    def stop(self):
        """立即停（打断用）：清当前段与待播队列"""
        with self._lock:
            dropped = (1 if self._cur else 0) + len(self._items)
            self._items.clear()
            self._cur = None
            self.playing_id = None
        self.dropped += dropped
        return dropped

    def is_playing(self):
        with self._lock:
            return self._cur is not None or len(self._items) > 0

    def drain_events(self):
        out_ev = []
        while True:
            try:
                out_ev.append(self._events.get_nowait())
            except queue.Empty:
                return out_ev

    def _callback(self, outdata, frames, time_info, status):
        buf = np.zeros(frames, dtype=np.float32)
        pos = 0
        refs = []
        with self._lock:
            while pos < frames:
                if self._cur is None:
                    if not self._items:
                        break
                    item_id, out, ref = self._items.popleft()
                    self._cur = [item_id, out, ref, 0]
                    self.playing_id = item_id
                    self._events.put(("start", item_id, len(out) / float(self.sr)))
                item_id, out, ref, p = self._cur
                take = min(frames - pos, len(out) - p)
                if take <= 0:
                    self._events.put(("end", item_id, None))
                    self._cur = None
                    self.playing_id = None
                    continue
                buf[pos:pos + take] = out[p:p + take]
                # AEC 参考按输出位置成比例取片：与播放严格同时间轴，且天然无漂移
                r0 = int(p * self.aec_rate / self.sr)
                r1 = int((p + take) * self.aec_rate / self.sr)
                if r1 > r0:
                    refs.append(ref[r0:r1])
                self._cur[3] = p + take
                pos += take
        for c in range(outdata.shape[1]):
            outdata[:, c] = buf
        if self.aec is not None:
            if refs:
                self.aec.add_reference(refs[0] if len(refs) == 1 else np.concatenate(refs))
            else:
                # 空闲也喂参考：只喂播放样本会让参考时间轴停走，环形缓冲和麦克风时钟错位
                # （下一段开始时取窗取到的是几秒前的位置）。空档期补等长零样本；
                # 播放路径仍走上面的切片，保持零分配。
                self.aec.add_reference(np.zeros(
                    int(round(frames * self.aec_rate / float(self.sr))), dtype=np.float32))


def push_block(arr):
    """把一帧 float32 音频放进 VAD 队列；队列过长时丢最老的，避免慢消费者积压"""
    while _block_queue.qsize() >= 400:   # ~32s 缓冲：识别线程短暂占用也不会顶掉新音频
        try:
            _block_queue.get_nowait()
        except queue.Empty:
            break
    _block_queue.put(arr)


def out(obj):
    with _print_lock:
        sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
        sys.stdout.flush()


# ========== Audio ==========
def audio_callback(indata, frames, time_info, status):
    # 采集侧回声消除：先用 AEC 减去估计回声，再做 VAD/识别。
    # 参考信号由 Player 的播放回调提供（同进程、同时间轴），这是能真正消回声的前提。
    block = np.asarray(indata[:, 0], dtype=np.float32) if indata.ndim > 1 else np.asarray(indata, dtype=np.float32)
    if _aec is not None:
        block = _aec.process(block)
    if _listen_active:
        push_block(block)
    rms = float(np.sqrt(np.mean(block * block)))
    try:
        _level_queue.put_nowait(round(rms, 4))
    except queue.Empty:
        pass


def drain_blocks():
    n = 0
    while not _block_queue.empty() and n < 10000:
        try:
            _block_queue.get_nowait()
            n += 1
        except queue.Empty:
            break


# ========== Streaming VAD loop ==========
def listen_loop():
    global _listen_active, _empty_dump_idx
    state = "idle"
    collected = []
    speech_start = 0.0
    preroll = deque(maxlen=PRE_ROLL)
    last_voice = 0.0
    noise_floor = 0.002

    out({"type": "vad_state", "state": "listening"})

    while _listen_active:
        try:
            block = _block_queue.get(timeout=0.1)
        except queue.Empty:
            continue

        rms = float(np.sqrt(np.mean(block * block)))
        now = time.time()
        threshold = max(VAD_ENERGY_MIN, noise_floor * VAD_MULT)
        echo_suppress = _playback_active or (now - _playback_off_at) < PLAYBACK_TAIL_S

        if state == "idle":
            preroll.append(block)
            if rms < threshold:
                # 回落要快：响过一段（播报/噪声）后噪声底会被抬高，
                # 若不快速回落，接下来用户轻声说话会被当成静音切掉（表现为"说了没反应"）
                rate = 0.2 if (echo_suppress or rms < noise_floor) else 0.05
                noise_floor = (1 - rate) * noise_floor + rate * rms
                noise_floor = min(noise_floor, VAD_FLOOR_MAX)   # 硬上限，绝不允许被抬到压住人声
            onset_gate = threshold * (PLAYBACK_GATE_MULT if echo_suppress else 1.0)
            if rms > onset_gate and now - _playback_since > 0.5:
                state = "speech"
                speech_start = now
                collected = list(preroll) + [block]
                preroll.clear()
                last_voice = now
                out({"type": "vad_state", "state": "speech"})

        elif state == "speech":
            collected.append(block)
            if rms > threshold * 0.7:
                last_voice = now
            else:
                # 静音窗自适应：短句（唤醒词/短指令）用更短的窗，明显降低"说完还要等"的感觉；
                # 长句仍用长窗，避免说话中间换气被切断。
                elapsed = now - speech_start
                if echo_suppress:
                    silence_need = PLAYBACK_SILENCE_MS / 1000.0
                elif elapsed < SHORT_UTTERANCE_S:
                    silence_need = SHORT_SILENCE_MS / 1000.0
                else:
                    silence_need = SILENCE_MS / 1000.0
                if now - last_voice > silence_need:
                    audio = np.concatenate(collected, axis=0)
                    duration = len(audio) / SAMPLE_RATE
                    collected = []
                    state = "idle"
                    if duration > (PLAYBACK_MAX_UTTERANCE_S if echo_suppress else MAX_UTTERANCE_S):
                        # 播报期的长段几乎必然是回声/持续噪声，丢弃；正常期的超长段按环境噪声丢弃
                        out({"type": "vad_state", "state": "listening"})
                        continue
                    out({"type": "vad_state", "state": "transcribing"})
                    _asr_queue.put(audio)      # 交给识别线程，VAD 立刻回到实时采集
                    out({"type": "vad_state", "state": "listening"})

    out({"type": "vad_state", "state": "off"})


# ========== ASR (FunASR paraformer + fsmn-vad) ==========
_asr_model = None
_model_ready = threading.Event()


def load_asr_model():
    global _asr_model
    from funasr import AutoModel
    out({"type": "status", "message": "loading_models"})
    _asr_model = AutoModel(
        model=conf("asr.model", "paraformer-zh"),
        vad_model=conf("asr.vadModel", "fsmn-vad"),
        device=conf("asr.device", "cpu"),
        disable_update=conf_bool("asr.disableUpdate", True),
        disable_pbar=True,
    )
    out({"type": "ready"})
    _model_ready.set()


def transcribe(audio_data):
    if audio_data is None or len(audio_data) == 0:
        return ""
    if not _model_ready.wait(timeout=300):
        raise RuntimeError("ASR model failed to load")
    temp_path = os.path.join(TMP_DIR, f"asr_{uuid.uuid4().hex}.wav")
    sf.write(temp_path, audio_data, SAMPLE_RATE)
    try:
        results = _asr_model.generate(input=temp_path)
        text = ""
        if results and len(results) > 0:
            text = results[0].get("text", "").strip().replace(" ", "")
        return text
    finally:
        try:
            os.remove(temp_path)
        except OSError:
            pass


# ========== TTS: 本地(sherpa-onnx/Kokoro) 优先，edge-tts 兜底 ==========
SYNTH_TIMEOUT = cenv("VOICEAI_TTS_TIMEOUT", "tts.timeoutSec", 15, float)
SYNTH_RETRIES = cenv("VOICEAI_TTS_RETRIES", "tts.retries", 2, int)
def _tts_order(backend):
    """首选后端 + 其余兜底（末端 edge 网络合成）"""
    return [backend] + [b for b in ("piper", "edge", "sherpa", "kokoro") if b != backend]


TTS_BACKEND = cenv("VOICEAI_TTS", "tts.backend", "piper", str).lower()   # piper | kokoro | sherpa | edge
# 兜底顺序按实测速度/可用性排：首选之后依次 piper → edge → sherpa。
# sherpa(Kokoro) 在 CPU 上 RTF 1.5（比实时慢、跟不上播放），只作最后手段；
# edge 是网络合成但要 1.2s/句、质量稳，排在 piper 之后。
TTS_ORDER = _tts_order(TTS_BACKEND)
_local_tts = None
_local_fails = 0            # 本地连续失败次数
_local_disabled = False     # 连续失败达上限后本次进程内不再尝试本地
_missing_logged = False     # "模型未就绪"只提示一次，避免每句刷屏
_piper_tts = None
_kokoro_tts = None
_kokoro_sc = None         # 常驻 sidecar 进程（默认主 venv 的 cpu 版 torch）
_kokoro_sc_lock = None
_piper_fails = 0
_piper_disabled = False
_piper_missing_logged = False
LOCAL_FAIL_LIMIT = cenv("VOICEAI_TTS_FAIL_LIMIT", "tts.failLimit", 3, int)


def _get_piper():
    """Piper(VITS) 本地 TTS：可跑 DirectML(AMD GPU)，实测 RTF 0.02~0.05"""
    global _piper_tts
    if _piper_tts is None:
        from tts_piper import PiperTts
        _piper_tts = PiperTts(model_dir=conf("tts.piperDir") or None,
                              provider=conf("tts.provider", "auto"),
                              num_threads=cenv("VOICEAI_TTS_THREADS", "tts.threads", 4, int))
        print(f"[tts] Piper 模型目录: {_piper_tts.model_dir} 可用={_piper_tts.available()}",
              file=sys.stderr, flush=True)
    return _piper_tts


def synth_piper(text, voice=None):
    from tts_piper import PiperUnavailable
    global _piper_fails, _piper_disabled, _piper_missing_logged
    if _piper_disabled:
        raise RuntimeError("Piper 已因连续失败禁用（重启 worker 可恢复）")
    tt = _get_piper()
    if not tt.available():
        raise PiperUnavailable(f"Piper 模型缺失: {tt.model_dir}")
    t0 = time.time()
    out = os.path.join(TMP_DIR, f"tts_{uuid.uuid4().hex}.wav")
    try:
        path, dur = tt.synthesize(text, out)
    except Exception:
        if os.path.exists(out):
            try:
                os.remove(out)
            except OSError:
                pass
        raise
    _piper_fails = 0
    print(f"[tts] Piper 合成 {len(text)}字 ({(time.time() - t0) * 1000:.0f}ms, "
          f"{tt.provider_used}, 音频 {dur:.2f}s)", file=sys.stderr, flush=True)
    return path


def _get_kokoro():
    """Kokoro（中英双语）。实测：CPU RTF 0.8~0.9；**DirectML 会崩**（动态 shape 图），故默认 cpu"""
    global _kokoro_tts
    if _kokoro_tts is None:
        from tts_kokoro import KokoroTts
        _kokoro_tts = KokoroTts(model_dir=conf("tts.kokoroDir") or None,
                                provider=conf("tts.kokoroProvider", "cpu"),
                                voice=conf_int("tts.kokoroVoice", 0),
                                threads=cenv("VOICEAI_TTS_THREADS", "tts.threads", 4, int))
        print(f"[tts] Kokoro 模型目录: {_kokoro_tts.model_dir} 可用={_kokoro_tts.available()}",
              file=sys.stderr, flush=True)
    return _kokoro_tts


def synth_kokoro(text, voice=None):
    from tts_kokoro import KokoroUnavailable
    t = _get_kokoro()
    if not t.available():
        raise KokoroUnavailable(f"Kokoro 模型缺失: {t.model_dir}")
    t0 = time.time()
    out = os.path.join(TMP_DIR, f"tts_{uuid.uuid4().hex}.wav")
    path, dur = t.synthesize(text, out)
    print(f"[tts] Kokoro 合成 {len(text)}字 ({(time.time() - t0) * 1000:.0f}ms, "
          f"{t.provider_used}, 音频 {dur:.2f}s)", file=sys.stderr, flush=True)
    return path


def kokoro_sidecar_python():
    """Kokoro sidecar 用的解释器：优先配置；默认主 venv（cpu 版 torch 实测 RTF 0.25~0.60 ✓），
    其次 venv-gpu（ROCm torch，GPU 实验用 —— 本机 Windows 上反而更慢 ✗）"""
    here = os.path.dirname(os.path.abspath(__file__))
    for p in (conf("tts.kokoroSidecarPython"),
              os.path.join(here, "venv", "Scripts", "python.exe"),
              os.path.join(here, "venv-gpu", "Scripts", "python.exe")):
        if p and os.path.exists(p):
            return p
    return None


def _kokoro_sidecar_env():
    """sidecar 的环境：PYTHONPATH 注入隔离依赖目录（kokoro-deps），
    免得 Kokoro 的 transformers/tokenizers/scipy 与主 venv 的 funasr 打架 ✗"""
    env = dict(os.environ)
    env.setdefault("PYTHONIOENCODING", "utf-8")
    dep = conf("tts.kokoroSidecarPath") or os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "kokoro-deps")
    if os.path.isdir(dep):
        env["PYTHONPATH"] = (dep + os.pathsep + env["PYTHONPATH"]) if env.get("PYTHONPATH") else dep
    return env


def _kokoro_sidecar_proc():
    """懒启动常驻 sidecar（模型只加载一次；每句重载模型会白等 1~2 秒）。
    设备由 tts_kokoro_gpu.py 按 torch.cuda.is_available() 自选：
    主 venv → cpu（快且确定 ✓）；venv-gpu → gpu（本机 Windows 上默认更慢 ✗）"""
    global _kokoro_sc, _kokoro_sc_lock
    import subprocess
    if _kokoro_sc_lock is None:
        _kokoro_sc_lock = threading.Lock()
    with _kokoro_sc_lock:
        if _kokoro_sc is not None and _kokoro_sc.poll() is None:
            return _kokoro_sc
        py = kokoro_sidecar_python()
        if not py:
            return None
        script = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tts_kokoro_gpu.py")
        env = _kokoro_sidecar_env()
        # ROCm 运行时若在外部 SDK 里，补进 PATH（torch 轮子通常自带，缺了才需要）
        rocm_bin = os.path.join(os.environ.get("HIP_PATH", r"D:\Program Files\AMD\ROCm"), "bin")
        if os.path.isdir(rocm_bin) and rocm_bin not in env.get("PATH", ""):
            env["PATH"] = rocm_bin + os.pathsep + env.get("PATH", "")
        _kokoro_sc = subprocess.Popen([py, script, "--server"], stdin=subprocess.PIPE,
                                      stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                                      text=True, encoding="utf-8", bufsize=1, env=env)
        line = _kokoro_sc.stdout.readline()      # 等 ready
        if not line:
            raise RuntimeError("Kokoro sidecar 启动失败")
        print(f"[tts] Kokoro sidecar 就绪: {line.strip()}", file=sys.stderr, flush=True)
        return _kokoro_sc


def synth_kokoro_sidecar(text, voice=None):
    """Kokoro 合成（常驻 sidecar：默认主 venv 的 cpu 版 torch，实测 RTF 0.25~0.60 ✓）"""
    import json
    proc = _kokoro_sidecar_proc()
    if proc is None:
        raise RuntimeError("未找到 sidecar 解释器（venv/Scripts/python.exe）")
    out = os.path.join(TMP_DIR, f"tts_{uuid.uuid4().hex}.wav")
    vname = voice if (voice and not voice.startswith("zh-CN")) else conf("tts.kokoroVoiceName", "zf_001")
    req = json.dumps({"text": text, "out": out, "voice": vname}, ensure_ascii=False)
    with _kokoro_sc_lock:
        proc.stdin.write(req + "\n")
        proc.stdin.flush()
        r = None
        while r is None:
            line = proc.stdout.readline()
            if not line:
                raise RuntimeError("Kokoro sidecar 无响应")
            try:
                cand = json.loads(line)
            except Exception:
                continue                          # 启动期的 WARNING 等非 JSON 行
            if isinstance(cand, dict) and "ok" in cand:
                r = cand
    if not r.get("ok"):
        raise RuntimeError(r.get("error", "未知错误"))
    print(f"[tts] Kokoro 合成 {len(text)}字 ({r.get('ms')}ms, 音频 {r.get('dur')}s, "
          f"设备 {r.get('device') or 'cpu'}{', 显存 %sMB' % r['vram'] if r.get('vram') else ''}, "
          f"音色 {vname})", file=sys.stderr, flush=True)
    return r["path"]


def _get_local_tts():
    global _local_tts
    if _local_tts is None:
        from tts_local import SherpaTts
        _local_tts = SherpaTts(num_threads=cenv("VOICEAI_TTS_THREADS", "tts.threads", 4, int),
                               model_dir=conf("tts.modelDir") or None)
        print(f"[tts] 本地 TTS 模型目录: {_local_tts.model_dir} 可用={_local_tts.available()}",
              file=sys.stderr, flush=True)
    return _local_tts


class LocalTtsUnavailable(RuntimeError):
    """本地模型缺失/不完整——配置状态，不是故障，不能计入粘性失败计数"""


def synth_local(text, voice=None):
    """本地合成，写 24k/16k WAV，返回路径"""
    tts = _get_local_tts()
    if not tts.available():
        raise LocalTtsUnavailable(f"本地 TTS 模型缺失: {tts.model_dir}")
    out = os.path.join(TMP_DIR, f"tts_{uuid.uuid4().hex}.wav")
    path, _dur = tts.synthesize(text, out, voice=voice)
    if not os.path.exists(path) or os.path.getsize(path) == 0:
        raise RuntimeError("本地 TTS 输出为空")
    return path


async def _synth_once(text, voice, output_path):
    import asyncio
    import edge_tts
    communicate = edge_tts.Communicate(text, voice)
    # 没有超时的话，edge-tts 网络挂起会让 worker 主循环永久阻塞
    await asyncio.wait_for(communicate.save(output_path), timeout=SYNTH_TIMEOUT)


def synth_edge(text, voice="zh-CN-XiaoxiaoNeural"):
    import asyncio
    output_path = os.path.join(TMP_DIR, f"tts_{uuid.uuid4().hex}.mp3")
    last_err = None
    for attempt in range(SYNTH_RETRIES):
        try:
            if os.path.exists(output_path):
                os.remove(output_path)
            asyncio.run(_synth_once(text, voice, output_path))
            if os.path.getsize(output_path) > 0:
                return output_path
            last_err = RuntimeError("empty audio file")
        except Exception as e:
            last_err = e
            print(f"[tts] attempt {attempt + 1} failed: {type(e).__name__}: {e}", file=sys.stderr, flush=True)
    detail = f"{type(last_err).__name__}: {last_err}" if last_err else "unknown"
    raise RuntimeError(f"TTS failed after {SYNTH_RETRIES} attempts ({detail})")


def synthesize(text, voice="zh-CN-XiaoxiaoNeural"):
    """统一入口：按优先级链合成。返回 (路径, 后端名)。

    TTS_ORDER = 首选 + 其余兜底（末端 edge 网络）：
      piper  —— 本地 VITS，实测 DirectML(RX 9070 XT) RTF 0.02~0.05，单句 120~220ms
      sherpa —— 本地 Kokoro（CPU 上 RTF 1.5，慢，仅作次级兜底）
      edge   —— edge-tts 网络合成（~1.2s/句，质量稳）
    某个后端连续失败 tts.failLimit 次后本进程内跳过它，避免每句白等一次异常。
    """
    global _local_fails, _local_disabled, _missing_logged
    global _piper_fails, _piper_disabled, _piper_missing_logged
    last_err = None

    for backend in TTS_ORDER:
        try:
            if backend == "piper":
                p = synth_piper(text, voice)
                if p:
                    return p, "piper"
            elif backend == "kokoro":
                # 常驻 sidecar（主 venv 的 cpu 版 torch + kokoro-deps）实测 RTF 0.25~0.60 ✓，
                # 比 ONNX 路径（0.9~1.06）快约 4 倍 ✓；ONNX 仅作兜底
                if kokoro_sidecar_python():
                    p = synth_kokoro_sidecar(text, voice)
                    if p:
                        return p, "kokoro"
                p = synth_kokoro(text, voice)
                if p:
                    return p, "kokoro-onnx"
            elif backend == "sherpa":
                if _local_disabled:
                    continue
                tt = _get_local_tts()
                if not tt.available():
                    if not _missing_logged:
                        _missing_logged = True
                        print(f"[tts] 本地 Kokoro 模型未就绪: {tt.model_dir}", file=sys.stderr, flush=True)
                    continue
                t0 = time.time()
                path = synth_local(text, voice=voice)
                _local_fails = 0
                print(f"[tts] Kokoro 合成 {len(text)}字 {(time.time() - t0) * 1000:.0f}ms",
                      file=sys.stderr, flush=True)
                return path, "sherpa"
            elif backend == "edge":
                t0 = time.time()
                path = synth_edge(text, voice)
                print(f"[tts] edge 合成 {len(text)}字 {(time.time() - t0) * 1000:.0f}ms",
                      file=sys.stderr, flush=True)
                return path, "edge"
        except Exception as e:
            last_err = e
            if backend == "piper":
                _piper_fails += 1
                print(f"[tts] Piper 失败({_piper_fails}/{LOCAL_FAIL_LIMIT}): {type(e).__name__}: {e}",
                      file=sys.stderr, flush=True)
                if _piper_fails >= LOCAL_FAIL_LIMIT:
                    _piper_disabled = True
                    print(f"[tts] Piper 连续失败 {LOCAL_FAIL_LIMIT} 次，本次进程内不再尝试",
                          file=sys.stderr, flush=True)
            elif backend == "sherpa":
                _local_fails += 1
                print(f"[tts] Kokoro 失败({_local_fails}/{LOCAL_FAIL_LIMIT}): {type(e).__name__}: {e}",
                      file=sys.stderr, flush=True)
                if _local_fails >= LOCAL_FAIL_LIMIT:
                    _local_disabled = True
            else:
                print(f"[tts] edge 失败: {type(e).__name__}: {e}", file=sys.stderr, flush=True)

    raise RuntimeError(f"所有 TTS 后端都失败（最后错误: {last_err}）")


def normalize_for_asr(audio, target_rms=None, max_gain=None):
    """识别前自动增益：麦克风电平偏低（实测用户侧峰值仅 0.03~0.04）时，
    paraformer 会返回空；适度放大到目标 RMS 可救回"轻但有人声"的片段。"""
    target_rms = conf_num("asr.targetRms", 0.1) if target_rms is None else target_rms
    max_gain = conf_num("asr.maxGain", 8.0) if max_gain is None else max_gain
    rms = float(np.sqrt(np.mean(audio * audio)))
    if rms < 1e-5:
        return audio, 1.0
    gain = min(max_gain, target_rms / rms)
    if gain <= 1.05:
        return audio, 1.0
    return (audio * gain).astype(np.float32), gain


def asr_worker():
    """独立线程做识别：VAD 线程若同步等待 transcribe（一段 7s 音频要 1s+），
    采集队列会堆积到上限并丢弃最老的块 → 用户的话被"挖洞" → 乱码或空结果。"""
    while True:
        audio = _asr_queue.get()
        if audio is None:
            return
        try:
            t_asr0 = time.time()
            duration = len(audio) / SAMPLE_RATE
            seg_rms = float(np.sqrt(np.mean(audio * audio)))
            boosted, gain = normalize_for_asr(audio)
            text = transcribe(boosted)
            asr_ms = int((time.time() - t_asr0) * 1000)
            if not text:
                try:
                    global _empty_dump_idx
                    path = os.path.join(TMP_DIR, f"asr_empty_{_empty_dump_idx}.wav")
                    _empty_dump_idx = (_empty_dump_idx + 1) % 5
                    sf.write(path, audio, SAMPLE_RATE, subtype='PCM_16')
                    print(f"[asr] 空结果: dur={duration:.1f}s rms={seg_rms:.4f} "
                          f"playback={_playback_active} → 已存 {os.path.basename(path)}",
                          file=sys.stderr, flush=True)
                except Exception as de:
                    print(f"[asr] 空结果: dur={duration:.1f}s rms={seg_rms:.4f} (存盘失败 {de})",
                          file=sys.stderr, flush=True)
            out({"type": "asr_result", "text": text,
                 "duration": round(duration, 2), "rms": round(seg_rms, 4), "gain": round(gain, 2),
                 "asr_ms": asr_ms})
        except Exception as e:
            out({"type": "error", "error": str(e)})


# ========== Threads ==========
def handle_audio_frame(cmd):
    """音频帧快车道：直接入 VAD 队列，不经过主循环。
    否则合成一句话（1~2s）期间到达的音频只能在服务端排队并被丢弃，
    用户的话被"挖洞" → ASR 乱码或空 → 表现为"说了没反应"。"""
    if not (_feed_mode and _listen_active) or not cmd.get("pcm"):
        return
    try:
        raw = base64.b64decode(cmd["pcm"])
    except Exception:
        return
    pcm = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    for i in range(0, len(pcm), BLOCK_SIZE):
        seg = pcm[i:i + BLOCK_SIZE]
        if len(seg) == 0:
            continue
        try:
            _level_queue.put(float(np.sqrt(np.mean(seg * seg))))
        except Exception:
            pass
        push_block(seg)


def stdin_reader():
    for line in sys.stdin:
        line = line.strip()
        if line:
            try:
                cmd = json.loads(line)
            except json.JSONDecodeError:
                out({"type": "error", "error": f"bad json: {line[:80]}"})
                continue
            if isinstance(cmd, dict) and cmd.get("cmd") == "audio":
                handle_audio_frame(cmd)
                out({"type": "ack", "cmd": "audio"})   # 回执让服务端放行下一帧
                continue
            _cmd_queue.put(cmd)
    _cmd_queue.put(None)


def level_sender():
    """电平上报 + 服务端放音状态同步（回调线程不能直接写 stdout，所以在这里发）"""
    global _playback_active, _playback_since, _playback_off_at
    last = 0.0
    while True:
        try:
            level = _level_queue.get(timeout=0.5)
        except queue.Empty:
            continue
        now = time.time()

        # 服务端放音：把状态同步给 VAD 门控（等价于浏览器模式下的 playback on/off）
        if _player is not None:
            for ev in _player.drain_events():
                kind, item_id, dur = ev
                out({"type": "playback_" + kind, "id": item_id, "duration": dur})
            playing = _player.is_playing()
            if playing and not _playback_active:
                _playback_active = True
                _playback_since = now
                drain_blocks()          # 播放开始：清掉队列里可能混入的回声残留
            elif not playing and _playback_active:
                _playback_active = False
                _playback_off_at = now

        if now - last >= 0.1:
            msg = {"type": "audio_level", "level": level}
            if _aec is not None and not hasattr(_aec_report, 'last') or (
                    _aec is not None and now - getattr(_aec_report, 'last', 0) >= 2.0):
                _aec_report.last = now
                st = _aec.stats()
                msg["aec"] = {"erle": st["erle_db"], "blowups": st["blowups"],
                              "adapted": st["adapted_blocks"], "frozen": st["frozen_blocks"]}
                if st["blowups"]:
                    print(f"[aec] ERLE={st['erle_db']}dB 发散重置={st['blowups']} 次 "
                          f"自适应={st['adapted_blocks']} 冻结={st['frozen_blocks']}",
                          file=sys.stderr, flush=True)
            if _player is not None:
                msg["playing"] = _player.is_playing()
                msg["playing_id"] = _player.playing_id
            out(msg)
            last = now


# ========== Main Loop ==========
def main():
    global _listen_active, _playback_active, _playback_since, _playback_off_at, _feed_mode, _stream, _player, _aec
    global TTS_BACKEND, TTS_ORDER

    if PLAY_SERVER:
        _player = Player(aec=_aec)

    print(f"[conf] {CONF_PATH} | TTS={TTS_BACKEND} 语音窗={SILENCE_MS}ms 门限={VAD_ENERGY_MIN}x{VAD_MULT} "
          f"ASR={conf('asr.model', 'paraformer-zh')}", file=sys.stderr, flush=True)

    threading.Thread(target=stdin_reader, daemon=True).start()
    threading.Thread(target=level_sender, daemon=True).start()
    threading.Thread(target=asr_worker, daemon=True).start()
    threading.Thread(target=load_asr_model, daemon=True).start()

    while True:
        cmd = _cmd_queue.get()
        if cmd is None:
            break

        action = cmd.get("cmd")
        if action != "audio":   # 音频帧 12.5/s，日志会刷屏
            print(f"[cmd] {action}", file=sys.stderr, flush=True)
        try:
            if action == "listen":
                if not _listen_active:
                    _listen_active = True
                    drain_blocks()
                    _feed_mode = cmd.get("source") == "browser"
                    if not _feed_mode:
                        _stream = sd.InputStream(
                            samplerate=SAMPLE_RATE,
                            channels=CHANNELS,
                            dtype=np.float32,
                            blocksize=BLOCK_SIZE,
                            callback=audio_callback,
                        )
                        _stream.start()
                    out({"type": "status", "message": "listening", "source": "browser" if _feed_mode else "server"})
                    threading.Thread(target=listen_loop, daemon=True).start()

            elif action == "stop_listen":
                _listen_active = False
                if _stream:
                    _stream.stop()
                    _stream.close()
                    _stream = None

            elif action == "playback":
                want = bool(cmd.get("on"))
                if want != _playback_active:
                    # 只在状态变化时清空音频队列：否则重复的 on:true 会不断清队，
                    # 导致 VAD 起句后拿不到完整语音（表现为"打断不了"）
                    _playback_active = want
                    if want:
                        drain_blocks()   # 播放开始：清掉队列里可能是回声的音频
                        _playback_since = time.time()
                    else:
                        _playback_off_at = time.time()

            elif action == "clear":
                # 打断：停掉正在播的音 + 丢掉待播段（服务端放音时这是"立刻闭嘴"的关键）
                if _player is not None:
                    dropped = _player.stop()
                    if dropped:
                        print(f"[tts] 打断播放：丢弃 {dropped} 段", file=sys.stderr, flush=True)
                # Interrupt: drop pending tts commands still queued for synthesis
                kept = queue.Queue()
                while True:
                    try:
                        item = _cmd_queue.get_nowait()
                    except queue.Empty:
                        break
                    if item is not None and item.get("cmd") == "tts":
                        continue
                    kept.put(item)
                while True:
                    try:
                        _cmd_queue.put(kept.get_nowait())
                    except queue.Empty:
                        break

            elif action == "tts":
                text = cmd.get("text", "")
                voice = cmd.get("voice", "zh-CN-XiaoxiaoNeural")
                rid = cmd.get("id")
                if text:
                    audio_path, backend = synthesize(text, voice)
                    try:
                        duration = float(sf.info(audio_path).duration)
                    except Exception:
                        duration = len(text) / 4.5   # 估个大概：中文约 4.5 字/秒
                    played = "browser"
                    if PLAY_SERVER and _player is not None:
                        try:
                            _player.enqueue(audio_path, rid)
                            played = "server"
                        except Exception as pe:
                            print(f"[tts] 服务端放音入队失败，改由浏览器播放: {pe}",
                                  file=sys.stderr, flush=True)
                    # play_mode 交给浏览器判断是否也要放（auto 模式下远程浏览器要放 ✓ 本地不播 ✓）
                    out({"type": "tts_audio", "audio_path": audio_path, "text": text, "id": rid,
                         "backend": backend, "duration": round(duration, 2),
                         "played": played, "play_mode": TTS_PLAYBACK})

            elif action == "prewarm_tts":
                # 预生成常用短语音（唤醒应答等），避免每次现合成带来的 1~2 秒延迟
                text = cmd.get("text", "")
                voice = cmd.get("voice", "zh-CN-XiaoxiaoNeural")
                if text:
                    try:
                        path, backend = synthesize(text, voice)
                        out({"type": "tts_prewarmed", "text": text, "voice": voice, "audio_path": path,
                             "backend": backend})
                    except Exception as e:
                        print(f"[prewarm] 失败: {e}", file=sys.stderr, flush=True)

            elif action == "aec_calibrate":
                # 就地标定：用**生产中的**输出/采集流测播放→麦克风往返延迟，
                # 按 ERLE 扫最佳 delay（跨进程标定会因流启动时序不同而失配，实测踩过）
                if _aec is None:
                    out({"type": "error", "error": "AEC 未启用（tts.playback 需为 server）"})
                else:
                    try:
                        from aec import EchoCanceller
                        import soundfile as _sf
                        rng2 = np.random.default_rng(11)
                        burst = (0.35 * rng2.standard_normal(SAMPLE_RATE)).astype(np.float32)
                        cal = os.path.join(TMP_DIR, "aec_cal.wav")
                        _sf.write(cal, burst, SAMPLE_RATE)
                        rec = np.zeros(SAMPLE_RATE * 2, dtype=np.float32)
                        pos = {"n": 0}

                        def _cal_cb(indata, frames, ti, st):
                            n = pos["n"]
                            blk = indata[:, 0] if indata.ndim > 1 else indata
                            if n + frames <= rec.size:
                                rec[n:n + frames] = blk
                            pos["n"] = n + frames

                        st = sd.InputStream(samplerate=SAMPLE_RATE, channels=1, dtype="float32",
                                            blocksize=BLOCK_SIZE, callback=_cal_cb)
                        st.start()
                        time.sleep(0.3)
                        _player.enqueue(cal, "cal")
                        time.sleep(1.4)
                        _player.stop()
                        time.sleep(0.4)
                        st.stop(); st.close()

                        n = len(rec)
                        ref = np.zeros(n, dtype=np.float32)
                        ref[int(SAMPLE_RATE * 0.3):int(SAMPLE_RATE * 0.3) + len(burst)] = burst
                        best = (0, -99.0)
                        table = []
                        for delay in range(0, 14000, 160):
                            a = EchoCanceller(sample_rate=SAMPLE_RATE, taps=conf_int("aec.taps", 2048),
                                              delay_samples=delay)
                            w0 = int(SAMPLE_RATE * 0.3) + delay
                            w1 = w0 + len(burst)
                            if w0 + BLOCK_SIZE * 4 >= n:
                                continue
                            m0 = w0 + int((w1 - w0) * 0.45)
                            me, oe = [], []
                            for b in range((n - BLOCK_SIZE) // BLOCK_SIZE):
                                i = b * BLOCK_SIZE
                                a.add_reference(ref[i:i + BLOCK_SIZE])
                                o = a.process(rec[i:i + BLOCK_SIZE].copy())
                                if m0 <= i < min(w1, n):
                                    me.append(float(np.mean(rec[i:i + BLOCK_SIZE] ** 2)))
                                    oe.append(float(np.mean(o ** 2)))
                            if len(me) < 3:
                                continue
                            erle = 10 * np.log10(max(np.mean(me), 1e-15) / max(np.mean(oe), 1e-15))
                            table.append((delay, round(erle, 1)))
                            if erle > best[1]:
                                best = (delay, erle)
                        table.sort(key=lambda x: -x[1])
                        # 应用：用最佳延迟重建 AEC（跨进程标定会失配，就地标定才准）
                        if best[1] > 2.0:
                            _aec = EchoCanceller(sample_rate=SAMPLE_RATE,
                                                 taps=conf_int("aec.taps", 2048),
                                                 delay_samples=int(best[0]),
                                                 mu=conf_num("aec.mu", 0.4))
                            # 重新挂到播放器上：Player 持有的是旧实例的引用，
                            # 不重挂则麦克风走新消除器、播放回调仍喂旧实例（total_ref 恒为 0），
                            # 新实例一直走"没播过东西"分支 → 本进程内再也不消除回声。
                            if _player is not None:
                                _player.aec = _aec
                            print(f"[aec] 就地标定并应用 delay={best[0]} 样本 "
                                  f"({best[0] / SAMPLE_RATE * 1000:.0f}ms) ERLE={best[1]:.1f}dB",
                                  file=sys.stderr, flush=True)
                        out({"type": "aec_calibrated", "delay": best[0],
                             "erle": round(best[1], 1), "applied": best[1] > 2.0,
                             "top": table[:5]})
                    except Exception as ce:
                        out({"type": "error", "error": f"标定失败: {ce}"})

            elif action == "set_backend":
                # 运行时热切换 TTS 后端（web 设置面板选音色时用）：不用重启 worker
                b = str(cmd.get("backend", "")).strip().lower()
                if b in ("piper", "kokoro", "sherpa", "edge") and b != TTS_BACKEND:
                    TTS_BACKEND = b
                    TTS_ORDER = _tts_order(b)
                    print(f"[tts] 后端热切换 → {b}（兜底顺序 {TTS_ORDER}）", file=sys.stderr, flush=True)
                out({"type": "ack", "cmd": "set_backend"})

            elif action == "ping":
                out({"type": "pong"})

        except Exception as e:
            out({"type": "error", "error": str(e)})
        finally:
            # 每条命令都回执：server 端 workerBusy 闩锁依赖"收到任意输出"才释放，
            # 若某条命令（如 clear）静默处理，闩锁会永久卡住、后续 tts 再也发不进来。
            out({"type": "ack", "cmd": action})


if __name__ == "__main__":
    try:
        main()
    finally:
        if _kokoro_gpu is not None:
            try:
                _kokoro_gpu.stdin.write(json.dumps({"cmd": "quit"}) + "\n")
                _kokoro_gpu.stdin.flush()
                _kokoro_gpu.terminate()
            except Exception:
                pass
