"""setup_gpu_venv.py — 从已有的 ROCm venv 复制一套独立 GPU 环境到项目自己的目录

为什么：Kokoro 需要 ROCm 版 PyTorch（GPU 上 RTF 可到 0.02 级），而项目主 venv 里是 CPU 版 torch。
用户要求依赖放在项目自己目录（不共用 I:\\DocOCR_engine\\venv）。直接从本机已有 venv 复制，
比重新下载几个 GB 快得多，也避免 HF 不通的问题。

用法：
    python setup_gpu_venv.py                 # 默认源 I:\\DocOCR_engine\\venv，目标 venv-gpu
    python setup_gpu_venv.py <源venv> <目标venv>

它会：
  1) 用与源相同的**基础解释器**建 venv（保证 ABI 兼容；Windows venv 只是薄壳）
  2) 复制必需的包 + 同名 .dist-info（**dist-info 必须一起拷**，否则 importlib.metadata 找不到发行包）
  3) 跑目标解释器探测，遇到 ModuleNotFoundError / 元数据缺失 / 版本不符 就从源 venv 补齐并重试

实测踩到的坑（脚本已处理）：
  · ROCm 运行时在下划线包里：`_rocm_sdk_core`、`_rocm_sdk_libraries_custom`（共约 3.4GB），
    不在 `rocm_sdk*` 里；少了它会报 "rocm_sdk ... UnboundLocalError"
  · `transformers` 要求 `tokenizers<=0.23.0`，而 PyPI 上只有更新的版本 →
    必须用源 venv 里的那份，并**先删掉 pip 装的那份**（两份 dist-info 并存会读到错的）
"""
import os
import re
import shutil
import subprocess
import sys

DEFAULT_SRC = r'I:\DocOCR_engine\venv'
DEFAULT_DST = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'venv-gpu')

# 必需包（+ 它们的 dist-info 会被自动带上）
PACKAGES = [
    'torch', 'torchaudio', 'torchgen', 'typing_extensions',
    'rocm_sdk', 'rocm_sdk_core', 'rocm_sdk_devel', 'rocm_sdk_libraries_custom',
    '_rocm_sdk_core', '_rocm_sdk_libraries_custom',
    'numpy', 'numpy.libs', 'soundfile', '_soundfile.py', '_soundfile_data',
    'cffi', 'pycparser',
    'transformers', 'tokenizers', 'huggingface_hub', 'httpx2', 'httpcore2',
    'truststore', 'hf_xet', 'filelock', 'attrs', 'colorama', 'loguru',
    'win32_setctime', 'kokoro', 'fsspec', 'jinja2', 'markupsafe', 'mpmath',
    'networkx', 'sympy', 'packaging', 'pyyaml', 'tqdm', 'regex', 'requests',
    'safetensors', 'anyio', 'sniffio', 'certifi', 'idna', 'h11', 'setuptools',
]

# 探测脚本：必须先给 misaki 打桩（kokoro 包的 __init__ 会连带导入 KPipeline，
# 而 KPipeline 依赖 misaki/spacy 一整条链；我们只用 KModel，用桩绕开）
PROBE_SRC = """
import sys, types
def _mk(n):
    class C:
        def __init__(self,*a,**k): pass
        def __call__(self,*a,**k): return self
        def __getattr__(self,x): return _mk(x)
        def __iter__(self): return iter(())
    C.__name__=n; return C
class M(types.ModuleType):
    def __getattr__(self,n):
        if n.startswith('__'): raise AttributeError(n)
        t=_mk(n); setattr(self,n,t); return t
for n in ('misaki','misaki.en','misaki.espeak'):
    m=M(n); m.__file__='<stub:'+n+'>'; m.__path__=[]; sys.modules[n]=m
sys.modules['misaki'].en=sys.modules['misaki.en']
sys.modules['misaki'].espeak=sys.modules['misaki.espeak']
import torch, soundfile, numpy
from kokoro.model import KModel
print('READY', torch.__version__, torch.cuda.is_available())
"""


def site_packages(venv):
    return os.path.join(venv, 'Lib', 'site-packages')


def base_python(src_venv):
    """取源 venv 的 pyvenv.cfg 里的 home（基础解释器目录）"""
    cfg = os.path.join(src_venv, 'pyvenv.cfg')
    home = None
    if os.path.exists(cfg):
        for line in open(cfg, encoding='utf-8'):
            if line.lower().startswith('home'):
                home = line.split('=', 1)[1].strip()
    if home:
        p = os.path.join(home, 'python.exe')
        if os.path.exists(p):
            return p
    return None


def copy_pkg(src, dst, name):
    s = os.path.join(src, name)
    if not os.path.exists(s):
        return False
    d = os.path.join(dst, name)
    if os.path.isdir(s):
        shutil.copytree(s, d, dirs_exist_ok=True)
    else:
        shutil.copy2(s, d)
    return True


def copy_with_distinfo(src, dst, name):
    """拷包本体 + 同名 dist-info（后者决定 importlib.metadata 看到的版本）"""
    n = 0
    if copy_pkg(src, dst, name):
        n += 1
    key = name.lower().replace('-', '_').rstrip('.py')
    for d in os.listdir(src):
        dl = d.lower().replace('-', '_')
        if dl.startswith(key) and dl.endswith(('.dist-info', '.dist_info')):
            if copy_pkg(src, dst, d):
                n += 1
    return n


def purge(dst, name):
    key = name.lower().replace('-', '_')
    for d in list(os.listdir(dst)):
        dl = d.lower().replace('-', '_')
        if dl == key or dl == key + '.py' or (dl.startswith(key + '-') and dl.endswith(('.dist-info', '.dist_info'))):
            q = os.path.join(dst, d)
            if os.path.isdir(q):
                shutil.rmtree(q, ignore_errors=True)
            else:
                try:
                    os.remove(q)
                except OSError:
                    pass


def main():
    src_venv = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_SRC
    dst_venv = sys.argv[2] if len(sys.argv) > 2 else DEFAULT_DST
    src = site_packages(src_venv)
    dst = site_packages(dst_venv)
    if not os.path.isdir(src):
        print('源 venv 不存在:', src)
        return 2

    # 1) 建 venv（用源的基础解释器，保证兼容）
    if not os.path.exists(os.path.join(dst_venv, 'Scripts', 'python.exe')):
        bp = base_python(src_venv)
        if not bp:
            print('找不到源 venv 的基础解释器，无法创建目标 venv')
            return 2
        print('创建 venv:', dst_venv, '← 基础解释器', bp)
        subprocess.run([bp, '-m', 'venv', dst_venv], check=True)
    os.makedirs(dst, exist_ok=True)
    py = os.path.join(dst_venv, 'Scripts', 'python.exe')
    probe_file = os.path.join(dst_venv, '_probe_gpu.py')
    with open(probe_file, 'w', encoding='utf-8') as f:
        f.write(PROBE_SRC)

    # 2) 复制必需包
    print('复制包…')
    for name in PACKAGES:
        copy_with_distinfo(src, dst, name)

    # 3) 探测并自动补齐
    for i in range(40):
        r = subprocess.run([py, probe_file], capture_output=True, text=True,
                           encoding='utf-8', errors='replace')
        if r.returncode == 0 and 'READY' in (r.stdout or ''):
            print(f'✓ 环境就绪（{r.stdout.strip()}）')
            return 0
        err = (r.stderr or '') + (r.stdout or '')
        m = re.search(r"No module named '([\w\.]+)'", err)
        if m:
            mod = m.group(1).split('.')[0]
            if copy_with_distinfo(src, dst, mod):
                print('  补包:', mod)
                continue
            print('源里找不到模块:', mod)
            return 3
        m2 = re.search(r"metadata was found for The '([^']+)' distribution", err)
        if m2:
            name = m2.group(1)
            copy_with_distinfo(src, dst, name)
            print('  补元数据:', name)
            continue
        m3 = re.search(r'found ([A-Za-z0-9_.\-]+)==', err)
        if m3:
            name = m3.group(1)
            purge(dst, name)                 # 先删掉版本不对的那份
            copy_with_distinfo(src, dst, name)
            print('  按源版本替换:', name)
            continue
        print('无法自动解决，最后错误:\n', err[-600:])
        return 4
    print('超过迭代上限')
    return 5


if __name__ == '__main__':
    sys.exit(main())
