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
     构建 opts（onMFARequest / onMFAPrompt / onPurpose 等回调）
     runPromise = session.runExclusive(() => runAgent(session, msg.content, opts))
     │   ↑ 同一 session 上的一切 run（用户消息 / Slave 结果注入 / session_send / loop tick / IPC）
     │     都经这一个队列严格串行；running 与 currentRunPromise 由 runExclusive 维护，
     │     调用方**不再手工置位**（旧的「检查 running → await → 赋值」存在并发窗口）
     │
     runPromise.then  → connector.send(result.content)（主动推送回复）
     runPromise.catch → connector.send("抱歉，处理消息时出现错误")
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
│    │    ├─ 思考档位：session.getThinkingLevel()（`/think` 写入的会话级覆盖）→
│    │    │    与后端 config 的 reasoningEffort / disableThinking 一起交给
│    │    │    llm/thinking.ts 的 resolveThinkingParams()（仅 DeepSeek 系后端生效）
│    │    ├─ AbortError → break（被软中断取消）
│    │    └─ 其他错误  → throw
│    │
│    ├─ 情形 A：LLM 直接回复（无 tool_calls）
│    │    ├─ [空回复守卫] content 为空？→ 见「空回复与思考退化」节
│    │    │    → 注入纠偏提示（length / degenerate / silent 三态）+ 重试本轮一次
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
│           ├─ 剥离框架保留字段 __purpose（见本节末「__purpose 进度旁白」）
│           │    { args: toolArgs, purpose } = stripReservedArgs(call.args)
│           │    purpose 归一化（长度上限 / emoji 不计长 / 图形簇截断）
│           │
│           ├─ MFA 检查（见第五节）——判定与告警文案都用**剥离后**的 toolArgs
│           │    toolNeedsMFA(name, toolArgs, cfg) == true
│           │    && session.mfaApprovedForThisRun == false
│           │    ├─ opts.approvalPolicy == "never"（子 Agent / 无人值守）
│           │    │    → [tool_result:name] 已拒绝：子 Agent 不允许发起审批，continue（不弹提示）
│           │    └─ 进行 MFA 验证（接口 A 或 B）
│           │         ├─ 通过 → session.mfaApprovedForThisRun = true，继续执行
│           │         ├─ 拒绝 → [tool_result:name] 操作被取消：用户拒绝，continue
│           │         └─ 超时/异常 → [tool_result:name] 操作被取消：MFA 未通过，continue
│           │
│           └─ 执行工具
│                purposeArbiter.onToolStart(name, purpose)   ← 记录候选，慢工具到点才展示
│                result = await executeTool(name, toolArgs)   ← 工具看不到 __purpose
│                purposeArbiter.onToolEnd(name, durationMs)   ← T2：长工具刚收尾时展示
│                messages.push([tool_result:name]\n{result})
│                [再次检测 abortRequested] → break（工具可能运行数秒）
│         │
│         [批次结束后检测 abortRequested] → break，退出轮次循环
│         │
│         [round == maxToolRounds-1] → 强制 LLM 生成总结回复，break
│
│    注：非串行工具在一个批次内**并行执行**（Promise.all），因此完成顺序可能与发起顺序相反；
│        __purpose 的展示按"发送那一刻的真实进度"重新选取，不受这个顺序影响。
│
├─ 步骤 4.5：`__purpose` 进度旁白（取代了旧的定时心跳）
│    注入：组装 tools 之后，给每个工具的参数 schema 追加可选字段 __purpose
│          （内置工具 / MCP 工具 / customTools 一视同仁，全部模式一致）
│    剥离：执行前从参数中移除，工具实现与 MCP server 永远看不到它
│    进历史：它就在 assistant.tool_calls[].function.arguments 里，随 JSONL 自然持久化；
│          **不额外插入独立消息**（插在 assistant(tool_calls) 与 tool(result) 之间会打断配对触发 400）
│    展示仲裁（core/purpose-arbiter.ts）：
│      T1 工具运行满 agent.purposeHoldMs(默认 4s) → 展示（"用户确实在等"）
│      T2 长工具刚结束且当前无在跑工具 → 展示
│      快工具静默；agent.purposeMinGapMs(默认 3s) 限制间隔；
│      agent_fork / session_send 这类"秒返回但后台长跑"的工具跳过 hold 直接展示
│      发送时按真实进度重新选取：有工具在跑→取"最后发起"者，否则取"最后完成"者；
│      被超越的候选一律丢弃、不回放
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
threshold       = contextWindow × memory.tokenThreshold  // 默认 0.6
```

### 触发前的无模型剪枝（参考 DSH）

压力超过阈值时，**先做一次不需要模型调用的工具结果剪枝**（`src/memory/tool-result-pruner.ts`）：

- 把超大的 `role:"tool"` 结果替换为「头部 + `[... 工具结果中间部分已剪枝 ...]` + 尾部」
- 默认 `thresholdChars=8192` / `headChars=4096` / `tailChars=1024`（对齐 DSH `dsh-compaction-tool-result-pruner`）
- **有界且幂等**：结果长度严格小于原文，且已含标记的不再处理 → 反复调用不会反复改写
- 剪枝后用估算值重新判断压力；**若已回到阈值以下，就跳过下面的摘要调用**

> 这一版取代了旧的 MicroCompact。旧版在 0.45 阈值**每轮**触发、反复原地改写头部历史，
> 前缀缓存每次全失效（省 10~20% 输入 token 却丢 100% 前缀缓存），因此被禁用。

### 未超过阈值

什么都不做，messages 继续 append，下轮正常使用。

### 超过阈值 → summarizeAndCompress()

**保留策略**：按 **token 预算**逐字保留近期尾部 = `contextWindow × CHAT_RETAIN_RATIO`（0.16，
对齐 DSH `retainRatio`），而不是按轮数——后者在一轮里塞入大工具结果时仍会超预算。
切点会对齐到工具调用／结果配对边界（绝不以孤立的 `role:"tool"` 消息开头）。

```
第一步：用 summarizer LLM 生成结构化检查点
  取所有非 system 消息，拼成纯文本
  发给 llm.backends.summarizer（独立后端，可配置轻量模型）
  按固定 Markdown 结构输出（参考 DSH compaction-basic 的检查点模板）：
    主要请求与意图 / 关键技术概念 / 涉及的文件与代码 / 错误与修复 /
    待办任务 / 当前工作 / 下一步 / 关键上下文 / 用户原始消息
  规则：每个章节都要保留（空则写「(无)」）；精确保留路径、命令、错误串、标识符、数值；
        不要提及本次摘要或"上下文被压缩"；已有 <compacted-summary> 时合并而非照抄

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
    { role:"assistant", content:"[对话历史摘要]\n<compacted-summary>\n检查点正文\n</compacted-summary>" }
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

### 委派运行不审批（`approvalPolicy: "never"`）
子 Agent（`agent_fork` → `slaveRunFn`）与 cron / loop 的无人值守消息步骤，其 `runAgent()`
一律带 `AgentRunOptions.approvalPolicy = "never"`。命中 MFA 判定时**在发起任何提示之前**确定性拒绝：

```
→ [tool_result:name] 已拒绝：子 Agent 不允许发起审批（approvalPolicy=never），请在委派范围内完成
→ bus.emit({ type: "mfa:denied" }) + 审计（reason: "子 Agent approvalPolicy=never"），不弹 MFA / 不发提示
```

同一策略经 `ToolContext.approvalPolicy` 传给工具层：`exec_shell({ elevate: true })` 也直接拒绝
（见 `docs/architecture/overview.md` 的提权节）。语义是"子 Agent 只能在委派时定下的作用域里干活"。

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

### 空回复与思考退化（`llm/reasoning-guard.ts` + 空回复守卫）

**实测事故（2026-09-13）**：prompt 已到 **340k+ token** 的长会话里，向 flash 级模型
要"下载 PDF + 说明"时，它把输出预算全用在 `reasoning_content` 里，并退化成同一句短话的
无限重复（`好。写。好。发送。好。…`），**最终 `content` 为空**（该轮 `completion_tokens`
只有 1,422，远低于 `maxTokens=4096` → 不是长度截断，是模型自己以空正文收尾）。
旧行为把"没有 tool_calls"直接当成最终回复 → `main.ts` 的兜底文案 `✅ 已完成` 顶上去，
**用户没拿到任何回答却看到"已完成"**。

处理（细节与门限见 `docs/architecture/retry.md` 的「空回复重试」）：

1. **判定三态**：`finish_reason === "length"` → 长度截断；reasoning 重复退化
   （同一 ≤24 字单元 ≥12 次，`detectReasoningRepetition()`）→ `degenerate`；其余 → `silent`；
2. **连续空最多重试 `MAX_EMPTY_REPLY_RETRIES`（=3）次**：每次注入英文纠偏提示（`emptyReplyNudge(kind)`）后
   `continue` 重试本轮；**重试与最终失败都不落库空 assistant 消息**（2026-09-24 前是"只救一次"，
   第二次空正文 + 循环思考会落库并被下一轮照抄）；
3. **点名日志**：`⚠️ 收到空回复（finish_reason=…, reasoning=N 字符, 单元=x/去重=y, **reasoning 重复退化**："好。" ×N）第 1/4 次，…`；
4. **可观测**：计数写入指标 `llm/empty_reply`（`note` = 三态），Dashboard「指标」页可见；
5. **诚实兜底**：重试仍为空时结果带 `emptyReplyKind`，`main.ts` 对 `degenerate` / `length`
   发 `⚠️ 模型这轮没有产出正文（…），请再问一次或换个模型`；`✅ 已完成` 只留给
   "工具已交付结果、模型确实没有补充"的情形。
6. **reasoning 落库净化**：产出正文/工具调用的轮次，落库前过 `sanitizeReasoningForStorage()` ——
   退化时只保留**重复开始之前**的前缀并注入 `reasoningLoopNudge()`（带 `tools` 时 DeepSeek 要求
   历史 `reasoning_content` 完整回传，整条丢弃会 400）；有工具调用时纠偏提示延到**工具结果写完**之后，
   避免插进 `assistant.tool_calls` 与 `tool` 消息之间破坏配对。

---

### 会话级思考档位（`/think`，`llm/thinking.ts`）

- **命令**：`/think`（无参数看当前状态）· `/think <档位>` · `/think default` 清除覆盖。
  合法档位 `off | none | minimal | low | medium | high | xhigh | max`（别名 `med`/`mid`/`min`/`disable` 归一化）。
- **存储**：`~/.tinyclaw/sessions/<sanitized-sessionId>.toml` 的 `[thinking] level`（与 `[loop]` / `[mcp_*]` 同文件）。
  `Session.getThinkingLevel()` 惰性读一次并缓存 → **重启后仍生效**；`/think default` 会删掉该块。
- **生效点**：每轮 `client.streamChat()` 的 `ChatOptions.thinking`，优先级
  会话覆盖 > `disableThinking` > `reasoningEffort` > `thinkingBudget`（见 `resolveThinkingParams()`）。
- **边界**：只有声明了 `thinkingControl` 的后端（DeepSeek 系）会把它落到请求上；其它 provider 忽略，
  `/think` 也会直接提示不支持。压缩 / 视觉 / cron / subagent 不受会话覆盖影响。
- **实测锚点**（2026-09-13，`tmp/probe-reasoning-effort*.ts`）：档位是**上限/引导**而非工作量下限——
  30th prime 这类简单题 7 个档位的 reasoning tokens 几乎相同（~140），换一道多步题 low=260 → high=319。
  想省 token 只能 `off`（真关）或换更小的模型，不要指望调档位带来数量级差异。

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
| `agent.toolPurpose` | `config.toml` | `true` | 是否启用工具调用的 `__purpose` 进度旁白（关掉则完全不注入、不展示） |
| `agent.purposeMaxUnits` | `config.toml` | 10 | `__purpose` 长度上限：CJK 按字、连续拉丁串按词；emoji 不计；超出按图形簇截断 |
| `agent.purposeHoldMs` | `config.toml` | 4000 | 工具运行超过该时长才算"用户在等"；0 = 一开始就展示 |
| `agent.purposeMinGapMs` | `config.toml` | 3000 | 两次 `__purpose` 展示之间的最小间隔 |
| `auth.mfa.tools` | `config.toml` | `["delete_file","write_file"]` | 整工具 MFA 黑名单 |
| `auth.mfa.exec_shell_patterns.patterns` | `config.toml` | `["rm","sudo","chmod","chown","dd","mv"]` | exec_shell 命令级黑名单 |
| `auth.mfa.timeoutSecs` | `config.toml` | 60 | MFA 等待超时（秒） |
| `searchMemory limit` | `memory/qmd.ts` 硬编码 | 5 | 每次检索返回最多 5 条记忆 |
| `searchMemory minScore` | `memory/qmd.ts` 硬编码 | 0.3 | 相似度低于此阈值的结果丢弃 |
| 摘要结构 | `summarizer.ts` SUMMARIZE_SYSTEM / CODE_SUMMARIZE_SYSTEM | 9 个固定章节 | 检查点模板，每章必留、空则写「(无)」 |


---

