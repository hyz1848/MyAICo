"""test_tts_all.py — 三个 TTS 后端横向对比（延迟 / RTF / ASR 回读可懂度 / 试听文件）

  piper  : Piper(VITS) int8 + **DirectML(AMD GPU)**     —— 中文，最快
  kokoro : Kokoro 多语言 v1.1（中英同模型）+ **CPU**     —— DML 会崩（动态 shape），只能 CPU
  edge   : edge-tts（网络）

跑法：venv/Scripts/python.exe test_tts_all.py [--voices]
      --voices 额外生成 Kokoro 若干音色的试听片段
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

OUT = 'temp'
PHRASES = [
    ('中文', '你好，我是潞潞同学。今天成都小雨，气温十六到二十四度。'),
    ('中英混', 'Node.js 24.1 是最新的长期支持版本，建议生产环境使用。'),
    ('英文', 'Hello, the weather is nice today.'),
]


def norm(s):
    return re.sub(r'[^\w\u4e00-\u9fff]', '', str(s or '')).lower()


def similarity(a, b):
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


def main():
    from funasr import AutoModel
    print('加载 ASR（回读校验）…')
    asr = AutoModel(model='paraformer-zh', vad_model='fsmn-vad', disable_update=True, disable_pbar=True)

    def readback(path):
        y, sr = sf.read(path, dtype='float32')
        if y.ndim > 1:
            y = y.mean(axis=1)
        r = asr.generate(input=y, fs=sr, batch_size_s=60)
        return (r[0].get('text') if r else '') or ''

    engines = {}
    try:
        from tts_piper import PiperTts, PiperUnavailable
        e = PiperTts()
        if e.available():
            e.voice()
            engines['piper'] = (lambda t, p: e.synthesize(t, p), f'{e.provider_used}')
    except Exception as ex:
        print('piper 不可用:', ex)
    try:
        from tts_kokoro import KokoroTts
        k = KokoroTts(provider='cpu')
        if k.available():
            k.session()
            engines['kokoro'] = (lambda t, p: k.synthesize(t, p), f'{k.provider_used} voice={k.voice}')
    except Exception as ex:
        print('kokoro 不可用:', ex)
    engines['edge'] = (None, 'network')

    def edge_synth(text, path):
        import edge_tts

        async def run():
            await edge_tts.Communicate(text, 'zh-CN-XiaoxiaoNeural').save(path)
        t0 = time.time()
        asyncio.run(run())
        return path, time.time() - t0

    rows = []
    for label, text in PHRASES:
        print(f'\n=== {label}: {text[:30]}…')
        for name, (fn, info) in engines.items():
            path = os.path.join(OUT, f'tts_{name}_{label}.' + ('mp3' if name == 'edge' else 'wav'))
            try:
                if name == 'edge':
                    _, dt = edge_synth(text, path)
                    dur = float(sf.info(path).duration)
                else:
                    t0 = time.time()
                    _, dur = fn(text, path)
                    dt = time.time() - t0
                sim = similarity(text, readback(path))
                rtf = dt / max(dur, 1e-6)
                rows.append((label, name, dt, dur, rtf, sim, info))
                print(f'  {name:7} {dt * 1000:6.0f}ms 音频 {dur:5.2f}s RTF {rtf:6.3f} '
                      f'回读 {sim:.2f}  [{info}]')
            except Exception as ex:
                print(f'  {name:7} 失败: {type(ex).__name__}: {str(ex)[:70]}')

    print('\n=== 汇总 ===')
    print(f'{"场景":<8}{"后端":<8}{"耗时ms":>8}{"音频s":>8}{"RTF":>8}{"回读":>7}')
    for (label, name, dt, dur, rtf, sim, _) in rows:
        print(f'{label:<8}{name:<8}{dt * 1000:>8.0f}{dur:>8.2f}{rtf:>8.3f}{sim:>7.2f}')

    print(f'\n试听文件: {OUT}/tts_{{piper,kokoro,edge}}_*.wav|mp3')

    if '--voices' in sys.argv:
        print('\n[Kokoro 音色试听]')
        from tts_kokoro import KokoroTts
        k = KokoroTts(provider='cpu')
        phrase = '你好，我是潞潞同学，很高兴见到你。'
        for v in [0, 1, 5, 20, 60, 102]:
            p = os.path.join(OUT, f'kokoro_voice{v:03d}.wav')
            try:
                t0 = time.time()
                _, dur = k.synthesize(phrase, p, voice=v)
                print(f'  voice={v:3}: {time.time() - t0:.1f}s → {p}')
            except Exception as ex:
                print(f'  voice={v:3}: 失败 {ex}')

    ok = True
    for (label, name, dt, dur, rtf, sim, _) in rows:
        if name == 'edge':
            continue
        if sim < 0.45:
            print(f'✗ {name}/{label} 回读相似度过低 {sim:.2f}')
            ok = False
    piper = [r for r in rows if r[1] == 'piper']
    if piper and max(r[4] for r in piper) > 0.3:
        print('✗ piper RTF 异常（应 <0.3）')
        ok = False
    print('通过 ✓' if ok else '未通过 ✗')
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
