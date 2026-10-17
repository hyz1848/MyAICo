# pi 集成基线设计（VoiceAI）

> 目标：把「自己手写 LLM 调用」换成 pi 的 agent 能力基线，为后续 tool / MCP 留好接口；
> 分阶段独立实现 + 测试通过后再替换，不影响正在跑的语音链路。

## 1. 事实（已核实，非猜测）

| 项 | 结论 | 依据 |
|---|---|---|
| 运行时 | **Node ≥ 22.19.0**，同时支持 Bun；**不是 Bun-only** | 三个包 `npm view … engines` 均为 `>=22.19.0`；官方 SDK 文档写「embeds Pi in a Node.js or Bun process」 |
| 模块形态 | 全部 `"type": "module"`（ESM） | `npm view … type` |
| 当前版本 | `pi-ai` / `pi-agent-core` / `pi-coding-agent` 均为 **1.3.0** | npm view |
| 本机运行时 | Windows node **v22.21.1**（已固定进 `start.cmd`）、Bun 1.3.14（备选） | 环境探测 |
| 本地模型 | LM Studio OpenAI 兼容端点（`LLM_BASE_URL`），pi 明确支持「Any OpenAI-compatible API」 | pi-ai README |

分层与取舍：

| 包 | 提供 | 我们的用法 |
|---|---|---|
| `@earendil-works/pi-ai` | 统一多 provider LLM API（流式事件、工具定义/调用、abort、token/成本） | **阶段 1 就用**：替换裸 fetch/SSE 解析 |
| `@earendil-works/pi-agent-core` | agent 循环 + 工具执行 + 状态管理 | 阶段 3：真正开始加工具时 |
| `@earendil-works/pi-coding-agent` | CLI + SDK：session/compaction/extensions/**MCP**/skills | 阶段 4：要 MCP、要官方会话压缩时 |

## 2. 关键决策

### 2.1 进程内集成，不跨进程

- **理由**：Node 22 已满足 pi，进程内省掉 IPC 序列化/生命周期/握手/超时一整套复杂度；语音链路里真正的隔离需求在 Python worker（那里继续用子进程）。
- **CRLF/编码/路径的坑**：这一轮已经踩过（Linux node vs Windows node、`/mnt/h` vs `H:/`），进程内 + 固定 Windows node 直接消灭该类问题。
- **备选（保留）**：若将来必须回到 Node 18 或需要故障隔离，把同一适配模块搬进独立进程、走 JSON-lines（协议与 `worker.py` 完全同构），**上层接口不变**。

### 2.2 ESM 调用方式

`server.js` 是 CJS，pi 是 ESM → 在适配模块内用 `await import()` 动态加载（Node 22 的 `require(esm)` 不依赖）。

### 2.3 安全边界

语音助手不该拥有 coding agent 的默认工具（bash/文件读写）。阶段 1 只用 `pi-ai`（纯 LLM 调用，无工具）；阶段 3/4 引入工具时显式白名单，禁止内置 bash/文件工具，MCP server 走白名单。

## 3. 接口契约

现有契约（`server.js: sendToLLM`）：广播 `llm_start/llm_stream/llm_done/llm_interrupted` + 分句喂 TTS + `AbortController` 中断 + 会话历史。

适配层 `agent/pi-client.js`：

```js
const { createPiClient } = require('./agent/pi-client');
const client = await createPiClient({ baseUrl, modelId, apiKey });   // 惰性、可复用
const { text, stopReason, errorMessage, usage } = await client.chat({
  systemPrompt,          // 含历史摘要
  messages,              // [{ role:'user'|'assistant', content, timestamp }]
  signal,                // AbortSignal（沿用 server 现有的 controller）
  onDelta(delta) {},     // 增量文本 → 喂给 TtsChunker
});
```

不变式（测试必须覆盖）：
1. `onDelta` 是**增量**的（不是一次性给全量）；
2. `signal.abort()` 后 `stopReason === 'aborted'` 且 `text` 保留已收到的部分；
3. 多轮 `messages` 生效（能记住前文）；
4. 出错不抛穿调用方（`stopReason === 'error'` + `errorMessage`）。

## 4. 迁移阶段

| 阶段 | 内容 | 状态 |
|---|---|---|
| 1 | `agent/pi-client.js` + `agent/test_pi_client.js`，直连本地 LM Studio | ✅ **完成**：15/15 通过（流式增量 29 deltas、首包 <5s、abort 902ms 保留部分文本、多轮记忆、错误不抛穿、与旧 fetch 路径一致） |
| 2 | `server.js` 的 `sendToLLM` + `summarizeInto` 改用 pi-client，保留 `TtsChunker`/背压/打断/会话管理 | ✅ **完成**：`test_stream`（11 段、首段早于生成结束 3.7s）、`test_interrupt`、`test_after_interrupt`、`test_session`、`test_backpressure` 全绿 |
| 3 | 工具：`customTools`（如 `get_time` 设闹钟）、工具调用期间播报「让我查一下」而不是朗读参数 | ⏳ 待做 |
| 4 | MCP / 长期记忆：`createMcpExtension()` 或直接 `@modelcontextprotocol/sdk`；历史+压缩交给 pi `SessionManager` | ⏳ 待做 |

### 实施中确认的关键事实（阶段 1 实测）

1. **pi 要求 message.content 是内容块数组**：传裸字符串会内部 `flatMap is not a function` → 适配层统一归一化为 `[{type:'text',text}]`。
2. **keyless 端点也要给 key**：`getClientApiKey()` 在无 key 且无 authorization 头时直接抛 `No API key for provider` → 传占位 key。
3. **本地模型是 `qwen3.8-27b`（推理模型）**：默认会输出 `reasoning_content`，把 `max_tokens` 预算吃光 → 文本为空、`stopReason='length'`、首包 2s+。用 `onPayload` 注入 `chat_template_kwargs:{enable_thinking:false}` 后：**首包 325ms、零思考 token**。
4. pi 的 `stopReason` 取值：`stop` / `length` / `aborted` / `error`（配合 `errorMessage`）；abort 不会抛，走 `error` 事件 + 最终消息。

### 阶段 2 顺带修掉的严重 bug（与本迁移无关但被测试暴露）

- **worker `clear` 造成 TTS 永久静默**：worker 对合法命令如 `clear` 不发任何输出 → server 端 `workerBusy` 闩锁（等待任意 worker 输出来释放）永久卡住 → 之后所有 `tts` 命令只排队、永不写入 worker 进程。表现就是"打断之后再也不出声"。
  修法：worker 主循环 `finally` 对**每条命令回执** `{type:'ack'}`（server 端不向前端广播），并新增回归测试 `test_after_interrupt.js`。

## 5. 风险与对策

| 风险 | 对策 |
|---|---|
| LM Studio 不理解 `developer` 角色 / `reasoning_effort` | model `compat: { supportsDeveloperRole:false, supportsReasoningEffort:false }`（pi 文档针对 Ollama/vLLM 类服务器的建议） |
| pi 依赖树大（pi-ai 87 包；coding-agent 更大） | 阶段 1 只装 pi-ai；coding-agent 推迟到阶段 4，且 `noTools` + 自定义 `ResourceLoader` |
| 版本漂移 | 锁 exact 版本（1.3.0），升级走单独一次变更 |
| pi 的 `session` 与我们现有 `data/conversation.json` 双份历史 | 阶段 4 一次性切换，禁止双写 |
| 服务运行时跑偏（曾经的 Linux node v18） | `package.json engines` + `start.cmd` 固定 node 路径 |
