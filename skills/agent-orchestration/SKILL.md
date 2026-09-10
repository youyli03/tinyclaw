---
name: agent-orchestration
description: |
  Master-Slave Agent 分叉编排规范。含 agent_fork 两种结果交付模式(inject 自动注入/wait
  静默等待)的选择场景、context_rounds 按轮继承、进度汇报间隔、agent_wait 两种用法
  (等单个/等全部)与超时语义、agent_status 状态过滤、agent_trace 轨迹检索、agent_abort 软中断。
trigger-phrases:
  - 分叉
  - 子 agent
  - 子任务
  - 并行任务
  - 后台执行
  - 后台任务
  - 后台跑
  - fork
  - slave
  - 让另一个
requires:
  - agent_fork
  - agent_status
  - agent_wait
  - agent_trace
  - agent_abort
---

# agent-orchestration — Master-Slave 分叉编排规范

## 分工

| 工具 | 用途 |
|------|------|
| `agent_fork` | 后台 fork Slave 异步执行,立即返回 slave_id |
| `agent_status` | 查询进度/状态(不传 slave_id 列出全部) |
| `agent_wait` | 阻塞等待并取回结果全文 |
| `agent_trace` | 检索已归档的执行轨迹(子 agent 的完整留档) |
| `agent_abort` | 软中断运行中的 Slave |

## 选择 result_mode

| 场景 | result_mode | 说明 |
|------|-------------|------|
| 一次性后台任务,完成即汇报 | **inject**(默认) | 完成后自动注入 Master,触发 LLM 推理后回复用户 |
| 同一轮并行多个 Slave,统一汇总 | **wait** | 静默完成,用 `agent_wait(slave_id)` 取结果 |

## agent_fork 参数

- `task`:Slave 任务描述,须清晰、可独立执行(不依赖对话中未提供的背景)
- `context_rounds`:继承 Master 最近多少**轮**对话(默认 10,最大 30)。
  一轮 = 一条用户消息起算,含该轮内**全部工具调用与结果**;裁剪按轮向前对齐,
  不会切断「assistant 发 tool_call / 结果未回」的中间态。需要更多背景就调大它
- **上下文有字符预算(120000)**:轮数少但单轮很长时(如一次大文件读取)可能触顶,
  此时会从**最旧的整轮**开始丢弃。丢了哪几轮会写在 `agent_status` 的
  「继承上下文」一行与归档 `meta.json` 的 `droppedRounds`;若关键背景被丢,
  应把结论直接写进 `task` 而不是指望 Slave 从历史里翻
- `progress_interval_secs`:进度汇报间隔(秒,30~3600);不设置则仅完成时通知。
  汇报内容含**当前阶段**(最近一轮助手输出开头)、已用工具与调用次数、实时输出尾部

## agent_wait 用法

- `agent_wait(slave_id="xxx")`:等单个 Slave,返回其结果**全文**
- `agent_wait()`:等当前会话创建的全部 Slave,返回汇总
- `timeout_secs` 默认 300 秒。**超时不会把 Slave 标记为 error**——返回里会说明它
  **仍在运行**,并给出仍在运行的 id;此时应继续用 `agent_status` 查询,
  确要终止则显式调 `agent_abort`
- 对 inject 模式的 Slave:已完成则立即返回已有结果,运行中则阻塞等待

## agent_trace 用法

- `agent_trace()`:列出最近归档的轨迹(任务/状态/工具/目录)
- `agent_trace(slave_id="xxx")`:取该 Slave 的结果全文 + 轨迹文件路径
- `agent_trace(slave_id="xxx", full=true)`:连轨迹 JSONL 全文一起返回(可能很长)
- 用途:复盘子 agent「用了哪些工具、看了什么、为什么这么判断」;也可查进程重启前
  遗留的孤儿轨迹

## 注意

- Slave 不允许嵌套 fork(最大深度 1);sub-agent 内调用会返回错误
- `agent_abort` 需 slave_id;它是**软中断**,调用后状态未必立刻变 aborted
- 多个 Slave 并行时用 wait 模式 + 一次 agent_wait() 汇总,避免逐个轮询
- 同一 session 上的所有 run 严格串行(用户消息 / Slave 结果注入 / session_send / loop tick
  共用一条队列),因此不要向自己所在的 session 调 `session_send`
- Slave 结束时其完整轨迹会**全文归档**到 `~/.tinyclaw/slaves/YYYY-MM/YYYY-MM-DD-<slaveId>/`
