"""tts_local.py — 本地 TTS（sherpa-onnx / Kokoro 多语言）

为什么换：edge-tts 每句要 1.0s 以上网络往返（实测均值 1.6s/句），是当前延迟最大头。
本地 ONNX 推理在 CPU 上 RTF 通常 0.05~0.2，且不依赖网络。

中英混读：Kokoro 多语言模型用 lang 选择前端（zh 用 jieba+拼音，en 用 espeak）。
文本同时含汉字与拉丁字母时按"有汉字就用 zh"处理——中文前端能拼读夹带的英文单词。
"""

import os
import numpy as np
import soundfile as sf

MODEL_DEFAULT = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'models', 'kokoro-int8-multi-lang-v1_1')


class SherpaTts:
    """按语言缓存 OfflineTts 实例（zh / en 需要不同前端配置）"""

    def __init__(self, model_dir=None, num_threads=4, speed=1.0):
        self.model_dir = model_dir or os.environ.get('VOICEAI_TTS_MODEL') or MODEL_DEFAULT
        self.num_threads = int(num_threads)
        self.speed = float(speed)
        self._engines = {}
        self._sid = {}

    def _resolve(self, *names):
        for n in names:
            p = os.path.join(self.model_dir, n)
            if os.path.exists(p):
                return p
        return None

    def _model_file(self):
        """int8 包文件名通常是 model.int8.onnx；两种都要认"""
        p = self._resolve('model.onnx', 'model.int8.onnx', 'model.fp16.onnx')
        if p:
            return p
        import glob
        cands = [f for f in glob.glob(os.path.join(self.model_dir, '*.onnx'))
                 if not os.path.basename(f).startswith('voices')]
        return cands[0] if cands else None

    def _family(self):
        """按目录文件构成判断模型族：kokoro（带 voices.bin）/ vits（piper、aishell3 等）"""
        if self._resolve('voices.bin', 'voices.txt'):
            return 'kokoro'
        return 'vits' if self._model_file() else None

    def available(self):
        if not (self._model_file() and self._resolve('tokens.txt')):
            return False
        # kokoro 必须有 voices.bin；vits 有 tokens 即可（lexicon/dict 可选）
        return self._family() != 'kokoro' or bool(self._resolve('voices.bin', 'voices.txt'))

    def _build(self, lang):
        import sherpa_onnx
        cfg = sherpa_onnx.OfflineTtsConfig()
        model, tokens = self._model_file(), self._resolve('tokens.txt')
        espeak = os.path.join(self.model_dir, 'espeak-ng-data')
        jieba = os.path.join(self.model_dir, 'dict')
        if self._family() == 'kokoro':
            k = cfg.model.kokoro
            k.model, k.tokens = model, tokens
            k.voices = self._resolve('voices.bin', 'voices.txt')
            # 多语言 Kokoro **必须显式给 lexicon**（逗号合并 zh + en），
            # 否则中文全被判为词表外丢弃：实测输出仅 0.2s、ASR 回读为空、相似度 0。
            lex = [p for p in (self._resolve('lexicon-zh.txt'),
                               self._resolve('lexicon-us-en.txt'),
                               self._resolve('lexicon-gb-en.txt')) if p]
            if lex:
                k.lexicon = ','.join(lex)
            if os.path.isdir(espeak):
                k.data_dir = espeak
            if os.path.isdir(jieba):
                k.dict_dir = jieba
            k.lang = lang                      # zh 用 jieba+拼音，en 用 espeak
        else:
            v = cfg.model.vits                 # piper / vits 系（单语言模型）
            v.model, v.tokens = model, tokens
            lex = self._resolve('lexicon.txt')
            if lex:
                v.lexicon = lex
            if os.path.isdir(jieba):
                v.dict_dir = jieba
            if os.path.isdir(espeak):
                v.data_dir = espeak
            v.noise_scale, v.noise_scale_w = 0.667, 0.8
            if lang == 'en' and not os.path.isdir(espeak):
                print('[tts_local] 警告：当前是单语言 vits 模型，英文文本可能读不准 '
                      '（建议用 kokoro 多语言模型）', flush=True)
        cfg.model.num_threads = self.num_threads
        cfg.max_num_sentences = 1
        return sherpa_onnx.OfflineTts(cfg)

    def engine(self, lang='zh'):
        if lang not in self._engines:
            self._engines[lang] = self._build(lang)
        return self._engines[lang]

    def sid_for(self, lang, voice=None):
        """choose speaker id：兼容旧的 edge 音色名（映射到对应语言的默认音色）"""
        if isinstance(voice, int):
            return voice
        key = (lang, voice or '')
        if key in self._sid:
            return self._sid[key]
        sid = 0
        try:
            n = self.engine(lang).num_speakers
            # 中文默认用 sid=0；英文默认 sid=0（Kokoro voices.bin 内已按语言分好音色）
            sid = 0 if n <= 0 else min(0, n - 1)
        except Exception:
            sid = 0
        self._sid[key] = sid
        return sid

    def synthesize(self, text, out_path, lang=None, voice=None, speed=None):
        """合成到 WAV 文件；返回 (path, duration)"""
        text = (text or '').strip()
        if not text:
            raise ValueError('empty text')
        if lang is None:
            lang = 'zh' if any('\u4e00' <= c <= '\u9fff' for c in text) else 'en'
        engine = self.engine(lang)
        sid = self.sid_for(lang, voice)
        audio = engine.generate(text, sid=sid, speed=float(speed or self.speed))
        samples = np.asarray(audio.samples, dtype=np.float32)
        if samples.size == 0:
            raise RuntimeError('本地 TTS 未产生音频')
        peak = float(np.max(np.abs(samples)))
        if peak > 1.0:                      # 防削顶
            samples = samples / peak
        sf.write(out_path, samples, int(audio.sample_rate), subtype='PCM_16')
        return out_path, len(samples) / float(audio.sample_rate)


if __name__ == '__main__':
    import sys, time
    t = SherpaTts()
    print('模型目录:', t.model_dir, '| 可用:', t.available())
    text = sys.argv[1] if len(sys.argv) > 1 else '你好，今天天气不错，气温二十四度。'
    t0 = time.time()
    path, dur = t.synthesize(text, 'temp/_local_tts_probe.wav')
    print(f'{len(text)} 字 → 音频 {dur:.2f}s，耗时 {(time.time()-t0)*1000:.0f}ms（含首次加载）')
    t0 = time.time()
    path, dur = t.synthesize(text, 'temp/_local_tts_probe.wav')
    dt = time.time() - t0
    print(f'第二次（已加载）: {dt*1000:.0f}ms, RTF={dt/dur:.3f} → {path}')
