'use strict';
/**
 * agent/pi-client.js — 基于 @earendil-works/pi-ai 的 LLM 适配层
 *
 * 取代此前手写的 fetch + SSE 解析：统一多 provider、自带工具调用与 abort 语义。
 * 对外契约与旧实现保持一致，便于 server.js 平滑替换：
 *
 *   const client = await createPiClient({ baseUrl, modelId });
 *   const { text, stopReason, errorMessage, usage } = await client.chat({
 *     systemPrompt, messages, signal, onDelta,
 *   });
 *
 * 不变式：
 *  - onDelta 为增量回调（不是一次给全量）
 *  - signal.abort() 后 stopReason === 'aborted'，text 保留已收到部分
 *  - 出错不抛穿调用方：stopReason === 'error' + errorMessage
 *
 * pi 是 ESM，本模块是 CJS，故用动态 import 惰性加载。
 */

const DEFAULT_BASE_URL = process.env.LLM_BASE_URL || 'http://192.168.3.166:1234';
const DEFAULT_MODEL_ID = process.env.LLM_MODEL || 'qwen3.8-27b';
const CTX_WINDOW = parseInt(process.env.VOICEAI_CTX_LIMIT || '256000', 10);
// 流式响应看门狗：首包（模型加载/大提示词 prefill）给宽一些，之后按"多久没数据"判定
const FIRST_EVENT_TIMEOUT_MS = parseInt(process.env.VOICEAI_LLM_FIRST_MS || '90000', 10);
const IDLE_TIMEOUT_MS = parseInt(process.env.VOICEAI_LLM_IDLE_MS || '30000', 10);

let piModulesPromise = null;
function loadPiModules() {
  if (!piModulesPromise) {
    piModulesPromise = Promise.all([
      import('@earendil-works/pi-ai'),
      import('@earendil-works/pi-ai/api/openai-completions.lazy'),
    ]).then(([pi, api]) => ({ pi, api }));
  }
  return piModulesPromise;
}

function normalizeBaseUrl(url) {
  const trimmed = String(url || DEFAULT_BASE_URL).replace(/\/+$/, '');
  return /\/v1$/i.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

/** pi 的 message.content 必须是内容块数组；裸字符串会让内部 flatMap 抛错 */
function toContentBlocks(content) {
  if (Array.isArray(content)) return content;
  return [{ type: 'text', text: String(content ?? '') }];
}

/**
 * 创建 pi 客户端（指向本地 OpenAI 兼容端点）
 * @param {{baseUrl?:string, modelId?:string, apiKey?:string, providerId?:string, maxTokens?:number}} opts
 */
async function createPiClient(opts = {}) {
  const { pi, api } = await loadPiModules();

  const providerId = opts.providerId || 'local';
  const baseUrl = normalizeBaseUrl(opts.baseUrl);
  const modelId = opts.modelId || DEFAULT_MODEL_ID;
  // 本地 OpenAI 兼容端点通常不校验 key，但 pi 的 getClientApiKey() 要求存在 key
  // （或 authorization 头），否则直接抛 "No API key for provider"。故给占位值。
  const apiKey = opts.apiKey || process.env.LLM_API_KEY || 'local';
  // 语音助手默认关闭思维链（可用 VOICEAI_THINKING=1 打开）
  const disableThinking = opts.disableThinking !== undefined
    ? !!opts.disableThinking
    : process.env.VOICEAI_THINKING !== '1';

  const contextWindow = Number(opts.contextWindow) > 0 ? Math.floor(opts.contextWindow) : CTX_WINDOW;
  const model = {
    id: modelId,
    name: modelId,
    api: 'openai-completions',
    provider: providerId,
    baseUrl,
    reasoning: false,
    input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: opts.maxTokens || 2048,
    // 本地 OpenAI 兼容服务器（LM Studio/vLLM/Ollama 类）通常不认 developer 角色与 reasoning_effort
    compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
  };

  const provider = pi.createProvider({
    id: providerId,
    name: 'Local LLM',
    baseUrl,
    auth: {
      apiKey: {
        name: 'Local',
        resolve: async () => ({ auth: { apiKey } }),
      },
    },
    models: [model],
    api: api.openAICompletionsApi(),
  });

  const models = pi.createModels();
  models.setProvider(provider);
  const handle = models.getModel(providerId, modelId);
  if (!handle) throw new Error(`pi: 模型未注册: ${providerId}/${modelId}`);

  /**
   * 流式对话
   * @param {{systemPrompt?:string, messages:Array, signal?:AbortSignal, onDelta?:Function, tools?:Array}} args
   * @returns {Promise<{text:string, stopReason:string, errorMessage:string|null, usage:object|null}>}
   */
  async function chat(args) {
    const { systemPrompt, messages, signal, onDelta, tools, maxTokens } = args || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new Error('pi-client.chat: messages 不能为空');
    }

    const context = {
      systemPrompt: systemPrompt || undefined,
      messages: messages.map((m) => {
        const out = {
          role: m.role,
          content: toContentBlocks(m.content),
          timestamp: m.timestamp || Date.now(),
        };
        // 工具结果消息需要保留这些字段，pi 才能把结果关联回对应调用
        if (m.toolCallId) out.toolCallId = m.toolCallId;
        if (m.toolName) out.toolName = m.toolName;
        if (m.isError !== undefined) out.isError = !!m.isError;
        return out;
      }),
      ...(tools && tools.length ? { tools } : {}),
    };

    const streamOptions = { apiKey };
    // 自己接管 AbortController：把调用方的 signal 中继进来，同时保留本地看门狗的能力
    const abort = new AbortController();
    const relay = () => abort.abort();
    if (signal) {
      if (signal.aborted) abort.abort();
      else signal.addEventListener('abort', relay, { once: true });
    }
    streamOptions.signal = abort.signal;

    // 真正发出去的请求体（审计/测试用：可核验 max_tokens、思维链开关、前缀是否稳定）
    let sentPayload = null;

    // 调试/审计钩子：可以看到发给模型的真实请求体（用于核对 KV 前缀稳定性等）。
    // 先应用思维链开关再交给钩子，保证钩子看到的就是最终内容。
    const userOnPayload = opts.onPayload;
    const capTokens = Number(maxTokens) > 0 ? Number(maxTokens) : 0;   // 保温等场景：只要 prefill
    // 语音场景不需要思维链：实测 Qwen3 默认会把 max_tokens 预算耗在 reasoning_content 上
    // （文本为空、首包 2s+），关掉后首包 ~325ms。用 onPayload 注入 LM Studio/vLLM 支持的开关。
    if (userOnPayload || disableThinking || capTokens) {
      streamOptions.onPayload = (payload) => {
        let p = payload;
        if (capTokens && p && typeof p === 'object') {
          p = { ...p, max_tokens: capTokens };
        }
        if (disableThinking && p && typeof p === 'object') {
          p = { ...p, chat_template_kwargs: { ...(p.chat_template_kwargs || {}), enable_thinking: false } };
        }
        if (userOnPayload) { const r = userOnPayload(p); if (r) p = r; }
        sentPayload = p;
        return p;
      };
    } else {
      // 没有任何钩子时也要能审计：至少记录 pi 传进来的原始载荷
      streamOptions.onPayload = (payload) => { sentPayload = payload; return undefined; };
    }

    // 空闲看门狗：LLM 服务端卡死（TCP 连着但不出数据）时，语音助手不能被永久挂住。
    // 首包给更长时间（模型可能正在加载/大提示词 prefill），之后按空闲时间判定。
    const idleMs = Math.max(0, Number(opts.idleTimeoutMs ?? IDLE_TIMEOUT_MS) || 0);
    const firstMs = Math.max(idleMs, Number(opts.firstEventTimeoutMs ?? FIRST_EVENT_TIMEOUT_MS) || 0);
    let watchdogFired = false;
    let watchdog = null;
    const arm = (ms) => {
      if (!ms) return;
      clearTimeout(watchdog);
      watchdog = setTimeout(() => { watchdogFired = true; abort.abort(); }, ms);
      watchdog.unref?.();
    };

    const stream = models.stream(handle, context, streamOptions);

    let text = '';
    let stopReason = null;
    let errorMessage = null;
    let usage = null;
    const toolCalls = [];

    arm(firstMs);
    try {
      for await (const event of stream) {
        arm(idleMs);
        switch (event.type) {
          case 'text_delta':
            text += event.delta;
            if (onDelta) onDelta(event.delta);
            break;
          case 'toolcall_end':
            if (event.toolCall) toolCalls.push(event.toolCall);
            break;
          case 'error':
            stopReason = event.reason || 'error';
            errorMessage = event.error?.errorMessage || String(event.reason || 'error');
            break;
          case 'done':
            stopReason = event.reason || stopReason;
            break;
          default:
            break;
        }
      }
    } catch (e) {
      // pi 声明请求失败不抛，但网络/驱动层异常仍需兜住
      stopReason = signal?.aborted ? 'aborted' : 'error';
      errorMessage = watchdogFired
        ? `LLM 无响应（${Math.round((text ? idleMs : firstMs) / 1000)}s 内无数据），已中止本轮`
        : (e?.message || String(e));
    } finally {
      clearTimeout(watchdog);
      if (signal) signal.removeEventListener('abort', relay);
    }

    let final = null;
    try {
      // 单独的兜底超时：迭代已结束但 result() 不落地（驱动层 bug）时不能卡住整条对话
      final = await Promise.race([
        stream.result(),
        new Promise((_, rej) => {
          const t = setTimeout(() => rej(new Error('stream.result() 超时')), 5000);
          t.unref?.();
        }),
      ]);
    } catch (e) {
      if (!errorMessage) errorMessage = e?.message || String(e);
    }
    if (final) {
      stopReason = final.stopReason || stopReason;
      if (final.errorMessage) errorMessage = final.errorMessage;
      usage = final.usage || null;
      // 以最终消息为权威文本（事件流与最终消息不一致时以最终为准）
      const authoritative = (final.content || [])
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('');
      if (authoritative && authoritative !== text) text = authoritative;
      // 工具调用以最终消息为权威：事件流可能漏报（漏了会导致"工具调用没有结果"，
      // 下一轮请求会被服务端判为非法消息序列）。仅有在最终消息确实带调用时才覆盖事件流结果。
      const fromFinal = (final.content || []).filter((b) => b.type === 'toolCall');
      if (fromFinal.length) {
        toolCalls.length = 0;
        toolCalls.push(...fromFinal);
      }
    }

    if (watchdogFired) {
      // 看门狗中止 ≠ 用户打断：必须报成错误，且用我们的说明覆盖驱动层的通用文案（"Request aborted"）
      stopReason = 'error';
      errorMessage = `LLM 无响应（${Math.round((text ? idleMs : firstMs) / 1000)}s 内无数据），已中止本轮`;
    }
    if (!stopReason) stopReason = 'stop';
    if (stopReason === 'aborted' && !errorMessage) errorMessage = 'aborted';
    return { text, stopReason, errorMessage, usage, toolCalls, finalMessage: final, timedOut: watchdogFired, payload: sentPayload };
  }

  /**
   * 非流式补全（历史摘要等场景）
   * @param {{systemPrompt?:string, messages:Array, signal?:AbortSignal}} args
   */
  async function complete(args) {
    const { systemPrompt, messages, signal } = args || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new Error('pi-client.complete: messages 不能为空');
    }
    const context = {
      systemPrompt: systemPrompt || undefined,
      messages: messages.map((m) => ({
        role: m.role,
        content: toContentBlocks(m.content),
        timestamp: m.timestamp || Date.now(),
      })),
    };
    const options = { apiKey };
    if (signal) options.signal = signal;
    const message = await models.complete(handle, context, options);
    const text = (message.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join('');
    return {
      text,
      stopReason: message.stopReason || 'stop',
      errorMessage: message.errorMessage || null,
      usage: message.usage || null,
    };
  }

  return { chat, complete, model, models, handle };
}

module.exports = { createPiClient, normalizeBaseUrl };
