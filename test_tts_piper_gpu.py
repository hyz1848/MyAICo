"""test_tts_piper_gpu.py — Piper + DirectML(AMD GPU) 本地 TTS 验收

三条路径对比（同一批句子）：
  · piper-gpu：本模块自研离线音素化 + onnxruntime DirectML 会话（目标方案）
  · sherpa   ：sherpa-onnx 的 VITS 实现（音素化参考实现，CPU）
  · edge     ：edge-tts（网络，当前默认）
指标：首字延迟 / 稳态耗时 / RTF / **ASR 回读相似度**（客观可懂度）/ 试听文件。

跑法：venv/Scripts/python.exe test_tts_piper_gpu.py
"""
import asyncio
import os
import re
import sys
import time
import warnings

import numpy as np
import soundfile as sf

warnings.filterwarnings('ignore')
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

PIPER_DIR = os.path.join('models', 'vits-piper-zh_CN-xiao_ya-medium-int8')
OUT = 'temp'
PHRASES = [
    ('中文', '你好，我是潞潞同学。今天成都小雨，气温十六到二十四度。'),
    ('多音字', '长期住在银行旁边，看着小树慢慢生长。'),
    ('中英混', 'Node.js 24.1 是最新的长期支持版本，我建议生产环境使用它。'),
    ('数字', '一共 1500 元，下午 3 点 24 分出发，路程大约 12.5 公里。'),
]


def norm(s):
    return re.sub(r'[^\w\u4e00-\u9fff]', '', str(s or '')).lower()


def similarity(a, b):
    """简单相似度：以较长串为分母的最长公共子序列比（够用于回归判断）"""
    a, b = norm(a), norm(b)
    if not a or not b:
        return 0.0
    prev = [0] * (len(b) + 1)
    for ca in a:
        cur = [0]
        for j, cb in enumerate(b, 1):
            cur.append(prev[j - 1] + 1 if ca == cb else max(prev[j], cur[-1]))
        prev = cur
    return prev[-1] / max(len(a), len(b))


def synth_edge(text, path):
    import edge_tts

    async def run():
        await edge_tts.Communicate(text, 'zh-CN-XiaoxiaoNeural').save(path)
    t0 = time.time()
    asyncio.run(run())
    return time.time() - t0


def main():
    from tts_piper import PiperTts, PiperUnavailable
    try:
        piper = PiperTts()
        if not piper.available():
            print('Piper 模型缺失，跳过')
            return 1
        # 触发加载，确认 provider
        piper.voice()
        print(f'piper provider = {piper.provider_used} | 模型 {piper.model_dir}')
    except (PiperUnavailable, Exception) as e:
        print('Piper 不可用:', type(e).__name__, e)
        return 1

    print('加载 ASR（回读校验用）…')
    from funasr import AutoModel
    asr = AutoModel(model='paraformer-zh', vad_model='fsmn-vad',
                    disable_update=True, disable_pbar=True)

    def readback(path):
        y, sr = sf.read(path, dtype='float32')
        if y.ndim > 1:
            y = y.mean(axis=1)
        r = asr.generate(input=y, fs=sr, batch_size_s=60)
        return (r[0].get('text') if r else '') or ''

    rows = []
    for label, text in PHRASES:
        path = os.path.join(OUT, f'piper_gpu_{label}.wav')
        t0 = time.time()
        _, dur = piper.synthesize(text, path)
        dt = time.time() - t0
        t0 = time.time()
        piper.synthesize(text, path)
        dt2 = time.time() - t0
        back = readback(path)
        sim = similarity(text, back)
        e_path = os.path.join(OUT, f'piper_edge_{label}.mp3')
        dt_e = synth_edge(text, e_path)
        sim_e = similarity(text, readback(e_path))
        rows.append((label, dt2, dur, dt2 / max(dur, 1e-6), sim, dt_e, sim_e))
        print(f'\n=== {label}: {text[:30]}…')
        print(f'  piper-gpu: {dt * 1000:.0f}ms(首) / {dt2 * 1000:.0f}ms(稳态) 音频 {dur:.2f}s '
              f'RTF {dt2 / max(dur, 1e-6):.3f} 回读相似 {sim:.2f}')
        print(f'    回读: {back[:46]!r}')
        print(f'  edge     : {dt_e * 1000:.0f}ms 回读相似 {sim_e:.2f}')

    print('\n=== 汇总 ===')
    print(f'{"场景":<8}{"稳态ms":>9}{"音频s":>8}{"RTF":>8}{"回读":>7}{"edge ms":>9}{"edge回读":>9}')
    for (label, dt, dur, rtf, sim, dte, sime) in rows:
        print(f'{label:<8}{dt * 1000:>9.0f}{dur:>8.2f}{rtf:>8.3f}{sim:>7.2f}{dte * 1000:>9.0f}{sime:>9.2f}')
    print(f'\n试听: {OUT}/piper_gpu_*.wav（GPU 本地） vs {OUT}/piper_edge_*.mp3（edge）')

    ok = True
    avg_rtf = sum(r[3] for r in rows) / len(rows)
    avg_sim = sum(r[4] for r in rows) / len(rows)
    print(f'\n[验收] 平均 RTF={avg_rtf:.3f}（目标 <0.2）  平均回读相似={avg_sim:.2f}（目标 ≥0.60）')
    if avg_rtf >= 0.2:
        ok = False
        print('  ✗ RTF 未达标')
    if avg_sim < 0.60:
        ok = False
        print('  ✗ 回读相似度未达标')
    print('通过 ✓' if ok else '未通过 ✗')
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
