"""test_aec.py — AEC 离线验证（合成房间，无需真实麦克风）

跑法: venv/Scripts/python.exe test_aec.py
"""
import numpy as np
import sys
from aec import EchoCanceller

SR = 16000
L = 1280            # 80ms 一帧
BLOCKS = 240
PASS_ERLE = 15.0    # 要求至少 15dB 回声抑制


def make_room(rng, delay_ms=20, tail=0.5, level=1.0):
    """合成房间冲激响应：直达 + 指数衰减尾"""
    n = int(SR * tail)
    ir = np.zeros(n, dtype=np.float32)
    d = int(SR * delay_ms / 1000)
    ir[d] = level
    for k in range(1, 60):
        idx = d + k * 8
        if idx < n:
            ir[idx] += level * (0.75 ** k) * rng.standard_normal() * 0.7
    return ir


def run_case(name, ref_level=0.25, near_level=0.0, delay_samples=0, taps=2048, mu=0.4, adapt_from=60):
    rng = np.random.default_rng(42)
    ir = make_room(rng)
    ref = (rng.standard_normal(L * BLOCKS).astype(np.float32) * ref_level)
    echo = np.convolve(ref, ir)[:len(ref)].astype(np.float32)
    near = (rng.standard_normal(len(ref)).astype(np.float32) * near_level) if near_level > 0 else np.zeros(len(ref), np.float32)
    noise = rng.standard_normal(len(ref)).astype(np.float32) * 0.003
    mic = echo + near + noise

    aec = EchoCanceller(sample_rate=SR, taps=taps, mu=mu, delay_samples=delay_samples)
    mic_e, out_e = [], []
    for b in range(BLOCKS):
        s = b * L
        aec.add_reference(ref[s:s + L])
        out = aec.process(mic[s:s + L])
        if b >= adapt_from:
            mic_e.append(float(np.dot(mic[s:s + L], mic[s:s + L])))
            out_e.append(float(np.dot(out, out)))

    erle = 10 * np.log10(np.mean(mic_e) / np.mean(out_e))
    st = aec.stats()
    print(f"  {name}: ERLE={erle:6.1f} dB  自适应={st['adapted_blocks']} 冻结={st['frozen_blocks']} |w|²={st['w_energy']:.3f}")
    return erle, out_e, mic_e


print("[1] 回声消除基本能力（无近端说话）")
erle1, _, _ = run_case("布20ms延迟+衰减尾")

print("\n[2] 双讲：远端在放、近端同时在说")
# 近端信号与远端不相关；双讲时不该把近端也消掉
rng = np.random.default_rng(7)
ir = make_room(rng)
ref = rng.standard_normal(L * BLOCKS).astype(np.float32) * 0.25
echo = np.convolve(ref, ir)[:len(ref)].astype(np.float32)
near = rng.standard_normal(len(ref)).astype(np.float32) * 0.25
mic = echo + near
aec = EchoCanceller(sample_rate=SR, taps=2048, mu=0.4)
near_e, out_e = [], []
for b in range(BLOCKS):
    s = b * L
    aec.add_reference(ref[s:s + L])
    out = aec.process(mic[s:s + L])
    if b >= 80:
        near_e.append(float(np.dot(near[s:s + L], near[s:s + L])))
        out_e.append(float(np.dot(out, out)))
loss_db = 10 * np.log10(np.mean(near_e) / np.mean(out_e))
print(f"  近端能量变化: {loss_db:+.1f} dB（负=被削弱；双讲时应尽量接近 0 或仅部分削弱）")

print("\n[3] 无参考（纯近端/静音）不应失真")
silent = np.zeros(L, dtype=np.float32)
noise = (rng.standard_normal(L).astype(np.float32) * 0.02)
aec2 = EchoCanceller(sample_rate=SR, taps=512)
o1 = aec2.process(silent)
o2 = aec2.process(noise)
d1 = float(np.sqrt(np.mean((o1 - silent) ** 2)))
d2 = float(np.sqrt(np.mean((o2 - noise) ** 2)))
print(f"  静音输入残差 RMS={d1:.6f}（应≈0）; 噪声输入失真 RMS={d2:.6f}（应≈0）")

print("\n[4] 静音参考不应导致发散")
aec3 = EchoCanceller(sample_rate=SR, taps=512, mu=0.9)
for _ in range(50):
    aec3.add_reference(np.zeros(L, dtype=np.float32))
    aec3.process((rng.standard_normal(L).astype(np.float32) * 0.02))
st3 = aec3.stats()
print(f"  |w|²={st3['w_energy']:.6f}（应保持≈0，不发散）")
definite = np.isfinite(st3['w_energy']) and st3['w_energy'] < 1.0

ok = True
def check(name, cond):
    global ok
    print(f"  {'✓' if cond else '✗'} {name}")
    ok = ok and cond

print("\n判定:")
check(f"回声抑制 ERLE >= {PASS_ERLE}dB", erle1 >= PASS_ERLE)
check("双讲时近端未被完全消掉（削弱 < 12dB）", loss_db < 12.0)
check("无参考时输出≈输入（不失真）", d1 < 1e-4 and d2 < 0.005)
check("静音参考不发散", definite)

print("\n全部通过 ✓" if ok else "\n存在失败项 ✗")
sys.exit(0 if ok else 1)
