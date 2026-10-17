"""tts_kokoro_gpu.py — Kokoro 走 PyTorch(ROCm) 在 AMD GPU 上合成（独立 venv-gpu）

为什么独立：GPU 版 torch（rocm7.2.1）装在项目自己的 `venv-gpu`（不共用 OCR venv），
由 worker 以**常驻 sidecar** 方式调用（模型只加载一次）。

为什么不用 sherpa-onnx 跑 Kokoro：sherpa 内置的是纯 CPU 版 onnxruntime，
且要求 ORT API 28，而 DirectML 包只到 API 24（实测报 "requested API version [28]"）✗；
直接驱动 ONNX 又会撞上 DirectML 在动态 shape 图上的崩溃（退出码 5）✗。

音素化不用 misaki（会拖 spacy/num2words 一整条链）：
复用 tts_kokoro.py 里**已用 ASR 回读验证过**的查表实现（与 PyTorch 版词表 171/171 一致）。

用法：
  tts_kokoro_gpu.py "文本" 输出.wav [音色名]     # 单次
  tts_kokoro_gpu.py --server                     # 常驻：按 JSON 行收请求
     请求 {"text":..,"out":..,"voice":"zf_001","speed":1.0}
     应答 {"ok":true,"path":..,"dur":..,"rtf":..,"ms":..,"vram":..}
"""
import os
import sys
import time
import types
import warnings

warnings.filterwarnings('ignore')

# 子进程经管道与 worker 通信：Windows 下默认 stdout 编码可能不是 UTF-8，
# 写 JSON 时直接抛 OSError [Errno 22]（实测）→ 显式改 UTF-8。
for _s in (sys.stdin, sys.stdout, sys.stderr):
    try:
        _s.reconfigure(encoding='utf-8')
    except Exception:
        pass

# 注意：**不要**乱设 MIOPEN_* 环境变量。我曾设 MIOPEN_FIND_MODE/ENFORCE 试图避免
# 运行时算法搜索，结果 MIOpen 解析失败报 "invalid stoul argument"（用户环境不设它们时反而正常）。
# 真正需要的只是"别让模型去请求 dropout 内核"——见下面配置级 dropout 归零。

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)

MODEL_DIR = os.path.join(HERE, 'models', 'kokoro-torch')
ONNX_DIR = os.path.join(HERE, 'models', 'kokoro-int8-multi-lang-v1_1')
STYLES_PER_VOICE = 510
DEFAULT_VOICE = 'zf_001'


def setup_miopen_cache():
    """MIOpen 的算法搜索是**按卷积形状**做的：句子长度一变就是新形状 → 重新搜索（实测每句 10~15s ✗）。
    给它一个可写的持久化 DB 目录，搜索结果会落盘复用（第二次遇到同形状就是查表 ✓）。
    注意：只设路径类变量；不要设 MIOPEN_FIND_MODE/ENFORCE 这类"模式"变量
    （实测会触发 MIOpen 解析错误 invalid stoul argument ✗）。"""
    cache = os.path.join(HERE, 'data', 'miopen')
    try:
        os.makedirs(cache, exist_ok=True)
        os.environ.setdefault('MIOPEN_USER_DB_PATH', cache)
        os.environ.setdefault('MIOPEN_CUSTOM_CACHE_DIR', cache)
        return cache
    except Exception:
        return None


def stub_misaki():
    """kokoro 包的 __init__ 会连带导入 KPipeline（依赖 misaki/spacy）——我们只用 KModel，
    把 misaki 换成宽容桩，绕开整条用不到的 G2P 依赖链。"""
    if 'misaki' in sys.modules:
        return

    def make_cls(name):
        class C:
            def __init__(self, *a, **k):
                pass

            def __call__(self, *a, **k):
                return self

            def __getattr__(self, n):
                return make_cls(n)

            def __iter__(self):
                return iter(())
        C.__name__ = name
        return C

    class Mod(types.ModuleType):
        def __getattr__(self, n):
            if n.startswith('__') and n.endswith('__'):
                raise AttributeError(n)
            t = make_cls(n)
            setattr(self, n, t)
            return t

    for name in ('misaki', 'misaki.en', 'misaki.espeak'):
        m = Mod(name)
        m.__file__ = '<stub:%s>' % name
        m.__path__ = []
        sys.modules[name] = m
    sys.modules['misaki'].en = sys.modules['misaki.en']
    sys.modules['misaki'].espeak = sys.modules['misaki.espeak']


setup_miopen_cache()          # 须在模型加载（懒 import torch）之前调用


class KokoroGpu:
    def __init__(self, device='cuda'):
        import numpy as np
        import soundfile as sf
        import torch
        self.np, self.sf, self.torch = np, sf, torch

        # ROCm 7.2 的 MIOpen 在 gfx1201（RDNA4/9070 XT）上**编译不了 dropout 内核**
        # （实测报 "Code object build failed. Source: MIOpenDropoutHIP.cpp"）。
        # 而推理期 dropout 本就是恒等映射 → 直接换成 Identity，绕开这个内核。
        torch.nn.Dropout = torch.nn.Identity
        torch.nn.Dropout1d = torch.nn.Identity
        torch.nn.Dropout2d = torch.nn.Identity
        torch.nn.Dropout3d = torch.nn.Identity
        torch.nn.functional.dropout = lambda x, p=0.5, training=False, inplace=False: x
        torch.nn.functional.dropout1d = torch.nn.functional.dropout
        torch.nn.functional.dropout2d = torch.nn.functional.dropout
        torch.nn.functional.dropout3d = torch.nn.functional.dropout
        self.device = device if torch.cuda.is_available() else 'cpu'

        from tts_kokoro import KokoroTts
        self.ph = KokoroTts(model_dir=ONNX_DIR, provider='cpu')

        stub_misaki()
        from kokoro.model import KModel
        self.KModel = KModel
        self._load()
        self.voices = {}

    def _load(self):
        torch, t0 = self.torch, time.time()
        # 配置里 plbert.dropout=0.1 / dropout=0.2：ALBERT 注意力在 **C++ 层**调 dropout，
        # Python 侧替换 F.dropout 盖不住 → MIOpen 会去编译 dropout 内核，而它在 gfx1201 上
        # 编不过（MIOpenDropoutHIP.cpp build failed）。推理期 dropout 本就是恒等，
        # 所以**构造前**把配置里的 dropout 归零，从源头不需要这个内核。
        import json as _json
        with open(os.path.join(MODEL_DIR, 'config.json'), encoding='utf-8') as f:
            cfg = _json.load(f)
        cfg['dropout'] = 0.0
        if isinstance(cfg.get('plbert'), dict):
            cfg['plbert']['dropout'] = 0.0
        patched = os.path.join(MODEL_DIR, 'config.nodropout.json')
        with open(patched, 'w', encoding='utf-8') as f:
            _json.dump(cfg, f)
        self.km = self.KModel(config=patched,
                              model=os.path.join(MODEL_DIR, 'kokoro-v1_1-zh.pth'))
        # LSTM 里配了 dropout=0.2（torch 会警告 num_layers=1 时它无效）。
        # 但 torch 的 MIOpen RNN 路径即便推理期也要 dropout 内核，而该内核在 gfx1201 上
        # JIT 编译失败（MIOpenDropoutHIP.cpp）→ 直接把 RNN 的 dropout 置 0，彻底不需要它。
        zeroed = 0
        for m in self.km.modules():
            for attr in ('dropout',):
                if isinstance(getattr(m, attr, None), float) and getattr(m, attr) > 0:
                    setattr(m, attr, 0.0)
                    zeroed += 1
        if zeroed:
            print('WARN 已把 %d 处 RNN dropout 置 0（绕开 MIOpen dropout 内核）' % zeroed, flush=True)
        self.km = self.km.to(self.device).eval()
        self.load_s = time.time() - t0

    def voice(self, name):
        if name not in self.voices:
            p = os.path.join(MODEL_DIR, 'voices', name + '.pt')
            if not os.path.exists(p):
                raise RuntimeError('音色文件不存在: %s' % p)
            # 形状是 [510, 1, 256]，取 [idx] 得 [1,256] —— 官方就是直接传，不要再 unsqueeze
            # torch>=2.6 默认 weights_only=True，部分音色文件含非张量对象会反序列化失败 ✗
            # （实测报 WeightsUnpickler "Unsupported operand"）→ 显式关闭（文件来自官方镜像，可信）
            try:
                self.voices[name] = self.torch.load(p, map_location='cpu', weights_only=False)
            except TypeError:
                self.voices[name] = self.torch.load(p, map_location='cpu')
        return self.voices[name]

    def _run(self, ids, ref, speed):
        torch = self.torch
        # 关键：模型内部是 [[0, *phoneme_ids, 0]]（首尾各补一个 0 作为 BOS/EOS），
        # 且要用 forward_with_tokens（高阶 forward 收的是**音素字符串**，传 id tensor 会被
        # vocab.get 全部过滤成空序列 → 只会输出 0.3 秒的垃圾）。
        tokens = torch.LongTensor([[0, *ids, 0]]).to(self.device)
        with torch.no_grad():
            t0 = time.time()
            out = self.km.forward_with_tokens(tokens, ref.to(self.device), float(speed))
            if self.device != 'cpu':
                torch.cuda.synchronize()
            dt = time.time() - t0
        audio = out[0] if isinstance(out, (tuple, list)) else out
        return audio, dt

    def synth(self, text, out, voice=DEFAULT_VOICE, speed=1.0):
        ids = self.ph.phonemize_ids(text)
        if len(ids) < 2:
            raise RuntimeError('音素化为空')
        idx = min(len(ids), STYLES_PER_VOICE - 1)
        ref = self.voice(voice)[idx]
        try:
            audio, dt = self._run(ids, ref, speed)
        except RuntimeError as e:
            # ROCm/MIOpen 在 LSTM 上会报 miopenStatusUnknownError（实测）→
            # 关掉 MIOpen（ROCm 下 torch.backends.cudnn 即 MIOpen）重建模型重试一次
            if 'miopen' not in str(e).lower():
                raise
            print('WARN 仍命中 MIOpen 错误（dropout 补丁未覆盖？），禁用 MIOpen 重试: %s' % e, flush=True)
            self.torch.backends.cudnn.enabled = False
            self._load()
            audio, dt = self._run(ids, ref, speed)
        samples = audio.detach().to('cpu').numpy().reshape(-1).astype('float32')
        peak = float(self.np.max(self.np.abs(samples))) if samples.size else 0.0
        if peak > 1.0:
            samples = samples / peak
        os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
        self.sf.write(out, samples, 24000, subtype='PCM_16')
        dur = len(samples) / 24000.0
        vram = self.torch.cuda.memory_allocated() / 1048576 if self.device != 'cpu' else 0
        return {'ok': True, 'path': out, 'dur': round(dur, 3), 'rtf': round(dt / max(dur, 1e-6), 3),
                'ms': round(dt * 1000), 'vram': round(vram), 'tokens': len(ids), 'voice': voice}


def serve():
    import json
    eng = KokoroGpu()
    # 热身：首次推理要 JIT 编译内核（一次性），放在启动阶段做完，别让用户第一句话等
    warm_s = 0.0
    try:
        t0 = time.time()
        # 按几种典型长度各预热一次：MIOpen 搜索是按卷积形状的，覆盖常见长度后
        # 用户实际句子的形状大多命中（首次仍可能略慢，之后落盘复用 ✓）
        for t in ('你好', '你好，我是潞潞同学。',
                  '这是一句用来覆盖中等长度卷积形状的预热文本，大约三十来个字。',
                  '这句更长一些，用来把更大形状的卷积也预热掉，避免用户第一次说长句时等待过久。' * 2):
            eng.synth(t, os.path.join(HERE, 'temp', '_warm.wav'))
        warm_s = time.time() - t0
    except Exception as e:
        print(json.dumps({'warm_error': '%s: %s' % (type(e).__name__, e)}), flush=True)
    print(json.dumps({'ready': True, 'device': eng.device, 'load': round(eng.load_s, 2),
                      'warm': round(warm_s, 1),
                      'vram': round(eng.torch.cuda.memory_allocated() / 1048576)
                      if eng.device != 'cpu' else 0}), flush=True)

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
            if req.get('cmd') == 'quit':
                break
            r = eng.synth(req.get('text', ''),
                          req.get('out') or os.path.join(HERE, 'temp', '_kokoro_gpu.wav'),
                          req.get('voice') or DEFAULT_VOICE,
                          req.get('speed') or 1.0)
            print(json.dumps(r, ensure_ascii=False), flush=True)
        except Exception as e:
            print(json.dumps({'ok': False, 'error': '%s: %s' % (type(e).__name__, e)}), flush=True)
    return 0


def main():
    if '--server' in sys.argv:
        return serve()
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    text = args[0] if args else '你好，我是潞潞同学。'
    out = args[1] if len(args) > 1 else os.path.join(HERE, 'temp', '_kokoro_gpu.wav')
    voice = args[2] if len(args) > 2 else DEFAULT_VOICE
    eng = KokoroGpu()
    r = eng.synth(text, out, voice)
    print('RESULT dur=%ss rt=%sms rtf=%s device=%s load=%ss vram=%sMB tokens=%s voice=%s'
          % (r['dur'], r['ms'], r['rtf'], eng.device, round(eng.load_s, 1), r['vram'], r['tokens'], r['voice']))
    return 0


if __name__ == '__main__':
    sys.exit(main())
