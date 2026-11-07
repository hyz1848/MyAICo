// VoiceAI Frontend - Display Only (C/S Architecture)
(function() {
  'use strict';

  let ws = null;
  let isConnected = false;
  let isListening = false;
  let captureMode = 'server';     // server=Python sounddevice；browser=浏览器采集(WebRTC AEC)
  let captureModeOverride = null; // 用户在设置里选的来源（优先于服务端默认）
  let wakeWord = '潞潞同学';      // 唤醒词（服务端下发）
  let wakeAwake = false;          // 是否处于会话中
  let frameSamples = 1280;
  let micStream = null, audioCtx = null, captureNode = null, captureSource = null;
  let audioQueue = [];
  let isPlayingAudio = false;
  // 播放音量：压低一点可显著减少"自己说自己听"（不改任何能力 ✓ 只调电平 ✓）
  // ★ 0.65 → 0.35 ✓（2026-10-19 晚）：外放越响，喇叭→麦克风的回声越大 ✗
  //   实测证据 ✓：`playing=true` 期间识别出「对呀球子」「我说你过年啊」「好多啊」(rms 0.05~0.08 ✗)
  //   = 它听见自己的声音 → 当成用户插话 → 自我对话 ✗✗（echo.tailMs 也加长到 2500 一起兜 ✓）
  const PLAYBACK_VOLUME = 0.35;
  // localStorage 在隐私模式/file:// 下会抛异常 ✗：顶层读一次就能让整页连不上 WS ✓（见 connect()）
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch (e) { return null; } };
  const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };
  let currentReplyId = 0;
  let playbackMode = 'server';   // server = Python 端放音（浏览器只显示）
  let streamEl = null;   // 本轮流式回复的气泡元素

  // ========== DOM Elements ==========
  const $ = (id) => document.getElementById(id);
  const chatContainer = $('chatContainer');
  const messagesEl = $('messages');
  const welcomeMessage = $('welcomeMessage');
  const micBtn = $('micBtn');
  const textInput = $('textInput');
  const sendBtn = $('sendBtn');
  const inputHint = $('inputHint');
  const statusDot = document.querySelector('.status-dot');
  const statusText = document.querySelector('.status-text');
  const settingsBtn = $('settingsBtn');
  const settingsPanel = $('settingsPanel');
  const visualizer = $('voiceVisualizer');
  const visualizerBars = $('visualizerBars');

  // Create visualizer bars
  const BAR_COUNT = 32;
  for (let i = 0; i < BAR_COUNT; i++) {
    const bar = document.createElement('div');
    bar.className = 'viz-bar';
    visualizerBars.appendChild(bar);
  }
  const bars = visualizerBars.querySelectorAll('.viz-bar');

  // ========== WebSocket ==========
  function connect() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${location.host}`);

    ws.onopen = () => {
      isConnected = true;
      updateStatus('connected', '已连接');
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      handleServerMessage(msg);
    };

    ws.onclose = () => {
      isConnected = false;
      updateStatus('disconnected', '已断开');
      setTimeout(connect, 2000);
    };

    ws.onerror = () => {
      isConnected = false;
      updateStatus('disconnected', '连接错误');
    };
  }

  /** 服务端放音：浏览器只显示（别再放一遍），用状态提示表示正在播报 */
  function noteServerPlayback(text) {
    console.debug('[TTS] 由服务端播报:', text);
    document.body.classList.add('server-speaking');
    updateInputHint('speaking');
  }

  function handleServerMessage(msg) {
    switch (msg.type) {
      case 'wake_state':
        wakeAwake = !!msg.awake;
        if (isListening) updateInputHint(wakeAwake ? 'listening' : 'standby');
        break;

      case 'hello':
        if (msg.playback) playbackMode = msg.playback;
        captureMode = captureModeOverride || msg.capture || 'server';
        frameSamples = msg.frameSamples || 1280;
        wakeWord = msg.wakeWord || wakeWord;
        if (typeof msg.awake === 'boolean') wakeAwake = msg.awake;
        // ★ 界面显示服务端的**真实**录音状态 ✓（不是本地记性 ✗）：hello.recordAudio ← conf debug.recordUserAudio ✓
        if ($('optRecord') && typeof msg.recordAudio === 'boolean') $('optRecord').checked = msg.recordAudio;
        if ($('captureSource')) $('captureSource').value = captureMode;
        if (captureMode === 'browser') {
          updateInputHint('browser-mic');
        }
        // ✗ 服务重启后页面只会重连、不会重新发起聆听 → 表现为"我说了没反应"（麦克风实际没开）
        // ✓ 若刷新前是开启状态（localStorage 记住），重连后自动恢复聆听
        if (!isListening && lsGet('voiceai_listening') === '1') {
          setTimeout(() => {
            if (!isListening && isConnected) {
              if (captureMode === 'browser') {
                startBrowserCapture().catch((e) => addNotice('浏览器麦克风不可用：' + (e.name || e.message)));
              }
              ws.send(JSON.stringify({ type: 'listen', source: captureMode }));
            }
          }, 400);
        }
        break;

      case 'vad_state':
        handleVadState(msg.state);
        break;

      case 'audio_level':
        updateVisualizer(msg.level);
        break;

      case 'asr_result':
        // 仅用于提示/调试：用户气泡统一由 user_text 渲染，避免与 llm_start 顺序错乱
        break;
      case 'ready':
        statusText.textContent = '就绪';
        break;

      case 'user_text':
        hideWelcome();
        addMessage('user', msg.text, false, { audio: msg.audio, conf: msg.conf, parts: msg.conf_parts });
        break;

      case 'llm_start':
        currentReplyId = msg.id || 0;
        stopPlayback();
        startAssistantMessage();
        updateInputHint('speaking');
        break;

      case 'stop_tts':
        currentReplyId = -1;   // 打断后，仍在途的同 id 音频一律丢弃
        document.body.classList.remove('server-speaking');
        bargeHeld = false;
        stopPlayback();
        break;

      case 'hold_tts':
        // ★ 用户刚开口：立刻暂停（不是清除 ✗）→ 判成噪声还能续播 ✓
        bargeHeld = true;
        if (currentAudio && !currentAudio.paused) { try { currentAudio.pause(); } catch (e) {} }
        break;

      case 'resume_tts':
        // ★ ASR 判定不是有效插话 → 原地续播 ✓
        bargeHeld = false;
        if (currentAudio && currentAudio.paused) { try { currentAudio.play().catch(() => {}); } catch (e) {} }
        else if (!currentAudio) playNext();
        break;

      case 'llm_stream':
        // 按 id 过滤：打断旧一轮时，旧流可能还有在途增量/收尾事件，不能污染新一轮气泡
        if (msg.id !== undefined && currentReplyId > 0 && msg.id !== currentReplyId) break;
        appendToStream(msg.content);
        break;

      case 'llm_done':
        // -1 是 stop_tts 设的哨兵（真值！），用 > 0 判断避免丢掉本轮自己的收尾
        if (msg.id !== undefined && currentReplyId > 0 && msg.id !== currentReplyId) break;
        finalizeStream();
        updateInputHint('normal');
        break;

      case 'llm_interrupted':
        // 同上：currentReplyId 为 -1（已被 stop_tts 清空）时也要收尾，否则动画光标永久闪烁
        if (msg.id !== undefined && currentReplyId > 0 && msg.id !== currentReplyId) break;   // 旧一轮的收尾，别动新一轮
        currentReplyId = -1;
        finalizeStream();
        updateInputHint('normal');
        break;

      case 'notice':
        addNotice(msg.text);
        break;

      case 'history':
        renderHistory(msg);
        break;

      case 'llm_retract': {
        if (msg.id !== undefined && currentReplyId > 0 && msg.id !== currentReplyId) break;
        // 撤回"调用工具前的草稿"：从当前气泡尾部删掉相应字数
        if (msg.chars > 0 && streamEl) {
          const bubble = streamEl.querySelector('.message-bubble');
          const cursor = bubble.querySelector('.cursor');
          let textNode = cursor ? cursor.previousSibling : bubble.lastChild;
          let remain = msg.chars;
          while (textNode && remain > 0) {
            const len = (textNode.textContent || '').length;
            if (len <= remain) { remain -= len; const prev = textNode.previousSibling; bubble.removeChild(textNode); textNode = prev; }
            else { textNode.textContent = textNode.textContent.slice(0, len - remain); remain = 0; }
          }
        }
        break;
      }

      case 'drop_queued_audio':
        // 丢弃这一轮已排队的语音（草稿），但保留本轮 id 以便答案继续播放
        dropQueuedAudio();
        break;

      case 'playback_start':
        // 服务端放音（Python 端播给声卡）：用状态提示表示正在说话
        document.body.classList.add('server-speaking');
        updateInputHint('speaking');
        break;

      case 'playback_end':
        document.body.classList.remove('server-speaking');
        updateInputHint('normal');
        break;

      case 'tts_audio': {
        // 只按"数字回复 id"过滤 ✓；▶ 试听的 id 是字符串 "preview-<ts>" → 不能被这道过滤吃掉 ✗✓
        // ★ -1（打断后）必须**一律丢数字 id** ✓：否则 stop_tts 之后在途/延迟 700ms 的旧音频
        //   会照样播出来 → "界面都断了、播音还在响" ✗（真 bug ✓ 已实测）
        if (msg.id !== undefined && typeof msg.id === 'number') {
          if (currentReplyId === -1) break;
          if (currentReplyId > 0 && msg.id !== currentReplyId) break;
        }
        // 是否由浏览器放：server=否（Python 已在服务器喇叭放过 ✓）；
        // browser=是；both=两边都放；auto=服务器照常放 ✓ 且**远程**浏览器也要放 ✓
        // （本地浏览器不播 ✗ 否则和服务器喇叭同屋双响）
        const mode = String(msg.play_mode || playbackMode || 'server').toLowerCase();
        // worker.py 会把服务端没入队成功的块标成 played="browser"，必须优先兜底，
        // 否则 play_mode=server 时浏览器也不播 → 两边都没声音
        const played = String(msg.played || '').toLowerCase();
        const host = location.hostname;
        const isRemote = !(host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]' || host === '');
        const browserPlays = mode === 'browser'
          || mode === 'both'
          || played === 'browser'                                  // 服务端没播成 → 浏览器兜底 ✓
          || (mode === 'auto' && isRemote);
        if (!browserPlays) {
          noteServerPlayback(msg.text);
          break;
        }
        playAudio(msg.audioPath || msg.audio_path, msg.text, msg.visemes);
        break;
      }

      case 'duix_poster':
        // ★ 一进页面就显示真人 ✓（不依赖有没有说话 ✓）
        try { window.DuixAvatar && window.DuixAvatar.onPoster(msg.url, msg.idle); } catch (e) {}
        break;

      case 'duix_clip':
        // ★ 服务端把这段语音渲好了 ✓：转给播放器 ✓（它只在当前音频匹配时才切画面 ✓）
        try { window.DuixAvatar && window.DuixAvatar.onClip(msg); } catch (e) {}
        break;

      case 'asr_error':
      case 'error':
        showError(msg.error);
        break;
    }
  }

  // ========== UI Helpers ==========
  function updateStatus(state, text) {
    statusDot.className = `status-dot ${state}`;
    statusText.textContent = text;
  }

  function updateInputHint(state) {
    inputHint.className = 'input-hint';
    switch (state) {
      case 'listening':
        inputHint.textContent = wakeAwake ? '正在聆听...' : `待命中 · 说「${wakeWord}」唤醒`;
        inputHint.classList.add(wakeAwake ? 'listening' : 'standby');
        break;
      case 'standby':
        inputHint.textContent = `已回到待命 · 说「${wakeWord}」唤醒`;
        break;
      case 'speaking':
        inputHint.textContent = 'AI 正在回复...';
        inputHint.classList.add('speaking');
        break;
      case 'browser-mic':
        inputHint.textContent = '点击麦克风开始对话（浏览器采集 · 已开启回声消除）';
        break;
      default:
        inputHint.textContent = '点击麦克风开始语音对话';
    }
  }

  function handleVadState(state) {
    switch (state) {
      case 'listening':
        isListening = true;
        try { localStorage.setItem('voiceai_listening', '1'); } catch (e) {}
        micBtn.classList.add('recording');
        visualizer.classList.add('active');
        inputHint.className = 'input-hint listening';
        inputHint.textContent = '聆听中，请说话...';
        break;
      case 'speech':
        inputHint.className = 'input-hint listening';
        inputHint.textContent = '检测到语音，正在录音...';
        break;
      case 'transcribing':
        inputHint.className = 'input-hint speaking';
        inputHint.textContent = '识别中...';
        break;
      default:
        isListening = false;
        try { localStorage.setItem('voiceai_listening', '0'); } catch (e) {}
        micBtn.classList.remove('recording');
        visualizer.classList.remove('active');
        updateInputHint('normal');
    }
  }

  function updateVisualizer(level) {
    const normalized = Math.min(1, level * 5);
    for (let i = 0; i < BAR_COUNT; i++) {
      const threshold = i / BAR_COUNT;
      const height = normalized > threshold ? (normalized - threshold) * 100 : 5;
      bars[i].style.height = `${Math.max(5, Math.min(100, height))}%`;
    }
  }

  function hideWelcome() {
    if (welcomeMessage) welcomeMessage.style.display = 'none';
  }

  // 点击用户气泡回听自己那句原话 ✓：独立于 TTS 队列 ✓（不抢播放权、不上报 playback ✓
  //   否则会把服务端的"正在放音"门控带偏 ✗ 连 VAD 阈值都跟着变 ✓）
  let utteranceAudio = null;
  function playUtterance(url, tag) {
    if (!url) return;
    if (utteranceAudio) { try { utteranceAudio.pause(); } catch (e) {} }
    const a = new Audio(url);
    utteranceAudio = a;
    a.addEventListener('ended', () => { if (tag) tag.textContent = ' ▶'; });
    a.addEventListener('error', () => { if (tag) tag.textContent = ' ✗已清理'; });
    const label = tag ? tag.textContent : '';
    a.play().then(() => { if (tag) tag.textContent = ' ⏸ 播放中'; })
      .catch(() => { if (tag) { tag.textContent = ' ✗ 播不了'; setTimeout(() => { tag.textContent = label; }, 1800); } });
  }

  function addMessage(role, text, withCursor = role === 'assistant', opts = {}) {
    const msgEl = document.createElement('div');
    msgEl.className = `message ${role}`;

    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';
    avatar.textContent = role === 'user' ? '👤' : role === 'notice' ? '⚙️' : '🤖';

    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';
    bubble.textContent = text;
    // ★「可信度」✓：只在**调试勾选框开着**时显示 ✓（跟录音同一个开关 ✓）
    //   paraformer **不给**模型置信度 ✗（实测四种入参只返回 key/text/timestamp ✓）
    //   → 这是 rms/增益/时长/文本自洽 算出的**质量分** ✓ 悬停看原始数字 ✓ 不冒充模型后验 ✓
    const dbgConf = $('optRecord') ? $('optRecord').checked : false;
    if (dbgConf && typeof opts.conf === 'number') {
      const c = document.createElement('span');
      c.style.cssText = 'opacity:.62;font-size:.85em;margin-right:.4em';
      const p = opts.parts || {};
      c.textContent = ` 可信度 ${opts.conf}`;
      c.title = `★不是模型后验 ✓（funasr 只返回 key/text/timestamp ✓）\n电平 rms=${p.rms} · 数字增益 ${p.gain}× · 时长 ${p.dur}s · 字数 ${p.chars}\n判据：认对的原始 rms 0.09~0.14 ✓ / 幻觉 0.009~0.030 且增益顶满 ✗`;
      bubble.insertBefore(c, bubble.firstChild);   // 放在文字前面 ✓ 一眼看到 ✓
    }
    // ★ 用户气泡可点回放 ✓：服务端开着 debug.recordUserAudio 时会把这句录音的 URL 随 user_text 发来 ✓
    //   识别错了不用再跑脚本、不用查日志 ✓ —— 点一下自己听 ✓（点击本身就是用户手势 ✓ 不会被自动播放策略拦 ✗）
    if (opts.audio) {
      const tag = document.createElement('span');
      tag.textContent = ' ▶';
      tag.title = '点这里回听这句（录音在 temp/asr_kept/ ✓ 只留最近若干条 ✗ 太旧的会提示已清理）';
      bubble.appendChild(tag);
      bubble.style.cursor = 'pointer';
      bubble.dataset.audio = opts.audio;
      bubble.addEventListener('click', () => playUtterance(bubble.dataset.audio, tag));
    }

    if (withCursor) {
      const cursor = document.createElement('span');
      cursor.className = 'cursor';
      bubble.appendChild(cursor);
    }

    const time = document.createElement('div');
    time.className = 'message-time';
    time.textContent = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

    msgEl.appendChild(avatar);
    msgEl.appendChild(bubble);
    msgEl.appendChild(time);
    messagesEl.appendChild(msgEl);
    chatContainer.scrollTop = chatContainer.scrollHeight;
    return msgEl;
  }

  // 流式文本锚定在本轮回复自己的气泡上（不能被通知/错误插队抢走）
  function startAssistantMessage() {
    streamEl = addMessage('assistant', '');
    return streamEl;
  }

  function appendToStream(content) {
    if (!streamEl) return;
    const bubble = streamEl.querySelector('.message-bubble');
    const cursor = bubble.querySelector('.cursor');
    if (cursor) bubble.insertBefore(document.createTextNode(content), cursor);
    else bubble.appendChild(document.createTextNode(content));
    chatContainer.scrollTop = chatContainer.scrollHeight;
  }

  function finalizeStream() {
    if (!streamEl) return;
    const cursor = streamEl.querySelector('.cursor');
    if (cursor) cursor.remove();
    streamEl = null;
  }

  function addNotice(text) {
    addMessage('notice', text);
  }

  // 恢复历史会话（页面刷新 / 重连）
  function renderHistory(msg) {
    messagesEl.innerHTML = '';
    streamEl = null;
    const msgs = Array.isArray(msg.messages) ? msg.messages : [];
    if (msgs.length) {
      hideWelcome();
      for (const m of msgs) {
        if (m.role !== 'user' && m.role !== 'assistant') continue;
        addMessage(m.role, m.content, false);
      }
    } else {
      if (welcomeMessage) welcomeMessage.style.display = '';
    }
    if (msg.summary) {
      addNotice(`已压缩的早期对话摘要已载入（约 ${msg.tokens || 0} tokens 上下文）`);
    }
  }

  function showError(error) {
    console.error('[VoiceAI]', error);
    addNotice(`出错了: ${error}`);
  }

  // ========== 浏览器采集（WebRTC AEC，采集与播放同一音频引擎） ==========
  function getMicOptions() {
    return {
      echo: $('optEcho') ? $('optEcho').checked : true,
      noise: $('optNoise') ? $('optNoise').checked : true,
      // ★ 自动增益默认**关** ✓：实测同一句"露露同学"的电平 20 秒内从 0.1375 掉到 0.0091 ✗（≈15 倍 ✓）
      //   而 worker 侧数字增益顶到 maxGain=8 补不动 ✗ → 后半句被听成 `一`/`the`/空 ✓。
      //   Chrome 的 AGC 自己压/抬增益 ✓ 与我们的确定性归一化（targetRms 0.1 ✓）叠加反而乱 ✗
      //   → 交给 worker 一处管增益 ✓ 界面里仍可手动打开 ✓
      agc: $('optAgc') ? $('optAgc').checked : false,
    };
  }

  // ★ 麦克风设备下拉 ✓：Chrome 的"默认麦"≠ 系统默认麦 ✗（实测抓到闲置的远场麦 → 只有环境音）
  //   授权前 enumerateDevices 的 label 是空的 ✓ 所以 startBrowserCapture 成功后会再刷一次
  async function refreshMicDevices() {
    const sel = $('micDevice');
    if (!sel || !navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;
    try {
      const devs = await navigator.mediaDevices.enumerateDevices();
      const mics = devs.filter((d) => d.kind === 'audioinput');
      const keep = sel.value || lsGet('voiceai_mic_device') || '';
      sel.innerHTML = '';
      const def = document.createElement('option');
      def.value = ''; def.textContent = '系统默认';
      sel.appendChild(def);
      for (const m of mics) {
        const o = document.createElement('option');
        o.value = m.deviceId;
        o.textContent = m.label || `麦克风 ${String(m.deviceId).slice(0, 6)}`;
        sel.appendChild(o);
      }
      sel.value = mics.some((m) => m.deviceId === keep) ? keep : '';
    } catch (e) {}
  }

  const PCM_WORKLET_SRC = `
class PcmCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.frame = (options.processorOptions && options.processorOptions.frameSamples) || 1280;
    this.buf = new Float32Array(this.frame);
    this.n = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === this.frame) {
        const pcm = new Int16Array(this.frame);
        for (let j = 0; j < this.frame; j++) {
          const s = Math.max(-1, Math.min(1, this.buf[j]));
          pcm[j] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        this.port.postMessage(pcm.buffer, [pcm.buffer]);
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor('pcm-capture', PcmCapture);
`;

  async function startBrowserCapture() {
    // ★ 重入守卫 ✓：本函数会直接覆盖 micStream/audioCtx/captureNode ✗，
    //   连点两下（服务端 vad_state 还没回来的窗口内 ✓）或重连自动聆听撞上手动点击 ✓
    //   就会**双麦 + 两路 worklet 同时推 PCM → 帧率翻倍** ✓，且旧麦没 stop（麦克风指示灯常亮 ✗）
    if (micStream || audioCtx || captureNode) stopBrowserCapture();
    // 这些处理开关在不同设备组合下效果差别很大：外放喇叭 + 普通麦时，
    // Chrome 的 AEC/降噪可能把人声也压掉（表现为"有声音但识别为空"），故做成可切换。
    const opts = getMicOptions();
    const devId = $('micDevice') ? $('micDevice').value : (lsGet('voiceai_mic_device') || '');
    const audioBase = {
      echoCancellation: opts.echo,
      noiseSuppression: opts.noise,
      autoGainControl: opts.agc,
      channelCount: 1,
    };
    try {
      micStream = await navigator.mediaDevices.getUserMedia(
        devId ? { audio: { ...audioBase, deviceId: { exact: devId } } } : { audio: audioBase });
    } catch (e) {
      // 选中的麦拔了/不可用 → 退回系统默认 ✓ 并清掉记住的设备 ✓（别让"换电脑"变成"开不了麦"✗）
      if (devId && (e.name === 'OverconstrainedError' || e.name === 'NotFoundError' || e.name === 'DevicesNotFoundError')) {
        addNotice(`所选麦克风不可用（${e.name}）→ 已改用系统默认`);
        lsSet('voiceai_mic_device', '');
        if ($('micDevice')) $('micDevice').value = '';
        micStream = await navigator.mediaDevices.getUserMedia({ audio: audioBase });
      } else throw e;
    }
    refreshMicDevices();   // 拿到权限后才有真 label ✓ 此时刷新下拉才显示得全 ✓
    audioCtx = new AudioContext({ sampleRate: 16000 });
    if (audioCtx.state === 'suspended') await audioCtx.resume();
    const url = URL.createObjectURL(new Blob([PCM_WORKLET_SRC], { type: 'application/javascript' }));
    await audioCtx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    captureNode = new AudioWorkletNode(audioCtx, 'pcm-capture', {
      numberOfInputs: 1, numberOfOutputs: 0,
      processorOptions: { frameSamples },
    });
    captureNode.port.onmessage = (e) => {
      if (isConnected && ws && ws.readyState === WebSocket.OPEN) ws.send(e.data);
    };
    captureSource = audioCtx.createMediaStreamSource(micStream);
    captureSource.connect(captureNode);
    // 注意：不接到 destination，避免把麦克风原声再放出来
    const track = micStream.getAudioTracks()[0];
    const s = track && track.getSettings ? track.getSettings() : {};
    console.log(`[capture] 浏览器采集启动: ${s.sampleRate || '?'}Hz echoCancellation=${s.echoCancellation}`);
    // ★ 把麦克风"真实生效"的参数上报服务端 → 日志里能直接看到回声消除开没开（不再靠猜 ✗）
    try {
      if (isConnected) ws.send(JSON.stringify({ type: 'client_info', capture: {
        echoCancellation: !!s.echoCancellation, noiseSuppression: !!s.noiseSuppression,
        autoGainControl: !!s.autoGainControl, sampleRate: s.sampleRate || 0,
        device: (micStream.getAudioTracks()[0] || {}).label || '?' } }));
    } catch (e) {}
    addNotice(`浏览器麦克风已启用（回声消除 ${s.echoCancellation ? '开' : '关'}）`);
  }

  function stopBrowserCapture() {
    if (captureNode) { try { captureNode.port.onmessage = null; captureNode.disconnect(); } catch (e) {} captureNode = null; }
    if (captureSource) { try { captureSource.disconnect(); } catch (e) {} captureSource = null; }
    if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null; }
    if (audioCtx) { try { audioCtx.close(); } catch (e) {} audioCtx = null; }
  }

  // ========== Audio Playback ==========
  let currentAudio = null;
  let playbackHeartbeat = null;
  let playbackToken = 0;
  let autoplayBlockedNotified = false;   // 自动播放被拦截只提示一次，避免每块都刷屏
  // ★ 快速打断 ✓：服务端一报"开口"就先暂停本地播音（不等 ASR ✗）
  //   ASR 确认是噪声 → resume_tts 原地续播 ✓；真插话 → stop_tts 彻底停 ✓
  let bargeHeld = false;

  // 块间停顿：由句子结束标点决定（标点已随文本送给 TTS，语调由 edge-tts 决定）
  const PUNCT_GAP = { '。': 260, '．': 260, '.': 260, '！': 380, '!': 380, '？': 380, '?': 380, '；': 160, ';': 160, '…': 300, '\n': 300 };
  const CLAUSE_GAP = 120;    // 超长句在逗号处被切开
  const DEFAULT_GAP = 90;    // 其他硬切

  function gapFor(text) {
    const t = (text || '').trim();
    if (!t) return DEFAULT_GAP;
    const last = t[t.length - 1];
    if (PUNCT_GAP[last] !== undefined) return PUNCT_GAP[last];
    if ('，,、：:'.includes(last)) return CLAUSE_GAP;
    return DEFAULT_GAP;
  }

  function playAudio(audioPath, text, visemes) {
    // visemes ✓：服务端算好的口型序列 ✓（见 viseme.js ✓ 权重 w 用来把音频时长分给各口型 ✓）
    audioQueue.push({ path: audioPath, text: text || '', visemes: visemes || null });
    // ★ 预解码 ✓：数字人得先 fetch + 解码才能开口 ✓ 若等 playNext 才做 ✓ 会有一段"没嘴"的静音 ✗
    //   （用户实测「语音比嘴型早 0.5 秒」的两个成因之一 ✓ 另一个是静音时机 ✗ 见 avatar3d.js ✓）
    try {
      const av = window.VoiceAvatar && (window.VoiceAvatar.default || window.VoiceAvatar);
      if (av && typeof av.prefetch === 'function') {
        av.prefetch('/temp/' + String(audioPath || '').split(/[\\/]/).pop());
      }
    } catch (e) {}
    if (!isPlayingAudio) playNext();
  }

  /** 丢弃已排队的语音但保留本轮 id（用于撤回工具前的草稿语音） */
  function dropQueuedAudio() {
    audioQueue = [];
    playbackToken++;
    if (currentAudio) {
      currentAudio.onended = null;
      currentAudio.onerror = null;
      try { currentAudio.pause(); } catch (e) {}
      currentAudio = null;
    }
    isPlayingAudio = false;
    if (playbackHeartbeat) { clearInterval(playbackHeartbeat); playbackHeartbeat = null; }
    // ★ 数字人复位 ✓：不停的话它会按暂停时的 currentTime 一直画那帧 → 停在半张嘴 ✗
    try { window.DuixAvatar && window.DuixAvatar.reset && window.DuixAvatar.reset(); } catch (e) {}
    if (isConnected) ws.send(JSON.stringify({ type: 'playback', on: false }));
  }

  function stopPlayback() {
    bargeHeld = false;
    audioQueue = [];
    playbackToken++;
    if (currentAudio) {
      currentAudio.onended = null;
      currentAudio.onerror = null;
      currentAudio.pause();
      currentAudio = null;
    }
    isPlayingAudio = false;
    if (playbackHeartbeat) { clearInterval(playbackHeartbeat); playbackHeartbeat = null; }
    // ★ 数字人复位 ✓：打断/停播后别停在半张嘴的帧 ✗（否则按暂停时的 currentTime 一直画那帧 ✗）
    try { window.DuixAvatar && window.DuixAvatar.reset && window.DuixAvatar.reset(); } catch (e) {}
    if (isConnected) ws.send(JSON.stringify({ type: 'playback', on: false }));
  }

  function playNext() {
    if (bargeHeld) return;   // ★ 暂停期间不推进队列 ✓（resume_tts 时会再调 ✓）
    if (audioQueue.length === 0) {
      isPlayingAudio = false;
      if (playbackHeartbeat) { clearInterval(playbackHeartbeat); playbackHeartbeat = null; }
      if (isConnected) ws.send(JSON.stringify({ type: 'playback', on: false }));
      return;
    }
    if (!isPlayingAudio) {
      isPlayingAudio = true;
      // 只在"开始播放"这一刻上报 on:true，之后靠心跳续租约。
      // 每切换一个音频块都上报会触发服务端下发 playback 命令，反复清空采集队列。
      if (isConnected) ws.send(JSON.stringify({ type: 'playback', on: true }));
    }
    if (!playbackHeartbeat) {
      playbackHeartbeat = setInterval(() => {
        if (isConnected && isPlayingAudio) ws.send(JSON.stringify({ type: 'playback', on: true }));
      }, 600);   // 心跳 1000→600ms ✓：与服务端租约拉开倍数（见 server 的 lease ✓），后台标签页节流也顶得住 ✓
    }
    const token = playbackToken;
    const item = audioQueue.shift();
    currentAudio = new Audio(`/temp/${item.path.split(/[\\/]/).pop()}`);
    // ★ 回声抑制（不改任何能力 ✓ 只调播放电平 ✓）：
    //   外放音量越接近麦克风，Chrome 的 AEC 越难消掉 ✗ —— 实测回声会反过来触发"自己说自己听" ✗。
    //   默认降到 0.65 ✓（技能/打断/停词全部保留 ✓）；觉得小声可以调 PLAYBACK_VOLUME ✓
    currentAudio.volume = PLAYBACK_VOLUME;
    // ★ 数字人 ✓：口型按**内容**驱动 ✓（visemes 是服务端逐字拼音算好的 ✓ 见 viseme.js ✓）
    //   取用 window.VoiceAvatar ✓：avatar.js 是 ES 模块 ✓ 而本文件是传统脚本 ✗ 不能 import ✓
    //   ★ 模块还没到时**不缓存 null** ✓：否则这一次会话就永远不出数字人了 ✗
    //   ★ 出任何问题都只 warn ✓：语音链路一个字都不受影响 ✓（不降级 ✓）
    try {
      if (!window.DUIX_ONLY && !playNext.__avatar && window.VoiceAvatar) {
        // 优先复用 avatar.js 在页面加载时建好的那个 ✓（否则同一容器会被建两次 ✗ 白跑一套 AudioWorklet ✗）
        playNext.__avatar = window.VoiceAvatar.default
          || window.VoiceAvatar.create({ container: document.getElementById('avatarDock') });
      }
      if (!window.DUIX_ONLY && playNext.__avatar) playNext.__avatar.speak(currentAudio, item.visemes);
    } catch (e) { console.warn('[Avatar]', e && e.message); }
    // ★ 2D 数字人（DUIX + Wav2Lip）✓：拿到这段的帧就切过去 ✓ 没有就先用上一段的画面 ✓
    try { window.DuixAvatar && window.DuixAvatar.speak(currentAudio); } catch (e) {}
    const gap = gapFor(item.text);
    currentAudio.onended = () => {
      currentAudio = null;
      setTimeout(() => { if (isPlayingAudio && token === playbackToken) playNext(); }, gap);
    };
    currentAudio.onerror = () => {
      if (token !== playbackToken) return;   // 已被打断/换轮：这是旧元素的失败，别清掉正在播的那个
      currentAudio = null; playNext();
    };
    currentAudio.play().catch((err) => {
      if (token !== playbackToken) return;   // pause() 触发的中止（AbortError）在后续任务里到达，必须忽略
      currentAudio = null;
      // 自动播放策略拦截（无用户手势）：否则每块都被静默丢弃，用户完全听不到任何提示
      if (err && err.name === 'NotAllowedError' && !autoplayBlockedNotified) {
        autoplayBlockedNotified = true;
        addNotice('浏览器拦截了自动播放：请点一下页面任意处');
      }
      playNext();
    });
  }

  // ========== Event Handlers ==========
  micBtn.addEventListener('click', async () => {
    if (!isConnected) return;
    const wantListen = !isListening;

    if (captureMode === 'browser') {
      if (wantListen) {
        // 先告诉服务端进入聆听，再开采集：避免音频帧早于 listen 到达（否则帧会被丢弃）
        ws.send(JSON.stringify({ type: 'listen', source: 'browser' }));
        try {
          await startBrowserCapture();
        } catch (e) {
          console.error('[capture] 浏览器麦克风不可用:', e);
          stopBrowserCapture();
          addNotice(`浏览器麦克风不可用（${e.name || e.message}），改用服务器麦克风`);
          ws.send(JSON.stringify({ type: 'listen', source: 'server' }));
          return;
        }
      } else {
        stopBrowserCapture();
        ws.send(JSON.stringify({ type: 'stop_listen' }));
      }
      return;
    }

    ws.send(JSON.stringify({ type: isListening ? 'stop_listen' : 'listen' }));
  });

  sendBtn.addEventListener('click', sendText);
  textInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) sendText();   // ✓ 中文输入法候选确认的 Enter 不再误发送 ✓
  });

  function sendText() {
    const text = textInput.value.trim();
    if (!text || !isConnected) return;
    ws.send(JSON.stringify({ type: 'text', text }));
    textInput.value = '';
  }

  settingsBtn.addEventListener('click', () => {
    settingsPanel.classList.add('open');
    try { window.__reloadDuixPicker && window.__reloadDuixPicker(); } catch (e) {}
  });

  const newSessionBtn = document.getElementById('newSessionBtn');
  if (newSessionBtn) {
    newSessionBtn.addEventListener('click', () => {
      if (!isConnected) return;
      if (!confirm('开始新会话？当前对话记录会清空。')) return;
      ws.send(JSON.stringify({ type: 'clear_history' }));
    });
  }

  settingsPanel.addEventListener('click', (e) => {
    if (e.target === settingsPanel) settingsPanel.classList.remove('open');
  });

  // ===== 音色列表（引擎 → 音色 两级）+ 试听 =====
  let ttsEngines = {};        // { edge: {label, voices:[{id,label}]}, piper: {...} }
  let currentEngine = 'edge';
  async function loadVoices() {
    try {
      const d = await (await fetch('/api/voices')).json();
      ttsEngines = d.engines || {};

      // ★ 大模型预设切换 ✓（多套热切换 ✓ 不用重启 ✓）
      async function loadLLMPicker() {
        const sel = $('llmPick');
        if (!sel) return;
        try {
          const r = await (await fetch('/api/llm/presets')).json();
          const list = r.presets || [];
          sel.innerHTML = list.length
            ? list.map((p) => '<option value="' + p.id + '">' + p.name + ' · ' + p.model + '</option>').join('')
            : '<option value="">没有可用预设</option>';
          if (r.active) sel.value = r.active;
          sel.addEventListener('change', async () => {
            const id = sel.value;
            if (!id) return;
            try {
              const res = await fetch('/api/llm/switch', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id }),
              });
              const j = await res.json();
              if (j && j.ok) {
                const p = (j.presets || []).find((x) => x.id === j.active);
                try { addNotice('大模型已切到 ' + (p ? p.name : j.active)); } catch (e) {}
              }
            } catch (e) { console.warn('[LLMPick] 切换失败', e && e.message); }
          });
        } catch (e) { console.warn('[LLMPick] 预设列表加载失败（不影响语音）:', e && e.message); }
      }
      await loadLLMPicker();

      // ★ 数字人形象下拉框 ✓：选完**即时换脸** ✓（重建实例 ✓ 不刷新页面 ✓ 不丢聊天记录 ✓）
      //   ★ 整块包在 try 里 ✓：数字人出任何问题都绝不影响语音链路 ✓（不降级 ✓）
      async function loadAvatarPicker() {
        const sel = $('avatarPick');
        if (!sel) return;
        try {
          const r = await (await fetch('/api/avatars')).json();
          const list = r.avatars || [];
          let cur = '';
          try { cur = localStorage.getItem('voiceai.avatar') || ''; } catch (e) {}
          sel.innerHTML = list.length
            ? list.map((a) => '<option value="' + a.id + '">' + a.id + '（' + a.mb + ' MB）</option>').join('')
            : '<option value="">目录里没有可用的 .glb</option>';
          if (cur && list.some((a) => a.id === cur)) sel.value = cur;
          sel.addEventListener('change', () => {
            const id = sel.value;
            if (!id) return;
            try { localStorage.setItem('voiceai.avatar', id); } catch (e) {}
            const VA = window.VoiceAvatar;
            if (!VA || typeof VA.create !== 'function') return;
            const dock = $('avatarDock');
            try { if (VA.default && VA.default.destroy) VA.default.destroy(); } catch (e) {}
            VA.default = VA.create({ container: dock, name: id });   // 重建 ✓ 新脸立刻加载 ✓
          });
        } catch (e) { console.warn('[AvatarPick] 形象列表加载失败（不影响语音）:', e && e.message); }
      }
      await loadAvatarPicker();

      // ★ 2D 真人数字人（DUIX 素材包）✓ 切包 = 服务端换素材并重启渲染进程 ✓
      async function loadDuixPicker() {
        const sel = $('duixPick');
        if (!sel) return;
        try {
          const r = await (await fetch('/api/duix/packs')).json();
          if (!r.enabled) { sel.innerHTML = '<option value="">2D 数字人未启用</option>'; return; }
          // ★ 2D 真人可用 → **彻底不用 3D** ✓（用户要求：数字人去掉，用真人）
          window.DUIX_ONLY = true;
          try {
            const av = window.VoiceAvatar && window.VoiceAvatar.default;
            if (av && av.destroy) av.destroy();          // 拆掉 3D（省一块 GPU ✓）
            window.VoiceAvatar = null;
            const row = sel.closest('.setting-item') && sel.closest('.setting-item').previousElementSibling;
            const avPick = document.getElementById('avatarPick');
            if (avPick && avPick.closest('.setting-item')) avPick.closest('.setting-item').style.display = 'none';
          } catch (e) {}
          const list = r.packs || [];
          const cur = r.current || '';     // 只认服务端 ✓
          const ids = list.map((p) => (typeof p === 'string' ? p : p.id));
          sel.innerHTML = list.length
            ? list.map((p) => { const id = typeof p === 'string' ? p : p.id; const nm = p.name || id;
                                return '<option value="' + id + '">' + nm + '（' + id + '）</option>'; }).join('')
            : '<option value="">没有素材包</option>';
          if (ids.includes(cur)) sel.value = cur;
          // ✗✗ 千万别在这里自动同步：设置面板每打开一次就重跑本函数 ✓
          //   多个标签页各自存着不同的 localStorage → **互相把对方切回去** ✗
          //   实测：两个窗口来回切、数字人狂闪 ✗
          //   现在唯一真相是**服务端 conf.json** ✓ 前端只显示、只在用户主动选时发指令 ✓
          // ★ 必须用 onchange 赋值 ✗ 不能用 addEventListener：设置面板每次打开都会重跑这个函数 ✓
          //   addEventListener 会**叠加监听器** → 点一次换人等于连发 N 次 ✗
          //   实测：渲染进程每 1.1s 重载一次素材包 → 数字人卡住 ✗
          sel.onchange = () => {
            const p = sel.value;
            if (!p) return;
            try { localStorage.setItem('voiceai.duix', p); } catch (e) {}
            if (isConnected) ws.send(JSON.stringify({ type: 'duix_switch', pack: p }));
          };
        } catch (e) { console.warn('[DuixPick] 列表加载失败:', e && e.message); }
      }
      await loadDuixPicker();
      // 设置面板每次打开都刷新一次列表 ✓ 新下好的素材包不用刷新页面就能出现 ✓
      window.__reloadDuixPicker = loadDuixPicker;
      const esel = $('ttsEngine');
      const vsel = $('ttsVoice');
      if (!vsel) return;
      let want = (d.current && d.current.backend) || 'edge';
      let wantVoice = (d.current && d.current.voice) || '';
      try {
        const s = JSON.parse(localStorage.getItem('voiceai_settings') || '{}');
        if (s.engine) want = s.engine;
        if (s.voice) wantVoice = s.voice;
      } catch (e) {}
      if (!ttsEngines[want]) want = Object.keys(ttsEngines)[0] || 'edge';
      if (esel) {
        esel.innerHTML = Object.keys(ttsEngines)
          .map((k) => '<option value="' + k + '">' + (ttsEngines[k].label || k) + '</option>').join('');
        esel.value = want;
      }
      currentEngine = want;
      fillVoices(want, wantVoice);
    } catch (e) {
      addNotice('音色列表加载失败：' + (e.message || e));
    }
  }
  function fillVoices(engine, pick) {
    const vsel = $('ttsVoice');
    const eng = ttsEngines[engine];
    if (!vsel || !eng) return;
    vsel.innerHTML = (eng.voices || [])
      .map((v) => '<option value="' + v.id + '">' + (v.label || v.id) + '</option>').join('');
    if (pick) vsel.value = pick;
    // ★ 兜底 ✓：保存过的音色可能已被删除（例：aishell3 那 174 个"说话人"下线 ✗）
    //   此时 vsel.value=pick 赋值失败 → value='' ✗ → 上行 {voice:''} 被服务端 `if (!v) break` 忽略 ✗
    //   → 表现是"引擎切了音色没切 ✓、且 localStorage 存成空串 ✗"→ 回落到该引擎第一个音色 ✓
    if (!vsel.value && eng.voices && eng.voices.length) vsel.value = eng.voices[0].id;
  }
  loadVoices();

  const engSel = $('ttsEngine');
  if (engSel) engSel.addEventListener('change', () => {
    currentEngine = engSel.value;
    fillVoices(currentEngine);      // 换引擎 → 音色下拉换成该引擎的 ✓
  });

  // 试听：直接用当前音色合成一句（服务端走正常 TTS 通路 → 这里播放 ✓）
  const pvBtn = $('previewVoice');
  if (pvBtn) pvBtn.addEventListener('click', async () => {
    const voice = $('ttsVoice') ? $('ttsVoice').value : '';
    const engine = $('ttsEngine') ? $('ttsEngine').value : currentEngine;
    try {
      if (isConnected) ws.send(JSON.stringify({ type: 'set_voice', voice, engine }));
      await fetch('/api/preview');
      addNotice('正在用「' + (ttsEngines[engine] ? (ttsEngines[engine].label || engine) : engine) + '」试听…');
    } catch (e) {
      addNotice('试听失败：' + (e.message || e));
    }
  });

  $('saveSettings').addEventListener('click', () => {
    const voice = $('ttsVoice').value;
    const engine = $('ttsEngine') ? $('ttsEngine').value : currentEngine;
    const opts = getMicOptions();
    const source = $('captureSource') ? $('captureSource').value : captureMode;
    const speed = $('ttsSpeed') ? Number($('ttsSpeed').value) : 1;
    if (isConnected) ws.send(JSON.stringify({ type: 'set_voice', voice, engine }));
    if (isConnected && speed) ws.send(JSON.stringify({ type: 'set_speed', speed }));   // 语速热调 ✓（不用重启）
    localStorage.setItem('voiceai_settings', JSON.stringify({ voice, engine, speed, ...opts, source }));
    settingsPanel.classList.remove('open');

    const wasListening = isListening;
    const sourceChanged = source !== captureMode;
    captureMode = source;
    captureModeOverride = source;   // ✓ 一并更新：否则重连时 hello 里 `captureMode = captureModeOverride || msg.capture` 会静默回滚到旧选择 ✗✓
    // 采集参数改变需要重建采集链路，否则新设置不生效
    if (wasListening) {
      stopBrowserCapture();
      if (isConnected) ws.send(JSON.stringify({ type: 'stop_listen' }));
      isListening = false;
      setTimeout(async () => {
        if (captureMode === 'browser') {
          try { await startBrowserCapture(); } catch (e) { addNotice('浏览器麦克风不可用：' + (e.name || e.message)); }
        }
        if (isConnected) ws.send(JSON.stringify({ type: 'listen', source: captureMode }));
      }, 300);
      addNotice(sourceChanged
        ? `已切换到${captureMode === 'browser' ? '浏览器' : '服务器'}麦克风`
        : '麦克风设置已更新，正在重新开启聆听');
    }
  });

  // Load saved settings
  const saved = localStorage.getItem('voiceai_settings');
  if (saved) {
    try {
      const s = JSON.parse(saved);
      if (s.engine && $('ttsEngine')) {
        currentEngine = s.engine;
        $('ttsEngine').value = s.engine;
        fillVoices(s.engine, s.voice);     // 引擎+音色一起恢复 ✓
      } else if (s.voice) $('ttsVoice').value = s.voice;
      if (s.speed && $('ttsSpeed')) { $('ttsSpeed').value = String(s.speed); }
      if (typeof s.echo === 'boolean' && $('optEcho')) $('optEcho').checked = s.echo;
      if (typeof s.noise === 'boolean' && $('optNoise')) $('optNoise').checked = s.noise;
      if (typeof s.agc === 'boolean' && $('optAgc')) $('optAgc').checked = s.agc;
      // 采集来源：服务器端 hello 会给出默认值，本地保存的优先
      if (s.source === 'server' || s.source === 'browser') {
        captureModeOverride = s.source;
        if ($('captureSource')) $('captureSource').value = s.source;
      }
    } catch (e) {}
  }

  // ========== Init ==========
  // ========== 调试录音热开关 ✓（界面勾选框 ↔ worker ✓ 改一下即时生效 ✗ 不用重启）==========
  // 上行 {type:'record_audio',on} ✓ → 服务端转 worker {cmd:'set_record'} ✓（worker 回 record_ack ✓）
  // 初值由 hello 填 ✓ → 界面永远显示服务端真实状态 ✓（不是浏览器自己的记性 ✗）
  const optRecord = $('optRecord');
  if (optRecord) optRecord.addEventListener('change', () => {
    if (isConnected && ws) ws.send(JSON.stringify({ type: 'record_audio', on: optRecord.checked }));
  });
  // 麦克风设备：进页先刷一次（授权前 label 可能为空 ✓ 无妨）；插拔热刷新 ✓
  refreshMicDevices();
  const micSel = $('micDevice');
  if (micSel) micSel.addEventListener('change', async () => {
    lsSet('voiceai_mic_device', micSel.value);
    if (micStream) {
      stopBrowserCapture();
      if (isConnected && isListening) {
        try { await startBrowserCapture(); } catch (e) { addNotice(`切换麦克风失败: ${e.message || e}`); }
      }
    }
  });
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener)
    { try { navigator.mediaDevices.addEventListener('devicechange', refreshMicDevices); } catch (e) {} }
  connect();
})();
