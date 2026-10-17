"""test_tts_backends.py — 本地 TTS(sherpa/Kokoro) vs 网络 TTS(edge-tts) 对比

三个维度：
  1) 延迟：首字（含加载）与稳态耗时、RTF
  2) 可懂度：把合成音频喂回 FunASR，与原文比对（客观代理指标）
  3) 试听：把两边生成的音频写到 temp/tts_compare_*.wav，可在浏览器打开对比

跑法: venv/Scripts/python.exe test_tts_backends.py
"""
import asyncio
import os
import sys
import time
import warnings

import numpy as np
import soundfile as sf

warnings.filterwarnings('ignore')

PHRASES = [
    ('中文', '你好，我是潞潞同学，今天成都小雨，气温十六到二十四度。'),
    ('中英混', 'Node.js 最新版本是 24.1，我建议生产环境用 LTS 版本。'),
    ('英文', 'Hello, how are you doing today?'),
]
OUT = 'temp'


def norm(s):
    import re
    return re.sub(r'[^\w\u4e00-\u9fff]', '', str(s or '')).lower()


def similarity(a, b):
    a, b = norm(a), norm(b)
    if not a or not b:
        return 0.0
    # 用最长公共子序列占比做近似
    prev = [0] * (len(b) + 1)
    for i in range(1, len(a) + 1):
        cur = [0] * (len(b) + 1)
        for j in range(1, len(b) + 1):
            cur[j] = prev[j - 1] + 1 if a[i - 1] == b[j - 1] else max(prev[j], cur[j - 1])
        prev = cur
    return prev[len(b)] / max(len(a), len(b))


def synth_edge(text, path):
    import edge_tts
    async def run():
        await edge_tts.Communicate(text, 'zh-CN-XiaoxiaoNeural').save(path)
    t0 = time.time()
    asyncio.run(run())
    return time.time() - t0


def main():
    from tts_local import SherpaTts
    local = SherpaTts()
    print(f'本地模型: {local.model_dir}  可用={local.available()}')
    if not local.available():
        print('模型不完整，跳过本地对比')
        return 1

    # ASR 用于回读校验
    print('加载 ASR（用于回读校验）…')
    from funasr import AutoModel
    asr = AutoModel(model='paraformer-zh', vad_model='fsmn-vad', disable_update=True)

    def readback(path):
        y, sr = sf.read(path, dtype='float32')
        if y.ndim > 1:
            y = y.mean(axis=1)
        r = asr.generate(input=y, fs=sr, batch_size_s=60)
        return (r[0].get('text') if r else '') or ''

    rows = []
    for label, text in PHRASES:
        print(f'\n=== {label}: {text[:36]}…')
        # 本地（第一次含加载）
        p_local = os.path.join(OUT, f'tts_compare_local_{label}.wav')
        t0 = time.time()
        try:
            local.synthesize(text, p_local)
            dt_local_first = time.time() - t0
            t0 = time.time()
            local.synthesize(text, p_local)
            dt_local = time.time() - t0
        except Exception as e:
            print('  本地失败:', e)
            dt_local_first = dt_local = float('nan')
        # 网络
        p_edge = os.path.join(OUT, f'tts_compare_edge_{label}.mp3')
        dt_edge = synth_edge(text, p_edge)

        def info(p):
            if not os.path.exists(p):
                return 0, 0
            y, sr = sf.read(p, dtype='float32')
            dur = len(y) / sr
            return dur, (sr, len(y))

        dur_l, _ = info(p_local)
        dur_e, _ = info(p_edge)
        back_l = readback(p_local) if dur_l else ''
        back_e = readback(p_edge) if dur_e else ''
        rows.append((label, dt_local_first, dt_local, dur_l, similarity(text, back_l),
                     dt_edge, dur_e, similarity(text, back_e)))
        print(f'  本地: 首 {dt_local_first*1000:.0f}ms / 稳态 {dt_local*1000:.0f}ms, 音频 {dur_l:.2f}s, RTF {dt_local/max(dur_l,1e-6):.3f}, 回读相似度 {similarity(text, back_l):.2f}')
        print(f'       回读: {back_l[:40]!r}')
        print(f'  网络: {dt_edge*1000:.0f}ms, 音频 {dur_e:.2f}s, 回读相似度 {similarity(text, back_e):.2f}')
        print(f'       回读: {back_e[:40]!r}')

    print('\n=== 汇总（延迟 / RTF / 回读相似度）===')
    print(f'{"场景":<8}{"本地稳态":>10}{"本地RTF":>9}{"本地相似":>9}{"网络":>9}{"网络相似":>9}')
    for (label, f, l, dl, sl, e, de, se) in rows:
        print(f'{label:<8}{l*1000:>9.0f}ms{(l/dl if dl else 0):>9.3f}{sl:>9.2f}{e*1000:>8.0f}ms{se:>9.2f}')
    print(f'\n试听文件（本地 vs 网络）已写入 {OUT}/tts_compare_*.wav|mp3')
    return 0


if __name__ == '__main__':
    sys.exit(main())
