"""aec.py — 声学回声消除（AEC）

前提（为什么现在才能做）：播放和采集都在本进程内。参考信号 = 我们喂给声卡的采样，
与麦克风严格同源同时间轴，自适应滤波器才有可对齐的参考。

算法：
  1) 参考信号环形缓冲（由播放回调写入）
  2) FIR 回声路径估计 w（NLMS，块更新）
  3) 双讲检测（DTD）：近端能量显著大于估计回声时冻结自适应，避免把用户语音学进滤波器
  4) 残留回声抑制（RES）：按估计的回声/近端能量比做软衰减，抑制滤波器没干掉的部分

用法：
    aec = EchoCanceller(sample_rate=16000, taps=2048)
    # 播放回调里（每帧输出前）
    aec.add_reference(frames_float32)
    # 采集线程里
    clean = aec.process(mic_block)      # 与 mic_block 等长
"""

import numpy as np


class EchoCanceller:
    def __init__(self, sample_rate=16000, taps=2048, mu=0.4, eps=1e-8,
                 ref_seconds=3.0, delay_samples=0, dtd_ratio=1.5, res_floor=0.15,
                 blowup_ratio=1.5, max_blowups=20):
        self.sr = int(sample_rate)
        self.taps = int(taps)
        self.mu = float(mu)
        self.eps = float(eps)
        self.delay_samples = int(delay_samples)
        # 双讲判据：近端能量 > dtd_ratio × 估计回声能量 → 冻结自适应
        self.dtd_ratio = float(dtd_ratio)
        # 残留抑制下限（0.15 ≈ 最多再压 16dB，避免把近端也压没）
        self.res_floor = float(res_floor)
        # 发散保护：输出能量超过输入的 blowup_ratio 倍，说明滤波器在放大而不是消除
        # （真机时延失配/强相关参考会出现），此时立即重置并透传，绝不放垃圾进识别。
        self.blowup_ratio = float(blowup_ratio)
        self.max_blowups = int(max_blowups)
        self.blowups = 0
        self.adapt_disabled = False

        self.buf_size = max(self.taps * 2, int(ref_seconds * self.sr))
        self.buf = np.zeros(self.buf_size, dtype=np.float32)
        self.wp = 0                                  # 环形缓冲写指针
        self.w = np.zeros(self.taps, dtype=np.float32)  # 回声路径估计

        self.total_ref = 0
        self._last_ref_total = -1     # 上次 process 时的参考总数：用于识别"播放空档"（见 process）
        self.adapted_blocks = 0
        self.frozen_blocks = 0
        self.last_erle_db = 0.0

    # ---------- 参考信号 ----------
    def add_reference(self, samples):
        """播放回调调用：写入即将输出的采样（float32, [-1,1]）"""
        if samples is None:
            return
        x = np.asarray(samples, dtype=np.float32).reshape(-1)
        n = x.size
        if n == 0:
            return
        if n >= self.buf_size:
            x = x[-self.buf_size:]
            n = x.size
        idx = (self.wp + np.arange(n)) % self.buf_size
        self.buf[idx] = x
        self.wp = (self.wp + n) % self.buf_size
        self.total_ref += n

    def _window(self, length, end_offset):
        """取环形缓冲中 [wp - end_offset - length, wp - end_offset) 的采样（按时间顺序）"""
        end = (self.wp - int(end_offset)) % self.buf_size
        start = (end - int(length)) % self.buf_size
        if start < end:
            return self.buf[start:end].copy()
        return np.concatenate([self.buf[start:], self.buf[:end]])

    # ---------- 处理 ----------
    def process(self, mic_block, adapt=True):
        """输入一帧麦克风采样，返回去回声后的同长度帧"""
        d = np.asarray(mic_block, dtype=np.float32).reshape(-1)
        L = d.size
        if L == 0:
            return d
        # 空闲判定：自上次 process 起参考缓冲没有写入新样本（TTS 分段之间的播放空隙），
        # 此时 wp 冻结，却仍按"当前时刻"取窗 → 自适应对着错时间轴的旧回声学；
        # 且静音块的 dot(e,e)=|y|²≠0 而 mic_energy=0，必然被误判成发散（实测每段间隙触发一次，
        # 累计到 20 次就锁死自适应，ERLE 恒为 0）。没有新参考 → 直接透传，不学也不判发散。
        if self.total_ref == self._last_ref_total:
            return d.copy()
        self._last_ref_total = self.total_ref
        if self.total_ref < self.taps + L:
            return d.copy()          # 还没播过东西，无可消除

        # 与 d 对齐的参考段：长度 taps+L-1，结尾对齐"当前时刻"（delay 补偿设备/声程延迟）
        x_seg = self._window(self.taps + L - 1, self.delay_samples)
        y = np.convolve(x_seg, self.w, mode='valid')   # 长度 == L，与 d 对齐
        e = d - y

        echo_energy = float(np.dot(y, y))
        mic_energy = float(np.dot(d, d))

        # 保护：输出比输入还响 ⇒ 滤波器在放大（真机时延失配时典型）→ 重置 + 本帧透传。
        # 额外要求真实麦克风能量：mic 静音时（|y|²>0 而 |d|²=0）上式恒成立，
        # 会把每个静音块都算成一次发散。
        if (mic_energy > 1e-8 * L and
                float(np.dot(e, e)) > mic_energy * self.blowup_ratio + self.eps):
            self.w[:] = 0.0
            self.blowups += 1
            self.last_erle_db = 0.0
            # 只在连续发散（中间没成功自适应过）时锁死；blowups 是"连续计数"，
            # 之前一旦置 True 就再也回不来（w=0 ⇒ e==d ⇒ 永远不判发散 ⇒ 计数不涨）。
            self.adapt_disabled = self.blowups >= self.max_blowups
            return d.copy()
        self.last_erle_db = 10.0 * np.log10((mic_energy + self.eps) / (float(np.dot(e, e)) + self.eps))

        x_energy = float(np.dot(x_seg, x_seg))
        # 参考信号太小（静音）时不要自适应：分母接近 0 会让权重炸掉
        can_adapt = x_energy > 1e-6 * x_seg.size
        # 双讲检测（Geigel 型）：麦克风比"最近参考"还响 → 近端在说话。
        # 不能用滤波器自己的估计（未收敛时会把回声当双讲 → 冻结 → 永远学不到）。
        ref_rms = float(np.sqrt(x_energy / max(1, x_seg.size)))
        mic_rms = float(np.sqrt(mic_energy / max(1, L)))
        double_talk = can_adapt and mic_rms > self.dtd_ratio * ref_rms
        if double_talk or self.adapt_disabled:
            self.frozen_blocks += 1
        elif adapt and can_adapt:
            grad = np.correlate(x_seg, e, mode='valid')     # 长度 == taps
            if grad.size == self.taps:
                # grad[k] 对应 w[taps-1-k]（与 np.convolve 的索引方向相反），故翻转
                self.w += (self.mu * grad[::-1] / (x_energy + self.eps)).astype(np.float32)
                self.adapted_blocks += 1
                self.blowups = 0        # 自适应成功 ⇒ 之前的不算"连续发散"，并解除锁死（adapt_disabled 由计数派生）
                if not np.all(np.isfinite(self.w)) or float(np.dot(self.w, self.w)) > 1e4:
                    # 数值发散兜底：重置滤波器，宁可没消除也不要输出垃圾
                    self.w[:] = 0.0
                    self.frozen_blocks += 1

        return self._residual_suppress(e, d, echo_energy, mic_energy)

    def _residual_suppress(self, e, d, echo_energy, mic_energy):
        """滤波后残留回声抑制：回声明显占优时再压一把，近端说话时不动"""
        if echo_energy <= self.eps or mic_energy <= self.eps:
            return e
        ratio = echo_energy / mic_energy            # 0~1，越小说明近端越强
        if ratio < 0.25:
            return e                                # 近端为主，别动
        gain = max(self.res_floor, 1.0 - ratio)
        return (e * gain).astype(np.float32)

    # ---------- 诊断 ----------
    def stats(self):
        return {
            "taps": self.taps,
            "adapted_blocks": self.adapted_blocks,
            "frozen_blocks": self.frozen_blocks,
            "erle_db": round(float(self.last_erle_db), 1),
            "w_energy": float(np.dot(self.w, self.w)),
            "blowups": self.blowups,
            "adapt_disabled": self.adapt_disabled,
            "delay_samples": self.delay_samples,
        }


def synth_fake_room(reference, ir):
    """测试用：把参考信号过一遍房间冲激响应，得到"麦克风听到的回声" """
    y = np.convolve(np.asarray(reference, dtype=np.float32), np.asarray(ir, dtype=np.float32), mode='full')
    return y[:len(reference)].astype(np.float32)
