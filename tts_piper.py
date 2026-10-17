"""tts_piper.py — Piper(VITS) 本地 TTS，可跑 DirectML（AMD GPU）/ CPU

为什么是 Piper 而不是 Kokoro：
  Kokoro int8 在本机 CPU 实测 RTF 1.5~1.6（合成比播放还慢，会追不上播报）。
  Piper 是 VITS 系小模型（本模型 int8 约 60MB），实测：
    CPU  RTF 0.342
    DirectML(RX 9070 XT)  RTF 0.014  ← 8.3 秒语音 117ms 合成完
  对比 edge-tts 每句 ~1.2s 的网络往返，快一个数量级。

音素化复用 piper 自带前端（espeak-ng 绑定 + zh 词典，自带 espeakbridge.pyd/espeak-ng-data），
推理用**我们自己的 onnxruntime 会话**（provider 可选 directml/cpu）——piper 的 load() 只认
CUDA/CPU，所以这里自己建会话交给 PiperVoice。
"""
import glob
import json
import os
import sys
from pathlib import Path

import numpy as np
import soundfile as sf

MODEL_DEFAULT = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                             'models', 'vits-piper-zh_CN-xiao_ya-medium-int8')

_PROVIDER_TABLE = {
    'dml': 'DmlExecutionProvider',
    'directml': 'DmlExecutionProvider',
    'cpu': 'CPUExecutionProvider',
    'cuda': 'CUDAExecutionProvider',
}


class PiperUnavailable(RuntimeError):
    """模型缺失/不完整——配置状态，不是故障"""


# piper 的中文前端需要联网下 G2PW 多音字模型（HF，本环境不通）→ 自己做离线音素化：
#   · 词典 lexicon.txt 含 1~10 字词条且读音已分上下文（长期 cháng / 银行 háng / 生长 zhǎng）
#     → 最长匹配即可正确念多音字
#   · 数字用 unicode_rbnf 转中文（与 piper 同源），拉丁字母按字母名读
#   · 未登录字用 pypinyin 兜底
_LETTER_NAMES = {
    'a': '诶', 'b': '比', 'c': '西', 'd': '迪', 'e': '伊', 'f': '艾弗', 'g': '吉', 'h': '艾尺',
    'i': '艾', 'j': '杰', 'k': '开', 'l': '艾勒', 'm': '艾姆', 'n': '艾恩', 'o': '哦', 'p': '屁',
    'q': '丘', 'r': '艾儿', 's': '艾丝', 't': '提', 'u': '优', 'v': '维', 'w': '达不溜',
    'x': '艾克斯', 'y': '歪', 'z': '贼德',
}
_PUNCT_TOKENS = {
    '。': '。', '.': '。', '？': '？', '?': '？', '！': '！', '!': '！',
    '，': '，', ',': '，', '、': '，', '：': '，', ':': '，', '；': '，', ';': '，',
    '—': '—', '…': '—', ' ': '，', '\t': '，', '\n': '，', '“': '', '”': '', '"': '',
    '(': '', ')': '', '（': '', '）': '', '《': '', '》': '', '·': '',
}


class ZhPhonemizer:
    """离线中文文本 → 音素 id（供 Piper/VITS 模型使用）"""

    def __init__(self, model_dir):
        import sys as _sys
        self.model_dir = model_dir
        self.phoneme_id = {}
        tok_path = os.path.join(model_dir, 'tokens.txt')
        with open(tok_path, encoding='utf-8') as f:
            for line in f:
                parts = line.rstrip('\n').split(' ')
                if len(parts) >= 2 and parts[-1].isdigit():
                    # 音素本身可能是空格（如 ' ' → 72），只取第一段作 key
                    self.phoneme_id[parts[0]] = int(parts[-1])
        self.bos = self.phoneme_id.get('^', 1)
        self.eos = self.phoneme_id.get('$', 2)
        self.sep = self.phoneme_id.get('_', 0)

        self.lex = {}
        self.maxlen = 1
        with open(os.path.join(model_dir, 'lexicon.txt'), encoding='utf-8') as f:
            for line in f:
                parts = line.split()
                if len(parts) < 2:
                    continue
                word, toks = parts[0], parts[1:]
                ids = [self.phoneme_id[t] for t in toks if t in self.phoneme_id]
                if not ids:
                    continue
                self.lex[word] = ids
                if len(word) > self.maxlen:
                    self.maxlen = len(word)
        self.by_len = {}
        for w in self.lex:
            self.by_len.setdefault(len(w), set()).add(w)
        print(f'[tts] 中文音素词典: {len(self.lex)} 条（最长 {self.maxlen} 字），'
              f'音素表 {len(self.phoneme_id)} 个', file=_sys.stderr, flush=True)
        self._rbnf = None

    # ---------- 文本规整 ----------
    def _rbnf_engine(self):
        if self._rbnf is None:
            try:
                from unicode_rbnf import RbnfEngine
                self._rbnf = RbnfEngine.for_language('zh')
            except Exception:
                self._rbnf = False
        return self._rbnf or None

    def normalize(self, text):
        import re as _re
        t = str(text or '')
        # 数字（含小数、千分位）→ 中文数字
        eng = self._rbnf_engine()
        if eng:
            def to_text(n):
                r = eng.format_number(n)
                return getattr(r, 'text', None) or str(r)

            def num_repl(m):
                s = m.group(0).replace(',', '')
                try:
                    if '.' in s:
                        head, _, tail = s.partition('.')
                        out = to_text(int(head)) if head else ''
                        return out + '点' + ''.join(to_text(int(d)) for d in tail if d.isdigit())
                    return to_text(int(s))
                except Exception:
                    return s
            t = _re.sub(r'\d[\d,]*(?:\.\d+)?', num_repl, t)
        # 拉丁字母 → 字母名（中文读法）
        def latin_repl(m):
            return ''.join(_LETTER_NAMES.get(c.lower(), '') for c in m.group(0))
        t = _re.sub(r'[A-Za-z]+', latin_repl, t)
        return t

    # ---------- 分词 + 映射 ----------
    def _fallback_ids(self, ch):
        """未登录字：pypinyin（带调）→ 声母 + 韵母 + 声调"""
        out = []
        try:
            import pypinyin
            ini = pypinyin.pinyin(ch, style=pypinyin.Style.INITIALS, strict=True,
                                  errors='ignore')
            fin = pypinyin.pinyin(ch, style=pypinyin.Style.FINALS_TONE3, strict=True,
                                  errors='ignore')
            if not fin or not fin[0]:
                return out
            i0 = (ini[0][0] if ini and ini[0] else '')
            f0 = fin[0][0]
            tone = ''
            if f0 and f0[-1].isdigit():
                tone, f0 = f0[-1], f0[:-1]
            if i0 and i0 in self.phoneme_id:
                out.append(self.phoneme_id[i0])
            if f0 and f0 in self.phoneme_id:
                out.append(self.phoneme_id[f0])
            if tone and tone in self.phoneme_id:
                out.append(self.phoneme_id[tone])
            if out:
                out.append(self.sep)
        except Exception:
            pass
        return out

    def phonemize_ids(self, text):
        """整段文本 → 音素 id 序列"""
        t = self.normalize(text)
        ids = [self.bos]
        i, n = 0, len(t)
        unknown = []
        while i < n:
            ch = t[i]
            p = _PUNCT_TOKENS.get(ch)
            if p is not None:
                if p and p in self.phoneme_id:
                    ids.append(self.phoneme_id[p])
                i += 1
                continue
            hit = None
            for L in range(min(self.maxlen, n - i), 0, -1):
                cand = t[i:i + L]
                if cand in self.lex:
                    hit = (L, self.lex[cand])
                    break
            if hit:
                ids.extend(hit[1])
                i += hit[0]
            else:
                fb = self._fallback_ids(ch)
                if fb:
                    ids.extend(fb)
                elif not ch.isspace():
                    unknown.append(ch)
                i += 1
        ids.append(self.eos)
        if unknown:
            print(f'[tts] 未登录字（跳过）: {"".join(unknown[:12])}', file=sys.stderr, flush=True)
        return ids

    def tokenize(self, text):
        """调试用：返回 (音素 id, 可读切片)"""
        t = self.normalize(text)
        out, words = [], []
        i, n = 0, len(t)
        while i < n:
            ch = t[i]
            p = _PUNCT_TOKENS.get(ch)
            if p is not None:
                if p and p in self.phoneme_id:
                    out.append(self.phoneme_id[p])
                    words.append(p)
                i += 1
                continue
            hit = None
            for L in range(min(self.maxlen, n - i), 0, -1):
                cand = t[i:i + L]
                if cand in self.lex:
                    hit = (L, cand)
                    break
            if hit:
                out.extend(self.lex[hit[1]])
                words.append(hit[1])
                i += hit[0]
            else:
                fb = self._fallback_ids(ch)
                out.extend(fb)
                words.append(ch + '(拼音兜底)' if fb else ch + '(跳过)')
                i += 1
        return out, words


class PiperTts:
    def __init__(self, model_dir=None, provider=None, num_threads=4, speed=1.0):
        self.model_dir = model_dir or os.environ.get('VOICEAI_PIPER_MODEL') or MODEL_DEFAULT
        self.provider = (provider or os.environ.get('VOICEAI_TTS_PROVIDER') or 'auto').lower()
        self.num_threads = int(num_threads)
        self.speed = float(speed)
        self._voice = None
        self._ph = None
        self.provider_used = None

    # ---------- 路径 ----------
    def _model_file(self):
        cands = sorted(glob.glob(os.path.join(self.model_dir, '*.onnx')))
        return cands[0] if cands else None

    def _config_file(self):
        m = self._model_file()
        if not m:
            return None
        for p in (m + '.json', os.path.join(self.model_dir, 'config.json')):
            if os.path.exists(p):
                return p
        return None

    def available(self):
        return bool(self._model_file() and self._config_file())

    # ---------- 引擎 ----------
    def _provider_name(self):
        import onnxruntime as ort
        avail = ort.get_available_providers()
        want = self.provider
        if want in ('auto', ''):
            want = 'dml' if 'DmlExecutionProvider' in avail else 'cpu'
        return _PROVIDER_TABLE.get(want, want), avail

    def voice(self):
        if self._voice is not None:
            return self._voice
        if not self.available():
            raise PiperUnavailable(f'Piper 模型缺失: {self.model_dir}')
        import onnxruntime as ort
        from piper.config import PiperConfig
        from piper.phonemize_espeak import ESPEAK_DATA_DIR
        from piper.voice import PiperVoice

        model, cfg_path = self._model_file(), self._config_file()
        name, avail = self._provider_name()
        so = ort.SessionOptions()
        so.log_severity_level = 3          # 只报错误：DML 下"部分节点回落 CPU"的警告无害但刷屏
        if name == 'CPUExecutionProvider':
            so.intra_op_num_threads = self.num_threads
        try:
            sess = ort.InferenceSession(model, sess_options=so, providers=[name])
        except Exception as e:
            # 指定 provider 建不起来（驱动/显存/版本）→ 退回 CPU，别让 TTS 整体不可用
            print(f'[tts] {name} 会话创建失败（{type(e).__name__}: {e}），回退 CPU',
                  file=sys.stderr, flush=True)
            sess = ort.InferenceSession(model)
        self.provider_used = sess.get_providers()[0]

        cfg = PiperConfig.from_dict(json.load(open(cfg_path, encoding='utf-8')))
        try:
            self._voice = PiperVoice(config=cfg, session=sess,
                                     espeak_data_dir=Path(ESPEAK_DATA_DIR),
                                     download_dir=Path(self.model_dir))
        except TypeError:
            # 直接构造不兼容时，退回官方 load（会多建一个会话，但保证可用）
            self._voice = PiperVoice.load(model, config_path=cfg_path)
            self._voice.session = sess
        return self._voice

    # ---------- 合成 ----------
    def phonemizer(self):
        if self._ph is None:
            if not self.available():
                raise PiperUnavailable(f'Piper 模型缺失: {self.model_dir}')
            self._ph = ZhPhonemizer(self.model_dir)
        return self._ph

    def synthesize(self, text, out_path, speed=None):
        """合成到 WAV；返回 (路径, 时长秒)"""
        text = (text or '').strip()
        if not text:
            raise ValueError('empty text')
        from piper.config import SynthesisConfig
        v = self.voice()
        # length_scale 越大语速越慢 → 用 1/speed 换算
        ls = 1.0 / max(0.3, float(speed or self.speed))
        syn = SynthesisConfig(length_scale=ls, noise_scale=None, noise_w_scale=None)

        ids = self.phonemizer().phonemize_ids(text)
        if len(ids) <= 2:                      # 只有 BOS/EOS
            raise RuntimeError('音素化为空（文本无法发音？）')
        audio = v.phoneme_ids_to_audio(ids, syn)
        if isinstance(audio, tuple):           # include_alignments 时返回 (audio, align)
            audio = audio[0]
        samples = np.asarray(audio, dtype=np.float32).reshape(-1)
        if samples.size == 0:
            raise RuntimeError('模型未产生音频')
        peak = float(np.max(np.abs(samples)))
        if peak > 1.0:
            samples = samples / peak
        sr = int(getattr(v.config, 'sample_rate', 0) or 22050)
        sf.write(out_path, samples, sr, subtype='PCM_16')
        return out_path, len(samples) / float(sr)


if __name__ == '__main__':
    import time
    t = PiperTts()
    print('模型目录:', t.model_dir, '| 可用:', t.available())
    text = sys.argv[1] if len(sys.argv) > 1 else '你好，我是潞潞同学。今天成都小雨，气温十六到二十四度。'
    ids, words = t.phonemizer().tokenize('长期住在银行旁边生长，Node.js 24.1 版本，下午三点十六分。')
    print('分词:', ' | '.join(words))
    for i in range(3):
        t0 = time.time()
        path, dur = t.synthesize(text, os.path.join('temp', '_piper_probe.wav'))
        dt = time.time() - t0
        tag = '首次(含加载)' if i == 0 else f'第{i + 1}次'
        print(f'{tag}: {dt * 1000:.0f}ms  音频 {dur:.2f}s  RTF={dt / max(dur, 1e-6):.3f}  '
              f'provider={t.provider_used} → {path}')
