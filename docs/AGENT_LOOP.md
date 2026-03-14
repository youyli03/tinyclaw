# Agent 循环详细流程

> 描述一条消息从进入 tinyclaw 到最终回复的完整生命周期，
> 包括历史记录管理、向量记忆检索、token 超限压缩、工具执行与 MFA 审批。

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
├─ 步骤 4：ReAct 工具循环（最多 MAX_TOOL_ROUNDS = 10 轮）
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
│         第 10 轮（MAX_TOOL_ROUNDS-1）强制调用 LLM 生成总结回复，break
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
| `MAX_TOOL_ROUNDS` | `core/agent.ts` 硬编码 | 10 | 单次 runAgent 最多工具调用轮数 |
| `memory.enabled` | `config.toml` | false | 向量记忆开关 |
| `memory.tokenThreshold` | `config.toml` | 0.8 | 触发压缩的上下文使用率 |
| `memory.embedModel` | `config.toml` | Q4_K_M | Embedding 模型（~380MB） |
| `auth.mfa.timeoutSecs` | `config.toml` | 60 | MFA 等待超时 |
| `searchMemory limit` | `memory/qmd.ts` 硬编码 | 5 | 每次检索返回最多 5 条记忆 |
| `searchMemory minScore` | `memory/qmd.ts` 硬编码 | 0.3 | 相似度低于此阈值的结果丢弃 |
| 摘要最大长度 | `summarizer.ts` SUMMARIZE_SYSTEM | 400 token | summarizer LLM 生成摘要的目标长度 |
