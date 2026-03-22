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

`Session` 内部维护一个 `messages: ChatMessage[]` 数组。消息只会 **append**，不会删除（直到触发压缩）。每次调用 `runAgent()` 都将完整的 `messages[]` 发给 LLM，LLM 通过上下文感知全部多轮历史。

**典型 messages 结构（多轮后）**

```
[0] system   ← BUILTIN_SYSTEM + SYSTEM.md（第一轮追加，后续不再重复）
[1] system   ← "## 相关历史记忆 ..."（本轮 QMD 检索结果，可能没有）
[2] user     ← 第一轮用户输入
[3] assistant ← LLM 中间回复（有工具调用时）
[4] system   ← [tool_result:exec_shell] 工具执行结果
[5] assistant ← 最终回复
[6] system   ← 下一轮：相关历史记忆（可能没有）
[7] user     ← 第二轮用户输入
[8] assistant ← 第二轮最终回复
...          ← 继续 append
```

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
│
├─ 步骤 2：QMD 向量记忆检索
│    searchMemory(userContent)
│    ├─ memory.enabled = false → 返回 ""，跳过
│    └─ memory.enabled = true
│         Qwen3-Embedding 对 userContent 向量化
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
  过滤掉 QMD 召回注入的临时 system messages（以"## 相关历史记忆"开头）
  新 messages = [
    原来的永久 system messages（BUILTIN_SYSTEM、SYSTEM.md）,
    { role:"assistant", content:"[对话历史摘要]\n摘要内容..." }
  ]
  原来的 user / assistant / tool_result 消息全部丢弃

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

## 七、向量记忆（QMD）详细说明

### 存储结构

```
~/.tinyclaw/memory/
  index.sqlite          向量索引数据库（SQLite + embeddings）
  2026-03-15.md         当日压缩摘要（压缩触发时追加）
  2026-03-14.md
  ...
~/.tinyclaw/sessions/
  qqbot_c2c_<openid>.jsonl    各 session 的 JSONL 持久化文件
  cli_<uuid>.jsonl
  ...
```

### 写入时机

仅在 `summarizeAndCompress()` 中触发一次：`persistSummary(summaryText)` 将摘要追加到当日 `.md` 文件，异步触发 `updateMemoryIndex()`。

> 不再有每轮写入（无 `persistLastTurn()`），避免高频磁盘 I/O。

### 检索时机

每次 `runAgent()` 步骤 2：以本轮用户输入为查询向量，检索最相关的历史摘要片段注入上下文。即使 session 是全新的，或历史已被压缩，过去细节仍可被召回。

由于 QMD 注入的 system messages 以 `"## 相关历史记忆"` 开头，压缩时会被正确过滤，不保留到压缩后的 messages[]。

### 开关

`memory.enabled = false`（默认）时全部跳过，不下载模型，不读写磁盘。开启需首次下载 ~380MB embedding 模型。

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

## 一、Session 与历史记录

每个消息来源拥有独立的 `Session` 实例，由 `main.ts` 用 `Map<sessionId, Session>` 维护，进程不重启则一直存活。

**SessionId 格式**

```
qqbot:c2c:<openid>       QQ 私聊
qqbot:group:<openid>     QQ 群
qqbot:guild:<channelId>  QQ 频道
cli:<uuid>               CLI tinyclaw chat
```

`Session` 内部维护一个 `messages: ChatMessage[]` 数组。消息只会 **append**，不会删除（直到触发压缩）。每次调用 `runAgent()` 都将完整的 `messages[]` 发给 LLM，LLM 通过上下文感知全部多轮历史。

**典型 messages 结构（多轮后）**

```
[0] system   ← BUILTIN_SYSTEM + SYSTEM.md（第一轮追加，后续不再重复）
[1] system   ← "## 相关历史记忆 ..."（本轮 QMD 检索结果，可能没有）
[2] user     ← 第一轮用户输入
[3] assistant ← LLM 中间回复（有工具调用时）
[4] system   ← [tool_result:exec_shell] 工具执行结果
[5] assistant ← 最终回复
[6] system   ← 下一轮：相关历史记忆（可能没有）
[7] user     ← 第二轮用户输入
[8] assistant ← 第二轮最终回复
...          ← 继续 append
```

---

## 二、单次 runAgent() 执行步骤

```
用户消息进入 runAgent(session, userContent)
│
├─ 步骤 1：初始化 system prompt（每个 session 只做一次）
│    messages 为空 → 追加：
│      BUILTIN_SYSTEM（写死，不可覆盖）
│      + ~/.tinyclaw/SYSTEM.md（用户自定义，可选）
│    messages 非空（已有历史）→ 跳过
│
├─ 步骤 2：QMD 向量记忆检索
│    searchMemory(userContent)
│    ├─ memory.enabled = false → 返回 ""，直接跳过
│    └─ memory.enabled = true
│         Qwen3-Embedding 对 userContent 向量化
│         在 index.sqlite 中检索 top-5，minScore=0.3
│         有结果 → 追加 system message "## 相关历史记忆\n[score%] 标题\n内容..."
│         无结果 → 跳过
│
├─ 步骤 3：追加用户消息
│    messages.push({ role:"user", content: userContent })
│
├─ 步骤 4：ReAct 工具循环（轮次上限由 tools.maxChatToolRounds 配置，默认 0=无限制）
│    ┌── LLM chat(messages, tools=[codex, copilot, exec_shell, write_file, delete_file, ...])
│    │
│    ├─ 情形 A：LLM 直接回复（不调用工具）
│    │    messages.push({ role:"assistant", content: 回复 })
│    │    finalContent = 回复，break 退出循环
│    │
│    └─ 情形 B：LLM 返回 tool_calls
│         messages.push({ role:"assistant", content: 思考过程或空串 })
│         │
│         对每个 tool_call：
│           ├─ 普通工具（codex / copilot）
│           │    直接执行 → 结果追加 system message
│           │    [tool_result:codex]\n执行结果...
│           │
│           └─ 高危工具（exec_shell / write_file / delete_file）
│                已被 withMFA() 包装：先走 MFA 审批（见第四节）
│                ├─ 通过 → 执行工具 → 结果追加 system message
│                └─ 拒绝/超时 → result = "操作被取消：xxx" → 追加 system message
│         │
│         进入下一轮 LLM chat（携带全量 messages + 工具结果）
│         │
│         达到轮次上限（maxToolRounds-1）强制调用 LLM 生成总结回复，break
│
├─ 步骤 5a：persistLastTurn() — 持久化本轮对话
│    在 messages 末尾找最后一对 user / assistant
│    追加写入 ~/.tinyclaw/memory/sessions/YYYY-MM-DD.md：
│      ## 2026-03-15T12:34:56.789Z
│      **User:** ...
│      **Assistant:** ...
│    异步触发 QMD updateMemoryIndex()（不阻塞响应返回）
│
└─ 步骤 5b：maybeCompress() — 检查是否需要压缩（见第三节）
```

---

## 三、Token 超限时的自动压缩

每次 `runAgent()` 结束后，`session.maybeCompress()` 检查当前上下文体积：

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
第一步：存档原始对话到 QMD（信息不丢失）
  persistMessages(messages)
  → 将所有 user/assistant 对写入 YYYY-MM-DD.md
  → 触发 updateMemoryIndex()，建立/更新向量索引
  （即使内存窗口被清空，历史永久保存在磁盘，下次可被检索回来）

第二步：用 summarizer LLM 生成摘要
  取所有非 system 消息，拼成纯文本
  发给 llm.backends.summarizer（独立后端，可配置轻量模型）
  生成 ≤400 token 的中文摘要，保留：
    - 用户关键需求、偏好、结论
    - 已完成操作及结果
    - 未解决的待办事项

第三步：替换 session.messages[]
  新 messages = [
    原来的 system messages（保留 BUILTIN_SYSTEM、SYSTEM.md）,
    { role:"assistant", content:"[对话历史摘要]\n摘要内容..." }
  ]
  原来的 user / assistant / tool_result 消息全部丢弃
```

**效果**：对用户完全无感，下一轮 LLM 接收到的是"带历史摘要的全新上下文"，同时 QMD 向量索引中保留了被压缩掉的所有细节，下次提问时可被检索回来注入。

---

## 四、MFA 权限审批流程

三个高危工具在注册时被 `withMFA()` 包装：

| 工具 | 触发 MFA 的原因 |
|---|---|
| `exec_shell` | 任意 shell 命令执行 |
| `write_file` | 文件写入 |
| `delete_file` | 文件删除 |

### 审批流程

```
withMFA(fn) 被调用
│
├─ 第一步：静默刷新（有 MSAL 缓存时用户无感）
│    检查本地 token 缓存（@azure/msal-node）
│    有有效 token → 直接通过，执行原始函数，用户无感知
│
└─ 第二步：无缓存 → Device Code Flow
     │
     生成提示消息，通过 onMFAPrompt 回调发出：
       QQBot 来源 → 发送到对应 QQ 用户/群
       CLI 来源   → 打印到终端
     提示内容："🔐 需要 MFA 验证\n打开 https://microsoft.com/devicelogin 输入 XXXXX"
     同时 Microsoft Authenticator 推送 number-matching 通知（数字匹配）
     │
     ├─ 用户点击确认（数字匹配）
     │    MFA 通过，token 写入缓存
     │    执行原始工具函数，结果返回给 agent
     │
     ├─ 用户点击拒绝
     │    throw MFAError("用户拒绝了 MFA 认证，操作已取消")
     │    agent 捕获 → result = "操作被取消：用户拒绝了 MFA 认证，操作已取消"
     │    追加为 [tool_result:xxx] system message
     │    LLM 下一轮感知到操作被取消，生成"操作已取消"最终回复
     │
     └─ 超时（默认 60s，可配置 auth.mfa.timeoutSecs）
          throw MFAError("MFA 确认超时，操作已取消")
          同上，操作取消
```

### MFA token 缓存说明

MSAL 的 token 缓存存在内存中，**进程重启后失效**，下次高危操作需重新认证。同一进程内多次高危操作只需认证一次（缓存命中）。

---

## 五、向量记忆（QMD）详细说明

### 存储结构

```
~/.tinyclaw/memory/
  index.sqlite                  向量索引数据库（SQLite + embeddings）
  sessions/
    2026-03-15.md               当日所有对话原始记录
    2026-03-14.md               昨日记录
    ...
```

### 写入时机

1. 每次 `runAgent()` 结束后的 `persistLastTurn()`：写入本轮最后一对对话
2. 压缩前的 `persistMessages()`：批量写入即将被丢弃的全部对话

### 检索时机

在每次 `runAgent()` 开始时（步骤 2），以本轮用户输入作为查询向量，检索最相关的历史片段注入到上下文。这样即使当前 session 是全新的，或历史已被压缩，过去的对话细节仍可被召回。

### 开关

`memory.enabled = false`（默认）时全部逻辑跳过，不下载模型，不读写磁盘，不影响正常对话。开启需要首次下载 ~380MB embedding 模型。

---

## 六、关键参数一览

| 参数 | 位置 | 默认值 | 说明 |
|---|---|---|---|
| `tools.maxChatToolRounds` | `config.toml` | 0（无限制） | Chat/Cron 模式单次 runAgent 最多工具调用轮数，0=无限制 |
| `memory.enabled` | `config.toml` | false | 向量记忆开关 |
| `memory.tokenThreshold` | `config.toml` | 0.8 | 触发压缩的上下文使用率 |
| `memory.embedModel` | `config.toml` | Q4_K_M | Embedding 模型（~380MB） |
| `auth.mfa.timeoutSecs` | `config.toml` | 60 | MFA 等待超时 |
| `searchMemory limit` | `memory/qmd.ts` 硬编码 | 5 | 每次检索返回最多 5 条记忆 |
| `searchMemory minScore` | `memory/qmd.ts` 硬编码 | 0.3 | 相似度低于此阈值的结果丢弃 |
| 摘要最大长度 | `summarizer.ts` SUMMARIZE_SYSTEM | 400 token | summarizer LLM 生成摘要的目标长度 |
