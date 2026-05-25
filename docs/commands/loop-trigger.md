# Loop Trigger

> Loop Trigger 是 tinyclaw 的**自主持续监控引擎**：按固定间隔触发、支持时间段过滤、可绑定任意 QQ session 推送，适合盘中监控、行情巡检、自动告警等场景。

与旧式 Loop Session 的区别：

| | 旧式 Loop Session | Loop Trigger |
|---|---|---|
| 配置位置 | `~/.tinyclaw/sessions/<id>.toml` | `~/.tinyclaw/loops/<id>.json` |
| 任务来源 | `TASK.md` 文件 | 配置中的 `message` + `steps` |
| 绑定方式 | session 本身就是 loop | 通过 `bindTo` 绑定任意 session |
| 多 bot 支持 | 否 | 是（`botId` 指定发送 bot）|
| 时间段过滤 | 否 | 是（`timeRanges`） |
| 预检脚本 | 否 | 是（`preCheckScript`） |
| 允许 AI 自主退出 | 否 | 是（`allowExit` + `loop_exit` 工具）|
| stateful | 可选 | 永远 stateful（历史自动压缩）|

---

## 配置文件

存放在 `~/.tinyclaw/loops/<id>.json`，修改后调度器自动重新加载（无需重启服务）。

### 完整字段说明

| 字段 | 类型 | 必填 | 默认值 | 说明 |
|------|------|------|--------|------|
| `id` | string | ✅ | — | 触发器唯一 ID，与文件名一致 |
| `enabled` | bool | — | `true` | `false` 则不触发 |
| `bindTo` | string | ✅ | — | 绑定的 session ID（如 `qqbot:c2c:OPENID`）|
| `agentId` | string | — | `"default"` | 使用哪个 Agent 的系统提示与记忆 |
| `tickSeconds` | int | — | `60` | 上次 tick 结束后等待的秒数 |
| `steps` | array | — | — | 顺序执行的工具步骤（输出拼为 message 前缀）|
| `message` | string | — | — | 注入 session 的 user 消息（steps 输出在其前面）|
| `timeRanges` | array/object | — | 全天 | 时间段过滤，段外静默跳过 |
| `allowExit` | bool | — | `false` | 是否允许 AI 调用 `loop_exit` 退出本轮 |
| `notify` | string | — | `"never"` | 推送策略：`always` / `llm` / `never` |
| `botId` | string | — | 第一个 bot | 发送消息使用的 bot（对应 config.toml `[channels.qqbots.<botId>]`）|
| `preCheckScript` | string | — | — | 预检脚本路径，退出码非 0 则跳过本次 tick |

---

## steps 字段

steps 中的工具按顺序执行，每步输出拼接为字符串前缀，最后与 `message` 合并注入 session。

```json
{
  "steps": [
    {
      "type": "tool",
      "name": "exec_shell",
      "args": { "command": "python3 /path/to/monitor.py" }
    }
  ]
}
```

- 目前只支持 `type: "tool"`（直接调用已注册工具，不走 LLM）
- `name` 必须是已注册工具名（如 `exec_shell`、`http_request` 等）
- 多个 steps 的输出以空行分隔，拼在 `message` 前面
- 任意 step 抛出异常则整个 tick 失败，后续 steps 不执行

---

## timeRanges 字段

指定允许触发的时间段，段外静默跳过。

```json
"timeRanges": [
  { "start": "09:15", "end": "11:31", "weekdays": [1,2,3,4,5] },
  { "start": "13:00", "end": "15:00", "weekdays": [1,2,3,4,5] }
]
```

| 字段 | 说明 |
|------|------|
| `start` | 开始时间（含），格式 `"HH:MM"`，本地时间 |
| `end` | 结束时间（不含） |
| `weekdays` | 可选，`0`=周日，`1`=周一...`6`=周六；不填=每天 |

不配置 `timeRanges` = 全天任何时间都触发。

---

## notify 推送策略

| 值 | 行为 |
|----|------|
| `"never"` | 不主动推送（默认），依赖 Agent 调用 `notify_user` / `send_report` |
| `"always"` | 每次 tick 结束后将 LLM 完整回复推送给用户 |
| `"llm"` | 由 LLM 决定：回复含 `[NOTIFY]...[/NOTIFY]` 块才推送，其余静默 |

**llm 模式的 NOTIFY 格式：**

```
[NOTIFY]
需要推送给用户的内容（可多个块，每块独立发送）
[/NOTIFY]
```

---

## allowExit — AI 自主退出

设置 `"allowExit": true` 后，Agent 可通过调用 `loop_exit` 工具退出本次时间窗口：

- 退出后，本时间窗口内不再 tick
- 下次进入时间窗口时自动重置，继续 tick
- 适合「监控到目标后自动停止」的场景

在 `message` 中写明退出条件，让 AI 知道什么情况调用 `loop_exit`。

---

## preCheckScript 预检脚本

每次 tick 前先运行该脚本，退出码非 0 则静默跳过本次 tick。

```json
"preCheckScript": "/home/lyy/.tinyclaw/loops/scripts/is_trading_day.py"
```

| 退出码 | 行为 |
|--------|------|
| 0 | 正常执行本次 tick |
| 非 0 | 静默跳过，等待下次 tick |
| 不存在 / 超时 | 同非 0 |

**交易日判断脚本示例：**

```python
#!/usr/bin/env python3
import datetime, sys
now = datetime.datetime.now()
if now.weekday() >= 5:   # 周末
    sys.exit(1)
sys.exit(0)
```

---

## botId — 多 bot 路由

系统配置多个 QQ bot 时，用 `botId` 指定发送 bot：

```json
"botId": "chat"
```

对应 `config.toml` 中的 `[channels.qqbots.chat]`。不填则 fallback 到第一个 bot。

---

## 完整示例：盘中股票监控

```json
{
  "id": "monitor",
  "enabled": true,
  "bindTo": "qqbot:c2c:YOUR_OPENID",
  "agentId": "default",
  "tickSeconds": 60,
  "steps": [
    {
      "type": "tool",
      "name": "exec_shell",
      "args": { "command": "python3 /home/lyy/.tinyclaw/loops/scripts/market_data.py" }
    }
  ],
  "message": "你是盘中监控助手。根据上方数据分析持仓和关注股，有信号则用 [NOTIFY]...[/NOTIFY] 推送，无信号保持静默。持仓为空且无关注股信号时调用 loop_exit。",
  "timeRanges": [
    { "start": "09:15", "end": "11:31", "weekdays": [1,2,3,4,5] },
    { "start": "13:00", "end": "15:00", "weekdays": [1,2,3,4,5] }
  ],
  "allowExit": true,
  "notify": "llm",
  "botId": "chat",
  "preCheckScript": "/home/lyy/.tinyclaw/loops/scripts/is_trading_day.py"
}
```

---

## 管理方式

直接编辑 JSON 文件，修改后无需重启服务，调度器自动重新加载：

```bash
# 查看所有触发器
ls ~/.tinyclaw/loops/*.json

# 禁用（修改 enabled 字段）
# 新建（文件名 = id 字段值）
nano ~/.tinyclaw/loops/my-trigger.json
```

---

## 运行机制

```
服务启动 → 扫描 ~/.tinyclaw/loops/*.json → 为 enabled=true 的触发器启动串行循环

每次 tick：
  ├─ 重新读取配置（动态生效）
  ├─ 若 enabled=false → 退出循环
  ├─ 检查 timeRanges → 段外静默跳过
  ├─ 执行 preCheckScript → 非 0 静默跳过
  ├─ 按序执行 steps（工具调用，拼输出前缀）
  ├─ runAgent(session, steps输出 + message)
  ├─ 根据 notify 策略决定是否推送
  └─ 等待 tickSeconds 秒 → 下一次 tick
```

**串行执行**：上次 tick 未结束时，新 tick 等待其完成（不 abort）。  
**永远 stateful**：session 历史持续积累，依赖 Agent 自动压缩管理上下文长度。
