# Loop Agent（已废弃）

> ⚠️ **此文档已废弃。**
>
> Loop 配置已从 **Agent 维度**（`agent.toml [loop]`）迁移到 **Session 维度**（`sessions/<id>.toml [loop]`）。
> CLI 入口从 `tinyclaw agent loop` 改为 `tinyclaw chat loop`。
>
> **请查阅新文档：[LOOP_SESSION.md](./LOOP_SESSION.md)**

---

> 以下内容仅作历史参考，**勿用于新部署**。

---

## 与 Cron 的区别

| | Cron | Loop Agent |
|---|---|---|
| 驱动方式 | 外部调度（once / every / daily）| Agent 内置 setInterval |
| 上下文 | 每次独立 session（stateful 可选）| 常驻 session，记忆累积 |
| 任务来源 | job JSON 中的 `message` 字段 | `TASK.md` 文件（可动态修改）|
| 适合场景 | 一次性任务、定时推送 | 需要记忆积累的持续智能体 |

---

## 配置方式

在 `~/.tinyclaw/agents/<id>/agent.toml` 中添加 `[loop]` 块：

```toml
id = "my-monitor"
createdAt = "2026-01-01T00:00:00Z"

[loop]
enabled     = true
tickSeconds = 300          # 每 5 分钟 tick 一次
taskFile    = "TASK.md"    # 相对于 agent 目录，默认 TASK.md
notify      = "on_change"  # 推送策略（见下方说明）
peerId      = "你的QQ号"   # 推送目标
msgType     = "c2c"        # c2c / group / guild / dm
# model     = "copilot/gpt-4o"  # 可选，覆盖默认模型
```

### 字段说明

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | bool | — | `false` 则跳过此 Agent |
| `tickSeconds` | int | — | tick 间隔（秒），最小建议 60 |
| `taskFile` | string | `TASK.md` | 任务指令文件路径（相对 agent 目录）|
| `notify` | string | `never` | 推送策略，见下方 |
| `peerId` | string | — | QQ 推送目标 ID |
| `msgType` | string | `c2c` | 消息类型：c2c / group / guild / dm |
| `model` | string | 同 daily | 覆盖模型（格式 `provider/model-id`）|

---

## TASK.md 写法

`TASK.md` 是每次 tick 注入 Agent 的任务指令，可随时修改（下次 tick 生效）：

```markdown
检查 /home/lyy/app/logs/error.log，统计最近1小时的错误数量和类型，
若错误数 > 10 则在输出中包含 [ALERT] 标记。
输出格式：错误总数 / 主要错误类型 / 简要说明
```

---

## 推送策略

| 策略 | 说明 |
|---|---|
| `always` | 每次 tick 都推送结果 |
| `on_change` | 仅当结果与上次不同时推送 |
| `on_error` | 仅当 Agent 执行出错时推送 |
| `never` | 不推送（结果仅写日志） |

---

## 注意事项

- **并发保护**：同一 Agent 上一次 tick 还未完成时，新 tick 自动跳过
- **任务文件为空**：跳过本次 tick，不调用 LLM
- **任务文件不存在**：跳过并打印警告，不报错
- **session 常驻**：Loop Agent 复用同一个 Session，记忆会累积，MEM.md 可被 Agent 主动更新
- **日志**：每次 tick 结果追加到 `~/.tinyclaw/cron/logs/loop:<agent-id>.jsonl`

---

## CLI 管理

> ⚠️ 以下命令已废弃，请使用 `tinyclaw chat loop` 系列命令。

目前 Loop Agent 通过直接编辑 `agent.toml` 启停，重启 tinyclaw 生效：

```bash
# ❌ 已废弃：不再支持在 agent.toml 中配置 [loop]
tinyclaw agent edit <id>    # 编辑 agent.toml（含 [loop] 配置）
tinyclaw restart            # 重启服务使配置生效
```

**新方式：**

```bash
tinyclaw chat loop enable <sessionId>   # 启用/新建 loop
tinyclaw chat loop set <sessionId> <key=value>  # 配置字段
tinyclaw restart                         # 重启生效
```
