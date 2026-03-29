# 跨 Session 通信：session_get / session_send

## 概述

`session_get` 和 `session_send` 工具允许不同 Agent 的 session 之间传递消息，实现跨 session 协作。

典型用例：
- **Loop session 汇报结果**：自动化任务 session 在完成分析后，向用户的主 session 推送摘要
- **任务分派**：主 Agent 向专用 Agent session 分派子任务
- **多 Agent 协同**：多个专用 Agent 并行工作，通过消息互相协调

---

## 权限模型

基于**双向 allow-list**（默认 deny）。必须同时满足以下两个条件才允许通信：

1. **发送方的 `can_access`** 包含接收方的 agentId
2. **接收方的 `allow_from`** 包含发送方的 agentId

任一条件不满足 → 拒绝，返回详细的权限错误提示。

### 配置文件

位置：`~/.tinyclaw/agents/<agentId>/access.toml`

```toml
# 示例：agent "monitor" 的 access.toml
# 允许向 "default" agent 的 session 发送消息
can_access = ["default"]

# 允许来自 "controller" agent 的消息
allow_from = ["controller"]
```

#### 字段说明

| 字段 | 含义 |
|------|------|
| `can_access` | 本 agent 可以向哪些 agentId 的 session 发消息（发送白名单） |
| `allow_from` | 允许哪些 agentId 的 agent 向本 agent 的 session 发消息（接收白名单） |

文件不存在 = 两个列表均为空 = 默认拒绝所有跨 session 通信。

---

## 工具说明

### `session_get`

列举对当前 Agent 可见的所有活跃 session。

**参数**：无

**返回**：JSON 数组，每项包含：
- `sessionId`：会话标识符
- `agentId`：绑定的 Agent ID
- `running`：当前是否正在执行任务
- `isLoop`：是否为 loop session

**示例输出**：
```json
[
  {
    "sessionId": "qqbot:c2c:OPENID",
    "agentId": "default",
    "running": false,
    "isLoop": false
  }
]
```

---

### `session_send`

向指定 session 注入一条消息，触发该 session 的 Agent 处理任务。

**参数**：
- `target_session_id`（必填）：目标 session 的 ID（可通过 `session_get` 获取）
- `message`（必填）：要注入的消息内容

**执行流程**：
1. 检查 access.toml 双向权限
2. 若目标 session 正在运行，等待当前任务完成
3. 注入消息（格式：`[来自 <agentId> @ <时间>] <message>`），走完整 runAgent 路径

**注意事项**：
- `session_send` 为串行工具，同一 runAgent 内不会并发调用
- 目标 session 若不存在，会自动创建（与现有的 lazy init 机制一致）
- 仅在完整服务模式下可用（CLI/cron 模式下返回错误）

---

## 配置示例

### 场景：loop session 向主 session 汇报

假设有：
- `monitor` agent：运行 loop session，定期监控某些指标
- `default` agent：用户的主交互 session

**`~/.tinyclaw/agents/monitor/access.toml`**：
```toml
# monitor 可以向 default agent 的 session 发消息
can_access = ["default"]
```

**`~/.tinyclaw/agents/default/access.toml`**：
```toml
# default 允许接收来自 monitor 的消息
allow_from = ["monitor"]
```

### loop session 的 TASK.md 示例

```markdown
检查系统状态，如有异常，使用 session_get 工具找到用户的主 session（agentId=default），
再用 session_send 工具发送告警消息。
```

---

## 可用性

| 运行模式 | session_get | session_send |
|----------|-------------|--------------|
| QQBot 完整服务 | ✅ | ✅ |
| IPC-only 服务 | ✅ | ✅ |
| CLI chat | ❌（返回错误） | ❌（返回错误） |
| cron job | ❌（返回错误） | ❌（返回错误） |
