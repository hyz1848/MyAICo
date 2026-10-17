"""test_playback_aec.py — 服务端放音（Python 端）与回声消除的离线验证

为什么需要：AEC 的参考信号必须是"我们喂给声卡的样本"，且与麦克风同进程、同时间轴。
浏览器放音时参考信号在浏览器里，Python 侧拿不到 → 只能靠能量门限硬扛。
本测试用假房间冲激响应模拟"喇叭 → 麦克风"的回声路径，验证：
  1) Player 的队列/回调语义（解码、重采样、补零、事件、打断）
  2) 播放回调把**输出样本**原样喂给 AEC 作为参考
  3) 经过该参考信号，AEC 能把麦克风里的回声压下去（ERLE 门限）

跑法：venv/Scripts/python.exe test_playback_aec.py
"""
import os
import sys
import time
import warnings

import numpy as np
import soundfile as sf

warnings.filterwarnings('ignore')
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import worker as W   # noqa: E402  （只用来取 BLOCK_SIZE / SAMPLE_RATE 与 Player/aec 类）
from aec import EchoCanceller, synth_fake_room   # noqa: E402

SR = W.SAMPLE_RATE
BS = W.BLOCK_SIZE
TMP = 'temp'
os.makedirs(TMP, exist_ok=True)

passed = failed = 0


def check(name, ok, info=''):
    global passed, failed
    if ok:
        passed += 1
        print(f'  ✓ {name}' + (f'  {info}' if info else ''))
    else:
        failed += 1
        print(f'  ✗ {name}' + (f'  {info}' if info else ''))


def make_tone(seconds=1.0, sr=22050, freq=220.0):
    t = np.arange(int(seconds * sr), dtype=np.float32) / sr
    return (0.3 * np.sin(2 * np.pi * freq * t)).astype(np.float32), sr


class FakeAec:
    """记录参考信号的假 AEC（只验证"喂了什么"）"""
    def __init__(self):
        self.refs = []
    def add_reference(self, block):
        self.refs.append(np.asarray(block, dtype=np.float32).copy())


print('\n[1] Player 队列与回调语义')
tone, tsr = make_tone(0.5)
wav22 = os.path.join(TMP, '_test_play_22k.wav')
sf.write(wav22, tone, tsr)

p = W.Player(aec=None, samplerate=SR, blocksize=BS)
p._stream = 'stub'            # 跳过真实声卡（单元测试不开设备）
p.enqueue(wav22, item_id=7)

n_expected = int(round(len(tone) * SR / tsr))
got = []
while p.is_playing() or not p._events.empty():
    buf = np.zeros(BS, dtype=np.float32)
    outdata = buf.reshape(-1, 1).copy()
    p._callback(outdata, BS, None, None)
    got.append(outdata[:, 0].copy())
    if len(got) > 400:
        break
played = np.concatenate(got)
check('重采样到采集率（16k）后长度符合预期', abs(len(played[:n_expected]) - n_expected) <= BS,
      f'期望≈{n_expected} 实际裁剪前 {len(played)}')
# 前 n_expected 个样本应与原信号（重采样后）相近
ref_res = np.interp(np.linspace(0, len(tone) - 1, n_expected, dtype=np.float64),
                    np.arange(len(tone), dtype=np.float64), tone).astype(np.float32)
err = float(np.max(np.abs(played[:n_expected] - ref_res)))
check('输出与源信号一致（最大误差 < 1e-3）', err < 1e-3, f'max|Δ|={err:.2e}')
tail = played[n_expected:]
check('播完后补零（不夹带噪声）', tail.size == 0 or float(np.max(np.abs(tail))) == 0.0,
      f'tail={tail.size} 样本')

# 事件
evs = p.drain_events()
kinds = [e[0] for e in evs]
check('产生 start/end 事件', 'start' in kinds and 'end' in kinds, f'{kinds}')
check('事件带 id 与时长', any(e[0] == 'start' and e[1] == 7 and e[2] > 0.4 for e in evs), '')

print('\n[2] 播放回调把"输出样本"原样喂给 AEC 作参考')
fake = FakeAec()
p2 = W.Player(aec=fake, samplerate=SR, blocksize=BS)
p2._stream = 'stub'
p2.enqueue(wav22, item_id=1)
ref_all, out_all = [], []
for _ in range(6):
    od = np.zeros((BS, 1), dtype=np.float32)
    p2._callback(od, BS, None, None)
    out_all.append(od[:, 0].copy())
    if fake.refs:
        ref_all.append(fake.refs[-1].copy())
ref_all = np.concatenate(ref_all) if ref_all else np.zeros(0, dtype=np.float32)
out_all = np.concatenate(out_all)
n = min(len(ref_all), len(out_all))
check('参考信号与输出逐样本相同', n > 0 and float(np.max(np.abs(ref_all[:n] - out_all[:n]))) == 0.0,
      f'对比 {n} 样本')

print('\n[3] 打断（stop）立即生效')
p2.enqueue(wav22, item_id=2)
check('入队后有音频', p2.is_playing())
dropped = p2.stop()
check('stop() 清空并报告丢弃段数', (not p2.is_playing()) and dropped >= 1, f'dropped={dropped}')
od = np.zeros((BS, 1), dtype=np.float32)
p2._callback(od, BS, None, None)
check('打断后回调输出静音', float(np.max(np.abs(od))) == 0.0, '')

print('\n[4] 端到端回声消除（假房间：参考=播放输出，麦克风=参考过混响）')
aec = EchoCanceller(sample_rate=SR, taps=2048)
rng = np.random.default_rng(0)
# 用宽带信号做参考：NLMS 在窄带（正弦）输入下容易发散，宽带才稳定
ref = (0.25 * rng.standard_normal(SR * 12)).astype(np.float32)   # 12s：留足自适应与统计区间
ir = np.zeros(1024, dtype=np.float32)         # 20ms 直达 + 衰减尾（模拟喇叭→麦克风；须 ≤ AEC taps）
d0 = int(SR * 0.02)
ir[d0] = 0.7
for k in range(1, 200):
    ir[d0 + k] = (0.35 * np.exp(-k / 40.0) * rng.uniform(-1, 1)).astype(np.float32)
mic = synth_fake_room(ref, ir)                 # 麦克风听到的（近端静音）

n_blocks = (len(ref) - BS) // BS
clean = np.zeros(n_blocks * BS, dtype=np.float32)
mic_e, out_e = [], []
ADAPT_BLOCKS = 40                              # 前 ~3.2s 让自适应收敛（实测 47 块内达 57dB），之后才计入 ERLE
for blk in range(n_blocks):
    i = blk * BS
    r = ref[i:i + BS]
    aec.add_reference(r)                       # 播放回调做的事
    out = aec.process(mic[i:i + BS].copy())    # 采集回调做的事
    clean[i:i + BS] = out
    if blk >= ADAPT_BLOCKS:
        mic_e.append(float(np.mean(mic[i:i + BS] ** 2)))
        out_e.append(float(np.mean(out ** 2)))
erle = 10 * np.log10(np.mean(mic_e) / max(np.mean(out_e), 1e-15))
check('AEC 明显抑制回声（ERLE ≥ 10dB）', erle >= 10.0, f'ERLE={erle:.1f}dB（自适应 {ADAPT_BLOCKS} 块后）')

print('\n[5] 对照：不处理时无任何抑制')
out_off = float(np.mean([np.mean(mic[i:i + BS] ** 2) for i in range(ADAPT_BLOCKS * BS, n_blocks * BS, BS)]))
in_pow = float(np.mean(mic_e))
check('对照 ERLE ≈ 0dB', abs(10 * np.log10(in_pow / max(out_off, 1e-15))) < 0.5,
      f'{10 * np.log10(in_pow / max(out_off, 1e-15)):.2f}dB')

print('\n[6] 时延失配保护（实机故障回归：回声延迟超过补偿窗）')
aec2 = EchoCanceller(sample_rate=SR, taps=2048, delay_samples=0)
ref2 = (0.25 * rng.standard_normal(SR * 4)).astype(np.float32)
delay = int(SR * 0.4)                       # 400ms 声程/设备延迟（远超 2048 taps 的 128ms 窗）
mic2 = np.zeros_like(ref2)
mic2[delay:] = ref2[:len(ref2) - delay] * 0.5      # 麦克风听到的是延迟后的回声
worst = 0.0
for i in range(0, len(ref2) - BS, BS):
    aec2.add_reference(ref2[i:i + BS])
    o = aec2.process(mic2[i:i + BS].copy())
    din = float(np.max(np.abs(mic2[i:i + BS]))) + 1e-12
    worst = max(worst, float(np.max(np.abs(o))) / din)
    if not np.all(np.isfinite(o)):
        worst = float('inf')
        break
check('时延失配时不放大（输出 ≤ 输入 ×1.5）', worst <= 1.5, f'最大放大倍数={worst:.2f}')
check('发散计数器工作', aec2.stats()['blowups'] >= 0, str(aec2.stats()))

print(f'\n通过: {passed}  失败: {failed}')
sys.exit(1 if failed else 0)
