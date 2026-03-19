# Code 模式

> 描述 tinyclaw 的 Code 模式设计原理、持久化机制、与 Chat 模式的差异，以及相关命令用法。

---

## 一、概述

Code 模式是独立于 Chat 对话历史的编码会话，灵感来源于 VS Code Copilot Chat 的 Edit 模式。

| 维度 | Chat 模式（默认） | Code 模式 |
|------|-----------------|-----------|
| 历史持久化文件 | `<sessionId>.jsonl` | `<sessionId>.code.jsonl` |
| 摘要压缩 | ✅ 触发后自动压缩 | ❌ 跳过 |
| QMD 记忆搜索 | ✅ 每次 run 注入相关记忆 | ❌ 跳过 |
| MEM.md / SKILLS.md | ✅ 加载到 system prompt | ❌ 跳过 |
| LLM 后端 | `llm.backends.daily` | `llm.backends.code`（可选，fallback daily）|
| System prompt | 完整通用 prompt | 精简代码专注 prompt |
| Crash 恢复 | ✅ 从 `.jsonl` 恢复 | ✅ 从 `.code.jsonl` 恢复 |
| 工具能力 | ✅ 完整（exec_shell、write_file 等） | ✅ 完整（同 Chat 模式）|

---

## 二、切换命令

```
/code   进入 Code 模式
/chat   返回 Chat 模式
```

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
                      maybeCompress()（code 模式跳过）
                      constructor（crash 恢复优先级）
  agent.ts          — runAgent() 中的 code 模式分支

src/config/
  schema.ts         — LLMBackendsSchema.code（可选字段）

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
  摘要压缩                 无压缩
      │                         │
      └──────/chat──────────────┘
              ↓
    删除 .code.jsonl
    恢复 .jsonl 历史
    回到 Chat 模式
```

两种模式的历史完全隔离，切换时不会相互污染。
