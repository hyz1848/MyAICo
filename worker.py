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
    if _listen_active:
        push_block(indata.copy())
    rms = float(np.sqrt(np.mean(indata * indata)))
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
TTS_BACKEND = cenv("VOICEAI_TTS", "tts.backend", "piper", str).lower()   # piper | sherpa | edge
# 兜底顺序按实测速度/可用性排：首选之后依次 piper → edge → sherpa。
# sherpa(Kokoro) 在 CPU 上 RTF 1.5（比实时慢、跟不上播放），只作最后手段；
# edge 是网络合成但要 1.2s/句、质量稳，排在 piper 之后。
TTS_ORDER = [TTS_BACKEND] + [b for b in ("piper", "edge", "sherpa") if b != TTS_BACKEND]
_local_tts = None
_local_fails = 0            # 本地连续失败次数
_local_disabled = False     # 连续失败达上限后本次进程内不再尝试本地
_missing_logged = False     # "模型未就绪"只提示一次，避免每句刷屏
_piper_tts = None
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
    last = 0.0
    while True:
        try:
            level = _level_queue.get(timeout=0.5)
        except queue.Empty:
            continue
        now = time.time()
        if now - last >= 0.1:
            out({"type": "audio_level", "level": level})
            last = now


# ========== Main Loop ==========
def main():
    global _listen_active, _playback_active, _playback_since, _playback_off_at, _feed_mode, _stream

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
                    out({"type": "tts_audio", "audio_path": audio_path, "text": text, "id": rid,
                         "backend": backend, "duration": round(duration, 2)})

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

            elif action == "ping":
                out({"type": "pong"})

        except Exception as e:
            out({"type": "error", "error": str(e)})
        finally:
            # 每条命令都回执：server 端 workerBusy 闩锁依赖"收到任意输出"才释放，
            # 若某条命令（如 clear）静默处理，闩锁会永久卡住、后续 tts 再也发不进来。
            out({"type": "ack", "cmd": action})


if __name__ == "__main__":
    main()
