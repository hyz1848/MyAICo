"""tts_kokoro.py — Kokoro(VITS 系, 中英双语) 本地 TTS，跑 DirectML(AMD GPU)

为什么：Piper 只支持中文；Kokoro 多语言 v1.1 是**中英同一模型**，音质更好。
sherpa-onnx 内置的是纯 CPU 版 onnxruntime，且要求 ORT API 28，而 DirectML 包只到 API 24
（实测报错 "requested API version [28] ... only [1, 24]"）→ 走不通，所以这里**直接驱动 ONNX**。

模型接口（实测自 model.int8.onnx）：
    tokens int64[1,L]   style float32[1,256]   speed float32[1]   →   audio float32[L]
音素化（全是查表 + 最长匹配，离线可复现）：
    lexicon-zh.txt    汉字 → 注音符号+声调     （68k 条，含多字词条）
    lexicon-us-en.txt  英文词 → IPA
    tokens.txt         音素符号 → id           （171 个）
    voices.bin         103 音色 × 510 个 style 向量（按 token 数索引），纯 float32 扁平表
"""
import glob
import os
import re
import sys

import numpy as np
import soundfile as sf

MODEL_DEFAULT = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                             'models', 'kokoro-int8-multi-lang-v1_1')
STYLES_PER_VOICE = 510
_PROVIDER_TABLE = {'dml': 'DmlExecutionProvider', 'directml': 'DmlExecutionProvider',
                   'cpu': 'CPUExecutionProvider', 'cuda': 'CUDAExecutionProvider'}
_LATIN = re.compile(r"[A-Za-z][A-Za-z']*")
# tokens.txt 里只有半角标点 → 全角要映射过来（否则中文句子里的"，，。"会被整段丢掉）
_PUNCT_MAP = {'，': ',', '。': '.', '！': '!', '？': '?', '；': ';', '：': ':', '、': ',',
              '“': '"', '”': '"', '（': '(', '）': ')', '—': '—', '…': '…', '·': ' '}


class KokoroUnavailable(RuntimeError):
    """模型缺失/不完整——配置状态，不是故障"""


class KokoroTts:
    def __init__(self, model_dir=None, provider=None, voice=0, speed=1.0, threads=4):
        self.model_dir = model_dir or os.environ.get('VOICEAI_KOKORO_MODEL') or MODEL_DEFAULT
        self.provider = (provider or os.environ.get('VOICEAI_TTS_PROVIDER') or 'auto').lower()
        self.voice = int(voice)
        self.speed = float(speed)
        self.num_threads = int(threads)
        self._sess = None
        self._tok = None
        self._styles = None
        self.provider_used = None
        self.sample_rate = 24000

    # ---------- 路径与可用性 ----------
    def _file(self, *names):
        for n in names:
            p = os.path.join(self.model_dir, n)
            if os.path.exists(p):
                return p
        cands = [f for f in glob.glob(os.path.join(self.model_dir, '*.onnx'))
                 if not os.path.basename(f).startswith('voices')]
        return cands[0] if cands else None

    def available(self):
        need = [self._file('model.int8.onnx', 'model.onnx'), 'voices.bin', 'tokens.txt',
                'lexicon-zh.txt', 'lexicon-us-en.txt']
        return all(os.path.exists(os.path.join(self.model_dir, n)) if not n.endswith('.onnx')
                   else self._file('model.int8.onnx', 'model.onnx') for n in need)

    # ---------- 表 ----------
    def _tables(self):
        if self._tok is not None:
            return
        self._tok = {}
        with open(os.path.join(self.model_dir, 'tokens.txt'), encoding='utf-8') as f:
            for line in f:
                p = line.rstrip('\n').split(' ')
                if len(p) >= 2 and p[-1].isdigit():
                    self._tok[' '.join(p[:-1])] = int(p[-1])
        self._zh = self._load_lexicon('lexicon-zh.txt')
        self._en = self._load_lexicon('lexicon-us-en.txt')
        self._by_len_zh, self._by_len_en = {}, {}
        for w in self._zh:
            self._by_len_zh.setdefault(len(w), set()).add(w)
        for w in self._en:
            self._by_len_en.setdefault(len(w), set()).add(w)
        self._zh_max = max(self._by_len_zh) if self._by_len_zh else 1
        self._en_max = max(self._by_len_en) if self._by_len_en else 1
        print(f'[kokoro] 词表 {len(self._tok)} 音素 | 中文词条 {len(self._zh)}（最长 {self._zh_max} 字）| '
              f'英文词条 {len(self._en)}（最长 {self._en_max}）', file=sys.stderr, flush=True)

    def _load_lexicon(self, name):
        out = {}
        tok = self._tok
        with open(os.path.join(self.model_dir, name), encoding='utf-8') as f:
            for line in f:
                parts = line.split()
                if len(parts) < 2:
                    continue
                ids = [tok[s] for s in parts[1:] if s in tok]
                if ids:
                    out[parts[0]] = ids
        return out

    def _styles_table(self):
        if self._styles is None:
            raw = np.fromfile(os.path.join(self.model_dir, 'voices.bin'), dtype='<f4')
            if raw.size % 256:
                raise KokoroUnavailable('voices.bin 长度不是 256 的整数倍')
            self._styles = raw.reshape(-1, 256)
            print(f'[kokoro] style 表 {self._styles.shape[0]} 个向量 = '
                  f'{self._styles.shape[0] // STYLES_PER_VOICE} 音色 × {STYLES_PER_VOICE}',
                  file=sys.stderr, flush=True)
        return self._styles

    # ---------- 音素化 ----------
    def _numbers_to_words(self, text):
        try:
            from unicode_rbnf import RbnfEngine
            eng = RbnfEngine.for_language('zh')
        except Exception:
            return text

        def rep(m):
            s = m.group(0).replace(',', '')
            try:
                if '.' in s:
                    head, _, tail = s.partition('.')
                    out = getattr(eng.format_number(int(head)), 'text', '') if head else ''
                    return out + '点' + ''.join(
                        getattr(eng.format_number(int(d)), 'text', '') for d in tail if d.isdigit())
                return getattr(eng.format_number(int(s)), 'text', s)
            except Exception:
                return s
        return re.sub(r'\d[\d,]*(?:\.\d+)?', rep, text)

    def phonemize_ids(self, text):
        self._tables()
        t = self._numbers_to_words(str(text or ''))
        ids = []
        unknown = []
        i, n = 0, len(t)
        while i < n:
            ch = t[i]
            # 1) 英文单词（最长匹配，大小写不敏感）
            if ch.isascii() and ch.isalpha():
                m = _LATIN.match(t, i)
                word = m.group(0) if m else ch
                hit = None
                for L in range(min(self._en_max, len(word)), 0, -1):
                    cand = word[:L].lower()
                    if cand in self._en:
                        hit = (L, self._en[cand])
                        break
                if hit:
                    ids.extend(hit[1])
                    i += hit[0]
                    continue
            # 2) 中文（最长匹配）
            if '\u3400' <= ch <= '\u9fff' or ch in '，。！？、；：':
                if ch in self._zh:
                    ids.extend(self._zh[ch])
                    i += 1
                    continue
                hit = None
                for L in range(min(self._zh_max, n - i), 1, -1):
                    cand = t[i:i + L]
                    if cand in self._zh:
                        hit = (L, self._zh[cand])
                        break
                if hit:
                    ids.extend(hit[1])
                    i += hit[0]
                    continue
            # 3) 标点/符号（全角先映射到半角，再用 tokens.txt）
            mapped = _PUNCT_MAP.get(ch, ch)
            if mapped in self._tok:
                ids.append(self._tok[mapped])
                i += 1
                continue
            if ch in self._tok:
                ids.append(self._tok[ch])
                i += 1
                continue
            if not ch.isspace():
                unknown.append(ch)
            i += 1
        if unknown:
            print(f'[kokoro] 未登录符号（跳过）: {"".join(unknown[:10])}', file=sys.stderr, flush=True)
        return ids

    # ---------- 引擎 ----------
    def session(self):
        if self._sess is None:
            if not self.available():
                raise KokoroUnavailable(f'Kokoro 模型缺失: {self.model_dir}')
            import onnxruntime as ort
            avail = ort.get_available_providers()
            want = self.provider
            if want in ('auto', ''):
                want = 'dml' if 'DmlExecutionProvider' in avail else 'cpu'
            name = _PROVIDER_TABLE.get(want, want)
            so = ort.SessionOptions()
            so.log_severity_level = 3
            if name == 'CPUExecutionProvider':
                so.intra_op_num_threads = self.num_threads
            try:
                self._sess = ort.InferenceSession(self._file('model.int8.onnx', 'model.onnx'),
                                                  sess_options=so, providers=[name])
            except Exception as e:
                print(f'[kokoro] {name} 不可用（{type(e).__name__}: {e}），回退 CPU',
                      file=sys.stderr, flush=True)
                self._sess = ort.InferenceSession(self._file('model.int8.onnx', 'model.onnx'))
            self.provider_used = self._sess.get_providers()[0]
            print(f'[kokoro] provider={self.provider_used}', file=sys.stderr, flush=True)
        return self._sess

    def style_for(self, n_tokens, voice=None):
        tab = self._styles_table()
        v = self.voice if voice is None else int(voice)
        idx = v * STYLES_PER_VOICE + min(n_tokens, STYLES_PER_VOICE - 1)
        if idx >= tab.shape[0]:
            idx = min(n_tokens, STYLES_PER_VOICE - 1)      # 音色号超范围时退回第一音色
        return tab[idx]

    def synthesize(self, text, out_path, voice=None, speed=None):
        """合成到 WAV；返回 (路径, 时长秒)"""
        text = (text or '').strip()
        if not text:
            raise ValueError('empty text')
        sess = self.session()
        ids = self.phonemize_ids(text)
        if len(ids) < 2:
            raise RuntimeError('音素化为空（文本无法发音？）')
        tokens = np.array([ids], dtype=np.int64)
        style = self.style_for(len(ids), voice=voice).reshape(1, 256).astype(np.float32)
        sp = np.array([float(speed or self.speed)], dtype=np.float32)
        audio = sess.run(None, {'tokens': tokens, 'style': style, 'speed': sp})[0]
        samples = np.asarray(audio, dtype=np.float32).reshape(-1)
        if samples.size == 0:
            raise RuntimeError('模型未产生音频')
        peak = float(np.max(np.abs(samples)))
        if peak > 1.0:
            samples = samples / peak
        sf.write(out_path, samples, self.sample_rate, subtype='PCM_16')
        return out_path, len(samples) / float(self.sample_rate)


if __name__ == '__main__':
    import time
    t = KokoroTts()
    print('模型目录:', t.model_dir, '| 可用:', t.available())
    text = sys.argv[1] if len(sys.argv) > 1 else '你好，我是潞潞同学。Node.js 24.1 是最新版本。'
    ids = t.phonemize_ids(text)
    print(f'音素数: {len(ids)}')
    for i in range(3):
        t0 = time.time()
        path, dur = t.synthesize(text, os.path.join('temp', '_kokoro_probe.wav'))
        dt = time.time() - t0
        tag = '首次(含加载/编译)' if i == 0 else f'第{i + 1}次'
        print(f'{tag}: {dt * 1000:.0f}ms 音频 {dur:.2f}s RTF={dt / max(dur, 1e-6):.3f} '
              f'provider={t.provider_used} → {path}')
