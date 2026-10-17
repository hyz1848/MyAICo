"""tts_sherpa.py — sherpa-onnx 通用本地 TTS（MeloTTS / Matcha / VITS 系）

为什么做这个：用户明确要求**本地** TTS，而 Piper 中文平淡 ✗、Kokoro-zh(82M) 韵律也偏平 ✗。
sherpa-onnx 的 **MeloTTS 中英模型**是本地方案里中文最自然的一档 ✓（CPU 也够快 ✓），
而且 venv 里已经有 sherpa_onnx 1.13.8 ✓，不用再拉 torch。

模型目录里需要的文件（sherpa-onnx VITS 系约定）：
    *.onnx            模型本体（例如 model.onnx）
    tokens.txt        音素 → id
    lexicon*.txt      中文/英文词典（MeloTTS 用 lexicon.txt + 可选的 *_en.txt）
    dict/             部分模型需要 jieba 词典目录
    espeak-ng-data/   英文音素化（MeloTTS zh_en 需要）

用法：
    t = SherpaTts(model_dir='models/tts/vits-melo-tts-zh_en')
    if t.available():
        path, dur = t.synthesize('你好，我是潞潞同学', 'out.wav', sid=0, speed=1.0)
"""
import glob
import os
import threading

import numpy as np
import soundfile as sf


class SherpaUnavailable(RuntimeError):
    """模型缺失或 sherpa_onnx 不可用"""


class SherpaTts:
    """薄封装 sherpa_onnx.OfflineTts：懒加载 + 线程安全（worker 是单线程调用，锁只为保险）"""

    def __init__(self, model_dir=None, threads=4, provider='cpu'):
        self.model_dir = model_dir or os.path.join(
            os.path.dirname(os.path.abspath(__file__)), 'models', 'tts', 'vits-melo-tts-zh_en')
        self.threads = int(threads)
        self.provider = provider or 'cpu'
        self._tts = None
        self._lock = threading.Lock()
        self._load_error = None

    # ---------- 可用性 ----------
    def _onnx_file(self):
        for pat in ('*.onnx', '*.ort'):
            got = sorted(glob.glob(os.path.join(self.model_dir, pat)))
            if got:
                return got[0]
        return None

    def available(self):
        if not os.path.isdir(self.model_dir):
            return False
        return bool(self._onnx_file()) and os.path.exists(os.path.join(self.model_dir, 'tokens.txt'))

    def _first(self, *names):
        for n in names:
            p = os.path.join(self.model_dir, n)
            if os.path.exists(p):
                return p
        return ''

    # ---------- 加载 ----------
    def _ensure(self):
        if self._tts is not None:
            return self._tts
        if self._load_error:
            raise SherpaUnavailable(self._load_error)
        try:
            import sherpa_onnx
        except Exception as e:                                   # pragma: no cover
            self._load_error = f'import sherpa_onnx 失败: {e}'
            raise SherpaUnavailable(self._load_error)
        if not self.available():
            self._load_error = f'模型不全: {self.model_dir}（需要 *.onnx + tokens.txt）'
            raise SherpaUnavailable(self._load_error)
        with self._lock:
            if self._tts is not None:
                return self._tts
            try:
                model = self._onnx_file()
                vits = sherpa_onnx.OfflineTtsVitsModelConfig(
                    model=model,
                    lexicon=self._first('lexicon.txt', 'lexicon-zh.txt'),
                    tokens=os.path.join(self.model_dir, 'tokens.txt'),
                    data_dir=self._first('espeak-ng-data') if os.path.isdir(
                        os.path.join(self.model_dir, 'espeak-ng-data')) else '',
                    dict_dir=self._first('dict') if os.path.isdir(
                        os.path.join(self.model_dir, 'dict')) else '',
                )
                cfg = sherpa_onnx.OfflineTtsConfig(
                    model=sherpa_onnx.OfflineTtsModelConfig(
                        vits=vits, num_threads=self.threads, debug=False, provider=self.provider),
                    max_num_sentences=1,
                )
                if not cfg.validate():
                    raise SherpaUnavailable('OfflineTtsConfig.validate() 失败（模型文件不匹配 ✗）')
                self._tts = sherpa_onnx.OfflineTts(cfg)
            except SherpaUnavailable:
                raise
            except Exception as e:
                self._load_error = f'加载失败: {type(e).__name__}: {e}'
                raise SherpaUnavailable(self._load_error)
        return self._tts

    # ---------- 合成 ----------
    def synth_array(self, text, sid=0, speed=1.0):
        tts = self._ensure()
        audio = tts.generate(str(text), sid=int(sid), speed=float(speed))
        samples = np.asarray(audio.samples, dtype=np.float32)
        return samples, int(audio.sample_rate)

    def synthesize(self, text, out_path, sid=0, speed=1.0):
        samples, sr = self.synth_array(text, sid=sid, speed=speed)
        if samples.size == 0:
            raise SherpaUnavailable('合成结果为空 ✗（文本/词典不匹配？）')
        sf.write(out_path, samples, sr)
        return out_path, len(samples) / float(sr)

    def speakers(self):
        try:
            return int(self._ensure().num_speakers)
        except Exception:
            return 0
