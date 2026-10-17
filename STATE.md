# VoiceAI 状态快照（2026-10-17 更新）

## ✅ 已完成：本地 TTS（默认 piper + DirectML，比 edge 快 ~10 倍）
本机 **AMD Radeon RX 9070 XT**（无 NVIDIA）走 **DirectML**，跑 Piper(VITS) int8：
**单句 120~220ms、RTF 0.02~0.05**（9.8s 音频 249ms），比 edge-tts 的 1.1~1.5s/句快一个数量级，且免网络。
可懂度与 edge 基本持平（多音字回读 1.00）。细节/验收数据见下文「TTS 后端」一节。

- 音素化是自己实现的**离线中文前端**（piper 官方前端要联网下 G2PW，本环境不通）：词典最长匹配解决多音字 ✓
- 三条后端互为兜底：**piper → edge → sherpa**（Kokoro 在 CPU 上 RTF 1.5，只作最后手段）
- ⚠️ 改 venv 的 onnxruntime 前**先停服务**（见下文坑位说明）
- 试听：`temp/piper_gpu_*.wav`（本地 GPU） vs `temp/piper_edge_*.mp3`

**注意**：模型下载很慢（网络波动 15~100KB/s），命令超时只会结束"等待"不会杀进程；查进度/续传命令见下。
```bash
cd H:/voiceai/models && ls -la *.tar.bz2          # 看字节数是否在涨
powershell -Command "Get-CimInstance Win32_Process -Filter \"Name='curl.exe'\" | Select ProcessId,CreationDate"
```
续传（Kokoro 支持 Range）：
```bash
cd H:/voiceai/models && curl -sL -C - -o kokoro-int8-multi-lang-v1_1.tar.bz2 \
  https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-int8-multi-lang-v1_1.tar.bz2
cd H:/voiceai/models && tar -xjf kokoro-int8-multi-lang-v1_1.tar.bz2
```
小模型（13.4MB，纯中文，用于先跑通链路；**注意 int8 只对 xiao_ya / chaowen 存在，huayan 没有 int8**）：
```bash
curl -sL -o piper-zh.tar.bz2 https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-piper-zh_CN-xiao_ya-medium-int8.tar.bz2
tar -xjf piper-zh.tar.bz2
```
镜像/代理均不通（hf-mirror 超时、ghproxy/gh-proxy/ghfast 0B/s、modelscope 404、无 aria2c）→ 只能 GitHub 直连。

## 代码管理（GitHub）
- 仓库：**https://github.com/hyz1848/MyAICo**（分支 `main`）
- 本地配置：`user.name/email = hyz1848 / hyz1840@163.com`；`credential.helper=manager`（凭据存 Windows 凭据管理器）
- 入库范围：源码/配置/测试/文档共 **58 文件 ~570K**；**排除** `venv/ models/ logs/ data/ temp/ node_modules/` 与 `config/tools.json`（含密钥，仓库里只放 `config/tools.example.json` 模板）
- ⚠️ 本机 **`github.com:443` 不可达**（`api.github.com` 正常）→ `git push` 会卡在连接超时。
  用 `push_via_github_api.js` 走 **REST API** 推送（`GH_TOKEN=<PAT> node push_via_github_api.js`）：
  它把本地 HEAD 的内容原样建成远端 tree/commit/ref，**用同一 tree 哈希校验内容逐字节一致**；
  空仓库阶段 GitHub 禁用 Git Data API（409 "Git Repository is empty"），脚本会先用 Contents API 造首个提交。
- 目前本地与远端的提交 SHA 不同源（本地无法 fetch 远端对象），但**内容完全一致**（tree 哈希相同已验证）。
  `github.com` 可达时一条命令对齐：`git fetch origin && git reset --mixed origin/main`
- 远端历史：`初始化仓库` → `VoiceAI 首版` → `增加 API 推送工具`

## 项目
个人 AI 语音助理，C/S 架构。浏览器纯显示（无框架原生 JS），Node 服务，Python worker 干语音重活。
目录 `H:/voiceai/`，端口 **8214**，启动 `node server.js`（自动拉起 worker）。

## 架构与数据流
```
浏览器(显示) ←WS→ server.js ←JSON行 stdin/stdout→ worker.py
                    │                                ├ sounddevice/浏览器 采集 + 流式VAD(能量+自适应静音窗)
                    ├ LLM 流式(pi-ai, OpenAI协议)     ├ funasr AutoModel(paraformer-zh + fsmn-vad) 独立线程
                    ├ TtsChunker 分句                └ TTS: 本地 sherpa-onnx(Kokoro/VITS) → 回退 edge-tts
                    ├ 有界 TTS 前瞻(背压=2)
                    ├ 唤醒门控(wake.js, 拼音匹配 潞潞同学) + 回声守卫 + 工具循环
```
**当前运行态**：服务 `node server.js --capture=browser`（pid 见启动日志），端口 8214；采集模式=浏览器麦克风（WebRTC AEC），另有 `server` 模式（Python sounddevice）可切。
环境：`H:/voiceai/venv`（torch 2.14.1+cpu, funasr 1.4.16, sounddevice, edge-tts 7.3.1, sherpa-onnx 1.13.8）。
LLM 默认 `http://192.168.3.166:1234`（`LLM_BASE_URL`/`LLM_MODEL` 可覆盖）；搜索用博查（`config/tools.json`）。

## 文件
| 文件 | 作用 |
|---|---|
| `server.js` | Express + WS + LLM 流式 + 分句 TTS 管线 + 停止词打断 + worker 自愈 + 会话管理 |
| `worker.py` | 录音 / 流式 VAD / ASR / TTS，单进程 JSON 行协议（每条命令回执 `ack`） |
| `agent/pi-client.js` | **pi-ai 适配层**（统一 LLM API：流式/abort/工具就绪），取代手写 fetch+SSE |
| `agent/test_pi_client.js` | 适配层 15 项不变式测试（流式/abort/多轮/错误/旧路径对比） |
| `tts-chunker.js` | **独立模块**：流式 token → 可朗读句块（去 Markdown/emoji、引号内不断句、标点归属） |
| `prompt.js` | **系统提示词**（口语化角色设定，`VOICEAI_SYSTEM_PROMPT` 可覆盖） |
| `AGENT_PLAN.md` | pi 集成基线设计与迁移阶段（阶段 1/2 已完成） |
| `start.cmd` | Windows 启动脚本，固定 Node 22（pi 要求 ≥22.19） |
| `data/conversation.json` | 会话落盘（`{summary, history}`），重启/刷新自动恢复 |
| `public/{index.html,style.css,app.js}` | 暗色 UI、气泡、打字机、通知样式、波形条、音色设置 |
| `test_chunker.js` | 92 个分句/清洗用例（`npm test`） |
| `test_stream.js` / `test_interrupt.js` / `test_backpressure.js` | 端到端：分句流式 / 停止词中断 / 背压 |
| `temp/` | wav/mp3，HTTP 挂 `/temp/`，15 分钟自动清理 |

## 回声（自问自答环）处理
问题：喇叭外放的 TTS 被自家麦克风听回去 → ASR 当成用户说话 → 自问自答。能量门限压不住（回声远高于噪声底）。

**三种采集模式**（`--capture=` / `VOICEAI_CAPTURE`，WSL 启动 Windows node 时环境变量不转发，用 CLI 参数）：

| 模式 | 启动 | 回声处理 |
|---|---|---|
| `server`（默认） | `npm start` | 内容级回声识别 + 播报期忽略 + 播报后 900ms 尾巴窗 + 提高 VAD 门限 |
| `browser` | `npm run start:browser` 或 `start.cmd browser` | **上面全部 + Chrome/Edge WebRTC AEC3**（采集与播放在同一音频引擎）|

浏览器模式链路：`getUserMedia({echoCancellation:true})` → AudioWorklet → 16k int16 帧（1280 样本/帧）→ WS 二进制 → server → worker（转 float32 入 VAD 队列）。VAD/ASR/TTS 全在 Python，未变。
失败兜底：浏览器麦克风不可用（无权限/非安全上下文）时自动回退服务器麦克风。
注意：远程设备（LAN IP over http）**无法**使用 `getUserMedia`（非安全上下文），需 HTTPS；本机 localhost 不受影响。

**内容级回声识别** `echo-guard.js`：记住最近 25s 播报内容，ASR 结果与播报文本高度重合即丢弃
（最长公共子串 ≥6 字，或 len≥2 且重合 ≥80%、绝对下限 4 字；单字不判回声以免误杀「停止」这类短指令）。
实测 32 用例通过；判据：真回声必拦、用户真语音不得误杀。

**AEC（为 C′ 版准备）** `aec.py` + `test_aec.py`：播放与采集都在 Python 时参考信号严格对齐，NLMS 自适应 + Geigel 型双讲检测 + 残留抑制。
离线合成验证：**ERLE 55.8dB**（20ms 延迟 + 衰减尾房间），双讲不伤近端，静音参考不发散，无参考时零失真。

## 操作纪律（踩过坑，务必遵守）
1. **禁止按名字/模式杀进程**：`pkill -f "server\.js"` 会误杀用户其它项目里所有 `node server.js`
   （实测用户的 `.\server.js` 被连带杀掉重启）；`Stop-Process -Name msedge -Force` 会关掉用户全部浏览器窗口（实测 67 个进程）。
2. 停/重启本服务：用 harness 的 `proc://<服务名>/kill`，或按 **PID** 杀（`taskkill /PID <pid> /F`）。
   启动时服务会打印 pid（`ready pid=…`），记下来用它。
3. 重启必须**分两步**：先杀，再单独启动。放在同一条命令里（`pkill … && node server.js`）会自杀（退出码 15/1）。
4. 测试期间用假麦克风/浏览器自动化时，**只操作自己打开的实例**，且**不要与其他测试并发**（会互相污染 LLM/麦克风状态）。
5. **自动化用完必须关掉自己起的浏览器实例**（`browser.close({kill:true})` 或按 PID 杀）。
   实测事故：我用 `--use-file-for-fake-audio-capture`（循环播放"别说了"的 wav）起了一个**可见**的 Edge 窗口，
   用户在那个窗口里测试 → 所有识别结果都是"别说了" → 完全不可用。自动化窗口绝不能留在用户桌面上。
6. **绝不删除/覆盖用户数据**：`data/reminders.json`、`data/conversation.json`、`config/tools.json` 都属用户数据。
   实测事故：我为跑测试执行 `rm data/reminders.json`，把用户待触发的提醒一起删了（表现为"设了提醒不响"）。
   测试要清理就按自己的唯一标签精确清理，或写到临时文件，**不得整文件删除**。
7. **测试不得与用户实时使用并发**：本地模型单并发，用户在用时应先停掉自己的测试任务（实测：用户的请求排队等待，看起来像"卡住"）。

## 工具（阶段 3）
架构：`tools/index.js` 注册表（`getToolDefs()` 给 LLM / `executeTool(name,args)` 本地执行）+ `agent/pi-client.js` 回传 toolCalls +
`server.js` 里的工具循环（最多 `VOICEAI_TOOL_MAX_ROUNDS`=3 轮，工具结果**只在本轮请求内回灌**，不进会话历史以免上下文被搜索结果撑爆）。

| 工具 | 说明 | 密钥 |
|---|---|---|
| `get_current_datetime` | 当前日期时间（可指定 IANA 时区） | 无 |
| `calculator` | 安全表达式求值（自研递归下降，**不用 eval**；白名单函数/常量、限长、限嵌套、拒注入） | 无 |
| `web_search` | 联网搜索（Tavily REST 代理） | `config/tools.json` 的 `search.apiKey`（或 `TAVILY_API_KEY`） |

关键设计：
- **当前时间直接注入系统提示词**：实测模型对"现在几点"经常不调工具而顺着历史编，注入才能保证永远准确（工具保留给其它时区）。
- 前端会收到 `tool_call` / `tool_result` 事件；搜索前会先播一句「让我搜一下」避免静默。
- 提示词要求：数字用口语读法、不要把 JSON/网址念出来。

测试：`npm run test:calc`（37 例，含注入/除零/嵌套攻击）、`test:tools`（工具层直调）、
`test:tools-e2e`（对话里真的调用并影响回答）、`test:tools-stability`（逐工具多轮统计调用率/正确率/延迟，含"不该调工具"反例）。

## KV 前缀缓存（重要，实测确认）
本地模型按**前缀匹配**复用 KV cache。**任何逐轮变化的内容都不能放在消息序列前部**。

实测（2022 token 提示词，同一段历史）：
| 条件 | 总耗时 | 缓存命中 |
|---|---|---|
| system 静态（第 1 次） | 2377ms | 0 |
| system 静态（第 2 次） | **531ms** | **2017/2022** |
| system 里带时间戳 | 2375ms | **0** ← 每轮全量重算 |
| 同一时间戳再问 | 588ms | 2049/2054 |
| 时间戳又变 | 2383ms | **0** |

所以：**`buildSystemMessage()` 必须逐轮稳定**，动态内容（当前时间、详细指令）一律拼到**本轮 user 消息**里（`dynamicContext()`）。
接入后真实服务连续两轮首字延迟：**3032ms → 993ms**。
唯一会让 system 变化的是历史摘要更新（压缩时）——罕见，可接受。

## TTS 后端（默认：piper + DirectML/AMD GPU，实测 RTF 0.02~0.05）
三条后端，互为兜底，**兜底顺序 piper → edge → sherpa**（按实测速度排；Kokoro 在 CPU 上是 1.5 的 RTF，只作最后手段）。
每个后端连续失败 `tts.failLimit`（默认 3）次后本进程内跳过，避免每句白等一次异常。

| 后端 | 实现 | 实测（本机） | 适用 |
|---|---|---|---|
| **`piper`（默认）** | 自研离线音素化 + onnxruntime **DirectML** 跑 Piper(VITS) int8 60MB | **单句 120~220ms，RTF 0.02~0.05**（9.8s 音频 249ms） | 日常：最快、免网络 |
| `edge` | edge-tts 网络合成 | 1.1~1.5s/句（网络固定开销） | piper 不可用时 |
| `sherpa` | sherpa-onnx + Kokoro int8（114MB，中英双语） | CPU RTF **1.5~1.6**（比实时慢） | 最后手段 |
| ~~DML+Kokoro~~ | — | 中英双语但要自研前端 | 未做 |

**电脑上的 GPU 事实**（决定实现路线）：
- 本机有 **AMD Radeon RX 9070 XT（15.9GB）**，但 **OCR 占了 ~14GB，只剩 ~2GB** → 必须用小模型（int8 60MB ✓）
- **没有 NVIDIA → CUDA 不可用**；onnxruntime 的 ROCm EP 只有 Linux；PyTorch 官方 Windows 轮子也只有 CPU/CUDA
  → 走 **DirectML**（`onnxruntime-directml` 1.24.4，`DmlExecutionProvider` ✓ 已装进 venv）
- （用户另有 torch 2.9.1+rocm7.2.1 在 `I:\DocOCR_engine\venv`，`cuda_available=True` 认到 9070 XT ✓，本方案用不到，但以后若换 torch 版 TTS 可用）
- ⚠️ **`piper-tts` 把 `onnxruntime`（CPU 版）声明为依赖** → 装它会覆盖 DML 版 ✗。修法：
  `pip install --force-reinstall --no-deps onnxruntime-directml`（**务必先停服务**，否则 numpy DLL 被占用会 WinError 5 半损）

**离线中文音素化（`tts_piper.py::ZhPhonemizer`）**：piper 官方中文前端要联网下 G2PW 多音字模型（HF，本环境不通）→ 自己实现：
- `lexicon.txt` 含 1~10 字词条且**读音已分上下文**（长期 cháng / 银行 háng / 生长 zhǎng）→ **最长匹配**即可正确念多音字（实测回读 1.00）
- 数字用 `unicode_rbnf`（与 piper 同源，"24.1"→二十四点一）；拉丁字母按中文读法（Node.js → 艾恩哦迪伊·杰艾丝）；标点映射到停顿 id
- 未登录字用 `pypinyin`（声母+韵母+声调）兜底

**验收（`venv/Scripts/python.exe test_tts_piper_gpu.py`）**：
| 场景 | piper-gpu 稳态 | RTF | 回读相似 | edge | edge 回读 |
|---|---|---|---|---|---|
| 中文 | **122ms** | 0.020 | 0.87 | 1275ms | 0.91 |
| 多音字 | 208ms | 0.049 | **1.00** | 1229ms | 1.00 |
| 中英混 | 213ms | 0.027 | 0.73 | 1465ms | 0.81 |
| 数字 | 213ms | 0.027 | 0.56 | 2719ms | 0.56 |

首次调用含模型加载+DML 编译约 2~4s → worker 启动时用"在呢"**预生成预热**（`prewarm_tts`）✓ 用户感知到的第一句也是 ~200ms。
切换：`conf.json` 的 `tts.backend`；`tts.provider`（auto/dml/cpu）；`tts.piperDir`；`tts.modelDir`（Kokoro）。
试听：`temp/piper_gpu_*.wav`（本地 GPU） vs `temp/piper_edge_*.mp3`（edge）。

## 唤醒词匹配的"静默唤醒"故障（2026-10-17 已修，日志实证）
**现象**：用户连喊多次"潞潞同学"，感觉"识别不利索"。

**日志证据**：ASR 其实听到了，但每次都换个写法 —— `陆露露同学` / `米露鲁同学` / `呃露露同学` / `露露露同学`（唤醒词前面多粘一个音）；
门控**确实匹配到了**（`[Wake] 唤醒并执行指令: "陆"`），但残留的那个碎音被当成"指令"→ 因过短被丢弃
→ **既不处理也不播"在呢"** → 用户喊了、系统醒了、一声不吭 ✗✗

**根因**：server 侧把"唤醒词+碎音"归入"带指令"分支（为省掉应答而设计），碎音又被过短过滤掉，于是没有任何反馈。

**修法**（`server.js::handleUserText`）：唤醒词后的残留若不算指令（`!isLongEnough`）且不是停止词 → 当**纯唤醒**处理并**播应答**。
停止词/结束语判断保持在前，所以"潞潞同学，别说了"仍能打断 ✓。

**回归测试**：`node test_wake_service.js`（隔离实例 + mock LLM + `debug.asrSim` 注入通道，11 项）
覆盖日志里出现过的全部变体 → 都必须"唤醒 + 应答"；带指令不播应答；待命中不误唤醒。

**顺带**：结束语新增 `睡吧/休息吧/待命/先这样吧`（原先只有 退下/再见/拜拜/…）。

**另一个日志发现（未修，属设备侧）**：末尾 6 次连续**空识别**（`rms=0.009~0.014`，正常说话 >0.1，我们的自动增益已开满 8×）
→ 浏览器采集到的电平太低，ASR 拿不到内容。建议：设置里关掉"降噪/自动增益"（保留回声消除）、或切"服务器麦克风"、
或调高 Windows 输入音量。

**新调试通道**：`conf.json` 的 `debug.asrSim=true` 时，可发 `{type:'asr_sim', text:'...'}` 注入一条"识别结果"，
走与真实 ASR 完全相同的下行处理（门控/停止词/回声判定都真实生效），便于复现这类问题。

## 唤醒延迟（实测 1043ms）
优化前后：`说完 → 听到应答` 由 **3~4 秒** 降到 **~1.2 秒**。

| 环节 | 优化 | 耗时 |
|---|---|---|
| VAD 句末判定 | 短句（<2.5s）静音窗 1200ms → **500ms**；长句仍 1200ms（避免换气被切断）；播报期 900ms | 533ms |
| ASR 识别 | RTF ≈0.16，独立线程不阻塞采集 | ~300ms |
| 应答合成 | **启动时预生成**「在呢」，之后直接播已合成文件（`prewarm_tts` / `tts_prewarmed`） | ~50ms |
| 带指令唤醒 | "潞潞同学，现在几点" **不播应答**，直接进 LLM 回答 | 省 ~1s |

测量：`node test_wake_latency.js`（按实时节奏喂音频，基准=语音说完那一刻；音频固件在 `testdata/`，不会被 temp 自动清理）。

## KV 前缀缓存（核心，实测确认）
本地模型按**前缀匹配**复用 KV cache，所以"实际发给模型的消息序列"必须**只追加、逐字节稳定**。

**踩过的三个坑（都会静默吃掉缓存）**：
| 坑 | 后果 | 修法 |
|---|---|---|
| system 里注入当前时间 | 每轮从第 0 个 token 就分叉 → 全量重算（2000token 2.4s vs 0.53s） | system 保持静态，动态内容移到消息尾部（`buildSystemMessage()` 必须逐轮稳定） |
| 动态上下文只注入当次、历史里存原文 | 从**第一条 user 消息**就分叉 → 实测只命中 system 那段 | 独立维护**线上序列 `wireMessages`**：只追加、逐字节稳定（显示历史 `history` 与它分离） |
| 工具轮把 `finalMessage`/`toolResult` 只放进当次请求 | 下一轮在工具调用处分叉 | 工具往返一并进 `wireMessages` |

**实测结果**（真实 LLM `qwen3.8-27b`，服务端回传 `usage.cacheRead`）：
```
[LLM] done, 12 chars (新 66tok / 出 9tok，缓存命中 2124/2190 ≈97%)
[LLM] done, 24 chars (新 94tok / 出 14tok，缓存命中 2286/2380 ≈96%)
[LLM] done, 13 chars (新 36tok / 出 9tok，缓存命中 2489/2525 ≈99%)
[LLM] done, 16 chars (新 66tok / 出 11tok，缓存命中 2534/2600 ≈97%)
```
连续两轮首字延迟 **3032ms → 993ms**。

### KV 缓存保温（`kvWarm` 配置）
服务端会置换掉不活跃会话的缓存 → 空闲达 `idleMs`（默认 60s）时，把**当前线上序列原样再发一次**（`max_tokens=1`，只要 prefill 不要输出）把缓存加热回来。
- 前提①：内容必须与下一次真实请求**逐字节同前缀**（同一个 `wireMessages` + 同一个 system + 同一套 tools）→ 已实测校验
- 前提②：只在真空闲时做（生成中/正在说话/正在播报都让路）
- 前提③：真实活动或上次加热后都顺延一个空闲窗口（不会每 tick 重复加热）
- **坑**：`lastUserActivity` 初值为 0 → 开机后永远被判"会话已凉"、从不保温（已修：启动即视为刚有活动）
- 会话超过 `keepMs`（默认 30min）无活动就不再保温，不白占 GPU

**实测**：`[KV] 缓存已加热 155ms（3 条消息 ~404 tokens）(新 9tok / 出 1tok，缓存命中 2320/2329 ≈100%)`
→ 60s 空闲后 LM Studio 仍保有缓存（保留期 ≥60s，故 60s 阈值合适），加热本身只花 ~150ms。

**A/B 独立验证**（`test_kv_warm.js`，自建模拟服务端含"前缀缓存+空闲置换"）：
| | 提示词字符 | 与缓存重合 | 重合率 |
|---|---|---|---|
| 保温开 | 1721 | 1595 | **92.7%** |
| 保温关 | 1721 | 0 | **0%** |

唯一会让前缀变化的是历史压缩（把老消息折进摘要）与服务重启（从历史重建）——罕见，可接受。

## 配置与日志
- **`conf.json`（唯一真相）**：端口/采集/LLM/TTS/ASR/VAD/唤醒/回声/打断/熔断/worker/工具/KV保温/日志，全在里面。
  优先级：**内置默认 < conf.json < 环境变量 < 命令行 `--set=KEY=VALUE`**（后两者是为了一次性实验，以及 WSL 启动 Windows node 时环境变量不转发的问题）。
  Node 侧 `config.js` 加载；**Python worker 读同一份文件**（启动日志会打印 `[conf] <路径> | ...`）。
- **日志**：`logger.js`（winston）。控制台保持 `[TAG] 消息` 原样式；文件 `logs/voiceai-YYYY-MM-DD.log`（`ISO时间 级别 [TAG] 消息`，10MB×5 轮转）。
  级别 `log.level`（debug 才打印音频帧统计），`log.file=false` 可关文件输出。
  `log` 的调用语义与 `console.log` 完全一致（内部用 `util.format`；不用 winston splat——它只在含占位符时才合并参数，会静默丢内容）。

## 唤醒词（潞潞同学）
唤醒名用**拼音匹配**（忽略声调）：`潞潞/璐璐/露露/路路/卢璐/鲁鲁/鹿鹿/陆陆/噜噜/lulu` 全部命中（都是 `lu+lu`）。
防误唤醒：名字必须在句首（可带 hey/嗨/嘿/喂/你好），或紧跟后缀（同学/小助手/在吗/你好）；句首后直接接话时必须是命令线索词（否则"陆陆续续…"会误唤醒）。
- 待命期：无关语音一律忽略（仅保留"播报中说停止"这一条，避免停不下来）；唤醒时应答「在呢」并把 `wake_state awake=true` 推给前端。
- 会话期：每轮有效输入刷新计时；打字输入也算活动（不打断用户会话）。
- 配置：`VOICEAI_WAKE=0` 关闭门控；`VOICEAI_IDLE_MS`（默认 25000）；`VOICEAI_WAKE_ACK`（默认"在呢"）；`VOICEAI_MIN_UTTERANCE_CHARS`（默认 4）；`VOICEAI_BARGE_IN_MIN_CHARS`（默认 5）。
- UI：待命时提示「待命中 · 说「潞潞同学」唤醒」，回到待命时提示「已回到待命…」。

测试：`npm run test:wake`（43 例：谐音/带指令/误唤醒反例/状态机/超时）、`test_wake_e2e.js`（真实音频喂入：未唤醒忽略→唤醒应答→唤醒后回复→空闲回待命）。

| `conf.json` | **统一配置**（唯一真相，Node 与 Python worker 共用；下面表格的开关都从这里读） |
| `config.js` | 配置加载器：内置默认 < conf.json < 环境变量 < `--set=` |
| `logger.js` | 日志（winston）：控制台 `[TAG] 消息` + 文件 `logs/voiceai-*.log` |
| `wake.js` | 唤醒门控（拼音匹配「潞潞同学」、结束语、空闲超时、最短指令长度） |
| `tts_local.py` | 本地 TTS（sherpa-onnx；Kokoro/VITS 自动判别） |
| `tts_piper.py` | **本地 TTS（Piper + DirectML GPU）**：自研离线中文音素化（词典最长匹配/数字/字母）+ onnxruntime 会话（provider 可选 dml/cpu） |
| `tools/index.js` + `tools/{calc,datetime,units,search,reminders}.js` | 工具注册表与实现（计算器/日期/单位/搜索/提醒） |
| `echo-guard.js` | 内容级回声识别（防自问自答） |
| `config/tools.json` | 工具密钥（博查搜索 key） |
| `models/` | sherpa-onnx TTS 模型（下载中） |
| `testdata/` | 测试音频固件（不会被 temp 自动清理） |

## 已知待办 / 环境问题
- **麦克风电平**：用户侧浏览器采集的语音峰值仅 0.02~0.04（正常 >0.1），导致 ASR 常返回空 → 已加识别前自动增益（上限 8×）+ 界面电平提示，但物理上录不到人声救不回。建议：设置里切「服务器麦克风」，或关掉「降噪/自动增益」；检查 Windows 输入音量与设备选择。
- **内存**：64GB 总量只剩 ~10GB 可用（模型 + 用户 5 个 pm2 服务）；继续加载模型可能触发换页。
- **搜索额度**：旧的 Tavily 代理额度用尽，已切博查（key 在 `config/tools.json`）。
- **本地 TTS / GPU**：Piper 走 DirectML；`piper-tts` 会依赖 `onnxruntime`(CPU) 覆盖 DML 版，重装需 `--force-reinstall --no-deps` 且先停服务。GPU 显存只剩 ~2GB（OCR 占大头）→ 只用小模型。
- `edge-tts` 依赖网络，偶发挂起 → 已有 15s 超时 + 重试 + 本地优先回退。

## 关键机制

## LLM 调用可靠性审查（2026-10-17，已修）
逐行审了 `agent/pi-client.js` + `server.js` 的调用/异常路径，修掉这些**会静默坏掉**的问题：

| # | 问题 | 后果 | 修法 |
|---|---|---|---|
| 1 | **生成中再来一句会起第二轮 LLM**（barge-in 只判了 `playbackActiveNow()`，没判 `activeLLM`） | 旧 controller 引用被覆盖 → 停止词也管不住它；两个 id 来回清 `ttsBuffers`；界面文字交错 | `handleUserText` 里 `playbackActiveNow() \|\| activeLLM` 都先 `interrupt()` 再处理新输入 |
| 2 | 被打断/被取代的流仍会广播在途增量 | 旧文字插进新一轮气泡与语音 | `onDelta` 里判 `controller.signal.aborted \|\| activeLLM.id !== id` 直接丢弃；`llm_stream` 带 id |
| 3 | `llm_interrupted` 广播**不带 id** | 旧一轮的收尾事件会把新一轮气泡结算掉 | 补上 `id`；app.js 对 `llm_stream/done/interrupted/retract` 全部按 id 过滤 |
| 4 | LLM 服务端卡死（TCP 连着不出数据）**无限等待** | 语音助手永久挂住（无 TTS、无回复） | pi-client 加**空闲看门狗**：首包 90s、之后 30s 无数据即中止；报成 `error` 且文案明确（不是 `aborted`，覆盖驱动层 "Request aborted"）。`VOICEAI_LLM_FIRST_MS`/`VOICEAI_LLM_IDLE_MS` 可调 |
| 5 | `stream.result()` 可能不落地 | 卡住整条对话 | 加 5s 兜底 race |
| 6 | 工具调用只以事件流为准（最终消息可能更全） | 漏掉调用 → "有调用没结果" → 下一轮被判非法消息序列 | 最终消息带工具调用时以它为权威 |
| 7 | 空文本失败无重试 | 服务端忙/瞬断 → 用户直接听到报错 | 一个字都没吐就失败时静默重试 1 次（吐过字不重试，避免重复播报） |
| 8 | worker stdin **无 error 监听** + 写入无保护 | worker 恰好死亡时 EPIPE → 未捕获异常 → **整个服务崩掉** | `proc.stdin.on('error')` + `processWorkerQueue` 判 `writable` 并 try/catch |
| 9 | worker 重启后 `audioPending` 不复位 | 在飞帧永远等不到回执 → 上限占满 → **麦克风永久丢帧** | close / restartWorker 里归零 |
| 10 | WebSocket 无 `error` 监听 | 浏览器异常断开 → socket 错误 → 未捕获异常崩服务 | `ws.on('error')` 兜住并清理 |
| 11 | 工具无超时 | 工具卡住连累整轮对话 | `executeTool` 统一 30s 超时（`VOICEAI_TOOL_TIMEOUT_MS`） |
| 12 | 无进程级兜底 | 任何漏网异步异常 = 服务静默死亡 | `unhandledRejection`/`uncaughtException` 记日志 + 前端提示，**保持运行**（常驻设备取向：带着异常活着好过静默死掉） |

**新增测试**：`node test_llm_robustness.js`（看门狗 + 并发生成串行化 + 事件 id 归属，13 项）、
`node test_payload.js`（**真实请求体**核对：system 逐轮一致 / 消息无 timestamp / 逐条前缀一致 / 思维链开关已注入，9 项）。
`agent/pi-client.js` 新增 `onPayload` 审计钩子（看到**最终**请求体，含思维链开关）。

写这类测试的坑：`replySeq`（回复 id）**不随 `clear_history` 复位**，测试不能写死 `id===1/2`，要按"第一次/第二次 llm_start"动态取；
另外测试的 `text` 消息会 **broadcast 到用户正在使用的浏览器**（共享会话），跑测试时用户界面会看到测试内容。

## 测试命令
| 命令 | 内容 |
|---|---|
| `npm test` | 分句/清洗 92 例 |
| `npm run test:echo` | 回声识别 32 例 |
| `npm run test:wake` | 唤醒门控 72 例（谐音/带指令/误唤醒反例/超时/结束语） |
| `npm run test:calc` / `test:tools` | 计算器 37 例 / 工具层直调 |
| `node test_wake_latency.js` | 唤醒延迟量化（实测 1043ms） |
| `node test_kvcache.js` | KV 前缀缓存实验（静态 system vs 带时间戳） |
| `python test_tts_backends.py` | 本地 vs 网络 TTS 对比（延迟/RTF/ASR 回读） |
| `node agent/test_pi_client.js` | pi 适配层 15 项 |
| `npm run test:all` | 端到端一套（分句/agent/流式/打断/打断后续/会话/背压） |
| `python test_aec.py` | AEC 离线验证（ERLE 55.8dB） |
| `node test_wake_service.js` | 唤醒的服务端端到端回归（真实 ASR 变体 + 注入通道，11 项） |
| `node test_llm_robustness.js` | LLM 看门狗/并发生成/id 归属（13 项，`--no-ws` 可跳过需服务的部分） |
| `node test_payload.js` | 真实请求体核对（KV 前缀稳定性/思维链开关，9 项） |
| `node test_kv_warm.js` | **KV 保温算法 A/B**（自建模拟服务端，16 项，不需要真实 LLM） |
| `node test_kv_prefix.js` | 真实服务上的消息布局审计：逐轮只追加 + 缓存命中率（需 `--set=VOICEAI_LLM_DUMP=...` 启动服务） |
| `python test_tts_piper_gpu.py` | **GPU TTS 验收**：piper-gpu vs edge 的延迟/RTF/ASR 回读 + 试听文件 |
| `python test_tts_backends.py` | Kokoro(sherpa) vs edge 对比（含中英混/英文） |

## 关键机制
- **运行时**：服务由 **Windows Node v22.21.1** 运行（`platform=win32`，`start.cmd` 固定路径）。
  pi 各包 engines 要求 Node ≥22.19；此前用 supervisor 默认 PATH 会落到 WSL 的 Linux node v18，已纠正。
- **LLM 调用**：`agent/pi-client.js`（pi-ai 的 `createProvider` + `openAICompletionsApi` + `models.stream`）。
  - 本地模型 `qwen3.8-27b` 是推理模型，默认把 `max_tokens` 耗在 `reasoning_content` 上（文本为空、首包 2s+）；
    适配层用 `onPayload` 注入 `chat_template_kwargs:{enable_thinking:false}` → **首包 ~325ms**（`VOICEAI_THINKING=1` 可恢复思考）。
  - message.content 必须归一化为内容块数组；keyless 端点也要给占位 key（否则 `No API key for provider`）。
- **worker 回执**：worker 对每条命令 `finally` 回 `{type:'ack'}`。否则静默命令（`clear`）会让 server 的
  `workerBusy` 闩锁永久卡住 → 打断后再也不出声（已修 + `test_after_interrupt.js` 回归）。
- **停止词打断**（中英）：`别说了/停止/闭嘴/停下/暂停/够了/退出` + `stop/shut up/quiet/enough/pause/quit/exit/cancel`。
  触发 → `AbortController.abort()` 掐断 LLM 流 + `ttsBuffers.clear()` + worker `clear` + 广播 `stop_tts`。
  浏览器：清空播放队列 + 当前音频 pause + `currentReplyId=-1`（在途旧音频全部丢弃）。
  - **停止词永远是停止指令**（即使空闲也不进 LLM）：否则空闲时"别说了"会变成提问（"好呀，不说了"），
    配合持续识别的回声就是死循环。
  - **播报期短句快闭**：回声会让电平居高不下，若等常规静音窗，句子永不闭合 → 用户的"别说了"
    被裹进超长句丢弃（这就是"打断不了"的根因之一）。播报期改为 600ms 静音窗、最长 4s，照常识别再按内容过滤。
- **播放状态三层收口**（另一个"打断不了"的根因）：
  浏览器原先每切一个音频块就发 `playback on:true`，worker 收到就 `drain_blocks()` 清空采集队列 →
  音频帧被反复清空、VAD 收不到完整语音。现在：浏览器只在开始播放时报 on:true（心跳 1s）、
  服务端按状态变化去重下发、worker 只在状态翻转时清队列，另加 800ms OFF 防抖。
  同时服务端用 **TTS 音频真实时长**推算"正在出声"窗口（不依赖浏览器心跳）。
- **回声自问自答熔断**：连续 3 次识别结果与上一轮回答重合度 ≥0.5 → 停止聆听 + 提示（再点麦克风可继续）；
  被判定为回声/播报期杂音/熔断的识别结果**不回显**，避免用户看到自己的回声上屏。
- **系统提示词 + 按请求注入的详细指令**：`prompt.js` 定义「先判断闲聊/详细」的长度策略（闲聊 ≤60 字；
  出现 详细/展开/介绍/为什么/原理/写一篇… 走详细模式，≥300 字）。
  光靠 system 提示词**压不住**小模型的简短惯性（实测只回 36~52 字），故 `detailDirective()` 还会把
  硬性要求同时注入**本轮 system 与本轮 user 消息**（模型对最近输入最敏感），会话历史仍存原始文本不被污染。
  实测：闲聊 12~28 字、详细 566~1064 字（`npm run test:prompt` 7/7）。
- **流式分句 TTS**：LLM token → `TtsChunker.push()` → 句边界（。！？；\n / 英文 . ? !）成块 → 清洗 → 送 TTS。
  长句 48 字在逗号处切；引号内不断句；`3.14`、`e.g.` 不误切。
- **有界前瞻（背压）**：LLM >50 tok/s 远快于播放，只提前合成 `TTS_LOOKAHEAD=2` 句，其余在 server 排队；
  worker 合成完一句才放下一句。实测长回答生成完毕时仅 2 段预合成。
- **块间停顿**：由句末标点决定（。260ms / ！？380ms / ；160ms / 逗号120ms / 硬切90ms），
  标点随文本送给 edge-tts（实测末尾 F0：句号 114Hz 下沉、问号 279Hz 上扬）。
- **会话管理**：`history` 全量累积发给 LLM；`historyTokens()` 估算（CJK≈1 token/字，其他≈1/3.5 字符）；
  超过 `CTX_COMPRESS_AT`(默认160k，窗口 256k) 时用 LLM 把较老消息摘要进 `summary`，只保留最近 12 条；
  每轮落盘 `data/conversation.json`；新连接自动下发 `history` 恢复界面；`clear_history` 开新会话。
- **worker 自愈**：有活干却 45s 无输出 → 判定卡死，kill + 重启（广播 notice）；进程意外退出也会自动重启。
- **播放租约**：browser 每 400ms 心跳，TTL 1500ms，断线自动过期。
- **UI 锚定**：流式文本锚定在 `llm_start` 创建的气泡（`streamEl`），通知/错误不再抢占或吞掉流式文本。
- **系统提示词**：定位「小助手」人类对话伙伴，口语化、1~2 句短答、禁 Markdown/emoji/括号旁白、数字口语化。

## WS 协议
C→S：`listen` | `stop_listen` | `playback{on}` | `set_voice{voice}` | `text{text}`
S→C：`vad_state` | `audio_level` | `asr_result{text}` | `user_text` | `llm_start{id}` | `llm_stream{content}` |
`llm_done{fullText,id}` | `llm_interrupted` | `tts_audio{audio_path,text,id}` | `stop_tts` | `notice{text}` | `error`
Worker cmd：`listen | stop_listen | playback{on} | clear | tts{text,voice,id} | ping`

## 已验证（本轮）
- `npm test` → 92/92 通过（分句、Markdown、代码块、emoji、数字、引号、增量不丢字）
- `npm run test:agent` → 15/15 通过（pi 适配层：多次增量、首包早于完成、abort 保留部分文本、多轮记忆、错误不抛穿、与旧 fetch 路径一致）
- `npm run test:all` → 全套（chunker + agent + stream + interrupt + after-interrupt + session + backpressure）
- pi 迁移：`sendToLLM` 与历史摘要均已切到 `agent/pi-client.js`；关闭思维链后首包 ~325ms
- 打断后管线可用性回归：`test_after_interrupt.js`（曾因 worker `clear` 静默导致永久不见声）
- 流式分句：556 字回答首段音频 6.2s 到、生成 10.2s 结束 → **播音提前 4.1s 开始**
- 背压：700 字长回答生成结束时仅合成 4/15 句（有界前瞻，未整篇预合成）
- 停止词：生成中断（中断后 0 新 token）+ 播放停止（无新音频、文本冻结）
- 浏览器实测：文本流式渲染、音频播放、发「别说了」→ 播放停 + 生成停 + 光标清除
- 多轮记忆：「我叫小明，做语音识别」→ 下一轮正确答出；`clear_history` 后不再记得
- 会话持久化：重启后 `[History] loaded 4 messages, ~337 tokens`；刷新页面自动恢复气泡
- 历史压缩：`compressing 4 messages → summary 44 chars, kept 4`，摘要落盘
- 标点语调实测：末尾 F0 句号 114Hz / 感叹 231Hz / 问号 279Hz
- worker 自愈：实测 `RESTART: no worker output for 47s with pending work` 后自动恢复
- TTS 超时：0.5s 超时下 1.4s 内报错且 worker 存活（不再永久卡死）

## 环境变量
`PORT` · `LLM_BASE_URL` · `LLM_MODEL`(qwen3.8-27b) · `LLM_API_KEY` · `VOICEAI_SYSTEM_PROMPT` ·
`VOICEAI_THINKING`(=1 恢复模型思维链，默认关闭) · `VOICEAI_CTX_LIMIT`(256000) ·
`VOICEAI_CTX_COMPRESS_AT`(160000) · `VOICEAI_CTX_KEEP_RECENT`(12) · `VOICEAI_TTS_TIMEOUT`(15) · `VOICEAI_TTS_RETRIES`(2)

## 已知限制
- edge-tts 依赖网络，可能挂起 → 已加 15s 超时 + 2 次重试（`VOICEAI_TTS_TIMEOUT`/`VOICEAI_TTS_RETRIES`）
- 无 AEC：喇叭外放时靠播放中提高 VAD 门限 + 0.5s 宽限
- 语音说的英文停止词 ASR 可能变谐音汉字（文字输入 100% 可靠）
- scipy 在 venv 里坏（仅 librosa 受影响，funasr 走 torchaudio 后端）

## 环境备忘
- **服务与工具链的 node 不同**：服务由 supervisor 用 Linux node（`/usr/bin/node`）跑，路径形如 `/mnt/h/...`；
  bash 工具里是 Windows node（win32，`H:/...`）。所以 python 路径用 `resolvePython()` 双候选探测。
- 重启服务：先 `pkill -f "server\.js"`（单独一条命令，避免自杀），再单独启动。
- 浏览器自动化测试时用 stub 替换 `window.Audio`（headless 无用户手势，autoplay 会被拒）。
