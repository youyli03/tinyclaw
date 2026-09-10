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
- `context_mode`:继承模式(默认取配置的 `memory.slaveContextMode` = `standard`)
  - `task-only`:不继承任何历史(记忆库 MEM.md / SKILLS.md 仍在 system prompt 里)。**task 写全时最省**
  - `minimal`:Master 摘要 + 最近 ≤6 轮
  - `standard`:Master 摘要 + 预算内尽可能多的近期轮次
  - `full`:同上但不设轮数上限(仍受 token 预算约束)
- `context_rounds`:轮数**上限**(与 mode 取更严格者),默认 10,最大 30
- `progress_interval_secs`:进度汇报间隔(秒,30~3600);不设置则仅完成时通知。
  汇报内容含**当前阶段**(最近一轮助手输出开头)、已用工具与调用次数、实时输出尾部

## 继承的语义(重要)

**继承提供的是「近因」——最近聊了什么,而不是「起因」。**
本 claw 的 chat 模式是长会话陪伴/管家型,最早那条消息可能来自几个月前,与本次子任务无关。
远期由三处承担,不需要靠继承硬塞:

| 远期来源 | 承载方式 |
|---|---|
| 长期偏好/人格 | system prompt 里的 `MEM.md`(自动注入) |
| 本会话更早的部分 | Master 的压缩检查点(继承时自动带上) |
| 主人近期在忙什么 | 启动时注入 `ACTIVE.md`(需 `memory.slaveRecall=true`) |
| 跨会话相关片段 | 用 `task` 做 QMD 语义检索后注入(`memory.slaveRecall=true`) |

**token 预算**:`clamp(窗口 × memory.slaveContextRatio, 8000, 窗口 − 8000)`。
Slave 每次 fork 都是新 session,继承内容首次请求**缓存全部未命中、按全价计费**,所以量与成本线性相关;
预算不足时会**少给**,并把 `droppedRounds` 写进 `agent_status` 与归档 `meta.json`。
**不要指望靠调大 `context_rounds` 把全部历史塞进去。**

**因此:写 `task` 时把 Slave 真正需要知道的背景直接写进去**——这比依赖继承更可靠也更省。

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
