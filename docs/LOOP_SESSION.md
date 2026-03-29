# Loop Session

> Loop Session 是一种**自主持续运行**的 Agent 模式：将一个普通会话标记为 loop，
> 服务按固定间隔读取 `TASK.md` 任务文件，调用 LLM 执行，结果按策略推送到 QQ。
> 无需用户手动触发，适合监控、定期汇报、自动化巡检等场景。

---

## 与 Cron 的区别

| | Cron Job | Loop Session |
|---|---|---|
| 驱动方式 | 外部调度（once / every / daily）| 服务内 setInterval |
| 上下文 | 每次独立 session（stateful 可选）| 常驻 session，记忆累积 |
| 任务来源 | job JSON 中的 `message` 字段 | `TASK.md` 文件（可随时修改）|
| 配置位置 | `~/.tinyclaw/cron/jobs/<id>.json` | `~/.tinyclaw/sessions/<id>.toml` |
| 适合场景 | 一次性任务、定时推送 | 需要记忆积累的持续智能体 |

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
| `qqbot:group:GROUPID` | `sessions/qqbot_group_GROUPID.toml` |

**配置文件格式（`[loop]` 块）：**

```toml
[loop]
enabled     = true
agentId     = "default"       # 走哪个 Agent 的记忆（SYSTEM.md / MEM.md）
tickSeconds = 300             # 每 5 分钟 tick 一次
taskFile    = "TASK.md"       # 任务指令文件路径
notify      = "on_change"     # 推送策略（见下方说明）
peerId      = "你的QQ号"       # 推送目标
msgType     = "c2c"           # c2c / group / guild / dm
# model     = "copilot/gpt-4o"  # 可选，覆盖默认模型
```

### 字段说明

| 字段 | 类型 | 默认值 | 说明 |
|---|---|---|---|
| `enabled` | bool | — | `false` 则此 loop 不启动 |
| `agentId` | string | `default` | 使用哪个 Agent 的系统提示与记忆 |
| `tickSeconds` | int | `60` | tick 间隔（秒），建议 ≥ 60 |
| `taskFile` | string | `TASK.md` | 任务指令文件（绝对路径，或相对 agentDir）|
| `notify` | string | `never` | 推送策略，见下方 |
| `peerId` | string | — | QQ 推送目标 ID（不填则不推送）|
| `msgType` | string | `c2c` | 消息类型：c2c / group / guild / dm |
| `model` | string | 同 daily | 覆盖模型，格式 `provider/model-id` |

---

## TASK.md 写法

`taskFile` 是每次 tick 注入 Agent 的任务指令，可随时修改，下次 tick 时生效。

**默认路径**：`~/.tinyclaw/agents/<agentId>/TASK.md`（相对 agentDir）

**示例：日志监控**

```markdown
检查 /home/lyy/app/logs/error.log，统计最近 1 小时的错误数量和类型。
若错误数 > 10 则在输出中包含 [ALERT] 标记。
输出格式：错误总数 / 主要错误类型 / 简要说明
```

**示例：价格追踪**

```markdown
查询 BTC 当前价格（用 exec_shell curl 工具获取实时数据，不得使用记忆中的旧值）。
与上次 MEM.md 中记录的价格对比，计算涨跌幅。
更新 MEM.md 中的价格记录。
输出：价格 / 涨跌幅 / 简要趋势分析（一句话）
```

---

## 推送策略

| 策略 | 说明 |
|---|---|
| `always` | 每次 tick 都推送结果 |
| `on_change` | 仅当结果与上次不同时推送（适合监控场景）|
| `on_error` | 仅当 Agent 执行出错时推送 |
| `never` | 不推送（结果仅写日志） |

---

## CLI 管理

所有操作通过 `tinyclaw chat loop` 子命令完成，**无需手动编辑 TOML 文件**。

```bash
# 查看所有启用的 loop session
tinyclaw chat loop list

# 查看指定 session 的 loop 配置（含配置文件路径）
tinyclaw chat loop show cli:abc-123
tinyclaw chat loop show qqbot:c2c:OPENID

# 启用（或新建）一个 session 的 loop，使用默认配置
tinyclaw chat loop enable cli:abc-123

# 禁用 loop（不删除配置，仅将 enabled 设为 false）
tinyclaw chat loop disable cli:abc-123

# 修改单个配置字段
tinyclaw chat loop set cli:abc-123 tickSeconds=300
tinyclaw chat loop set cli:abc-123 notify=on_change
tinyclaw chat loop set cli:abc-123 peerId=你的QQ号
tinyclaw chat loop set cli:abc-123 msgType=c2c
tinyclaw chat loop set cli:abc-123 model=copilot/gpt-4o
tinyclaw chat loop set cli:abc-123 taskFile=/home/lyy/my-task.md

# 立即触发一次 tick（不影响定时计划，需服务运行）
tinyclaw chat loop trigger cli:abc-123
```

**可用的 `set` 字段**：`agentId` / `tickSeconds` / `taskFile` / `notify` / `peerId` / `msgType` / `model` / `enabled`

---

## 快速上手

### 场景：为 QQ 私聊会话设置每日总结

```bash
# 1. 查看当前会话 ID（或让 QQ 用户向机器人发一条消息后查看）
tinyclaw chat list

# 2. 为该会话启用 loop（使用默认配置）
tinyclaw chat loop enable qqbot:c2c:你的OPENID

# 3. 配置间隔和推送策略
tinyclaw chat loop set qqbot:c2c:你的OPENID tickSeconds=3600
tinyclaw chat loop set qqbot:c2c:你的OPENID notify=always
tinyclaw chat loop set qqbot:c2c:你的OPENID peerId=你的OPENID

# 4. 创建任务文件
cat > ~/.tinyclaw/agents/default/TASK.md << 'EOF'
总结今天 MEM.md 中记录的工作内容，生成一份简短的每日汇报。
若无记录则输出"今日暂无记录"。
EOF

# 5. 重启服务使配置生效
tinyclaw restart

# 6. 验证（立即触发一次测试）
tinyclaw chat loop trigger qqbot:c2c:你的OPENID
```

### 场景：自定义 Agent 运行独立任务

```bash
# 1. 创建专用 Agent
tinyclaw agent new monitor

# 2. 为 Agent 创建任务文件
cat > ~/.tinyclaw/agents/monitor/TASK.md << 'EOF'
检查系统负载：用 exec_shell 执行 uptime 和 free -h。
若 load > 4.0 或内存使用率 > 90% 则在输出中包含 [WARN]。
输出：负载 / 内存使用率 / 状态
EOF

# 3. 创建一个 loop session（可以是虚拟会话名）
# 先确认有一个 session ID，或直接手动创建 toml 文件
tinyclaw chat loop enable cli:monitor-task
tinyclaw chat loop set cli:monitor-task agentId=monitor
tinyclaw chat loop set cli:monitor-task tickSeconds=300
tinyclaw chat loop set cli:monitor-task notify=on_error
tinyclaw chat loop set cli:monitor-task peerId=你的QQ号

# 4. 重启
tinyclaw restart
```

---

## 运行机制

### 启动

服务启动时，`LoopRunner.start()` 扫描所有 `sessions/*.toml`，
找出 `[loop] enabled = true` 的文件，为每个启用的 session 启动 `setInterval`。

### tick 执行

```
tick 触发
│
├─ 并发保护：同一 session 上次 tick 未完成 → 跳过本次
├─ 读取 taskFile 内容（为空则跳过）
├─ 复用或创建常驻 Session 实例（复用 messages 历史）
├─ 调用 runAgent(session, taskContent)
│    └─ 注入 Loop Agent 专用 system prompt（无人值守规则）
├─ 写 cron 日志（~/.tinyclaw/cron/logs/loop:<sessionId>.jsonl）
└─ 按 notify 策略决定是否通过 Connector 推送结果
```

### 注意事项

- **并发保护**：同一 session 上次 tick 还未完成时，新 tick 自动跳过，不会叠加执行
- **任务文件为空**：跳过本次 tick，不调用 LLM
- **任务文件不存在**：跳过并打印警告，不报错
- **常驻 Session**：loop session 复用同一个 Session 实例，记忆会持续累积，MEM.md 可被 Agent 主动更新
- **配置变更生效**：修改 `.toml` 后需重启服务（`tinyclaw restart`）才生效
- **日志位置**：`~/.tinyclaw/cron/logs/loop:<sanitized-sessionId>.jsonl`

---

## 配置文件结构速查

```toml
# ~/.tinyclaw/sessions/qqbot_c2c_OPENID.toml

[loop]
enabled     = true
agentId     = "default"
tickSeconds = 300
taskFile    = "TASK.md"
notify      = "on_change"
peerId      = "OPENID"
msgType     = "c2c"
```

> Loop 配置文件与 session JSONL 位于同一目录（`~/.tinyclaw/sessions/`），
> 文件名以 `.toml` 结尾，而 JSONL 持久化文件以 `.jsonl` 结尾。
