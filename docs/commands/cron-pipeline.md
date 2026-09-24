# Cron Pipeline 模式

Pipeline 模式允许一个 cron job 包含多个串行步骤，步骤之间共享同一个 stateful session——前一步的输出对后续 LLM 步骤完全可见。

---

## 概念

### 步骤类型

| 类型 | 字段 | 说明 |
|------|------|------|
| `tool` | `name`, `args` | 直接调用已注册工具，**不走 LLM**，输出以合成 tool call 对注入 session |
| `msg`  | `content` | 向 session 注入 user 消息，触发完整 `runAgent()`，LLM 生成回复 |

### 执行流程

```
Step 1: tool(exec_shell, "curl …")
         └─ 工具输出 → 注入 session（assistant{tool_calls} + role:tool 消息对）
Step 2: msg("根据以上数据，生成…")
         └─ runAgent(session, content) → LLM 读取 session 历史，含 Step 1 工具结果
Step 3: …（可继续叠加）
```

**为什么是 tool call 对而非 assistant 消息？**

`tool` step 的输出以 `assistant{tool_calls:[...]} + role:"tool"{content:...}` 的合成消息对注入 session，与 LLM 自身调用工具的消息格式完全一致。相比直接注入 assistant 纯文本消息，LLM 能更可靠地识别并使用这些数据，有效减少 LLM 忽略 pipeline 注入数据、转而自行重拉的幻觉问题。

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
  "mfaExempt": false,
  "writablePaths": [],
  "secrets": [],
  "createdAt": "2026-01-01T00:00:00.000Z"
}
```

> **注意**：Pipeline 模式内部强制使用 stateful session（`cron:<id>`）。`stateful: false` 时（默认），每次 run 开始前会自动清空 session JSONL，确保每次运行使用干净的上下文。如需保留跨 run 历史记忆，设置 `clearSessionOnRun: false` 或 `stateful: true`。
>
> **沙箱可写范围**：无人值守任务在沙箱里默认只能写**自己的 workspace**（`~/.tinyclaw/agents/<id>/workspace`）与 `/tmp`；
> agent 目录下的其他部分（`memory/` `skills/` `MEM.md` …）同样不可写。
> 脚本需要写别处时用 `writablePaths` **显式声明**（支持 `~` 前缀），例如
> `["~/.tinyclaw/data", "~/.tinyclaw/dashboard.db", "~/FinanceSkill"]`；声明**文件**时会自动放开其
> SQLite 边车（`-wal`/`-shm`/`-journal`）。`mfaExempt` 默认 **false**（高危工具仍会尝试向用户确认，
> 无人值守且无法送达时按 `[sandbox.unattended].mfaFallback` 处理，默认拒绝）。
>
> **密钥**：沙箱默认把 `secrets.toml` 掩码成空文件。任务若需读密钥，用 `secrets` 声明条目名，例如
> `"secrets": ["DEEPSEEK_API_KEY"]` —— 运行时会生成**只含这些 key** 的临时文件并 bind 回原路径，
> **脚本无需改动**，但每个任务只看得见自己声明的密钥；未声明 = 脚本读到空文件。物化与清理均写审计。

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

### 示例 3:脚本自控推送（[NOTIFY] 块 + notify=llm，无 LLM）

适合脚本逻辑简单、完全不需要 LLM 参与的定时推送场景。脚本自行判断是否需要推送，有内容时包裹 `[NOTIFY]...[/NOTIFY]` 块输出，cron runner 提取并推送，无块时静默。全程零 LLM 调用。

**脚本输出格式（Python 示例）：**
```python
if signals:
    content = "📊 VWAP 信号\n" + "\n".join(signal_lines)
    print(f"[NOTIFY]{content}[/NOTIFY]")
# 无信号时不输出任何内容（静默）
```

**Job 配置（pipeline + notify=llm）：**
```json
{
  "steps": [{ "type": "tool", "name": "exec_shell", "args": { "command": "python3 /path/to/monitor.py" } }],
  "output": { "notify": "llm" }
}
```

> **原理**：Pipeline 最后一个 `tool` step 的输出作为 resultText；`notify=llm` 时 runner 提取 `[NOTIFY]` 块推送，无块则静默，全程不触发 LLM。

---

### 示例 4:纯工具流水线（无 LLM）

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

### 示例 5:带 LLM 判断的条件分支（模拟）

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
  "model": "deepseek/deepseek-v4-flash",
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

## 运行环境与密钥

cron 的每一次运行（单步与 Pipeline 都一样）会组装一份**额外环境变量**给 job 的 agent，口径与
`job_start` 一致：`process.env`（含服务启动时载入的 `~/.tinyclaw/env`）< `~/.tinyclaw/agents/<id>/env`。

- **agent env 叠加**：`env_set` 写进 `agents/<id>/env` 的变量，cron 的 `exec_shell` 现在也能看到
  （实现见 `src/cron/run-env.ts` 的 `buildCronRunEnv()`）。
- **`${SECRET:NAME}` 引用**：agent env 里值写成 `${SECRET:NAME}` 的键，会在**过 `[secrets].agents` 授权闸**
  后从 `secrets.toml` 取值注入；未授权的 agent 不会解析这些键（留 warning + 审计 deny），其余变量照常注入。
- **只传增量、不改全局**：cron worker 是**跨 agent 共享**的长驻进程，可能并发跑多个 job，所以 env 走
  `AgentRunOptions.extraEnv` → `ToolContext.extraEnv` → `exec_shell` 子进程，**不修改 `process.env`**；
  沙箱路径下也只叠加增量（不能用整份 `process.env` 覆盖 bwrap 的 `plan.env`，那会抹掉
  `[sandbox].network = "deny"` 的环境收敛）。日志只落**键名**不落值。
- **声明式密钥（`secrets: [...]`）仍是文件形态**：它经 `sandbox/secrets-filter.ts` 物化成只含这几个 key 的
  临时 `secrets.toml` 并在沙箱内 bind（脚本零改动），**不会**自动变成环境变量 ——
  需要环境变量请显式写 `${SECRET:NAME}`。
- ⚠️ 与 `job_start` 一样，密钥只给 `[secrets].agents` 里授权的 agent（默认 `default`）。

### 把结果交给 LLM：`wake`（环境里自带的小命令）

cron 的 `tool` step 只能干活、`msg` step 才能起 LLM，而**外部脚本 / 后台 job** 想"做完事叫醒 agent"
时用 `wake` —— 服务启动时会在 `~/.tinyclaw/bin/` 物化一个**只做 wake 这一个动作**的可执行文件
（`core/wake-shim.ts`，零依赖、不暴露 `tinyclaw` CLI 的其它命令），并把它**前置注入**到
job / cron / `exec_shell` 的 `PATH`（沙箱内同样可见、socket 实测可达）。

**job / cron 里零参数**：这类运行环境会被注入自标识变量，`wake` 自动取用，所以脚本里就一句话：

```bash
# 目标会话 = TINYCLAW_WAKE_TARGET（启动该 job 的会话 / cron 绑定的 output.sessionId）
# 来源标签 = job:<TINYCLAW_JOB_ID> 或 cron:<TINYCLAW_CRON_JOB_ID>
wake "训练跑完了，看下最后的指标并汇报"

# 把日志尾部直接交给 agent（不必自己拼长文本）
tail -n 50 train.log | wake --stdin

# 在 job/cron 之外（比如你手动 ssh 上去跑）才需要显式指定目标
wake -s "qqbot:c2c:<openid>" --source manual "……"
```

注入给任务的变量：`TINYCLAW_WAKE_TARGET` / `TINYCLAW_AGENT_ID` / `TINYCLAW_JOB_ID`（job）、
`TINYCLAW_CRON_JOB_ID`（cron）。等价的显式入口（交互终端里）：`tinyclaw wake …`（同一实现）。

- 注入文本带 `[wake from <source> @ …]` 前缀，让模型知道这不是用户在说话；
- **受理即返回**，不等那一轮 LLM；agent 的最终回复由服务端推给该会话绑定的通道（QQ 会推到对应聊天）；
- ⚡ **插队（实时性）**：目标会话正在跑时，wake 会**打断当前轮**（软中断：标记 abort + 断在途请求 + 放掉待审批），
  然后立刻跑本次唤醒 —— 也就是说它能抢占用户正在进行的那一轮（这是刻意的实时优先语义）；
- ⚡ **节流不报错**：同一会话的多次 wake 按 ≥3 秒间隔**在服务端排开**（第二条起延迟投递），
  调用方永远是 exit 0，不会因为"喊得太快"失败；
- 🗑️ **投递不到就丢弃**：服务没在跑 / socket 连不上 → wake **静默退出 0**（不打印、不落盘、不重试）。
  没有离线队列：要在服务恢复后再通知，就**再喊一次**（结果请自行落盘，见上）；
- ⚠️ 被唤醒的那一轮按 **`origin=cron`（无人值守）** 跑：工具走 `[sandbox.unattended]` 白名单、
  MFA 无法送达即拒绝 —— 唤醒可能来自任意脚本，不能当"用户在场"；
- ⚠️ **`job_*` 工具不在白名单里**：被唤醒的 agent 读不到那个 job 的日志。
  要么把要点写进消息，要么让 job 把摘要落到 workspace 文件、在消息里给路径（`read_file` 在白名单内）；
- 只要一次纯 LLM 调用（无工具、无历史）用 `tinyclaw send`；agent 侧另有同名工具 `wake`
  （但它被列入 `HARD_DENY_REACT_UNATTENDED`：无人值守的 ReAct 循环里**模型不能**自我唤醒）。

---

## 注意事项

1. **`message` 字段仍为必填**（schema 约束），Pipeline 模式下它仅作为任务描述，不触发 LLM
2. **步骤失败即终止**：任意 step 抛出异常，整个 pipeline 标记为 `error`，后续步骤不执行
3. **工具名称**：`tool` step 的 `name` 必须是已注册的工具（如 `exec_shell`、`write_file`、`send_report`、`notify_user` 等），错误的工具名会返回错误字符串并注入 session（不会抛出异常），后续 LLM step 可感知此错误
4. **工具准入**：`tool` step 走**声明式步骤通道**（`channel: "steps"`）——按 `[sandbox.unattended].allowedTools`
   白名单放行（该通道**允许** `agent_fork`，见 `auth/tool-policy.ts`），白名单外的工具（`delete_file`、`restart_tool`、
   出网类等）会被拒绝并把拒绝原因注入 session。MFA 不再默认豁免：`mfaExempt: false`（默认）时高危工具会尝试向用户确认，
   无人值守且无法送达时按 `[sandbox.unattended].mfaFallback` 处理（默认拒绝）。
5. **沙箱**：`tool` step 的 `exec_shell` 在 `[sandbox].enabled` 时跑在 bwrap 内，默认可写只有 agent 目录 + `/tmp`，
   需要写别处用该 job 的 `writablePaths` 声明。
6. **session 清理**：Pipeline 模式（`stateful: false`）默认在每次 run 开始前自动清空 `~/.tinyclaw/sessions/cron_<id>.jsonl`，防止历史消息（含旧数据）跨 run 污染当次上下文。设置 `clearSessionOnRun: false` 可禁用此行为以保留历史记忆。`stateful: true` 的 job 不受影响

---

## 最佳实践：数据采集 → LLM 分析 Pipeline

### 为什么 MCP Server 不应该内嵌 LLM 调用

MCP Server 是**无状态工具提供方**，设计上只做同步执行。在 MCP 内部直接调 LLM 有以下问题：

- 没有 session / tool_use 循环，无法多轮推理
- 即使能调 LLM，也没有 `tool_call` 能力，不能再调 `search_store`、`send_report` 等工具
- 本质上退化为普通 HTTP 请求，不是 Agent

**正确做法**：`tool` step 负责数据采集，`msg` step 负责分析。`msg` 步骤在完整 Agent 环境中运行，拥有所有工具，天然支持多轮 ReACT 循环。

### 示例：新闻抓取 → 实体关系分析 → 推送

```
steps[0]: tool(mcp_news_fetch_and_store)   ← 纯数据采集，不走 LLM
steps[1]: tool(exec_shell, "python3 ...")  ← 拉取结构化行情数据
steps[2]: msg("数据锚定：先原文打印上游数据，再执行实体分析，最后 send_report")
          └─ msg 步骤在完整 Agent 里运行：
             可调 search_store / mcp_news_* / send_report / exec_shell
             支持多轮 tool_call（ReACT 循环）
```

### 防止数据幻觉的关键技巧

在分析类 `msg` step 的 prompt 开头加**数据锚定**指令：

```
【第一动作：数据锚定】
在做任何分析前，先原文打印 pipeline 上游数据：
[数据锚定-Step2] <原文JSON>
[数据锚定-Step3] <原文输出>

锚定数据中没有的字段，后续报告一律写"⚠️ 数据缺失"，禁止用知识库数字替代。
```

这可以有效防止 LLM 在长 session 中混淆上游数字、退回到训练知识。

### 报告格式建议

`send_report` 的 markdown 使用**表格 + Emoji + 章节编号**比纯列表更易读：

- 数值型数据（指数/价格）→ 表格，加数据日期列
- 状态型数据（情绪/涨跌）→ Emoji 图标 + 粗体标注
- 关系型数据（传导链/因果）→ `[实体A] --[关系]--> [实体B] → 市场含义`
- 禁止在报告正文中写工作流执行过程，禁止留 XXX 占位符

---

## 附:botId — 多 bot 路由

系统配置多个 QQ bot 时,`output.botId` 指定发送使用哪个 bot:

```json
{
  "output": {
    "sessionId": "qqbot:c2c:YOUR_OPENID",
    "peerId": "YOUR_OPENID",
    "msgType": "c2c",
    "botId": "chat",
    "notify": "always"
  }
}
```

- `botId` 对应 `config.toml` 中 `[channels.qqbots.<botId>]` 的键名
- **不填则 fallback 到第一个注册 bot**;若 peerId 归属于另一个 bot 的账号,消息会因 bot 身份不匹配而静默丢失(不报错),**必须显式填写正确的 `botId`**
- 通过 `cron_add` 工具创建时,在 `output` 字段中传入 `"botId": "chat"` 参数即可

### 常见问题:推送到另一个 QQ 账号收不到

**症状**:job 运行正常、notify 策略正确、日志显示已触发,但目标 QQ 收不到消息。

**原因**:系统有多个 QQ bot（如 `default` 和 `chat`），`peerId` 归属于 `chat` bot 的账号，但 `output.botId` 未填，fallback 到了 `default` bot，导致消息发不出去。

**修复**:在 job 的 `output` 中补充 `"botId": "chat"`（或目标 bot 的实际 ID）。

```json
// 修复前（推送静默失败）
"output": { "peerId": "TARGET_OPENID", "notify": "always" }

// 修复后
"output": { "peerId": "TARGET_OPENID", "botId": "chat", "notify": "always" }
```

---

## 附：timesOfDay 多时段触发

`daily` 类型支持 `timesOfDay` 字段（字符串数组），在一天内指定多个触发时间点，优先于 `timeOfDay`（单时段）：

```json
{
  "type": "daily",
  "timesOfDay": ["09:00", "12:00", "18:00"],
  ...
}
```

- `timeOfDay` 与 `timesOfDay` 互斥，建议统一用 `timesOfDay`
- 格式：`"HH:MM"`（本地时间），数量无上限
- 通过 `cron_add` 工具传入 `timesOfDay` 参数创建
