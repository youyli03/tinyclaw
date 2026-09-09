# Agent 循环详细流程

> 描述一条消息从进入 tinyclaw 到最终回复的完整生命周期，
> 包括历史记录管理、JSONL 持久化、向量记忆检索、token 超限压缩、
> 工具执行、MFA 审批与并发消息处理。

---

## 一、Session 与历史记录

每个消息来源拥有独立的 `Session` 实例，由 `main.ts` 用 `Map<sessionId, Session>` 维护，进程不重启则一直存活。

**SessionId 格式**

```
qqbot:c2c:<openid>       QQ 私聊
qqbot:group:<openid>     QQ 群
qqbot:guild:<channelId>  QQ 频道
cli:<uuid>               CLI tinyclaw chat
```

`Session` 内部维护一个 `messages: ChatMessage[]` 数组。**除压缩外，消息只追加、不原地改写**——任何对历史前缀的修改都会让服务端 KV cache 从该位置起失效。每次调用 `runAgent()` 都将完整的 `messages[]` 发给 LLM。

**典型 messages 结构（多轮后）**

```
[0] system   ← 冻结的 system prompt（本 session 内逐字节稳定）
[1] system   ← "<!-- memory:## 相关历史记忆 -->"（QMD 检索结果，可能没有）
[2] system   ← "<!-- skill-reminder -->"（可用技能列表，可能没有）
[3] user     ← 第一轮用户输入
[4] assistant ← LLM 中间回复（有工具调用时）
[5] system   ← [tool_result:exec_shell] 工具执行结果
[6] assistant ← 最终回复
[7] system   ← 下一轮：新的记忆注入（内容变化时才追加）
[8] user     ← 第二轮用户输入
[9] assistant ← 第二轮最终回复
...          ← 继续 append
```

**前缀稳定性（KV cache 友好）**

请求前缀逐字节不变时，服务端 KV cache 才能复用；`messages[0]` 位置最靠前，原地重写等于全量 cache miss。三条规则：

| 内容 | 策略 |
|---|---|
| system prompt | session 内**冻结**：`applySystemPrompt()` 内容相同则完全不动；变化时**追加**一条 `<!-- system-prompt-update -->` 消息（`[上下文更新] …`），不回写 `messages[0]` |
| 记忆注入 / skill reminder | `appendMemoryContext()` / `appendSkillReminder()` **只追加**；与最近一条同类注入逐字节相同则跳过 |
| 压缩 | **唯一**允许重写前缀的时机：`_foldPreambleInjections()` 把 system prompt 更新折叠回 `messages[0]`，并把同类注入收敛为最新一条 |
| 异常工具链修复 | `sanitizeMessages()` **优先补全**：末尾缺 tool result → 追加占位结果（仅追加，前缀不变）；只有位于历史中间的不完整链才删除（会破坏前缀缓存并打 warning） |

> 代价是尾部累积带来的 token 增长，由压缩回收；收益是两次压缩之间的所有请求都命中同一前缀。

**如何验证**：每次 run 结束的日志尾部与 `/status` 都会显示 `cache N%`（= 命中 token / 本轮输入 token），
`agent:end` 事件的 `stats.cacheHitRate` 同样带该值。前缀稳定时该比例应显著高于优化前。

**Session 持久化（JSONL 崩溃恢复）**

每个 session 对应一个 JSONL 文件：

```
~/.tinyclaw/sessions/<sanitized-sessionId>.jsonl
```

- 构造函数启动时检查 JSONL 是否存在，若存在则读取并重建 `messages[]`（进程崩溃恢复）
- 每轮对话结束后，`appendLastTurnToJsonl()` 异步追加最后一对 user/assistant（fire-and-forget）：
  ```jsonl
  {"role":"user","content":"...","ts":"2026-03-15T12:34:56.789Z"}
  {"role":"assistant","content":"...","ts":"2026-03-15T12:34:57.123Z"}
  ```
- 压缩触发后，`rewriteJsonl()` 整体覆盖写入，只保留 system messages + 摘要（丢弃原始对话行）

**Session 并发控制字段**

| 字段 | 类型 | 说明 |
|---|---|---|
| `running` | `boolean` | 当前是否有 `runAgent()` 正在执行 |
| `abortRequested` | `boolean` | 软中断标记，新消息到达时设为 `true` |
| `llmAbortController` | `AbortController\|null` | 持有当前 LLM HTTP 请求的 abort 控制器 |
| `currentRunPromise` | `Promise\|null` | 当前 run 的 Promise，供新消息等待其结束 |
| `mfaApprovedForThisRun` | `boolean` | run 级 MFA 授权，同一 run 内只验证一次 |
| `pendingApproval` | `PendingApproval\|null` | Interface A MFA：等待用户文字确认的 Promise 控制柄 |

---

## 二、消息入口与并发处理（main.ts）

```
新消息到达 handleMessage(msg)
│
├─ 检查 session.pendingApproval（当前是否有 MFA 等待用户确认）
│    pendingApproval != null
│    ├─ msg.content == "确认" → resolve(true)，connector.send("已收到，执行中...")
│    └─ 其他内容             → resolve(false)（视为取消）
│    handleMessage() 返回 ""，不启动新 run
│
├─ 检查 session.running（是否有 runAgent() 正在执行）
│    running == true → 触发软中断：
│      session.abortRequested = true
│      session.llmAbortController.abort()（取消 LLM HTTP 请求）
│      session.abortPendingApproval()（清理 MFA 等待）
│      await session.currentRunPromise（等待工具执行完毕后 run 自然退出）
│
└─ 启动新 run（fire-and-forget）
     session.running = true
     构建 opts（onMFARequest / onMFAPrompt 回调）
     runPromise = runAgent(session, msg.content, opts)
     session.currentRunPromise = runPromise
     │
     runPromise.then  → connector.send(result.content)（主动推送回复）
     runPromise.catch → connector.send("抱歉，处理消息时出现错误")
     runPromise.finally → session.running = false, currentRunPromise = null
     │
     handleMessage() 立即返回 ""（connector 不重复发送）
```

---

## 三、单次 runAgent() 执行步骤

```
runAgent(session, userContent, opts)
│
├─ 前置：重置并发/MFA 状态
│    session.abortRequested = false
│    session.mfaApprovedForThisRun = false
│    llmAc = new AbortController()
│    session.llmAbortController = llmAc
│
├─ 步骤 1：初始化 system prompt（每个 session 只做一次）
│    messages 中无任何永久 system message（包括 JSONL 恢复会话）→
│      prependSystemMessage()（插入 index 0，保证始终在历史消息前）：
│        BUILTIN_SYSTEM（写死，不可覆盖，含高危操作须先告知用户的指令）
│        + ~/.tinyclaw/agents/<id>/SYSTEM.md（Agent 系统提示，可选）
│    messages 已有永久 system → 跳过（JSONL 恢复后无需重复注入）
│    注：文本模式（textMode）时，同时将工具列表与 <tool_call> 格式规则追加进 system prompt
│         textMode = !client.supportsToolCalls（由后端 supportsToolCalls 标志决定）
│         supportsToolCalls 来源:Copilot 后端从模型元数据自动推断;
│         其它 provider(openai/openrouter/deepseek/mimo)默认 true,
│         可在 config.toml [llm.backends.*] 用 supportsToolCalls = false 手动声明弱模型,
│         强制走 textMode(让不支持 function calling 的模型也能用工具)。
│
├─ 步骤 2：QMD 向量记忆检索
│    searchMemory(userContent)
│    ├─ memory.enabled = false → 返回 ""，跳过
│    └─ memory.enabled = true
│         RKLLM NPU HTTP embed（1024 dim）对 userContent 向量化
│         在 index.sqlite 中检索 top-5，minScore=0.3
│         有结果 → 追加 system message "## 相关历史记忆\n[score%] 标题\n内容..."
│         无结果 → 跳过
│
├─ 步骤 3：追加用户消息
│    messages.push({ role:"user", content: userContent })
│
├─ 步骤 4：ReAct 工具循环（轮次上限由 tools.maxChatToolRounds 配置，默认 0=无限制）
│    textMode == false（supportsToolCalls=true，默认）：
│      LLM chat(messages, tools=[...])，LLM 用 tool_calls JSON 字段响应
│    textMode == true（supportsToolCalls=false，不支持 function calling 的模型）：
│      不传 tools 参数，LLM 用 <tool_call>{"name":"...","args":{...}}</tool_call> 文本响应
│      parseResponse() 正则提取所有 <tool_call> 块作为 tool_calls，剩余文本为 content
│
│    ┌── LLM chat(messages, [tools], signal=llmAc.signal)
│    │    ├─ AbortError → break（被软中断取消）
│    │    └─ 其他错误  → throw
│    │
│    ├─ 情形 A：LLM 直接回复（无 tool_calls）
│    │    messages.push({ role:"assistant", content: 回复 })
│    │    finalContent = 回复，break 退出循环
│    │
│    └─ 情形 B：LLM 返回 tool_calls
│         messages.push({ role:"assistant", content: 思考过程或空串 })
│         │
│         对 tool_calls 中每个 call：
│           │
│           ├─ [软中断检测] abortRequested == true
│           │    → 注入合成结果：[tool_result:name] 操作被中断，未执行
│           │    → continue（跳过后续工具）
│           │
│           ├─ 工具未找到 → [tool_result:name] 未知工具，continue
│           │
│           ├─ MFA 检查（见第五节）
│           │    toolNeedsMFA(name, args, cfg) == true
│           │    && session.mfaApprovedForThisRun == false
│           │    → 进行 MFA 验证（接口 A 或 B）
│           │    ├─ 通过 → session.mfaApprovedForThisRun = true，继续执行
│           │    ├─ 拒绝 → [tool_result:name] 操作被取消：用户拒绝，continue
│           │    └─ 超时/异常 → [tool_result:name] 操作被取消：MFA 未通过，continue
│           │
│           └─ 执行工具
│                result = await executeTool(name, args)
│                messages.push([tool_result:name]\n{result})
│                [再次检测 abortRequested] → break（工具可能运行数秒）
│         │
│         [批次结束后检测 abortRequested] → break，退出轮次循环
│         │
│         [round == maxToolRounds-1] → 强制 LLM 生成总结回复，break
│
├─ 步骤 5a：JSONL 持久化（异步 fire-and-forget，不阻塞）
│    finalContent != "" → session.appendLastTurnToJsonl()
│      从 messages 末尾反向查找最后一条 assistant message
│      再从该 assistant 向前找最近的 user message（不要求相邻）
│      （工具调用轮次会插入 system:tool_result，不能直接找相邻 user→assistant 对）
│
└─ 步骤 5b：maybeCompress()（仅未被中断时执行）
     abortRequested == false → 见第四节
```

---

## 四、Token 超限时的自动压缩

每次 `runAgent()` 正常结束后，`session.maybeCompress()` 检查当前上下文体积：

### 阈值计算

```
estimatedTokens = sum(所有 message.content.length) / 3.5
contextWindow   = llmRegistry.getContextWindow("daily")  // 从 Copilot 模型元数据读取
threshold       = contextWindow × memory.tokenThreshold  // 默认 0.8
```

### 未超过阈值

什么都不做，messages 继续 append，下轮正常使用。

### 超过阈值 → summarizeAndCompress()

```
第一步：用 summarizer LLM 生成摘要
  取所有非 system 消息，拼成纯文本
  发给 llm.backends.summarizer（独立后端，可配置轻量模型）
  生成 ≤400 token 的中文摘要，保留：
    - 用户关键需求、偏好、结论
    - 已完成操作及结果
    - 未解决的待办事项

第二步：persistSummary(summaryText)
  将摘要追加到 ~/.tinyclaw/memory/YYYY-MM-DD.md
  异步触发 QMD updateMemoryIndex()（建立/更新向量索引，不阻塞）

第三步：替换 session.messages[]
  保留永久 system messages：冻结的 system prompt、skill reminder、
  带 <!-- memory: --> 标记的记忆注入（旧格式以 "##" 开头且无标记的临时注入被丢弃）
  → _foldPreambleInjections() 收敛：system prompt 更新折叠回 messages[0]，
    同类记忆 / skill 注入各只保留最新一条
  新 messages = [
    永久 system messages（含折叠后的最新 system prompt）,
    { role:"assistant", content:"[对话历史摘要]\n摘要内容..." }
  ]
  更早的 user / assistant / tool_result 消息全部丢弃

第四步：rewriteJsonl()
  整体覆盖写入 JSONL，只保留 system messages + 摘要
```

> **注**：相比旧版，不再有 `persistLastTurn()`，也不再每轮写入磁盘。
> 唯一写入 QMD 的时机是压缩触发，避免高频 I/O。

---

## 五、MFA 权限审批流程

### 高危工具黑名单（`config.toml` 配置）

```toml
[auth.mfa]
interface = "simple"          # "simple"（Interface A）或 "msal"（Interface B）
tools = ["delete_file", "write_file"]          # 整工具触发 MFA
timeoutSecs = 60

[auth.mfa.exec_shell_patterns]
patterns = ["rm", "sudo", "chmod", "chown", "dd", "mv"]  # 命令级黑名单（word-boundary 匹配）
```

`toolNeedsMFA(name, args, cfg)` 判断逻辑（`auth/guard.ts`）：
- `name` 在 `cfg.tools[]` 中 → 触发
- `name == "exec_shell"` 且命令含黑名单词 → 触发（`\bword\b` 正则匹配）
- 其余 → 不触发（直接执行）

### Run 级授权

同一次 `runAgent()` 调用内，MFA 一旦通过，`session.mfaApprovedForThisRun = true`，
后续所有高危工具调用直接跳过验证。每次 `runAgent()` 开始时重置为 `false`。

### Interface A — 文字确认（`simple` 模式）

```
agent.ts 命中 MFA 检查
│
└─ opts.onMFARequest("⚠️ 即将执行：exec_shell: rm -rf /tmp/x\n请回复 确认 / 取消")
     main.ts：connector.send(warningMsg)  ← 主动推送警告到 QQ
     return session.waitForApproval(timeoutSecs)
     runAgent() 挂起，等待 Promise
│
用户回复"确认"（由下一条消息触发 handleMessage）
  handleMessage() 检测 session.pendingApproval != null
  → resolve(true)
  → connector.send("已收到，执行中...")
  → handleMessage() 返回 ""
│
runAgent() 恢复
  mfaPassed = true → session.mfaApprovedForThisRun = true
  执行工具，得到结果
  → connector.send(最终回复)（run 结束后由 fire-and-forget 推送）

用户回复非"确认"任意内容
  → resolve(false) → mfaPassed = false
  → [tool_result:xxx] 操作被取消：用户拒绝了 MFA 确认

超时（timeoutSecs 到期）
  → reject(Error) → catch 分支
  → [tool_result:xxx] 操作被取消：MFA 未通过
  → opts.onMFAPrompt("⏱ MFA 超时，操作已取消") 通知用户
```

### Interface B — MSAL Authenticator 推送（`msal` 模式）

```
首次配置：tinyclaw auth mfa
  → Device Code Flow（用户打开 microsoft.com/devicelogin 输入设备码）
  → 获取 refresh token，持久化到 ~/.tinyclaw/auth/msal-cache.json

每次触发 MFA：
  requireMFA(displayFn) 被调用
  ├─ 有缓存 token → 静默刷新，无感通过
  └─ 无缓存 → Device Code Flow
       displayFn("🔐 需要 MFA 验证\n打开 ... 输入 XXXXX")
       Microsoft Authenticator 推送 number-matching 通知
       用户在手机输入 2 位数字匹配码
       ├─ 确认 → token 写入缓存，opts.onMFAPrompt("✓ MFA 已通过，继续执行")
       ├─ 拒绝 → throw MFAError  → 操作取消
       └─ 超时 → throw MFAError  → 操作取消
```

---

## 六、并发消息处理（软中断）

### 触发条件

新消息到达时 `session.running == true`，说明上一个 `runAgent()` 尚未结束。

### 软中断流程

```
第一步：标记
  session.abortRequested = true

第二步：abort LLM HTTP 请求（若正在等待 LLM 响应）
  session.llmAbortController.abort()
  → LLM fetch 抛出 AbortError，runAgent() 退出循环

第三步：清理 pending MFA（若正在等待用户确认）
  session.abortPendingApproval()
  → pendingApproval reject → runAgent() 工具处理 catch 分支执行 continue

第四步：等待工具执行完成（若正在执行工具如 exec_shell）
  await session.currentRunPromise
  → 工具本身不被强杀（side effect 已发生，必须记录结果）
  → 工具执行完毕后，写入 [tool_result:name]\nresult
  → check abortRequested → 跳过后续工具，注入合成结果，退出循环

第五步：messages[] 状态说明（不回滚）
  已执行工具的 tool_result 完整保留在 messages[] 中
  被跳过的工具注入 "操作被中断" 合成结果
  agent 重启后感知完整历史，不与 side effect 失去同步
```

### 两种打断位置对比

| 打断发生在 | abortRequested 效果 | 等待时间 |
|---|---|---|
| LLM fetch pending 期间 | `abort()` 立即取消 HTTP | 毫秒级 |
| 工具执行期间（如 sleep 5） | 等工具执行完，拿结果后退出 | 最长工具耗时 |

---

## 七、向量记忆(QMD)详细说明

### Embed 架构

tinyclaw 支持两种 embed 后端（`config.toml` `[memory]` 节切换）：

| 后端 | 配置 | 维度 | 说明 |
|------|------|------|------|
| **RKLLM NPU HTTP** | `rkllmEmbed.enabled = true` | **1024 dim** | RK3588 NPU 加速，CPU 占用近零；需先启动 `~/rkllm-embed-server/start.sh` |
| **本地 GGUF（CPU）** | `rkllmEmbed.enabled = false`（默认）| 取决于模型 | 通用环境；`embedModel` 指定 HuggingFace URI（默认 embeddinggemma-300M） |

> ⚠️ 切换后端后，向量维度改变，必须执行 `tinyclaw memory index` 重建索引。

**RKLLM HTTP embed 接口**:`POST /embed`（单条）/ `/embed_batch`（批量），端口默认 11434。Tokenize 估算：`chars / 1.8` ≈ 900 tokens/chunk。

实现:`src/memory/rkllm-embed.ts` → `makeRkllmEmbedLlm(port)` 返回符合 QMD LLM interface 的对象;`qmd.ts` 在 `createStore()` 后覆盖 `store.internal.llm`,绕过 QMD 内部 LlamaCpp 自动初始化。

### 存储结构

```
~/.tinyclaw/
  memstores.toml          自定义额外知识库配置(如 Obsidian notes)
  agents/
    default/
      memory/
        index.sqlite      向量索引数据库(SQLite vec0,1024 dim)
        2026-05-01.md     当日压缩摘要
        ...
~/.tinyclaw/sessions/
  qqbot_c2c_<openid>.jsonl
  ...
```

#### memstores.toml 格式

```toml
[[stores]]
name    = "notes"
title   = "个人笔记(Obsidian Vault)"
path    = "~/.tinyclaw/user-data/notes/vault"
pattern = "**/*.md"
enabled = true
```

每个 store 对应一个独立 QMD collection,`search_store` 工具的 `store` 参数枚举从此文件动态生成。

### 写入时机

仅在 `summarizeAndCompress()` 中触发一次:`persistSummary(summaryText)` 将摘要追加到当日 `.md` 文件,异步触发 `updateMemoryIndex()`。

> 不再有每轮写入(无 `persistLastTurn()`),避免高频磁盘 I/O。

### 检索时机

每次 `runAgent()` 步骤 2:以本轮用户输入为查询向量,检索最相关的历史摘要片段注入上下文。即使 session 是全新的,或历史已被压缩,过去细节仍可被召回。

QMD 注入的 system message 带 `<!-- memory:... -->` 标记：压缩时会被**保留**（而非过滤），随后由 `_foldPreambleInjections()` 收敛为最新一条，因此不会无限堆积。

### 索引重建(memory_rebuild)

当向量索引维度发生变化(如切换 embed 模型)时,需重建索引:

```bash
tinyclaw memory index     # CLI 触发(通过 IPC 在服务进程内执行)
```

IPC `memory_rebuild` 流程:
1. 关闭并清理旧 store 缓存(`storeMap.delete(agentId)`)
2. 清空所有 embeddings(`clearAllEmbeddings(db)`)
3. 重新初始化 store(覆盖 `store.internal.llm` 为 RKLLM embed)
4. 遍历 `memstores.toml` 中的 store,动态追加 collections
5. 对所有 `.md` 文件重新向量化

### 开关

`memory.enabled = false`(默认)时全部跳过,不连接 NPU embed server,不读写磁盘。开启后需先启动 `~/rkllm-embed-server/start.sh`,并在 `config.toml` 设置 `[memory] rkllmEmbed.enabled = true`。
---

## 八、关键参数一览

| 参数 | 位置 | 默认值 | 说明 |
|---|---|---|---|
| `tools.maxChatToolRounds` | `config.toml` | 0（无限制） | Chat/Cron 模式单次 runAgent 最多工具调用轮数，0=无限制 |
| `auth.mfa.tools` | `config.toml` | `["delete_file","write_file"]` | 整工具 MFA 黑名单 |
| `auth.mfa.exec_shell_patterns.patterns` | `config.toml` | `["rm","sudo","chmod","chown","dd","mv"]` | exec_shell 命令级黑名单 |
| `auth.mfa.timeoutSecs` | `config.toml` | 60 | MFA 等待超时（秒） |
| `searchMemory limit` | `memory/qmd.ts` 硬编码 | 5 | 每次检索返回最多 5 条记忆 |
| `searchMemory minScore` | `memory/qmd.ts` 硬编码 | 0.3 | 相似度低于此阈值的结果丢弃 |
| 摘要最大长度 | `summarizer.ts` SUMMARIZE_SYSTEM | 400 token | summarizer LLM 生成摘要的目标长度 |


---

