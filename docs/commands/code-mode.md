# Code 模式

> 描述 tinyclaw 的 Code 模式设计原理、持久化机制、与 Chat 模式的差异，以及相关命令用法。

---

## 一、概述

Code 模式是独立于 Chat 对话历史的编码会话，灵感来源于 VS Code Copilot Chat 的 Edit 模式。

| 维度 | Chat 模式（默认） | Code 模式 |
|------|-----------------|-----------|
| 历史持久化文件 | `<sessionId>.jsonl` | `<sessionId>.code.jsonl` |
| 摘要压缩 | ✅ 全量压缩（保留 system + 摘要） | ✅ 滑动窗口压缩（保留最近 8 条）|
| 压缩触发阈值 | context 80%（可配）| context 75%（固定），≥90% 额外通知用户 |
| QMD 记忆搜索 | ✅ 每次 run 注入相关记忆 | ❌ 跳过 |
| MEM.md / SKILLS.md | ✅ 加载到 system prompt | ❌ 跳过 |
| LLM 后端 | `llm.backends.daily` | `llm.backends.code`（可选，fallback daily）|
| System prompt | 完整通用 prompt | 精简代码专注 prompt |
| Crash 恢复 | ✅ 从 `.jsonl` 恢复 | ✅ 从 `.code.jsonl` 恢复 |
| 工具能力 | ✅ 完整（exec_shell、write_file 等） | ✅ 完整（同 Chat 模式）|
| 工具调用轮次上限 | 0（无限制，可通过 `tools.maxChatToolRounds` 配置） | 0（无限制，可通过 `tools.maxCodeToolRounds` 配置）|
| 工具结果截断 | ✅ `tools.maxToolResultChars`（默认 20000）| ✅ 同 Chat 模式 |

---

## 二、切换命令

```
/code     进入 Code 模式
/chat     返回 Chat 模式
/plan     切换到 Plan 子模式(Code 模式下)
/auto     切换到 Auto 子模式(Code 模式下,默认)
/compact  手动触发上下文压缩(任意模式可用)
```

### `/compact`

在任意模式(Chat 或 Code)下强制触发一次上下文压缩,不等待 token 自动超限:
- **Chat 模式**:调用 `summarizeAndCompress()`,历史全量压缩为摘要
- **Code 模式**:调用 `compressForCode()`,保留最近 8 条,其余压缩为摘要

适用场景:上下文已很长但未触发自动压缩阈值,希望主动清理以提升响应速度/降低 token 消耗。

### `/code`

1. 将 `session.mode` 设为 `"code"`
2. 调用 `session.clearMessages()`：
   - 清空内存中的 `messages[]`
   - 删除 `~/.tinyclaw/sessions/<sessionId>.code.jsonl`（重置 crash 恢复状态）
3. 后续每轮对话写入 `.code.jsonl`（不写 `.jsonl`）

### `/chat`

1. 将 `session.mode` 设为 `"chat"`
2. 调用 `session.reloadFromDisk("chat")`：
   - 删除 `~/.tinyclaw/sessions/<sessionId>.code.jsonl`（防止重启后误判模式）
   - 从 `~/.tinyclaw/sessions/<sessionId>.jsonl` 恢复聊天历史
3. 后续恢复正常 Chat 模式行为

---

## 三、持久化文件路径

```
~/.tinyclaw/sessions/
  cli_<uuid>.jsonl           ← Chat 模式历史
  cli_<uuid>.code.jsonl      ← Code 模式历史（crash 恢复用）
```

两个文件独立存在，互不干扰。会话 ID 中的特殊字符（`: / \`）统一替换为 `_`。

---

## 四、Crash 恢复机制

进程重启后，`Session` 构造函数按以下优先级恢复上下文：

```
1. 检测 .code.jsonl 是否存在且有内容
   → 存在：mode = "code"，从 .code.jsonl 恢复 messages[]
   → 不存在：继续下一步
2. 检测 .jsonl 是否存在
   → 存在：mode = "chat"，从 .jsonl 恢复 messages[]
   → 不存在：空 session，mode = "chat"
```

这保证了无论进程何时崩溃，下次重启后用户都能继续上次的工作状态。

当用户主动执行 `/chat` 切换回聊天模式时，`.code.jsonl` 会被删除，确保下次重启不会再误判为 Code 模式。

---

## 五、LLM 后端配置

Code 模式默认回退到 `daily` 后端。如需使用更擅长代码的专用模型，在 `config.toml` 中配置：

```toml
[llm.backends.code]
baseUrl = "https://api.openai.com/v1"
apiKey  = "sk-..."
model   = "o3-mini"

# 或使用 Copilot：
# [llm.backends.code]
# provider    = "copilot"
# githubToken = "gh_cli"
# model       = "gpt-4.1"
```

---

## 六、System Prompt 差异

### Chat 模式 system prompt 包含：
- 内置通用指令（工具优先级、code_assist 规范、工作区约定、富媒体发送等）
- 全局 `~/.tinyclaw/SYSTEM.md`（可选）
- Agent 级 `SYSTEM.md`（可选）
- `MEM.md` 持久记忆
- `SKILLS.md` 技能目录
- QMD 历史记忆搜索结果（每轮动态注入）

### Code 模式 system prompt 包含：
- 精简代码专注指令（工具使用、工作区路径、代码任务规范）
- 视觉能力说明（若模型支持）

Code 模式 prompt 刻意精简，减少无关上下文干扰，专注于代码任务。

---

## 七、代码结构

```
src/code/
  index.ts          — 副作用入口，import 触发命令注册
  commands.ts       — /code 和 /chat 斜杠命令实现
  system-prompt.ts  — buildCodeSystemPrompt() 函数

src/core/
  session.ts        — Session.mode 字段、clearMessages()、reloadFromDisk()
                      appendLastTurnToJsonl()（模式感知路径）
                      maybeCompress()（chat 模式全量压缩）
                      compressForCode() / maybeCompressCode()（code 模式滑动窗口压缩）
                      rewriteCodeJsonl()（压缩后持久化 .code.jsonl）
                      constructor（crash 恢复优先级）
  agent.ts          — runAgent() 中的 code 模式分支
                      maxToolRounds（code 模式使用 config.tools.maxCodeToolRounds）
                      预调用 token 预算检查（≥75% 触发压缩，≥90% 通知用户）
                      工具结果截断（config.tools.maxToolResultChars）

src/config/
  schema.ts         — LLMBackendsSchema.code（可选字段）
                      tools.maxCodeToolRounds（默认 25）
                      tools.maxToolResultChars（默认 20000）

src/memory/
  summarizer.ts     — shouldSummarizeCode() / summarizeAndCompressCode()（code 专属）

src/llm/
  registry.ts       — BackendName 加入 "code"，init/get 支持
```

---

## 八、与 Chat 模式的上下文隔离

```
用户操作流：

  [ Chat 模式 ] ──/code──→ [ Code 模式 ]
      │                         │
  写 .jsonl                写 .code.jsonl
  QMD 记忆                 无记忆搜索
  全量摘要压缩              滑动窗口压缩（保留最近 8 条消息）
      │                         │
      └──────/chat──────────────┘
              ↓
    删除 .code.active
    恢复 .jsonl 历史
    回到 Chat 模式
```

两种模式的历史完全隔离，切换时不会相互污染。

---

## 九、上下文管理与滑动窗口压缩

Code 模式采用**滑动窗口**策略管理上下文，与 Chat 模式的全量替换策略不同。

### 压缩触发时机

每次 LLM 调用前，`agent.ts` 检查当前 messages 的估算 token 用量：

| 用量 | 行为 |
|------|------|
| < 75% | 正常执行 |
| ≥ 75% | 静默触发 `compressForCode()`，日志记录 |
| ≥ 90% | 触发压缩 + 通过 `onNotify` 向用户推送提示 |

### 压缩策略

```
压缩前：
  [system prompt] [旧消息 1..N] [最近消息 N+1..N+8]

压缩后：
  [system prompt] [历史摘要（assistant 角色）] [最近消息 N+1..N+8]
```

- **保留**：system prompt + 最近 8 条消息（完整，不压缩）
- **压缩**：更早的消息 → 代码专属摘要
- **摘要内容**：当前任务目标、已修改文件列表、执行命令及结果、任务进度、待解决问题

与 Chat 模式区别：Chat 压缩后只剩 system + 摘要（全量替换），Code 压缩后**保留最近上下文**，确保当前正在执行的操作不丢失。

### 压缩后持久化

`compressForCode()` 执行后立即调用 `rewriteCodeJsonl()`，将压缩后的 messages 覆写到 `.code.jsonl`，确保 crash 恢复时从压缩后的状态开始。

### 相关配置

```toml
# config.toml — tools 节（可选，以下均为默认值）
[tools]
maxCodeToolRounds = 0      # Code 模式工具调用轮次上限（0 = 无限制，与 Chat 模式一致）
maxToolResultChars = 20000 # 工具结果最大字符数（0 = 不限制）
```

### 工具结果截断

所有工具执行结果（`tool_result`）超过 `maxToolResultChars` 时自动截断，并在末尾附加说明：

```
[内容过长，已截断。原始长度 X 字符，保留前 20000 字符。如需查看更多请缩小范围重新调用。]
```

这有效防止 `read_file` 大文件或 `exec_shell` 冗长输出一次性占满大量 context。

---

## 十、Code 子模式：Plan / Auto

Code 模式内置两个子模式，通过 `/plan` 和 `/auto` 命令切换。

### 概述

| 子模式 | 命令 | 行为 |
|--------|------|------|
| **auto**（默认）| `/auto` | AI 直接分析并执行任务（同原有 Code 模式行为） |
| **plan** | `/plan` | AI 先分析任务、输出计划，等用户确认后再执行 |

子模式状态保存在 `session.codeSubMode`，不影响会话历史。

### Plan 子模式流程

```
用户发送任务
  └→ AI 分析（read_file / exec_shell）
       └→ AI 调用 exit_plan_mode 工具提交计划摘要
            └→ 向 QQ 推送操作菜单：
                 1. 🚀 autopilot    —— 批准，立即执行（推荐）
                 2. 💬 interactive  —— 批准，逐步确认
                 3. ❌ exit_only    —— 取消执行
                 或：输入自由文字 → AI 修改计划后重新提交
            └→ 用户选择：
                 ├→ 批准 → AI 继续执行（写文件等），仍在同一 runAgent()
                 └→ 反馈 → AI 修改计划，再次调用 exit_plan_mode
```

**计费说明**：分析 + 规划 + 等待确认 + 执行全部在同一 `runAgent()` 内完成，只消耗 1 次 Copilot premium request。每次拒绝并提供反馈才会产生额外消耗。

### exit_plan_mode 工具

AI 通过调用此工具触发计划审批流程：

```
exit_plan_mode(
  summary: string,            // 计划摘要（必填），展示给用户
  planPath?: string,          // 详细计划文件路径（可选，如 PLAN.md）
  actions?: string[],         // 操作列表，默认 ["autopilot","interactive","exit_only"]
  recommendedAction?: string  // 推荐操作，默认 "autopilot"
)
```

**返回给 AI**：
```json
{ "approved": true, "selectedAction": "autopilot" }
// 或
{ "approved": false, "feedback": "请把第3步的写法改为..." }
```

### 工具权限约束（system prompt 软约束）

- ✅ 允许：`read_file`、`exec_shell`（只读分析）、`write_file` 写 PLAN.md
- ⚠️ 禁止（软）：`exit_plan_mode` 批准前修改源代码

### 用户交互示例

```
📋 **计划已就绪**

将在 src/auth/ 新增 JWT 认证模块：
- 新建 src/auth/jwt.ts（encode/decode/verify）
- 修改 src/main.ts：在路由中间件前注入认证校验
- 预计影响范围：2 文件，新增约 80 行代码

─────────────────
请选择操作：
  1. 🚀 autopilot —— 推荐
  2. 💬 interactive
  3. ❌ exit_only

或直接输入反馈意见，AI 将修改计划后重新提交。
（超时 5 分钟自动取消）
```

### 相关文件

```
src/code/
  commands.ts               — /plan 和 /auto 命令
  exit-plan-mode-tool.ts    — exit_plan_mode 工具注册
  system-prompt.ts          — buildCodeSystemPrompt(agentId, supportsVision, subMode)
  backends/
    types.ts                — CodeBackend 接口（扩展点）
    copilot.ts              — Copilot 后端 stub

src/core/
  session.ts                — codeSubMode / pendingPlanApproval 状态机
  agent.ts                  — onPlanRequest 注入；isUserInitiated 传递

src/main.ts                 — pendingPlanApproval 处理；onPlanRequest 回调构建
```
