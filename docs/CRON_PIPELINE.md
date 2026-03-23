# Cron Pipeline 模式

Pipeline 模式允许一个 cron job 包含多个串行步骤，步骤之间共享同一个 stateful session——前一步的输出对后续 LLM 步骤完全可见。

---

## 概念

### 步骤类型

| 类型 | 字段 | 说明 |
|------|------|------|
| `tool` | `name`, `args` | 直接调用已注册工具，**不走 LLM**，输出注入 session 上下文 |
| `msg`  | `content` | 向 session 注入 user 消息，触发完整 `runAgent()`，LLM 生成回复 |

### 执行流程

```
Step 1: tool(exec_shell, "curl …")
         └─ 工具输出 → 注入 session（assistant 消息）
Step 2: msg("根据以上数据，生成…")
         └─ runAgent(session, content) → LLM 读取 session 历史，含 Step 1 输出
Step 3: …（可继续叠加）
```

**最终 resultText**：最后一个 `msg` step 的 LLM 输出；若无 `msg` step，取最后一个 `tool` step 的输出。该内容用于推送给用户和 on_change 比对。

### 与单步模式的区别

| 特性 | 单步模式（`message`） | Pipeline 模式（`steps`） |
|------|-----------------------|--------------------------|
| 入口 | 单次 `runAgent(message)` | 逐步执行 tool / msg |
| LLM 控制权 | LLM 全权决定调哪些工具 | 开发者精确控制执行顺序 |
| 工具调用 | LLM 自主触发 | `tool` step 强制执行，零 LLM token 消耗 |
| session | 可 stateful 或无状态 | **强制 stateful**（步骤间共享） |
| 适用场景 | 通用任务、灵活探索 | 固定流程、数据采集→AI总结→推送 |

---

## 手动配置示例

Job 文件存放在 `~/.tinyclaw/cron/jobs/<id>.json`，直接编辑 JSON 即可生效（调度器下次 reschedule 时读取）。

### 示例 1：天气简报（每天早 8 点）

抓取天气 → LLM 生成简报 → 推送

```json
{
  "id": "morning-weather",
  "enabled": true,
  "agentId": "default",
  "message": "每日天气简报（pipeline job）",
  "type": "daily",
  "timeOfDay": "08:00",
  "steps": [
    {
      "type": "tool",
      "name": "exec_shell",
      "args": { "command": "curl -s 'wttr.in/Shanghai?format=j1'" }
    },
    {
      "type": "msg",
      "content": "上方是上海今日天气的 JSON 数据。请用中文生成一条简洁的早安天气简报，包含：当前温度、天气状况、全天温度区间、穿衣建议。格式清晰，不超过 100 字。"
    }
  ],
  "output": {
    "sessionId": "qqbot:c2c:YOUR_OPENID",
    "peerId": "YOUR_OPENID",
    "msgType": "c2c",
    "notify": "always"
  },
  "stateful": false,
  "mfaExempt": true,
  "createdAt": "2026-01-01T00:00:00.000Z"
}
```

> **注意**：Pipeline 模式内部强制使用 stateful session（`cron:<id>`），但 `stateful` 字段设为 `false` 时，每次 run 后 session JSONL 不会被保留（当前版本 pipeline 不清理，可手动设 `stateful: true` 以持久保留历史）。

---

### 示例 2：多源数据聚合（每小时）

分别抓两个数据源 → 合并交给 LLM 总结 → 每次结果变化时才推送

```json
{
  "id": "multi-source-summary",
  "enabled": true,
  "agentId": "default",
  "message": "多源数据聚合简报（pipeline job）",
  "type": "every",
  "intervalSecs": 3600,
  "steps": [
    {
      "type": "tool",
      "name": "exec_shell",
      "args": { "command": "curl -s 'https://hacker-news.firebaseio.com/v0/topstories.json' | head -c 500" }
    },
    {
      "type": "tool",
      "name": "exec_shell",
      "args": { "command": "curl -s 'https://api.github.com/trending' 2>/dev/null || echo 'github trending unavailable'" }
    },
    {
      "type": "msg",
      "content": "以上是最新 HackerNews top stories ID 列表和 GitHub Trending 数据。请用中文总结 3 条最值得关注的技术动态，每条一句话，带序号。若数据获取失败请明确说明。"
    }
  ],
  "output": {
    "sessionId": "qqbot:c2c:YOUR_OPENID",
    "peerId": "YOUR_OPENID",
    "msgType": "c2c",
    "notify": "on_change"
  },
  "stateful": false,
  "mfaExempt": true,
  "createdAt": "2026-01-01T00:00:00.000Z"
}
```

---

### 示例 3：纯工具流水线（无 LLM）

用于需要精确控制、不需要 AI 参与的自动化任务（如定时备份、健康检查等）。最后一个 `tool` step 的输出作为 resultText。

```json
{
  "id": "disk-check",
  "enabled": true,
  "agentId": "default",
  "message": "磁盘空间检查（pipeline job）",
  "type": "daily",
  "timeOfDay": "09:00",
  "steps": [
    {
      "type": "tool",
      "name": "exec_shell",
      "args": { "command": "df -h / | tail -1 | awk '{print \"磁盘使用率: \" $5 \"，可用: \" $4}'" }
    },
    {
      "type": "tool",
      "name": "exec_shell",
      "args": { "command": "free -h | awk '/^Mem:/{print \"内存使用: \" $3 \"/\" $2}'" }
    },
    {
      "type": "tool",
      "name": "notify_user",
      "args": { "message": "系统状态检查完成" }
    }
  ],
  "output": {
    "sessionId": "qqbot:c2c:YOUR_OPENID",
    "peerId": "YOUR_OPENID",
    "msgType": "c2c",
    "notify": "on_error"
  },
  "stateful": false,
  "mfaExempt": true,
  "createdAt": "2026-01-01T00:00:00.000Z"
}
```

> 该 job 仅在出错时推送。`notify_user` 工具的调用在 pipeline `tool` step 中同样有效，但注意它会立即发送（不等 pipeline 结束），适合中途状态通知。

---

### 示例 4：带 LLM 判断的条件分支（模拟）

先用工具检查条件，再让 LLM 根据结果决定是否需要提醒。

```json
{
  "id": "smart-alert",
  "enabled": true,
  "agentId": "default",
  "message": "智能服务状态告警（pipeline job）",
  "type": "every",
  "intervalSecs": 300,
  "steps": [
    {
      "type": "tool",
      "name": "exec_shell",
      "args": { "command": "curl -s -o /dev/null -w '%{http_code}' --max-time 5 https://example.com/health || echo '000'" }
    },
    {
      "type": "msg",
      "content": "上方是 example.com/health 的 HTTP 状态码（000 表示连接超时）。如果状态码不是 200，用一句话说明服务可能异常，附上状态码。如果是 200，只输出'正常'两字即可。"
    }
  ],
  "output": {
    "sessionId": "qqbot:c2c:YOUR_OPENID",
    "peerId": "YOUR_OPENID",
    "msgType": "c2c",
    "notify": "on_change"
  },
  "stateful": false,
  "mfaExempt": true,
  "model": "copilot/claude-haiku-3.5",
  "createdAt": "2026-01-01T00:00:00.000Z"
}
```

> `on_change` 通知策略：只有当 LLM 输出与上次不同时才推送，避免反复刷屏"正常"。

---

## 通过 Agent 创建 Pipeline Job

在对话中也可以让 Agent 调用 `cron_add` 工具创建，传入 `steps` 参数即可：

```
创建一个每天早上 7:30 的 pipeline job：
- 第一步用 exec_shell 抓取 wttr.in/Beijing 天气
- 第二步让 LLM 生成简报推送给我
```

Agent 会自动构建 steps 数组并调用 `cron_add`。

---

## 注意事项

1. **`message` 字段仍为必填**（schema 约束），Pipeline 模式下它仅作为任务描述，不触发 LLM
2. **步骤失败即终止**：任意 step 抛出异常，整个 pipeline 标记为 `error`，后续步骤不执行
3. **工具名称**：`tool` step 的 `name` 必须是已注册的工具（如 `exec_shell`、`write_file`、`send_report`、`notify_user` 等），错误的工具名会返回错误字符串并注入 session（不会抛出异常），后续 LLM step 可感知此错误
4. **MFA 工具**：`exec_shell`、`write_file` 等需要 MFA 的工具在 pipeline `tool` step 中默认豁免（继承 `mfaExempt: true`）
5. **session 清理**：Pipeline 模式每次 run 共享 `cron:<id>` session，不自动清理 JSONL（避免步骤间上下文丢失），长期运行的 job 建议配合 `stateful: true` 或定期手动清理 `~/.tinyclaw/sessions/cron_<id>.jsonl`
