# Plan Mode 调研：vscode-copilot-chat 实现分析

本文档记录了对 vscode-copilot-chat 仓库中 **plan mode** 功能的调研结果，供 tinyclaw 参考实现。

---

## 背景

Plan mode 是一种"先规划、后执行"的工作流，AI 在执行代码变更之前先输出计划，经用户确认后才真正动手。这在需要多文件修改的复杂任务中尤为有价值。

vscode-copilot-chat 中存在**两套 plan mode 实现**，分别对应两个不同的 agent 后端：

1. **Claude (Anthropic) Plan Mode** — 位于 `src/extension/chatSessions/claude/`
2. **CopilotCLI Plan Mode** — 位于 `src/extension/chatSessions/copilotcli/`（即本 CLI 工具使用的实现）

---

## 一、Claude Plan Mode

### 核心机制

通过两个特殊工具实现状态机切换：

| 工具 | 触发方 | 参数 | 效果 |
|------|--------|------|------|
| `EnterPlanMode` | Claude 主动调用 | 无 | permissionMode → `"plan"` |
| `ExitPlanMode` | Claude 规划完成后调用 | `plan?: string`（计划内容）, `allowedPrompts` | permissionMode → `"acceptEdits"` |

### 工作流

```
用户发消息
  └→ Claude 调用 EnterPlanMode
       └→ permissionMode = "plan"（此阶段不允许文件写入）
            └→ Claude 思考并输出计划
                 └→ Claude 调用 ExitPlanMode(plan: "...")
                      └→ 弹出 "Ready to code?" 对话框
                           ├→ Approve → permissionMode = "acceptEdits"，开始执行
                           └→ Deny → 返回 "The user declined the plan, maybe ask why?"
```

### 关键文件

- `src/extension/chatSessions/claude/common/claudeTools.ts`
  - `ClaudeToolNames.EnterPlanMode` / `ExitPlanMode` — 工具名枚举
  - `ExitPlanModeInput` — 扩展了 SDK 类型，添加 `plan?: string` 字段
  - `EnterPlanModeInput` — 空接口（无参数）

- `src/extension/chatSessions/claude/node/hooks/toolHooks.ts`
  - `PlanModeHook` — PostToolUse hook
  - 检测 EnterPlanMode → `setPermissionModeForSession(sessionId, 'plan')`
  - 检测 ExitPlanMode → `setPermissionModeForSession(sessionId, 'acceptEdits')`

- `src/extension/chatSessions/claude/common/toolPermissionHandlers/exitPlanModeHandler.ts`
  - `ExitPlanModeToolHandler` — 处理 ExitPlanMode 工具调用
  - 弹出包含计划内容的确认对话框（Approve / Deny）

---

## 二、CopilotCLI Plan Mode（本 CLI 工具的实现）

### 核心机制

通过 SDK 的事件系统实现，而非静态工具：

- 本 CLI agent 调用 `exit_plan_mode` 工具，携带 `summary`, `actions[]`, `recommendedAction`
- SDK 将其转换为 `exit_plan_mode.requested` 事件，暂停执行，等待宿主响应
- 宿主（VS Code extension）调用 `respondToExitPlanMode(requestId, { approved, selectedAction })`

### 工具定义

```typescript
type ExitPlanModeTool = {
  toolName: 'exit_plan_mode';
  arguments: {
    summary: string;           // 计划摘要（展示给用户）
    actions?: string[];        // 可选操作列表，如 ["autopilot", "interactive", "exit_only"]
    recommendedAction?: string; // 推荐选项
  };
};
```

### 权限级别下的行为

| permissionLevel | 行为 |
|-----------------|------|
| `autopilot` | 自动批准，优先选 `autopilot` > `interactive` > `exit_only` |
| `autoApprove` | 弹出确认框，批准后自动审批后续编辑 |
| `interactive` | 弹出确认框，用户选择 |

### 响应结构

```typescript
respondToExitPlanMode(requestId, {
  approved: boolean,
  selectedAction?: 'autopilot' | 'interactive' | 'exit_only',
  autoApproveEdits?: boolean,
})
```

### 关键文件

- `src/extension/chatSessions/copilotcli/node/copilotcliSession.ts`
  - 监听 `exit_plan_mode.requested` 事件（L347-L409）
  - 根据权限级别决定自动批准或弹窗

- `src/extension/chatSessions/copilotcli/common/copilotCLITools.ts`
  - `ExitPlanModeTool` 类型定义（L289）
  - `formatExitPlanModeInvocation` — UI 消息格式化

- 配置项：`chat.advanced.cli.planMode.enabled`（总开关）
- 配置项：`chat.advanced.cli.planExitMode.enabled`（exit plan mode 事件处理开关）

---

## 三、两种实现的对比

| 维度 | Claude Plan Mode | CopilotCLI Plan Mode |
|------|------------------|----------------------|
| 触发方式 | AI 主动调用工具 | AI 调用工具 → SDK 事件 |
| 进入 plan 阶段 | `EnterPlanMode` 工具 | 由 prompt/状态控制 |
| 退出 plan 阶段 | `ExitPlanMode` 工具 | `exit_plan_mode` 工具 |
| 用户交互 | VS Code 对话框 | VS Code 确认工具 |
| 状态存储 | `sessionStateService.permissionMode` | `_permissionLevel` 字段 |
| 自动化支持 | 无显式 autopilot | autopilot 模式自动批准 |

---

## 四、对 tinyclaw 的启示

tinyclaw 当前已实现 `/code` 模式（无历史记录的编码会话）。若要实现类似的 plan mode，有两种路线：

### 方案 A：斜杠命令触发（轻量）
- 用户手动发 `/plan` 进入规划模式，AI 输出计划后用户确认，再发 `/execute` 执行
- 实现简单，无需 SDK 支持
- 缺点：用户需要手动协调

### 方案 B：工具触发（与 CopilotCLI 一致）
- 提供 `exit_plan_mode` 工具，AI 在规划完成后调用
- 工具处理器暂停执行，向用户展示计划摘要，等待确认
- 确认后 AI 继续执行；拒绝则返回否定反馈
- 需要在 `agent.ts` 中实现工具调用拦截和暂停/恢复机制

### 核心实现要点（方案 B）

1. **工具定义**：注册 `exit_plan_mode` 工具（description 引导 AI 在规划完成后调用）
2. **拦截机制**：在 agent loop 中检测到该工具调用时，暂停循环
3. **用户交互**：将计划展示给用户（CLI 中打印到终端），等待用户输入 `y/n`
4. **恢复/终止**：
   - 用户批准 → 返回 `{ approved: true }` 作为工具结果，AI 继续执行
   - 用户拒绝 → 返回 `{ approved: false, reason: "..." }`，AI 询问原因或调整计划
5. **System prompt**：在 prompt 中说明何时应调用 `exit_plan_mode`（任务分析完成、即将修改多个文件时）

---

## 五、Plan Agent（独立规划 Agent）

除了上述工具驱动的 plan mode，vscode-copilot-chat 还实现了一个**独立的 Plan Agent**，是一个专门用于规划的 agent provider。

### 定义位置
`src/extension/agents/vscode-node/planAgentProvider.ts`

### 设计理念
```
You are a PLANNING AGENT, pairing with the user to create a detailed, actionable plan.
You research the codebase → clarify with the user → capture findings and decisions.
Your SOLE responsibility is planning. NEVER start implementation.
```

### 工作流阶段
1. **Discovery** — 并行启动 2-3 个 Explore 子 agent 收集上下文
2. **Alignment** — 用 `askQuestions` 工具澄清模糊需求
3. **Design** — 生成包含依赖关系、文件列表、验证步骤的完整计划
4. **Refinement** — 根据用户反馈迭代修改计划

### 工具限制
- **允许使用**：Read, Explore（子 agent）、Bash（只读）、AskQuestions、Memory（持久化计划）
- **禁止使用**：Edit, Write, MultiEdit, NotebookEdit（通过 `EditToolHandler` 块）
- **计划存储**：写入 `vscode/memory` 工具，路径 `/memories/session/plan.md`

### 计划格式规范（内置于 system prompt）
- TL;DR 摘要段
- 带依赖/并行标注的编号步骤
- 相关文件列表（精确到函数/模式）
- 验证步骤
- 决策依据
- 待用户确认的进一步考量

### Handoff 按钮
计划完成后展示两个操作按钮：
- `Start Implementation` → 切换到实现 agent，携带 "Start implementation" 消息
- `Open in Editor` → 以 untitled 文件打开计划，供手动修改

---

## 六、权限模式完整列表

```typescript
type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk'
```

| Mode | 含义 | 编辑行为 |
|------|------|---------|
| `default` | Ask before edits | 每次编辑前询问用户 |
| `acceptEdits` | Edit automatically | 自动批准工作区内文件编辑 |
| `plan` | Plan mode | 阻止所有编辑工具 |
| `bypassPermissions` | Bypass all permissions | 自动批准所有工具 |

`EditToolHandler.canAutoApprove()` 中：
- `acceptEdits` / `bypassPermissions` → 直接返回 `true`
- `default` → 返回 `false`（询问）
- `plan` → 未处理，fallthrough 到工作区文件检查（实际被 SDK 层面阻断）

---

## 七、参考资料

- Claude Plan Mode: `vscode-copilot-chat/src/extension/chatSessions/claude/`
- CopilotCLI Plan Mode: `vscode-copilot-chat/src/extension/chatSessions/copilotcli/node/copilotcliSession.ts`
- Plan Agent Provider: `vscode-copilot-chat/src/extension/agents/vscode-node/planAgentProvider.ts`
- Edit Tool Handler: `vscode-copilot-chat/src/extension/chatSessions/claude/node/toolPermissionHandlers/editToolHandler.ts`
- Session State Service: `vscode-copilot-chat/src/extension/chatSessions/claude/node/claudeSessionStateService.ts`
- 测试用例: `src/extension/chatSessions/copilotcli/node/test/copilotcliSession.spec.ts` (L1088)
- 测试用例 (PlanModeHook): `src/extension/chatSessions/claude/node/test/planModeHook.spec.ts`
- Claude SDK 工具定义: `@anthropic-ai/claude-agent-sdk/sdk-tools`
