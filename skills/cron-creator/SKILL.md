---
name: cron-creator
description: |
  创建 tinyclaw 定时任务(cron job)的规范工作流。含需求确认清单、Message/Pipeline/manual 运行模式判定、
  各调度类型(once/every/daily/manual)必填参数、message 四要素、通知策略与创建后自查。配置模板见 templates/。
trigger-phrases:
  - 定时任务
  - 定时提醒
  - 定时推送
  - 定时监控
  - 定时运行
  - 定时执行
  - 定时汇报
  - 每天提醒
  - 每天定时
  - 每几分钟
  - 每隔
  - 设置定时
  - cron
  - cron job
  - 定时
requires:
  - cron_add
  - cron_list
  - ask_user
---

# cron-creator — 定时任务创建规范

## 触发时机

用户提到"定时任务 / 定时提醒 / 每天X点 / 每N分钟监控 / 定时推送 / cron"等意图时，按本 skill 流程创建 cron job。

## 工作流（必须按步骤执行）

### 第 1 步：收集需求（逐项确认，不得跳过）

用户描述模糊时用 ask_user 逐项确认，**不要凭猜测创建**：

1. **任务意图与执行流程**：做什么、操作对象、数据来源/关键步骤
2. **调度时间**：具体时间点（daily）/ 间隔（every）/ 一次性（once）/ 手动（manual）
3. **是否需要推送到 QQ**：推给谁（默认当前对话）
4. **通知策略**：每次 / 仅变化 / 仅出错 / 不推送
5. **输出要求**：内容与格式
6. **是否需要 LLM 推理**：否 → Pipeline 模式（零配额）；是 → Message 模式（须告知用户消耗配额）

### 第 2 步：选择运行模式

| 场景 | 模式 | 说明 |
|------|------|------|
| 固定脚本/命令/HTTP 请求，无需 LLM 理解 | **Pipeline（steps）** | 纯工具步骤、零配额，**推荐** |
| 需语义推理/总结/LLM 决策 | **Message（message）** | 消耗配额，创建前必须告知用户 |
| 只手动触发、不要自动调度 | **manual** | type=manual，无调度参数 |

### 第 3 步：对照模板构造配置

打开 `templates/` 下对应模板（与 SKILL.md 同级目录），**替换字段值后原样调用 cron_add**：

| 场景 | 模板 |
|------|------|
| daily 定时推送（Message 模式） | `templates/daily-message.json` |
| 周期监控（Pipeline 模式） | `templates/every-pipeline.json` |
| 手动触发 | `templates/manual.json` |
| 一次性提醒 | `templates/once.json` |

### 第 4 步：调用 cron_add（硬性要求）

- **name 必填**：≤20 字概括任务，用于列表/日志展示
- **交叉参数**：`type=once` 必填 `runAt`；`type=every` 必填 `intervalSecs`（可配 `timeRange` 限时段）；`type=daily` 必填 `timeOfDay` 或 `timesOfDay`；`type=manual` 不填调度参数
- **message 四要素**（Message 模式）：① 意图 ② 执行流程（数据来源/关键步骤）③ 约束（失败处理、禁编造）④ 输出要求（内容/格式）。**≥15 字**，否则被校验拒绝
- **notify 明确选择**：`always` 每次推送 / `on_change` 变化才推 / `on_error` 仅出错推 / `never` 仅写日志 / `llm` 由 LLM 决定
- **推送对象**：默认当前对话（自动绑定 session），无需填 peerId；推给其他会话须显式确认

### 第 5 步：自查

检查 cron_add 返回的完整 job JSON：

- `nextRunAt` 是否符合预期（不合理 → 调度参数有误，修正后重试）
- message 四要素 / steps 是否完整
- 必要时 `cron_list` 复核

## 常见错误

| 错误 | 后果 | 避免 |
|------|------|------|
| message 过短（如"查天气"） | 被校验拒绝 | 四要素齐全 ≥15 字 |
| daily 忘填时间点 / every 忘填间隔 | 被校验拒绝 | 对照模板 |
| steps 工具名拼错 | 运行时报 tool not found | 用已注册工具：exec_shell / http_request / db_write / read_url / notify_user / send_report |
| notify 一律 always | 每次运行都推送打扰 | 按场景选 on_change / on_error |
| Message 模式未告知用户 | 配额消耗引发困惑 | 创建前明确说明 |
