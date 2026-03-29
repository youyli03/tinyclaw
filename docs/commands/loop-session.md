# Loop Session

> Loop Session 是一种**自主持续运行**的 Agent 模式：将一个普通 session 标记为 loop，
> 服务按固定间隔读取 `TASK.md` 任务文件，将其内容作为一条"用户消息"注入该 session，
> 走完整的 `runAgent` 路径执行。无需用户手动触发，适合监控、定期巡检、自动化任务等场景。

---

## 与 Cron 的区别

| | Cron Job | Loop Session |
|---|---|---|
| 驱动方式 | 外部调度（once / every / daily）| 服务内串行循环（上次结束后等待 N 秒）|
| 上下文 | 每次独立 session（stateful 可选）| 常驻 session，对话历史与记忆持续积累 |
| 任务来源 | job JSON 中的 `message` 字段 | `TASK.md` 文件（可随时修改）|
| System Prompt | 无，或 job 指定 | 使用绑定 Agent 自己的 `SYSTEM.md` |
| 推送结果 | notify 策略（always/on_change 等）| Agent 自行调用 `notify_user` / `send_report` 工具 |
| 配置位置 | `~/.tinyclaw/cron/jobs/<id>.json` | `~/.tinyclaw/sessions/<id>.toml` |
| 适合场景 | 一次性任务、定时推送 | 需要记忆积累的持续自主 Agent |

---

## 间隔语义

间隔是**串行 delay**，而非固定 `setInterval`：

```
tick 执行中（runAgent）
     ↓ 结束
等待 tickSeconds 秒
     ↓
下一次 tick 开始
```

这意味着若任务执行耗时超过 `tickSeconds`，不会叠加触发；实际执行频率 = 执行时长 + 等待时长。

---

## 配置文件

Loop 配置存储在与 session JSONL 同目录的 TOML 文件中：

```
~/.tinyclaw/sessions/<sanitized-sessionId>.toml
```

**sessionId 转换规则（sanitized）**：将 `:` 和 `/` 替换为 `_`。

| sessionId | 配置文件 |
|---|---|
| `cli:abc-123` | `sessions/cli_abc-123.toml` |
| `qqbot:c2c:OPENID` | `sessions/qqbot_c2c_OPENID.toml` |

**配置文件格式（`[loop]` 块）：**

```toml
[loop]
enabled     = true
agentId     = "default"       # 走哪个 Agent 的 SYSTEM.md / MEM.md
tickSeconds = 300             # 上次执行结束后等待 5 分钟再触发
taskFile    = "TASK.md"       # 任务指令文件路径
```

### 字段说明

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | bool | — | `false` 则此 loop 不启动 |
| `agentId` | string | `default` | 使用哪个 Agent 的系统提示与记忆 |
| `tickSeconds` | int | `60` | 上次执行结束后等待的秒数，建议 ≥ 60 |
| `taskFile` | string | `TASK.md` | 任务指令文件（绝对路径，或相对 agentDir）|

---

## TASK.md 写法

`taskFile` 的内容在每次 tick 时作为一条"用户消息"注入 session，可随时修改，下次 tick 时生效。

**默认路径**：`~/.tinyclaw/agents/<agentId>/TASK.md`（相对 agentDir）

**示例：日志监控**

```markdown
检查 /home/lyy/app/logs/error.log，统计最近 1 小时的错误数量和类型。
若错误数 > 10，调用 notify_user 工具发送告警。
输出格式：错误总数 / 主要错误类型 / 简要说明
```

**示例：价格追踪**

```markdown
查询 BTC 当前价格（用 exec_shell curl 工具获取实时数据，不得使用记忆中的旧值）。
与上次 MEM.md 中记录的价格对比，计算涨跌幅。
更新 MEM.md 中的价格记录。
若涨跌幅超过 5%，调用 notify_user 推送提醒。
输出：价格 / 涨跌幅 / 简要趋势分析（一句话）
```

> **推送结果**：Loop session 不内置推送机制。若需通知到 QQ，在 TASK.md 中指示 Agent
> 调用 `notify_user` 工具（即时通知）或 `send_report` 工具（渲染为图片）。

---

## CLI 管理

```bash
# 查看所有启用的 loop session
tinyclaw chat loop list

# 查看指定 session 的 loop 配置（含配置文件路径）
tinyclaw chat loop show cli:abc-123

# 启用（或新建）一个 session 的 loop，使用默认配置
tinyclaw chat loop enable cli:abc-123

# 禁用 loop（不删除配置，仅将 enabled 设为 false）
tinyclaw chat loop disable cli:abc-123

# 修改单个配置字段
tinyclaw chat loop set cli:abc-123 tickSeconds=300
tinyclaw chat loop set cli:abc-123 agentId=mybot
tinyclaw chat loop set cli:abc-123 taskFile=/home/lyy/my-task.md

# 立即触发一次 tick（不影响定时计划，需服务运行）
tinyclaw chat loop trigger cli:abc-123

# 创建新 session 时直接启用 loop（默认 60s 间隔）
tinyclaw chat new --loop
tinyclaw chat new --agent mybot --loop --interval 300
```

**可用的 `set` 字段**：`agentId` / `tickSeconds` / `taskFile` / `enabled`

---

## 快速上手

```bash
# 1. 创建一个 loop session
tinyclaw chat new --loop --interval 300

# 2. 创建任务文件（默认路径 ~/.tinyclaw/agents/default/TASK.md）
cat > ~/.tinyclaw/agents/default/TASK.md << 'EOF'
检查系统负载：用 exec_shell 执行 uptime 和 free -h。
若 load > 4.0 或内存使用率 > 90%，调用 notify_user 工具发送告警。
输出：负载 / 内存 / 状态
EOF

# 3. 重启服务使配置生效
tinyclaw restart

# 4. 验证（立即触发一次测试）
tinyclaw chat loop trigger <sessionId>
```

---

## 运行机制

### 启动

服务启动时，`LoopRunner.start()` 扫描所有 `sessions/*.toml`，
找出 `[loop] enabled = true` 的文件，为每个 session 启动一个串行循环（首次 tick 在等待 `tickSeconds` 后触发）。

### tick 执行流程

```
等待 tickSeconds 秒
  │
  ├─ 重新读取 loop 配置（支持动态修改，下次 tick 生效）
  ├─ 若配置已移除（enabled=false）→ 退出循环
  ├─ 读取 taskFile 内容（为空则跳过）
  ├─ 调用 runAgent(session, taskContent)
  │    └─ 完全使用绑定 Agent 的 SYSTEM.md 和 MEM.md
  │    └─ Agent 可调用所有工具（含 notify_user / send_report）
  └─ 等待 tickSeconds 秒 → 下一次 tick
```

### 注意事项

- **串行执行**：同一 session 不会并发触发，上次 tick 未结束时新 tick 自动跳过
- **任务文件为空**：跳过本次 tick，不调用 LLM
- **任务文件不存在**：跳过并打印警告，不报错
- **常驻 Session**：loop session 复用同一个 Session 实例，记忆持续积累，Agent 可主动更新 MEM.md
- **配置变更生效**：修改 `.toml` 后需重启服务（`tinyclaw restart`）才生效；`taskFile` 内容可实时修改，下次 tick 时读取最新内容
