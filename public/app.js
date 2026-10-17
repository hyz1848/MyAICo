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
        if ($('captureSource')) $('captureSource').value = captureMode;
        if (captureMode === 'browser') {
          updateInputHint('browser-mic');
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
        addMessage('user', msg.text);
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
        stopPlayback();
        break;

      case 'llm_stream':
        // 按 id 过滤：打断旧一轮时，旧流可能还有在途增量/收尾事件，不能污染新一轮气泡
        if (msg.id !== undefined && currentReplyId && msg.id !== currentReplyId) break;
        appendToStream(msg.content);
        break;

      case 'llm_done':
        if (msg.id !== undefined && currentReplyId && msg.id !== currentReplyId) break;
        finalizeStream();
        updateInputHint('normal');
        break;

      case 'llm_interrupted':
        if (msg.id !== undefined && currentReplyId && msg.id !== currentReplyId) break;   // 旧一轮的收尾，别动新一轮
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
        if (msg.id !== undefined && currentReplyId && msg.id !== currentReplyId) break;
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

      case 'tts_audio':
        if (msg.id !== undefined && currentReplyId && msg.id !== currentReplyId) break;
        // 服务端放音：音频已由 Python 端播给声卡了，浏览器只显示文字，别再放一遍（否则双重出声）
        if ((msg.played || playbackMode) === 'server') {
          noteServerPlayback(msg.text);
          break;
        }
        playAudio(msg.audioPath || msg.audio_path, msg.text);
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

  function addMessage(role, text, withCursor = role === 'assistant') {
    const msgEl = document.createElement('div');
    msgEl.className = `message ${role}`;

    const avatar = document.createElement('div');
    avatar.className = 'message-avatar';
    avatar.textContent = role === 'user' ? '👤' : role === 'notice' ? '⚙️' : '🤖';

    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';
    bubble.textContent = text;

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
      agc: $('optAgc') ? $('optAgc').checked : true,
    };
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
    // 这些处理开关在不同设备组合下效果差别很大：外放喇叭 + 普通麦时，
    // Chrome 的 AEC/降噪可能把人声也压掉（表现为"有声音但识别为空"），故做成可切换。
    const opts = getMicOptions();
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: opts.echo,
        noiseSuppression: opts.noise,
        autoGainControl: opts.agc,
        channelCount: 1,
      },
    });
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

  function playAudio(audioPath, text) {
    audioQueue.push({ path: audioPath, text: text || '' });
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
    if (isConnected) ws.send(JSON.stringify({ type: 'playback', on: false }));
  }

  function stopPlayback() {
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
    if (isConnected) ws.send(JSON.stringify({ type: 'playback', on: false }));
  }

  function playNext() {
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
      }, 1000);
    }
    const token = playbackToken;
    const item = audioQueue.shift();
    currentAudio = new Audio(`/temp/${item.path.split(/[\\/]/).pop()}`);
    const gap = gapFor(item.text);
    currentAudio.onended = () => {
      currentAudio = null;
      setTimeout(() => { if (isPlayingAudio && token === playbackToken) playNext(); }, gap);
    };
    currentAudio.onerror = () => { currentAudio = null; playNext(); };
    currentAudio.play().catch(() => { currentAudio = null; playNext(); });
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
    if (e.key === 'Enter') sendText();
  });

  function sendText() {
    const text = textInput.value.trim();
    if (!text || !isConnected) return;
    ws.send(JSON.stringify({ type: 'text', text }));
    textInput.value = '';
  }

  settingsBtn.addEventListener('click', () => {
    settingsPanel.classList.add('open');
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

  // ===== 音色列表（Kokoro 100 个 + edge）+ 试听 =====
  let voiceSamples = {};
  const isKokoroVoice = (v) => /^(z[fm]|a[fm]|b[fm])_/i.test(v || '');
  async function loadVoices() {
    try {
      const d = await (await fetch('/api/voices')).json();
      voiceSamples = d.samples || {};
      const sel = $('ttsVoice');
      if (!sel) return;
      const o = ['<optgroup label="Kokoro · 本地 · ' + (d.kokoro || []).length + ' 个音色">'];
      for (const v of d.kokoro || []) {
        o.push('<option value="' + v + '">' + v + (voiceSamples['kokoro:' + v] ? '' : '（无试听样本）') + '</option>');
      }
      o.push('</optgroup><optgroup label="edge-tts · 微软 · 需联网">');
      for (const v of d.edge || []) o.push('<option value="' + v + '">' + v + '</option>');
      o.push('</optgroup>');
      sel.innerHTML = o.join('');
      let want = (d.current && d.current.voice) || '';
      try {
        const s = JSON.parse(localStorage.getItem('voiceai_settings') || '{}');
        if (s.voice) want = s.voice;
      } catch (e) {}
      if (want) sel.value = want;
    } catch (e) {
      addNotice('音色列表加载失败：' + (e.message || e));
    }
  }
  loadVoices();

  const pvBtn = $('previewVoice');
  if (pvBtn) pvBtn.addEventListener('click', () => {
    const v = $('ttsVoice').value;
    const url = voiceSamples[(isKokoroVoice(v) ? 'kokoro:' : 'edge:') + v];
    if (!url) { addNotice('这个音色还没有试听样本（Kokoro 已预生成 100 个，edge 只有部分）'); return; }
    if (window._pvAudio) { try { window._pvAudio.pause(); } catch (e) {} }
    const a = new Audio(url);
    window._pvAudio = a;
    a.play().catch((err) => addNotice('试听播放失败：' + (err.message || err)));
  });

  $('saveSettings').addEventListener('click', () => {
    const voice = $('ttsVoice').value;
    const opts = getMicOptions();
    const source = $('captureSource') ? $('captureSource').value : captureMode;
    if (isConnected) ws.send(JSON.stringify({ type: 'set_voice', voice }));
    localStorage.setItem('voiceai_settings', JSON.stringify({ voice, ...opts, source }));
    settingsPanel.classList.remove('open');

    const wasListening = isListening;
    const sourceChanged = source !== captureMode;
    captureMode = source;
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
      if (s.voice) $('ttsVoice').value = s.voice;
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
  connect();
})();
