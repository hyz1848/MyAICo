"""calibrate_aec.py — 实测"播放 → 扬声器 → 空气 → 麦克风"的往返延迟

为什么必须实测：AEC 的参考信号是"我们喂给声卡的样本"，而麦克风听到的回声有
声程 + 设备缓冲延迟（典型 100~300ms）。若这个延迟超过 aec.taps 能覆盖的范围
（taps=2048 @16k ≈ 128ms），滤波器根本对不齐 → 消不掉，还可能发散。
把实测延迟写进 conf.json 的 aec.delaySamples，AEC 就能对齐并真正抵消。

做法：用**真实的 Player 管线**播一段白噪声，同时用 InputStream 录回来，
互相关找峰值 → 延迟样本数。

跑法：venv/Scripts/python.exe calibrate_aec.py [--write]
      --write 会直接把结果写进 conf.json（aec.delaySamples / aec.taps）
"""
import json
import os
import sys
import time
import warnings

import numpy as np
import soundfile as sf

warnings.filterwarnings('ignore')
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import worker as W   # noqa: E402

SR = W.SAMPLE_RATE
BS = W.BLOCK_SIZE
TMP = 'temp'
CONF = 'conf.json'

rng = np.random.default_rng(7)
# 白噪声突发（带 50ms 静音前导，便于看清起跳），总长约 1.2s
lead = np.zeros(int(SR * 0.05), dtype=np.float32)
burst = (0.35 * rng.standard_normal(int(SR * 1.2))).astype(np.float32)
play = np.concatenate([lead, burst])
cal_path = os.path.join(TMP, '_aec_cal.wav')
os.makedirs(TMP, exist_ok=True)
sf.write(cal_path, play, SR)


def record_while_playing(seconds=5.0):
    """先用 Player 播标定信号，同时录音（不开 AEC，要的是原始回声）"""
    import sounddevice as sd
    rec = np.zeros(int(SR * seconds), dtype=np.float32)
    player = W.Player(aec=None, samplerate=SR, blocksize=BS)
    idx = {'n': 0}

    def cb(indata, frames, time_info, status):
        n = idx['n']
        if n + frames <= rec.size:
            rec[n:n + frames] = indata[:, 0] if indata.ndim > 1 else indata
        idx['n'] = n + frames

    stream = sd.InputStream(samplerate=SR, channels=1, dtype='float32', blocksize=BS, callback=cb)
    stream.start()
    time.sleep(0.35)                    # 先录一点本底噪声
    player.enqueue(cal_path, item_id='cal')
    time.sleep(1.4)
    player.stop()
    time.sleep(0.8)
    stream.stop()
    stream.close()
    return rec


def sweep_delay(play16k, rec, lead_samples, lo=0, hi=14000, step=80, adapt_frac=0.45, taps=2048):
    """按 ERLE 扫延迟。

    关键：回声只在"播放期间"存在于录音里，所以**每个候选延迟有自己的回声窗口**
    （起始 = 前导 + 该延迟），只在窗口后半段（滤波器已收敛）统计 ERLE。
    """
    from aec import EchoCanceller
    n = len(rec)
    ref_full = np.zeros(n, dtype=np.float32)
    ref_full[lead_samples:lead_samples + len(play16k)] = play16k
    n_blocks = (n - BS) // BS
    results = []
    for delay in range(lo, hi + 1, step):
        # 该延迟下，回声在录音里的位置
        w0 = lead_samples + delay
        w1 = w0 + len(play16k)
        if w0 + BS * 4 >= n:
            continue
        m0 = w0 + int((w1 - w0) * adapt_frac)          # 窗口后半段才开始统计
        m1 = min(w1, n)
        aec = EchoCanceller(sample_rate=SR, taps=taps, delay_samples=delay)
        mic_e, out_e = [], []
        for b in range(n_blocks):
            i = b * BS
            aec.add_reference(ref_full[i:i + BS])
            o = aec.process(rec[i:i + BS].copy())
            if m0 <= i < m1:
                mic_e.append(float(np.mean(rec[i:i + BS] ** 2)))
                out_e.append(float(np.mean(o ** 2)))
        if len(mic_e) < 3:
            continue
        erle = 10 * np.log10(max(np.mean(mic_e), 1e-15) / max(np.mean(out_e), 1e-15))
        results.append((delay, erle, aec.stats()['blowups'], len(mic_e)))
    return results


def main():
    print(f'录音 {SR}Hz / 块 {BS}（真实 Player 管线），请保持安静 ~4s…')
    rec = record_while_playing()
    bg = float(np.sqrt(np.mean(rec[:int(SR * 0.3)] ** 2)))
    peak = float(np.max(np.abs(rec)))
    print(f'麦克风本底 rms={bg:.4f}  录音峰值={peak:.4f}')
    if peak < 0.01:
        print('✗ 几乎没录到声音：确认扬声器在放音、麦克风可用')
        return 2

    # 提示用的互相关估计（仅供对照，真正的判定用 ERLE 扫描）
    a = rec - np.mean(rec); b = play - np.mean(play)
    lag = int(np.argmax(np.abs(np.correlate(a, b, mode='valid'))))
    print(f'互相关粗估 ≈ {lag - int(SR * 0.35)} 样本（仅供参考）')

    play16k = play if len(play) else None
    play16k = np.interp(np.linspace(0, len(play) - 1, int(len(play) * SR / SR), dtype=np.float64),
                        np.arange(len(play), dtype=np.float64), play).astype(np.float32)
    lead_samples = int(SR * 0.35)
    print('\nERLE 扫描（同时对比 taps=2048 / 4096，taps 越大越能容忍延迟漂移）:')
    tables = {}
    for taps in (2048, 4096):
        res = sweep_delay(play16k, rec, lead_samples, taps=taps)
        res.sort(key=lambda r: -r[1])
        tables[taps] = res
        print(f'  --- taps={taps} ---')
        for d, e, blow, nb in res[:3]:
            print(f'    delay={d:6d}（{d / SR * 1000:5.0f} ms）  ERLE={e:6.1f} dB  发散={blow} 块={nb}')
    # 选全局最佳
    best_taps, best = max(tables.items(), key=lambda kv: kv[1][0][1])
    best_delay, best_erle = best[0][0], best[0][1]
    print(f'\n最佳: taps={best_taps}  delay={best_delay} 样本（{best_delay / SR * 1000:.0f} ms）  ERLE={best_erle:.1f} dB')
    if best_erle < 6:
        print('⚠️ 最佳 ERLE 偏低：扬声器音量小/麦克风远，或回声太弱测不准')

    if '--write' in sys.argv:
        with open(CONF, encoding='utf-8') as f:
            c = json.load(f)
        c.setdefault('aec', {})
        c['aec']['delaySamples'] = int(best_delay)
        c['aec']['taps'] = int(best_taps)
        with open(CONF, 'w', encoding='utf-8') as f:
            json.dump(c, f, ensure_ascii=False, indent=2)
        print(f'✓ 已写入 {CONF}: delaySamples={best_delay} taps={best_taps}（重启服务生效）')
    else:
        print(f'提示：加 --write 直接写入；或手工设置 aec.delaySamples={best_delay}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
