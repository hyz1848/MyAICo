"""run_indextts.py — 用 GPU 跑 IndexTTS-2.5（bf16），输出样音并统计 RTF / 显存

用法（环境变量必须带上，否则卷积会退化成每形状 8 秒的 JIT ✗）：
    set MIOPEN_FIND_MODE=2
    set MIOPEN_USER_DB_PATH=H:/voiceai/temp/miopen_db
    set MIOPEN_CUSTOM_CACHE_DIR=H:/voiceai/temp/miopen_db
    set PYTHONPATH=H:/voiceai/indextts-deps
    venv-gpu/Scripts/python.exe tools/run_indextts.py

为什么用 bf16：官方 2.5 示例就是 use_bf16=True ✓；use_cuda_kernel 必须 False ✗（那是 CUDA 融合核，ROCm 没有）。
为什么 os._exit：ROCm 进程正常退出会挂住 ✗（实测打印完卡到超时），显式退出最省事 ✓。
"""
import os
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(HERE, 'index-tts-2.5.0'))
sys.path.insert(0, os.path.join(ROOT, 'indextts-deps'))

MODEL = os.path.join(ROOT, 'models', 'ms_cache', 'models',
                     'IndexTeam--IndexTTS-2.5', 'snapshots', 'master')
REF = os.path.join(ROOT, 'models', 'ms_cache', '_ref.wav')
OUT = os.path.join(ROOT, 'temp', 'indextts_sample.wav')
TEXT = os.environ.get('INDEXTTS_TEXT', '你好，我是潞潞同学，很高兴认识你。今天天气不错，适合出门走走。')

import torch  # noqa: E402

# ★ Windows-ROCm 的 torch 轮子没有编进 torch._C._distributed_c10d ✗（AMD 已知限制 ✓
#   见 huggingface/diffusers#12409：报告者用的也是 repo.radeon.com 的 Windows ROCm 预览版 ✓）
#   而 IndexTTS 只用 is_available()/is_initialized()/get_rank()（都有守卫 ✓）→
#   打个桩让 import 过得去 + 强制 is_available()=False ✓ 全部走"无分布式"分支 ✓
def _stub_distributed():
    import sys
    import types

    if getattr(torch._C, '_distributed_c10d', None) is not None:
        return
    mod = types.ModuleType('torch._C._distributed_c10d')

    class _Dummy:
        def __init__(self, *a, **k):
            pass

        def __call__(self, *a, **k):
            return _Dummy()

        def __getattr__(self, n):
            return _Dummy()

    def _any(name):                      # 模块级 __getattr__：任何名字都给个占位类 ✓
        return _Dummy

    mod.__getattr__ = _any
    sys.modules['torch._C._distributed_c10d'] = mod
    try:
        setattr(torch._C, '_distributed_c10d', mod)
    except Exception:
        pass
    print('[stub] 已为缺失的 torch._C._distributed_c10d 打桩 ✓（Windows-ROCm 构建限制）', flush=True)


_stub_distributed()
try:
    import torch.distributed as _d

    _real = getattr(_d, 'is_available', None)
    _d.is_available = lambda: False      # 强制走非分布式路径，避免桩被真正调用 ✓
except Exception as _e:
    print('[stub] torch.distributed 导入仍失败：%s' % _e, flush=True)

print('torch %s | cuda 可用 %s' % (torch.__version__, torch.cuda.is_available()), flush=True)
if torch.cuda.is_available():
    print('显卡 %s | 显存 %.1f GB' % (torch.cuda.get_device_name(0),
          torch.cuda.get_device_properties(0).total_memory / 1024 ** 3), flush=True)

from indextts.infer_v2_5 import IndexTTS2  # noqa: E402

t0 = time.time()
tts = IndexTTS2(cfg_path=os.path.join(MODEL, 'config.yaml'), model_dir=MODEL,
                use_bf16=True, use_cuda_kernel=False)
load = time.time() - t0
alloc = torch.cuda.memory_allocated() / 1024 ** 3 if torch.cuda.is_available() else 0
print('★ 加载完成 %.1fs  显存占用 %.2f GB' % (load, alloc), flush=True)

t0 = time.time()
tts.infer(spk_audio_prompt=REF, text=TEXT, output_path=OUT, lang='zh', verbose=False)
dt = time.time() - t0
import soundfile as sf  # noqa: E402

d, sr = sf.read(OUT)
dur = len(d) / float(sr)
peak = torch.cuda.max_memory_allocated() / 1024 ** 3 if torch.cuda.is_available() else 0
print('★ 合成 %.2fs / 音频 %.2fs → RTF %.2f   显存峰值 %.2f GB' % (dt, dur, dt / dur, peak), flush=True)
print('★ 输出: %s' % OUT, flush=True)

sys.stdout.flush()
os._exit(0)          # ✗ ROCm 正常退出会挂住 → 显式退出 ✓
