---
name: agent-orchestration
description: |
  Master-Slave Agent 分叉编排规范。含 agent_fork 两种结果交付模式(inject 自动注入/wait
  静默等待)的选择场景、context_window 背景截取、进度汇报间隔、agent_wait 两种用法
  (等单个/等全部)、timeout 语义、agent_status 状态过滤与 agent_abort 软中断。
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
  - agent_abort
---

# agent-orchestration — Master-Slave 分叉编排规范

## 分工

| 工具 | 用途 |
|------|------|
| `agent_fork` | 后台 fork Slave 异步执行,立即返回 slave_id |
| `agent_status` | 查询进度/状态(不传 slave_id 列出全部) |
| `agent_wait` | 阻塞等待并取回结果 |
| `agent_abort` | 软中断运行中的 Slave |

## 选择 result_mode

| 场景 | result_mode | 说明 |
|------|-------------|------|
| 一次性后台任务,完成即汇报 | **inject**(默认) | 完成后自动注入 Master,触发 LLM 推理后回复用户 |
| 同一轮并行多个 Slave,统一汇总 | **wait** | 静默完成,用 `agent_wait(slave_id)` 取结果 |

## agent_fork 参数

- `task`:Slave 任务描述,须清晰、可独立执行(不依赖对话中未提供的背景)
- `context_window`:从 Master 历史截取的消息条数(默认 10,最大 30)
- `progress_interval_secs`:进度汇报间隔(秒,30~3600);不设置则仅完成时通知

## agent_wait 用法

- `agent_wait(slave_id="xxx")`:等单个 Slave,返回其结果
- `agent_wait()`:等当前会话创建的全部 Slave,返回汇总
- `timeout_secs` 默认 300 秒,超时未完成标记为 error
- 对 inject 模式的 Slave:已完成则立即返回已有结果,运行中则阻塞等待

## 注意

- Slave 不允许嵌套 fork(最大深度 1);sub-agent 内调用会返回错误
- agent_abort 需 slave_id,软中断后状态为 aborted
- 多个 Slave 并行时用 wait 模式 + 一次 agent_wait() 汇总,避免逐个轮询
