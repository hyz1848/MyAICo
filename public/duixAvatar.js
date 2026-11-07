/**
 * DUIX 数字人播放器（2D 真人 + Wav2Lip 口型）
 *
 * 服务端在**开始渲染时**就发 { type:'duix_clip', id, audio, dir, count, fps }，
 * 帧是边渲边取的（manifest.json 里的 ready 表示已有多少帧）：
 *   - 画面按 `audio.currentTime * fps` 定位 ✓ 结构上不会音画不同步 ✓
 *   - 想要的帧还没渲好就先用最近的已解码帧 ✓ 不会黑屏 ✓
 *
 * 与 3D 数字人：3D 继续跑；一旦拿到第一段 clip，给 #avatarDock 加 `.duix-on`
 * 用 CSS 把 3D 画布藏起来（不销毁 ✓ 随时可切回 ✓）。
 */
(function () {
  const state = {
    canvas: null,
    ctx: null,
    audio: null,
    clips: new Map(),   // basename -> clip
    clip: null,
    idle: null,        // { dir, count, frames:Map } 兜底动画（素材包自己的循环帧）
    idleDir: '',
    raf: 0,
    poll: 0,
    dpr: Math.min(window.devicePixelRatio || 1, 2),
  };

  const base = (p) => String(p || '').split(/[\\/]/).pop();
  const frameUrl = (clip, i) => `${clip.dir}/${String(i).padStart(4, '0')}.jpg`;
  const dock = () => document.getElementById('avatarDock');

  function ensureCanvas() {
    // ★ 3D 数字人初始化时会 `container.innerHTML = ...` ✗ 把我们挂上去的 canvas 删掉 ✗
    //   实测：`.duix-on` 加上了、state.poster 也有，但 document.getElementById('duixCanvas') === null ✗
    //   → 每帧检查一次是否还挂在 DOM 里，掉了就挂回去 ✓
    if (state.canvas) {
      if (!state.canvas.isConnected) {
        const el = dock();
        if (el) el.appendChild(state.canvas);
      }
      return state.canvas;
    }
    const el = dock();
    if (!el) return null;
    let c = el.querySelector('#duixCanvas');
    if (!c) {
      c = document.createElement('canvas');
      c.id = 'duixCanvas';
      c.className = 'duix-canvas';
      el.appendChild(c);
      c.addEventListener('click', () => {
        if (state.audio) { state.audio.currentTime = 0; state.audio.play().catch(() => {}); }
      });
    }
    state.canvas = c;
    state.ctx = c.getContext('2d');
    // 3D 每次重写容器就把我们删掉 ✓ 用观察器补挂 + 重画 ✓（比每帧轮询更早恢复 ✓）
    if (!state.mo && window.MutationObserver) {
      state.mo = new MutationObserver(() => {
        if (state.canvas && !state.canvas.isConnected) {
          const el2 = dock();
          if (el2) {
            el2.appendChild(state.canvas);
            if (state.clip) start();
            else if (state.poster) drawPoster();
          }
        }
      });
      state.mo.observe(el, { childList: true });
    }
    return c;
  }

  function sizeCanvas() {
    const c = state.canvas;
    if (!c) return;
    const w = Math.max(1, Math.round(c.clientWidth * state.dpr));
    const h = Math.max(1, Math.round(c.clientHeight * state.dpr));
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  }

  function ensureFrame(clip, i) {
    let im = clip.frames.get(i);
    if (!im) {
      im = new Image();
      im.decoding = 'async';
      im.src = frameUrl(clip, i);
      clip.frames.set(i, im);
    }
    return im;
  }

  function draw(idx) {
    const clip = state.clip;
    const c = ensureCanvas();
    if (!clip || !c) return false;
    // manifest 每批（16 帧）更新一次 ✓ 只取"已经报过可以"的帧 ✓
    // （乐观多要会让 404 的 Image 永久坏掉 ✗ 实测：提前取帧反而整段黑屏 ✗）
    const lim = Math.max(0, Math.min(clip.count - 1, (clip.ready || 0) - 1));
    const i = Math.max(0, Math.min(idx, lim));
    for (let k = i; k <= Math.min(lim, i + 3); k++) ensureFrame(clip, k);
    let im = clip.frames.get(i);
    if (!im || !im.complete || !im.naturalWidth) {
      im = null;
      for (let d = 1; d <= 8 && !im; d++) {
        const a = clip.frames.get(i - d);
        if (a && a.complete && a.naturalWidth) { im = a; break; }
      }
    }
    if (!im || !im.complete || !im.naturalWidth) return false;
    sizeCanvas();
    const cw = c.width, ch = c.height;
    const s = Math.max(cw / im.naturalWidth, ch / im.naturalHeight);   // cover
    const w = im.naturalWidth * s, h = im.naturalHeight * s;
    state.ctx.drawImage(im, (cw - w) / 2, (ch - h) / 2, w, h);
    // ★ 第一帧真的画出来了才切掉 3D ✓ 否则会先黑一下 ✗
    const el = dock();
    if (el && !el.classList.contains('duix-on')) {
      el.classList.add('duix-on');
      // 3D 停跑 ✓ 它和我们在抢同一块显卡（实测 18ms/帧 → 200ms/帧 ✗）
      try { const av = window.VoiceAvatar && window.VoiceAvatar.default; av && av.pause && av.pause(); } catch (e) {}
    }
    return true;
  }

  function loop() {
    state.raf = 0;
    const a = state.audio, clip = state.clip;
    if (clip) {
      const t = a ? (a.currentTime || 0) : 0;
      const ok = draw(a && a.ended ? clip.count - 1 : Math.floor(t * clip.fps));
      // ★ 这一段还没渲出可用帧 → 用素材包自己的循环帧兜底 ✓ 人一直在动 ✓
      //   （实测：某些句子渲染晚于播放 → 以前整句静止 ✗ 用户反馈"有的句子不动"✗）
      if (!ok) drawIdle();
    } else {
      drawIdle();
    }
    state.raf = requestAnimationFrame(loop);
  }

  function start() {
    ensureCanvas();
    if (!state.raf) state.raf = requestAnimationFrame(loop);
  }

  /** 轮询 manifest.ready：服务端边渲边写 ✓ 每 400ms 一次 ✓ 渲完就停 ✓ */
  function pollReady(clip) {
    if (clip.done) return;
    clearTimeout(state.poll);
    state.poll = setTimeout(async () => {
      try {
        const r = await fetch(`${clip.dir}/manifest.json?t=${Date.now()}`, { cache: 'no-store' });
        const m = await r.json();
        if (m && typeof m.ready === 'number') {
          clip.ready = Math.max(clip.ready || 0, m.ready);
          if (typeof m.count === 'number') clip.count = m.count;
          if (clip.ready >= clip.count) clip.done = true;
        }
      } catch (e) {}
      if (!clip.done && state.clip === clip) pollReady(clip);
    }, 400);
  }

  function attach(clip) {
    if (state.clip === clip) { start(); return; }
    state.clip = clip;
    clip.frames = clip.frames || new Map();
    clip.ready = clip.ready || 0;
    console.info('[Duix] 播放', clip.dir, clip.count, '帧');
    pollReady(clip);
    start();
  }

  /** 静态海报：页面一打开就显示这张脸 ✓（不用等第一句话 ✓） */
  function drawIdle() {
    const idle = state.idle;
    const c = ensureCanvas();
    if (!idle || !c) return false;
    const i = Math.floor((performance.now() / 1000) * idle.fps) % idle.count;
    let im = idle.frames.get(i);
    if (!im) { im = new Image(); im.src = `${idle.dir}/${String(i).padStart(4, '0')}.jpg`; idle.frames.set(i, im); }
    if (!im.complete || !im.naturalWidth) {
      im = null;
      for (let d = 1; d <= 6 && !im; d++) {
        const a = idle.frames.get((i - d + idle.count) % idle.count);
        if (a && a.complete && a.naturalWidth) im = a;
      }
    }
    if (!im || !im.complete || !im.naturalWidth) return false;
    sizeCanvas();
    const cw = c.width, ch = c.height;
    const s2 = Math.max(cw / im.naturalWidth, ch / im.naturalHeight);
    state.ctx.drawImage(im, (cw - im.naturalWidth * s2) / 2, (ch - im.naturalHeight * s2) / 2,
                        im.naturalWidth * s2, im.naturalHeight * s2);
    const el = dock();
    if (el && !el.classList.contains('duix-on')) el.classList.add('duix-on');
    return true;
  }

  function onPoster(url, idleDir) {
    if (!url) return;
    const c = ensureCanvas();
    if (!c) return;
    const im = new Image();
    im.onload = () => {
      state.poster = im;
      // ★ 海报重生成 = 换人了 ✓ 旧片段的帧是**上一个人的** ✗ 必须丢掉 ✓
      state.clips.clear();
      state.clip = null;
      if (idleDir) {
        // ★ 兜底动画也一起换 ✓（否则换人后"没渲好"的那几秒还是上一个人的帧 ✗）
        state.idleDir = idleDir;
        state.idle = { dir: idleDir, count: 30, fps: 12, frames: new Map() };
      }
      if (state.raf) { cancelAnimationFrame(state.raf); state.raf = 0; }
      drawPoster();
      start();
    };
    im.src = url;
  }

  function drawPoster() {
    ensureCanvas();
    const c = state.canvas, im = state.poster;
    if (!c || !im) return;
    sizeCanvas();
    const cw = c.width, ch = c.height;
    const s2 = Math.max(cw / im.naturalWidth, ch / im.naturalHeight);
    const w = im.naturalWidth * s2, h = im.naturalHeight * s2;
    state.ctx.drawImage(im, (cw - w) / 2, (ch - h) / 2, w, h);
    const el = dock();
    if (el && !el.classList.contains('duix-on')) el.classList.add('duix-on');
  }

  // 窗口尺寸变了要重画（canvas 改尺寸会清空 ✓ 静态海报没有人重绘它 ✗）
  window.addEventListener('resize', () => { if (state.poster && !state.clip) drawPoster(); });

  /** 打断/停止时复位：丢掉当前片段，回到素材包自己的循环帧（嘴闭上、人继续动）
   *  ★ 之前 stop_tts 只停了音频 ✗ 这里 state.clip/state.audio 还留着 ✗
   *    loop() 拿暂停时的 currentTime 一直画同一帧 → 停在"嘴张一半" ✗
   */
  function reset() {
    state.audio = null;
    state.clip = null;
    if (!state.raf) { start(); return; }
    if (!drawIdle()) drawPoster();   // idle 帧还没就绪时退回静态海报，别留着半张嘴 ✗
  }

  /** 每段音频开始播放时调用（app.js 的 playNext） */
  function speak(audioEl) {
    state.audio = audioEl || null;
    if (!audioEl) return;
    ensureCanvas();
    const clip = state.clips.get(base(audioEl.src));
    if (clip) { attach(clip); return; }
    // ★ 这一段还没渲好 ✓ 千万别拿**上一段**的帧继续放 ✗
    //   那段口型对应的是上一句话 → 画面和声音对不上 ✗ 比不动更糟 ✗
    //   → 退回静态海报 ✓ 嘴不动但脸是对的 ✓ 帧一到立刻切 ✓
    // 停住：让画面停在**上一段最后一帧** ✓（同一张脸、同一姿势 ✓ 视觉上连续）
    // 千万别 drawPoster() ✗ 那是素材包第 0 帧，表情/角度都不一样 → 会"跳一下" ✗
    state.clip = null;
    if (!state.raf) start();     // 兜底循环继续跑 ✓ 不再静止 ✗
  }

  /** 服务端开始渲染时就会发这条（count/fps 已知，帧陆续到） */
  function onClip(msg) {
    if (!msg || !msg.dir || !msg.count) return;
    const prev = state.clips.get(msg.audio);
    state.clips.set(msg.audio, Object.assign({ frames: new Map(), ready: 0 }, msg, {
      frames: (prev && prev.frames) || new Map(),
      ready: (prev && prev.ready) || 0,
    }));
    // ★ 不能再按"只留 8 个"淘汰 ✗：本地 TTS 几百毫秒就把整段答案全合成完 ✓
    //   → 十几二十个片段瞬间进来 ✗ → 前面的被挤掉 ✗ → 播到它时找不到片段 → **静止** ✓✓
    //   改成：只淘汰**已经播过**的（按 Map 插入顺序 ✓ 保留最近的 64 个 ✓ 内存可控 ✓）
    if (state.clips.size > 64) state.clips.delete(state.clips.keys().next().value);
    if (state.audio && base(state.audio.src) === msg.audio) attach(state.clips.get(msg.audio));
  }

  window.DuixAvatar = { speak, onClip, onPoster, reset, mount: ensureCanvas };
  window.__duixState = state;   // 调试用（只读观察 ✓ 不影响逻辑 ✓）
})();
