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
# 采集必须用设备原生率 ✗ 实测同一只麦克风（MU900）用 16kHz 采集会被驱动静默压低 10~15 倍：
#   MME 48k/单声道 → RMS 0.198、峰值 0.925；而 16k → RMS 0.013 ✗（这就是"电平不动/识别恒为空"的根因）
# 所以按 CAPTURE_RATE（默认 48k）采集，再盒式平均抽取到 16k 供 VAD/ASR/AEC 使用 ✓
CAPTURE_RATE = conf_int("asr.captureRate", 48000)
INPUT_BLOCK = 960                     # 采集回调块（20ms@48k）：MME 友好尺寸 ✓
ASR_PAD_MS = conf_int("asr.padMs", 300)   # 识别前两端补的静音（让 paraformer 内部 VAD 有正常起止 ✓）
ASR_DENOISE = conf_bool("asr.denoise", True)      # 识别前谱门限降噪 ✓（噪声≈语音时最有价值 ✓）
RECORD_ON = conf_bool("debug.recordUserAudio", False)   # ★ 调试录音热开关：存下"模型真正听到的那份音频"✓（界面勾选框可实时改 ✓ set_record ✓ 不重启 ✓）
ASR_KEEP_MAX = conf_int("asr.keepWavMax", 12)   # 只留最近 N 条 ✓（temp/asr_kept 不会无限涨 ✓）
_last_asr_wav = None                            # 最近一次 transcribe 落盘的 wav 路径 ✓（ASR 单线程 ✓ 无并发问题 ✓）
VAD_WEBRTC_MIN = conf_num("vad.webrtcMinRatio", 0.25)  # webrtcvad 二道闸：有话音的帧占比低于此值就跳过识别 ✓
_vad = None


def voiced_ratio(audio):
    """webrtcvad 判定这段音频里"有人声"的帧占比 ✓
    ✗ 自研能量门限在"房间噪声 ≈ 说话电平"时必然失灵（把噪声切成碎片 → 识别成片段/空 ✓ 用户实测）
    ✓ webrtcvad 是真正的 VAD（判"是否人声"而非能量大小），用来拦掉这类碎片"""
    global _vad
    if _vad is None:
        import webrtcvad
        _vad = webrtcvad.Vad(2)          # 0~3：2 = 中等激进（实测较均衡 ✓）
    pcm = np.clip(audio * 32768.0, -32768, 32767).astype(np.int16).tobytes()
    frame = int(SAMPLE_RATE * 0.03) * 2          # 30ms @16bit ✓（webrtcvad 只认 10/20/30ms ✓）
    if len(pcm) < frame:
        return 0.0
    voiced = total = 0
    for i in range(0, len(pcm) - frame + 1, frame):
        total += 1
        if _vad.is_speech(pcm[i:i+frame], SAMPLE_RATE):
            voiced += 1
    return (voiced / total) if total else 0.0
DECIM = max(1, int(round(CAPTURE_RATE / float(SAMPLE_RATE))))   # 48000/16000 = 3
_capture_carry = np.zeros(0, dtype=np.float32)
_out_carry = np.zeros(0, dtype=np.float32)


# ★ 采集侧高通：实测本机噪声是 56~150Hz 的低频隆隆（风扇/气流/桌面振动 ✗），
#   而人声在 300~3000Hz ✓ → 180Hz 高通可以在不碰人声的前提下把嗡声削掉 ✓
#   （这是今晚"噪声≈语音"问题的对症解法之一 ✓；scipy 已修复可用 ✓）
from scipy.signal import butter, lfilter, lfilter_zi

_HP_HZ = conf_num("vad.highPassHz", 180)
# ✗ 曾经把它设成 0 当"关闭"，却直接拿去建滤波器 → ValueError: critical frequencies must be > 0 → worker 启动即崩
# ✓ 0（或超出有效范围）视为不启用；配置里必须保证这也是合法的"关闭"语义
if 0 < _HP_HZ < SAMPLE_RATE / 2.0 - 1:
    _b_hp, _a_hp = butter(2, _HP_HZ / (SAMPLE_RATE / 2.0), btype='high')
    _zi_hp = lfilter_zi(_b_hp, _a_hp) * 0.0
else:
    _b_hp, _a_hp, _zi_hp = None, None, None


def _highpass(block):
    """流式二阶高通（保留滤波器状态 ✓ 无块间不连续）"""
    global _zi_hp
    if _b_hp is None or block.size == 0:
        return block
    y, _zi_hp = lfilter(_b_hp, _a_hp, block, zi=_zi_hp)
    return y.astype(np.float32)


def _decimate_capture(mono):
    """原生率 → 16k，并攒满 BLOCK_SIZE(80ms) 才返回 ✓
    ✗ 之前每来一块就发一块：小块采集时下游会收到 320 样本的碎块 → VAD 的静音计数（按块）全乱
    ✓ 现在两级余数缓冲：原生率余数 + 16k 余数，保证下游块大小恒为 80ms"""
    global _capture_carry, _out_carry
    if DECIM > 1:
        if _capture_carry.size:
            mono = np.concatenate([_capture_carry, mono])
        n = (mono.size // DECIM) * DECIM
        _capture_carry = mono[n:].copy()
        if n == 0:
            return None
        blk = mono[:n].reshape(-1, DECIM).mean(axis=1).astype(np.float32)
    else:
        blk = mono
    if _out_carry.size:
        blk = np.concatenate([_out_carry, blk])
        _out_carry = np.zeros(0, dtype=np.float32)
    if blk.size < BLOCK_SIZE:
        _out_carry = blk.copy()
        return None
    n = (blk.size // BLOCK_SIZE) * BLOCK_SIZE
    _out_carry = blk[n:].copy()
    return blk[:n]

VAD_ENERGY_MIN = conf_num("vad.energyMin", 0.02)    # absolute RMS floor for the gate
VAD_FLOOR_MAX = conf_num("vad.floorMax", 0.025)    # 噪声底硬上限：超过这个值就可能把正常说话判成静音
VAD_MULT = conf_num("vad.mult", 3.0)           # onset threshold = max(MIN, noise_floor * MULT)
SILENCE_MS = conf_int("vad.silenceMs", 1200)       # trailing silence that closes an utterance
SHORT_SILENCE_MS = conf_int("vad.shortSilenceMs", 500)  # 短句（<SHORT_UTTERANCE_S）用更短静音窗，减少等待感
SHORT_UTTERANCE_S = conf_num("vad.shortUtteranceS", 2.5) # 判定"短句"的时长阈值
PRE_ROLL = conf_int("vad.preRollBlocks", 5)            # blocks kept before onset (~400ms)
MAX_UTTERANCE_S = conf_num("vad.maxUtteranceS", 30)     # segments longer than this are treated as ambient noise
PLAYBACK_TAIL_S = cenv("VOICEAI_ECHO_TAIL_MS", "echo.tailMs", 900, float) / 1000.0  # 播报结束后的余音压制窗
# ★ 识别前硬电平下限（RMS）：低于它直接跳过 ASR ✓（否则低电平碎片被放大后会幻觉出文本 ✗）
#   本机实测分界：真实呼唤 0.053~0.087 ✓ / 噪声与键盘 0.009~0.024 ✗ → 取 0.025 卡在中间 ✓
ASR_MIN_RMS = cenv("VOICEAI_ASR_MIN_RMS", "asr.minRms", 0.025, float)
PLAYBACK_GATE_MULT = conf_num("vad.playbackGateMult", 1.8) # 播报中/余音期的起始门限倍数（配合内容过滤，门限不宜过狠否则听不到打断）
PLAYBACK_SILENCE_MS = conf_int("vad.playbackSilenceMs", 900)   # 播报期的静音窗（比正常 1200ms 略短，兼顾"说停能较快生效"）
PLAYBACK_MAX_UTTERANCE_S = conf_num("vad.playbackMaxUtteranceS", 12.0)  # 播报期最长片段：留足空间，避免把用户的话切碎（回声交给内容过滤）
# ★ 播报期"确认打断"门限 ✓：VAD onset 只代表有声音，自己的回声也能触发 ✗
#   实测：直接用 onset 暂停播音 → 18 次误触发 → 回答被反复暂停/续播，听起来卡顿 ✗
#   这里要求"持续 ≥400ms 且平均电平 ≥0.045"才算人声开口 ✓ 回声通常 <0.03 且不持续 ✓
BARGE_ONSET_MS = conf_int("vad.bargeOnsetMs", 400)
BARGE_ONSET_RMS = conf_num("vad.bargeOnsetRms", 0.045)

TMP_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "temp")
MODELS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models")   # Piper 多音色按目录名定位 ✓
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
                             mu=conf_num("aec.mu", 0.4),
                             res_floor=conf_num("aec.resFloor", 1.0))   # 1.0=关闭 RES ✓（见 conf 注释）
        print(f"[aec] 已启用 taps={conf_int('aec.taps', 2048)} "
              f"delay={conf_int('aec.delaySamples', 0)} 样本 mu={conf_num('aec.mu', 0.4)}",
              file=sys.stderr, flush=True)
    except Exception as _e:
        _aec = None
        print(f"[aec] 初始化失败，退回无 AEC: {_e}", file=sys.stderr, flush=True)

_player = None
_aec_report = type('R', (), {})()


def resolve_device(val):
    """设备值解析：纯数字按**索引** ✓，其它按名称子串 ✓（✗ 否则 "9" 会撞上 MU900 里的 9）"""
    if val is None:
        return None
    if isinstance(val, int):
        return val
    t = str(val).strip()
    if not t:
        return None
    if t.lstrip('+-').isdigit():
        return int(t)
    return t


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
                                           latency="low",      # ✗ 默认缓冲在 MME 上约 500ms（标定 delay 570ms ✗）→ 低延迟 ✓
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
        # AEC 参考必须与麦克风同率**且相位一致** ✓
        # ✗ 曾经用 44100→16000 的分数比线性重采样：声卡自己也重采样，两者群延迟不一致 → 滤波器对不齐 → ERLE 恒为 0
        # ✓ 所以输出取设备支持的 48000（3:1 整数倍），参考用盒式平均精确抽取，与采集端同一套
        if self.sr == self.aec_rate:
            ref = out
        elif self.sr % self.aec_rate == 0:
            k = self.sr // self.aec_rate
            n = (len(out) // k) * k
            ref = out[:n].reshape(-1, k).mean(axis=1).astype(np.float32) if n else np.zeros(0, dtype=np.float32)
        else:
            ref = resample(data, sr, self.aec_rate)
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


def _json_fallback(o):
    """json 不认 numpy 标量 ✗ 之前标定消息就是这样整条发不出去（"Object of type bool is not JSON serializable"）
    → 兜底转换，但把类型打到 stderr，避免静默掩盖问题 ✗"""
    item = getattr(o, "item", None)
    if callable(item):
        v = item()
        print(f"[json] numpy 标量被自动转换: {type(o).__name__} → {type(v).__name__}",
              file=sys.stderr, flush=True)
        return v
    raise TypeError(f"不可序列化: {type(o).__name__}")


def out(obj):
    with _print_lock:
        sys.stdout.write(json.dumps(obj, ensure_ascii=False, default=_json_fallback) + "\n")
        sys.stdout.flush()


# ========== Audio ==========
def audio_callback(indata, frames, time_info, status):
    # 采集侧回声消除：先用 AEC 减去估计回声，再做 VAD/识别。
    # 参考信号由 Player 的播放回调提供（同进程、同时间轴），这是能真正消回声的前提。
    block = np.asarray(indata[:, 0], dtype=np.float32) if indata.ndim > 1 else np.asarray(indata, dtype=np.float32)
    block = _decimate_capture(block)          # 原生率 → 16k，且攒满 80ms 才下发（见函数注释）
    if block is None:
        return
    block = _highpass(block)                  # 180Hz 高通：削掉 56~150Hz 的风扇/隆隆声 ✓ 不碰人声 ✓
    if _aec is not None:
        block = _aec.process(block)
    if _listen_active and not _feed_mode:
        # 浏览器采集时由 handle_audio_frame 喂数据；这里再掺服务器麦克风会把两路音频
        # 交错进同一个 VAD 队列 → 切成垃圾片段 → 识别必然为空 ✗
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
    voiced_sum = 0.0        # 本段人声块的电平累计（用于"确认打断"判定）
    voiced_n = 0
    barge_sent = False      # 本段是否已上报过 barge_onset（一段只报一次）

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
                voiced_sum = rms
                voiced_n = 1
                barge_sent = False
                out({"type": "vad_state", "state": "speech"})

        elif state == "speech":
            collected.append(block)
            if rms > threshold * 0.7:
                last_voice = now
                voiced_sum += rms
                voiced_n += 1
                # ★ 播报期确认打断 ✓：持续够久 + 平均电平够高 → 才让服务端暂停播音 ✓
                #   （vad_state=speech 在播报期会被自己的回声触发 ✗ 见 BARGE_ONSET_RMS 注释）
                if echo_suppress and not barge_sent and (now - speech_start) * 1000.0 >= BARGE_ONSET_MS:
                    avg = voiced_sum / max(1, voiced_n)
                    if avg >= BARGE_ONSET_RMS:
                        barge_sent = True
                        out({"type": "barge_onset"})
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


def transcribe(audio_data, keep=False):
    if audio_data is None or len(audio_data) == 0:
        return ""
    if not _model_ready.wait(timeout=300):
        raise RuntimeError("ASR model failed to load")
    # ★ 两端补静音：paraformer 内部自带 VAD（vad_model=fsmn-vad），
    #   ✗ 直接喂一段被切得很紧的片段时，它的内部 VAD 可能判不出完整语句 → 返回空/丢字
    #     （用户实测症状："必须说很快，一停顿就只识别一部分"、"请详细介绍一下你" → "轻容的介绍一下你"）
    #   ✓ 前后各补 PAD_MS 静音，让内部 VAD 有正常的起止点
    audio_data = np.asarray(audio_data, dtype=np.float32)
    if ASR_DENOISE:
        try:
            import noisereduce as nr
            audio_data = nr.reduce_noise(y=audio_data, sr=SAMPLE_RATE,
                                         stationary=True, prop_decrease=0.8).astype(np.float32)
        except Exception as de:
            print(f"[asr] 降噪失败（忽略，继续识别）: {de}", file=sys.stderr, flush=True)
    pad = np.zeros(int(SAMPLE_RATE * ASR_PAD_MS / 1000.0), dtype=np.float32)
    audio_data = np.concatenate([pad, audio_data, pad])
    temp_path = os.path.join(TMP_DIR, f"asr_{uuid.uuid4().hex}.wav")
    sf.write(temp_path, audio_data, SAMPLE_RATE)
    try:
        results = _asr_model.generate(input=temp_path)
        text = ""
        if results and len(results) > 0:
            raw = (results[0].get("text", "") or "").strip()
            # ★ 兼容两种输出 ✓：
            #   paraformer  → `别 说 了`（无标签 ✓）
            #   SenseVoice  → `<|zh|><|NEUTRAL|><|Speech|><|woitn|>别说了`（带标签 ✓）
            #   → 统一**剥掉所有 `<|…|>`** ✓ 并记下语言标签 ✓
            # ★ 语言判据的依据（实测 ✓）：同一批 rms=0.02 的合成噪声（白噪/咔哒/低频嗡/静音 ✓ 绝非人声 ✓）
            #   被 SenseVoice 标成 `<|Speech|>` ✗ 且语言判成 `ko`/`en` ✗；而用户 6/6 条真语音全是 `<|zh|>` ✓✓
            #   → 纯中文场景下「标签不是 zh 就丢」是 6/6 vs 4/4 有效的零成本判据 ✓（标签本身**不是**噪声判据 ✗ 已实测否掉 ✓）
            _parts, _lang, _i = [], None, 0
            while True:
                _a = raw.find("<|", _i)
                if _a < 0:
                    _parts.append(raw[_i:])
                    break
                _parts.append(raw[_i:_a])
                _b = raw.find("|>", _a + 2)
                if _b < 0:
                    break
                _tag = raw[_a + 2:_b]
                if _lang is None and _tag in ("zh", "en", "ja", "ko", "yue"):
                    _lang = _tag
                _i = _b + 2
            text = "".join(_parts).strip().replace(" ", "")
            if _lang and _lang != "zh":
                print(f"[asr] 语言判据丢弃（lang={_lang} ✗ 非中文 ✓ 疑似噪声）：{raw!r}",
                      file=sys.stderr, flush=True)
                text = ""
        return text
    finally:
        global _last_asr_wav
        _last_asr_wav = temp_path
        if not keep:
            try:
                os.remove(temp_path)
            except OSError:
                pass
        # keep=True：文件留给调用方改名 ✓ 存的就是模型实际读到的字节 ✓（不是事后重采样 ✓）


# ========== TTS: 本地 Piper + 在线 edge-tts ==========
SYNTH_TIMEOUT = cenv("VOICEAI_TTS_TIMEOUT", "tts.timeoutSec", 15, float)
SYNTH_RETRIES = cenv("VOICEAI_TTS_RETRIES", "tts.retries", 2, int)
def _tts_order(backend):
    """首选后端 + 其余兜底（末端 edge 网络合成）"""
    return [backend] + [b for b in ("piper", "edge") if b != backend]


TTS_BACKEND = cenv("VOICEAI_TTS", "tts.backend", "piper", str).lower()   # piper | edge
# 实测结论（用户）：中文 edge 最好 ✓；Piper 作离线兜底 ✓。
# 已淘汰 ✗：Kokoro / sherpa / MeloTTS / CosyVoice / VibeVoice / Qwen3-TTS / IndexTTS
# （对应模型文件与代码已一并清理 ✓，回收约 32GB）
TTS_ORDER = _tts_order(TTS_BACKEND)
_piper_tts = None          # 每个模型目录一个 PiperTts 实例 ✓
_piper_fails = 0
_piper_disabled = False
_piper_missing_logged = False
LOCAL_FAIL_LIMIT = cenv("VOICEAI_TTS_FAIL_LIMIT", "tts.failLimit", 3, int)


def _parse_piper_voice(voice):
    """解析音色串 "piper:<模型目录名>[:<说话人id>]" → (模型目录绝对路径, 说话人id 或 None) ✓

    非 piper 前缀返回 (None, None)，表示用默认模型 ✓。
    """
    if not voice or not str(voice).startswith("piper:"):
        return None, None
    parts = str(voice).split(":")
    dirname = parts[1] if len(parts) > 1 else ""
    sid = parts[2] if len(parts) > 2 and parts[2] != "" else None
    if not dirname:
        return None, sid
    return os.path.join(MODELS_DIR, dirname), sid


def _get_piper(model_dir=None):
    """Piper(VITS) 本地 TTS：可跑 DirectML(AMD GPU)，实测 RTF 0.02~0.05。

    按模型目录分别缓存 ✓（多音色 = 多个模型目录 ✓）
    """
    global _piper_tts
    key = model_dir or ""
    if _piper_tts is None:
        _piper_tts = {}
    tt = _piper_tts.get(key)
    if tt is None:
        from tts_piper import PiperTts
        tt = PiperTts(model_dir=model_dir or conf("tts.piperDir") or None,
                      provider=conf("tts.provider", "auto"),
                      num_threads=cenv("VOICEAI_TTS_THREADS", "tts.threads", 4, int))
        _piper_tts[key] = tt
        print(f"[tts] Piper 模型目录: {tt.model_dir} 可用={tt.available()}",
              file=sys.stderr, flush=True)
    return tt


def synth_piper(text, voice=None):
    from tts_piper import PiperUnavailable
    global _piper_fails, _piper_disabled, _piper_missing_logged
    if _piper_disabled:
        raise RuntimeError("Piper 已因连续失败禁用（重启 worker 可恢复）")
    model_dir, sid = _parse_piper_voice(voice)
    tt = _get_piper(model_dir)
    if not tt.available():
        raise PiperUnavailable(f"Piper 模型缺失: {tt.model_dir}")
    t0 = time.time()
    out = os.path.join(TMP_DIR, f"tts_{uuid.uuid4().hex}.wav")
    try:
        path, dur = tt.synthesize(text, out, speaker=sid, speed=TTS_SPEED)
    except Exception:
        if os.path.exists(out):
            try:
                os.remove(out)
            except OSError:
                pass
        raise
    _piper_fails = 0
    print(f"[tts] Piper 合成 {len(text)}字 ({(time.time() - t0) * 1000:.0f}ms, "
          f"{tt.provider_used}, 音频 {dur:.2f}s, 音色={voice or '默认'})",
          file=sys.stderr, flush=True)
    return path


TTS_SPEED = conf_num("tts.speed", 1.0)   # 通用语速：Piper 每句传参 ✓（与 UI 的"语速"同源 ✓）



async def _synth_once(text, voice, output_path):
    import asyncio
    import edge_tts
    communicate = edge_tts.Communicate(text, voice)
    # 没有超时的话，edge-tts 网络挂起会让 worker 主循环永久阻塞
    await asyncio.wait_for(communicate.save(output_path), timeout=SYNTH_TIMEOUT)


def synth_edge(text, voice="zh-CN-XiaoxiaoNeural"):
    # 兜底保护 ✓：voice 可能来自 Piper 规格（piper:xxx ✗）或空值 ✗ → 用默认音色，
    # 否则"Piper 失败 → 退 edge"这一层会再失败一次，整句就彻底没声音了 ✗
    if not voice or ':' in str(voice) or not str(voice).lower().endswith('neural'):
        voice = "zh-CN-XiaoxiaoNeural"
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
            # ★ 音色不被端点接受 ✗（下架 / 拼错 ✓）→ 重试也是白等 ✗（实测每句白烧 1~2 秒才兜底 Piper ✓）
            #   按类名判 ✓：edge-tts 各版本异常路径不同 ✓（edge_tts.exceptions.NoAudioReceived ✓）
            if type(e).__name__ == "NoAudioReceived":
                print("[tts] NoAudioReceived：多半是音色已下架或名字不对 ✓ 直接放弃 edge、不再重试 ✓",
                      file=sys.stderr, flush=True)
                break
    detail = f"{type(last_err).__name__}: {last_err}" if last_err else "unknown"
    raise RuntimeError(f"TTS failed after {SYNTH_RETRIES} attempts ({detail})")


def synthesize(text, voice="zh-CN-XiaoxiaoNeural"):
    """统一入口：按优先级链合成。返回 (路径, 后端名)。

    TTS_ORDER = 首选 + 兜底（只保留实测可用的两条路 ✓）：
      piper —— 本地 VITS(Piper) ✓ 离线可用，DirectML/CPU 单句 120~220ms
      edge  —— edge-tts 在线合成 ✓（~1.2s/句，中文质量最稳 ✓）
    某个后端连续失败 tts.failLimit 次后本进程内跳过它，避免每句白等一次异常。
    """
    global _piper_fails, _piper_disabled, _piper_missing_logged
    last_err = None

    for backend in TTS_ORDER:
        try:
            if backend == "piper":
                p = synth_piper(text, voice)
                if p:
                    return p, "piper"
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
            else:
                print(f"[tts] edge 失败: {type(e).__name__}: {e}", file=sys.stderr, flush=True)

    raise RuntimeError(f"所有 TTS 后端都失败（最后错误: {last_err}）")


def utterance_conf(rms, gain, dur, text):
    """「可信度」0~100 ✓ 与它的分项原始值 ✓。
    ★ 这**不是**模型后验 ✗：实测 funasr 的 paraformer 只返回 key/text/timestamp ✓
      （`return_time`/`output_timestamp`/`label`/`decoding_ctc_weight` 四种入参全试过 ✗ 没有 confidence/cer/loss ✓）
      真·后验得摸 model 内部（model.py:345 的 log_softmax ✓）+ 再跑一遍前向 ✗ 143~602ms 等于翻倍 ✗ 不当默认代价付 ✓
    → 用**当天 60 条实录**里真正区分「认对」与「幻觉」的量来定 ✓：
      原始电平 rms ✓（成功 0.09~0.14 ✓ 幻觉 0.009~0.030 ✓；下限 asr.minRms ✓ 目标 asr.targetRms ✓）
      数字增益 gain ✓（1.0 最好 ✓ 顶到 asr.maxGain 说明原始电平太低 ✗）
      时长 dur ✓（太短不可信 ✗）
      文本自洽 ✓（空 ✗；两三秒静音只吐一两个字 = paraformer 幻觉 ✓）
    分项一起给前端 ✓（悬停核对 ✓ 不是黑箱 ✓）"""
    target = conf_num("asr.targetRms", 0.1) or 0.1
    maxg = conf_num("asr.maxGain", 8.0) or 8.0
    floor = conf_num("asr.minRms", 0.04) or 0.04
    level = max(0.0, min(1.0, (rms - floor) / max(1e-6, target - floor)))      # 电平 ✓ 权重最高 ✓（实测它是唯一判别量 ✓）
    gscor = max(0.0, min(1.0, 1.0 - (gain - 1.0) / max(1e-6, maxg - 1.0)))     # 增益越接近 1 越好 ✓
    dscor = 1.0 if 0.4 <= dur <= 12.0 else (0.5 if dur < 0.4 else 0.6)         # 时长 ✓
    nch = len("".join((text or "").split()))   # 去掉所有空白后的字数 ✓（不引 re ✓ 一个 split 就够 ✓）
    tscor = 0.0 if nch == 0 else (0.35 if (nch == 1 and dur >= 2.0) else (0.7 if nch == 1 else 1.0))   # 长静音只吐一字 = 幻觉 ✓
    w = 0.45 * level + 0.25 * gscor + 0.15 * dscor + 0.15 * tscor
    return int(round(w * 100)), {"rms": round(rms, 4), "gain": round(gain, 2), "dur": round(dur, 2), "chars": nch}

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
            # ★ 电平门槛要量「人声窗」的最大能量 ✓，不是整段平均 rms ✗
            #   短词落在长段里会被前后静音稀释 ✓（实测 ✓：用户说「露露同学」只占 ≈0.8s ✓ 段长 2.24s ✓
            #   → 整段 rms 0.012 ✗ 被丢 ✓，可人声窗 0.02~0.032、峰值 0.08 ✓ 明明是人声 ✓ → 越短越容易被丢 ✓）
            #   68 条留证音频实测分界 ✓：认对的段 burst 最小 **0.232** ✓ / 低电平噪声段 burst 最大 **0.031** ✗
            #   → 沿用同一条 ASR_MIN_RMS(0.04) ✓ 换度量后现有语料**一条都不改判** ✓（不降级 ✓）
            _win = 1600  # 100ms @16k ✓
            if len(audio) >= _win:
                _fr = np.asarray(audio)[:(len(audio) // _win) * _win].reshape(-1, _win)
                burst = float(np.sqrt(np.mean(_fr * _fr, axis=1)).max())
            else:
                burst = seg_rms  # 段太短 ✓ 平均即窗 ✓
            # ★ 识别前硬电平下限 ✓（在自动增益之前拦 ✓）
            #   为什么必须有它：低电平碎片经 normalize_for_asr 放大到 0.1 后 ✗，paraformer 会产生
            #   **幻觉文本** ✗（实测 0.009 电平被识别成"嘟嘟"/"啦啦啦" ✗）→ 这些幻觉还会误触发唤醒/停词 ✗。
            #   本机实测的干净分界：真实呼唤 rms 0.053~0.087 ✓ / 噪声与键盘 0.009~0.024 ✗ → 取 0.025 ✓
            # ★ 判据从 `burst`（最大窗）换成 **`top3`（前三大窗均值）** ✓✓
            #   实测证据 ✗：播报期一个"咔哒"瞬态就能把 burst 顶到 0.10 ✓ 让 ASR 从原始 0.0014 的噪声里
            #   **编出整句**（「你们回来的时候」✗「我们已经听到了什么」✗ —— 与正在播的 TTS 文本**一个词都不重合** ✓
            #   所以不是喇叭回声 ✓ 是噪声幻觉 ✓）
            #   top3 的分界（同一批留证音频 ✓）：真人声 0.19~0.44 ✓ / 噪声与瞬态 0.0085~0.017 ✗ = **11 倍**
            _eff_min = ASR_MIN_RMS * 2.5 if _playback_active else ASR_MIN_RMS
            if len(audio) >= _win:
                _fr2 = np.asarray(audio)[:(len(audio) // _win) * _win].reshape(-1, _win)
                _env = np.sqrt(np.mean(_fr2 * _fr2, axis=1))
                top3 = float(np.mean(np.sort(_env)[-3:])) if _env.size else seg_rms
                # ★ 第三道判据：**持续时长** ✓✓（用户实测 ✗："非常明显的噪音 根本不是人声 为什么也会生成内容" ✓）
                #   敲桌/咔哒/电流声的能量集中在 1~2 个窗（<150ms ✓）而人说话是 ≥300ms 的连续音节串 ✓
                #   → 数"最长的一段连续高能窗" ✓ 太短就不喂 ASR ✓（噪声没法伪装"持续"✓）
                _hi = max(top3 * 0.5, _eff_min * 0.5)
                _run = _best = 0
                for _v in _env:
                    _run = _run + 1 if _v >= _hi else 0
                    if _run > _best:
                        _best = _run
                sustain_ms = _best * _win / SAMPLE_RATE * 1000.0
            else:
                top3 = seg_rms
                sustain_ms = len(audio) / SAMPLE_RATE * 1000.0
            # ★ 两个条件合成**一个**闸 ✓：漏一个就是"日志说跳过了、其实还喂给 ASR"✗
            #   （我第一版把"持续过短"写成只打印不 continue ✗✓ 又是一条说谎的日志 ✗）
            # ★ 判据与日志**同源** ✓：写死两处 ✗ 必然有一天不一致 ✓（我这条就写错成 250ms 了 ✗）
            _SUSTAIN_MS = 150.0
            if top3 < _eff_min or sustain_ms < _SUSTAIN_MS:
                _why = (f"电平过低（top3={top3:.4f} < {_eff_min:.4f}"
                        f"{'·播报期加倍 ✓' if _playback_active else ''}）" if top3 < _eff_min
                        else f"持续过短（连续高能 {sustain_ms:.0f}ms < {_SUSTAIN_MS:.0f}ms：敲击/咔哒/电流声 ✗）")
                print(f"[asr] {_why}跳过 → 不喂 ASR，避免它编出内容 ✗"
                      f"（burst={burst:.4f} rms={seg_rms:.4f}）",
                      file=sys.stderr, flush=True)
                # ★ 被拒的段也要留证据 ✓：否则"我觉得我声音正常"永远没法核对 ✗
                #   （原先只有喂给 ASR 的段才落盘 ✓ → 低电平段连机器听到的是啥都不知道 ✗）
                #   文件名带 `_空.` ✓ → 走上面既有的"空结果先扔"淘汰规则 ✓ 不额外加淘汰代码 ✓
                kept_url = None
                if RECORD_ON:
                    try:
                        keep_dir = os.path.join(TMP_DIR, "asr_kept")
                        os.makedirs(keep_dir, exist_ok=True)
                        name = (f"{time.strftime('%H%M%S')}_r{seg_rms:.4f}_g0_d{duration:.2f}_低电平_空.wav")
                        sf.write(os.path.join(keep_dir, name), audio, SAMPLE_RATE, subtype='PCM_16')
                        kept_url = '/temp/asr_kept/' + name
                    except Exception as ke:
                        print(f"[asr] 低电平段留音频失败: {type(ke).__name__}: {ke}", file=sys.stderr, flush=True)
                out({"type": "asr_result", "text": "", "duration": round(duration, 2),
                     "rms": round(seg_rms, 4), "burst": round(burst, 4), "gain": 0, "asr_ms": 0,
                     "vad_skip": True, "audio_url": kept_url})
                continue
            boosted, gain = normalize_for_asr(audio)
            # ★ webrtcvad 二道闸：拦住"能量够但没话说"的噪声碎片（用户实测：必须说很快、一停就只剩片段）
            try:
                ratio = voiced_ratio(audio)
            except Exception:
                ratio = 1.0
            if ratio < VAD_WEBRTC_MIN:
                print(f"[asr] webrtcvad 判定无人声（voiced={ratio:.2f} < {VAD_WEBRTC_MIN}）→ 跳过识别 ✓",
                      file=sys.stderr, flush=True)
                out({"type": "asr_result", "text": "", "duration": round(duration, 2),
                     "rms": round(seg_rms, 4), "gain": 0, "asr_ms": 0, "vad_skip": True})
                continue
            text = transcribe(boosted, keep=RECORD_ON)
            asr_ms = int((time.time() - t_asr0) * 1000)
            kept_url = None   # 本次留住的录音 URL ✓（开关关着 / 没留住就是 None ✓ 前端也就不画 ▶ ✓）
            conf_score, conf_parts = utterance_conf(seg_rms, gain, duration, text)   # 「可信度」+ 分项原值 ✓
            if RECORD_ON and _last_asr_wav and os.path.exists(_last_asr_wav):
                # 文件名带上"模型听到的是什么条件"✓：电平 / 数字增益 / 时长 / 识别结果 ✓
                # → 识别错时能直接回放听 ✓ 也能离线重喂做 A/B（增益、降噪、补静音 ✓）
                try:
                    keep_dir = os.path.join(TMP_DIR, "asr_kept")
                    os.makedirs(keep_dir, exist_ok=True)
                    _bad = '\\/:*?"<>| \t'
                    safe = ''.join(ch for ch in text if ch not in _bad)[:12] or '空'
                    dst = os.path.join(keep_dir, f"{time.strftime('%H%M%S')}_"
                                                 f"r{seg_rms:.4f}_g{gain:.1f}_d{duration:.2f}_{safe}.wav")
                    os.replace(_last_asr_wav, dst)
                    kept_url = '/temp/asr_kept/' + os.path.basename(dst)   # 浏览器要的就是这个 URL ✓（express 把 temp/ 挂在 /temp 下 ✓）
                    # ★ 不要在这里给 _last_asr_wav 赋值 ✗：asr_worker 里一旦有赋值语句 ✓
                    #   Python 就把它当**局部变量** ✓ → 第 810 行先读 → UnboundLocalError ✓
                    #   （transcribe() 每次都会重设它 ✓ 这里无需清 ✓）
                    olds = sorted(os.listdir(keep_dir),
                                  key=lambda f: os.path.getmtime(os.path.join(keep_dir, f)))   # 旧→新 ✓
                    # ★ 溢出时的丢弃策略：**空结果的先扔** ✓（多是噪声/脉冲 ✓ 没有取证价值 ✗）
                    #   带识别文本的尽量留 ✓（"听它到底把我念成什么了"就靠这些 ✓；实测 12 条上限
                    #   会把刚录的 `跟我打电话` 挤掉 ✗ → 用户要听时文件已经没了 ✓）
                    over = len(olds) - ASR_KEEP_MAX
                    if over > 0:
                        empty_ = [f for f in olds if '_空.' in f]
                        victims = empty_[:over]
                        if len(victims) < over:
                            rest = [f for f in olds if f not in set(victims)]
                            victims += rest[:over - len(victims)]
                        for f in victims:
                            try:
                                os.remove(os.path.join(keep_dir, f))
                            except OSError:
                                pass
                    print(f"[asr] 已留音频: {os.path.basename(dst)} → 目录内现存 {len(os.listdir(keep_dir))} 条 ✓"
                          f"（temp/ 里未搬走的 asr_<uuid>.wav: "
                          f"{len([f for f in os.listdir(TMP_DIR) if f.startswith('asr_') and not f.startswith('asr_empty_')])}）",
                          file=sys.stderr, flush=True)
                except Exception as ke:
                    print(f"[asr] 留音频失败: {type(ke).__name__}: {ke}", file=sys.stderr, flush=True)
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
                 "asr_ms": asr_ms, "audio_url": kept_url,
                 "conf": conf_score, "conf_parts": conf_parts})
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


_no_server_play_logged = False   # "服务端放音未启用"只提示一次
_tts_epoch = 0          # 打断世代号：fast_interrupt 时 +1；合成完成的段落若世代变了就丢弃 ✗
                        # ✗ 否则"正在合成中的那一句"会在打断后照样播放（实测打断后又响了 6 秒）


def fast_interrupt(reason="clear"):
    """立刻打断：停当前播放 + 丢弃排队中待合成的 tts 段 ✓
    ✗ 关键：必须能在 stdin 线程里直接调用 —— 主循环此刻可能正卡在一整句合成（~1.5s），
       clear 排在它后面会导致"喊停后还要念完当前这句"（实测延迟 4.9s ✗）"""
    global _tts_epoch
    _tts_epoch += 1
    if _player is not None:
        dropped = _player.stop()
        if dropped:
            print(f"[tts] 打断播放：丢弃 {dropped} 段（{reason}）", file=sys.stderr, flush=True)
    kept = queue.Queue()
    while True:
        try:
            item = _cmd_queue.get_nowait()
        except queue.Empty:
            break
        if item is None or (isinstance(item, dict) and item.get("cmd") == "tts"):
            if item is None:
                kept.put(item)          # 哨兵要留着 ✓
            continue
        kept.put(item)
    while True:
        try:
            _cmd_queue.put(kept.get_nowait())
        except queue.Empty:
            break


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
            # ★ 打断类命令旁路队列：队列前面可能压着一整句合成（~1.5s），
            #   走队列会让"喊停"延迟一整句 ✗（实测 4.9s）→ 在 stdin 线程里立即执行 ✓
            if isinstance(cmd, dict) and cmd.get("cmd") == "clear":
                fast_interrupt("stop-word/interrupt")
                out({"type": "ack", "cmd": "clear"})
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
    global TTS_BACKEND, TTS_ORDER, PLAY_SERVER

    if PLAY_SERVER:
        _player = Player(aec=_aec)

    print(f"[conf] {CONF_PATH} | TTS={TTS_BACKEND} 语音窗={SILENCE_MS}ms 门限={VAD_ENERGY_MIN}x{VAD_MULT} "
          f"ASR={conf('asr.model', 'paraformer-zh')} "
              f"采集={CAPTURE_RATE}Hz/抽取1:{DECIM}→{SAMPLE_RATE}Hz", file=sys.stderr, flush=True)

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
                            samplerate=CAPTURE_RATE,          # ★ 原生率采集 ✗ 用 16k 会被驱动压低 10~15 倍
                            channels=CHANNELS,
                            device=resolve_device(conf("asr.inputDevice") or None),   # 可用 asr.inputDevice 换麦克风 ✓
                            dtype=np.float32,
                            blocksize=INPUT_BLOCK,            # ✗ 不能要 3840（80ms@48k）：MME 单次缓冲上限约 1024
                                                              #   驱动给不满 → 大段空洞（实测包络"空→爆点→空"✗）
                                                              # ✓ 改为 960 帧（20ms）小块采集，在回调里攒满 80ms 再下发
                            # ✗ 采集不要用 latency="low"：MME 上实测会丢块/断续 → ASR 全空（用户现场就是这症状）
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
                fast_interrupt("clear(queued)")
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
                    epoch = _tts_epoch                    # ★ 记下世代
                    audio_path, backend = synthesize(text, voice)
                    if epoch != _tts_epoch:
                        # 合成期间被打断：这句已经不该出声了 ✗ → 丢弃，不播也不回报
                        print(f"[tts] 该段合成期间被打断，丢弃（{text[:12]}…）", file=sys.stderr, flush=True)
                        try:
                            os.remove(audio_path)
                        except OSError:
                            pass
                        out({"type": "ack", "cmd": "tts_dropped", "id": rid})
                        continue
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
                    else:
                        # ✗ 静默兜底是这轮的万恶之源：这里必须有日志（但只提示一次，避免每句刷屏）
                        global _no_server_play_logged
                        if not _no_server_play_logged:
                            _no_server_play_logged = True
                            print(f"[tts] 服务端放音未启用（PLAY_SERVER={PLAY_SERVER} "
                                  f"_player={'有' if _player is not None else '无'} cfg={TTS_PLAYBACK}）"
                                  f"→ 由浏览器播放 ✓ 后续不再重复提示", file=sys.stderr, flush=True)
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

            elif action == "set_record":
                # ★ 界面「🎙 录音留证」勾选框 ✓：实时开关 ✓ 不用重启 ✓（关了就不再往 temp/asr_kept/ 落盘 ✓）
                global RECORD_ON   # ✗ 必须显式 global：本函数里一有赋值 ✓ Python 就把它当局部变量 → 别处读就 UnboundLocalError ✓
                RECORD_ON = bool(cmd.get("on", False))
                print(f"[asr] 调试录音 → {'开 ✓（每句存 temp/asr_kept/ ✓ 界面气泡可回放 ▶）' if RECORD_ON else '关 ✗（不再存盘 ✓）'}", file=sys.stderr, flush=True)
                out({"type": "record_ack", "on": RECORD_ON})
            elif action == "list_voices":
                # ★ 微软 edge 音色的**实时**列表 ✓：音色会下架 ✗（实测 Xiaohan/Xiaomo/Xiaorui/Xiaoxuan
                #   端点已无 ✓ → 选中就 NoAudioReceived ✗ → 白等两次重试再兜底 Piper ✗）
                # 所以界面不能写死清单 ✓；拉取失败回空表 ✓（服务端沿用旧表 ✓ 界面不崩 ✓）
                try:
                    import asyncio as _aio
                    import edge_tts as _et
                    _vs = _aio.run(_et.list_voices())
                    _items = sorted(
                        [{"id": v["ShortName"], "gender": v.get("Gender", ""),
                          "locale": v.get("Locale", "")}
                         for v in _vs if str(v.get("Locale", "")).startswith("zh")],
                        key=lambda x: x["id"])
                    out({"type": "edge_voices", "voices": _items})
                except Exception as e:
                    print(f"[voices] edge 音色列表拉取失败: {type(e).__name__}: {e}",
                          file=sys.stderr, flush=True)
                    out({"type": "edge_voices", "voices": [], "error": str(e)})
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
                        out({"type": "aec_calibrated", "delay": int(best[0]),
                             "erle": round(float(best[1]), 1), "applied": bool(best[1] > 2.0),
                             "top": [[round(float(e), 1), int(d)] for (e, d) in table[:5]]})
                    except Exception as ce:
                        out({"type": "error", "error": f"标定失败: {ce}"})

            elif action == "set_playback":
                # ★ 放音端随采集端自动配对 ✓（✗ 混用时两边都没有回声参考信号 → 等于没有回声消除，用户实测过）
                want = bool(cmd.get("server", True))
                if want != PLAY_SERVER:
                    PLAY_SERVER = want
                    if want and _player is None:
                        _player = Player(aec=_aec)
                    print(f"[tts] 放音端切换 → {'服务端喇叭' if want else '浏览器'}"
                          f"（与采集端配对 ✓）", file=sys.stderr, flush=True)
                out({"type": "ack", "cmd": "set_playback"})

            elif action == "set_speed":
                # 语速热调（web 设置面板）：Piper 每句传参 ✓
                global TTS_SPEED
                try:
                    sp = max(0.5, min(2.0, float(cmd.get("speed", 1.0))))
                    TTS_SPEED = sp
                    print(f"[tts] 语速热调 → {sp}", file=sys.stderr, flush=True)
                except (TypeError, ValueError):
                    pass
                out({"type": "ack", "cmd": "set_speed"})

            elif action == "set_backend":
                # 运行时热切换 TTS 后端（web 设置面板选音色时用）：不用重启 worker
                b = str(cmd.get("backend", "")).strip().lower()
                if b in ("piper", "edge") and b != TTS_BACKEND:
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
    # 原先这里要收尾 Kokoro sidecar 子进程 ✗（Kokoro 已淘汰 → 那个全局也删了 ✓）
    # 留着会 NameError ✗；现在无外部子进程需要清理 ✓
    main()
