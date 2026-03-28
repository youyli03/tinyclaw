# tinyclaw 架构文档

> 极简模块化 AI Agent 框架，Bun + TypeScript

---

## 设计原则

- **极简**：每个模块只做一件事，不过度设计
- **安全**：所有敏感信息只在 `~/.tinyclaw/config.toml`，永不进仓库
- **代码/操作分离**：日常对话用 daily LLM，代码任务 spawn codex/copilot，主 Agent 上下文不膨胀
- **数据与代码分离**：仓库只含代码，运行时数据全部在 `~/.tinyclaw/`

---

## 目录结构

### 仓库（代码）

```
tinyclaw/
├── src/
│   ├── main.ts               # 入口：加载配置 → 启动 QQBot → IPC server → Cron → 优雅退出
│   ├── main-supervisor.ts    # 进程守护：crash 后退避重启 main.ts，最多 20 次
│   ├── core/
│   │   ├── agent.ts          # ReAct 主循环（think → tool_call → observe → respond）
│   │   │                     # 支持 MFA 鉴权、心跳、auto-fork、textMode 文本工具调用
│   │   ├── session.ts        # messages[] + JSONL 持久化 + 并发控制 + 压缩（chat/code 两路）
│   │   ├── router.ts         # 意图路由（扩展点，当前直通）
│   │   ├── agent-manager.ts  # Agent 工作区管理（创建/查找/路径/repair）
│   │   └── slave-manager.ts  # Slave agent 生命周期：fork / status / abort / 进度推送
│   ├── llm/
│   │   ├── client.ts         # OpenAI-compatible 统一接口（streamChat + withRetry + idle timeout）
│   │   ├── registry.ts       # 多后端注册（providers + backends）；get(name)；async init()
│   │   ├── copilot.ts        # GitHub Copilot：token 换取 + 模型发现 + LLMClient 构建
│   │   └── copilotSetup.ts   # RFC 8628 Device Flow OAuth + ~/.tinyclaw/.github_token 持久化
│   ├── memory/
│   │   ├── qmd.ts            # @tobilu/qmd SDK 封装（search / updateIndex，按 agentId 隔离命名空间）
│   │   ├── store.ts          # 摘要 → agents/<id>/memory/YYYY-MM-DD.md
│   │   └── summarizer.ts     # chat: 全量压缩；code: 滑动窗口压缩（保留最近 8 条）
│   ├── auth/
│   │   ├── mfa.ts            # MSAL Interface B：Device Code Flow + number-matching push
│   │   ├── totp.ts           # Interface C：TOTP 验证码生成（otpauth）
│   │   └── guard.ts          # toolNeedsMFA() 判断 + withMFA() 高阶包装
│   ├── tools/
│   │   ├── registry.ts       # 工具注册表（spec / requiresMFA / hidden）+ ToolContext 定义
│   │   ├── system.ts         # exec_shell / write_file / edit_file / delete_file / read_file
│   │   ├── code-assist.ts    # code_assist（双子 Agent 架构：daily 协调 + code 执行）
│   │   ├── ask-master.ts     # ask_master（隐藏工具：daily 子 Agent 暂停向用户提问）
│   │   ├── run-code-subagent.ts  # run_code_subagent（隐藏工具：daily 触发 code 子 Agent 执行）
│   │   ├── render-diagram.ts # render_diagram（mermaid mmdc / mermaid.ink；python matplotlib）
│   │   ├── send-report.ts    # send_report（Markdown → 图片，主动推送给用户）
│   │   ├── notify.ts         # notify_user（不等 run 结束即推送消息）
│   │   ├── skill-creator.ts  # create_skill（创建 Skill 文档并注册到 SKILLS.md）
│   │   ├── agent-fork.ts     # agent_fork / agent_status / agent_abort
│   │   ├── cron.ts           # cron_add / cron_list / cron_remove / cron_enable / cron_disable / cron_run / cron_run
│   │   └── mcp-manager.ts    # mcp_list_servers / mcp_enable_server / mcp_disable_server
│   ├── code/                 # Code 模式（/code 斜杠命令）
│   │   ├── index.ts          # 副作用入口，import 触发命令注册
│   │   ├── commands.ts       # /code /chat /plan /auto /new 命令实现
│   │   ├── system-prompt.ts  # buildCodeSystemPrompt()（精简代码专注 prompt）
│   │   ├── exit-plan-mode-tool.ts  # exit_plan_mode 工具（Plan 子模式计划审批）
│   │   └── backends/         # 代码后端类型定义（扩展点）
│   ├── commands/             # 斜杠命令注册表（/help /status /code /plan 等）
│   │   ├── registry.ts       # parseCommand() + executeCommand()
│   │   └── builtin.ts        # 内置斜杠命令（/help /status /code /chat /plan /auto /new）
│   ├── cron/                 # Cron 定时任务调度器
│   │   ├── scheduler.ts      # 轮询 jobs/ 目录，热加载 job JSON，到时触发 runner
│   │   ├── runner.ts         # 单步/Pipeline 两种模式；结果按策略推送；session 自动清理
│   │   ├── store.ts          # jobs/ 目录 CRUD（每个 job 独立 <id>.json 文件）
│   │   └── schema.ts         # Job 类型定义（Zod，兼容 once/every/daily；Pipeline steps）
│   ├── ipc/                  # Unix socket IPC（CLI chat ↔ daemon）
│   │   ├── server.ts         # daemon 端：监听 socket，路由 chat/list/new 请求
│   │   ├── client.ts         # CLI 端：连接 socket，流式打印 delta
│   │   └── protocol.ts       # 消息类型定义（Request / Response）
│   ├── mcp/                  # MCP client 管理器（懒加载）
│   │   └── client.ts         # MCPManager：读配置 → 按需连接 → 注册/隐藏工具
│   ├── connectors/
│   │   ├── base.ts           # Connector 接口 + InboundMessage + QQ 事件类型
│   │   ├── utils/
│   │   │   └── media-parser.ts  # 视觉消息解析（图片 URL → ContentPart[]）
│   │   └── qqbot/
│   │       ├── index.ts      # 实现 Connector 接口，胶水层
│   │       ├── gateway.ts    # WS 协议 + 消息队列 + 重连 + Session 持久化
│   │       ├── api.ts        # QQ REST API 封装（token singleflight + send + markdown 派发）
│   │       ├── outbound.ts   # 发送限流（1h/4次）+ 降级主动消息 + 媒体预检
│   │       ├── transcribe.ts # 语音附件转写（SILK → WAV → faster-whisper ASR）
│   │       └── attachments.ts  # 附件下载到 workspace/downloads/ + 内容注入（图片/语音）
│   └── config/
│       ├── schema.ts         # Zod schema（providers + backends + tools + cron + retry 等）
│       ├── loader.ts         # 读 ~/.tinyclaw/config.toml，不存在时自动复制模板
│       └── writer.ts         # 保留注释的 TOML 行级补丁（供 CLI config set 使用）
├── scripts/
│   └── transcribe.py         # faster-whisper 语音转文字脚本（供 transcribe.ts 调用）
├── mcp-servers/
│   ├── browser/              # Playwright 浏览器自动化 MCP server
│   ├── news/                 # 多源新闻抓取/存档/检索 MCP server
│   │   ├── index.ts          # MCP 工具注册：fetch_and_store / read_day / list_days / search_local / rebuild_index
│   │   └── lib/
│   │       └── news_fetch.py # HackerNews + 58 个 RSS 源；L1 SQLite 去重 + L2 n-gram Jaccard 去重
│   ├── notes/                # 动态笔记知识库 MCP server（Agent 隔离，支持 structured/timestamped/freeform）
│   │   └── index.ts          # 工具：list_categories / create_category / add_note / query_notes / search_notes / delete_note / get_due_reminders
│   └── polymarket/           # Polymarket 预测市场 MCP server
├── bin/
│   └── tinyclaw.ts           # 全局命令入口（bun link 后注册为 tinyclaw）
├── docs/                     # 文档（本文件所在目录）
├── config.example.toml       # 配置模板，无真实值，供参考
├── mcp.example.toml          # MCP server 配置模板
└── package.json              # bin.tinyclaw 字段声明全局命令
```

### 运行时数据（`~/.tinyclaw/`，不进仓库）

```
~/.tinyclaw/
├── config.toml               # 所有敏感配置（API key、Azure ID、QQ secret）
├── mcp.toml                  # MCP server 配置（独立文件）
├── .service_pid              # supervisor 进程 PID（tinyclaw restart 读取）
├── .github_token             # GitHub OAuth token（0600 权限，由 Device Flow 写入）
├── auth/
│   ├── msal-cache.json       # MSAL token 缓存（自动维护）
│   └── totp.key              # TOTP 共享密钥（auth mfa-setup 生成，0600 权限）
├── agents/                   # Agent 工作区（每个 Agent 独立）
│   ├── default/
│   │   ├── agent.toml        # 元数据（id、createdAt、bindings、[loop] 可选）
│   │   ├── SYSTEM.md         # Agent 系统提示（可选）
│   │   ├── MEM.md            # 持久记忆（跨 session 偏好与结论）
│   │   ├── SKILLS.md         # 技能目录（技能名 → 主文档路径）
│   │   ├── TASK.md           # Loop Agent 任务指令文件（[loop] 启用时读取）
│   │   ├── memory/           # 向量索引（index.sqlite）+ 压缩摘要 YYYY-MM-DD.md
│   │   ├── notes/            # Notes MCP 数据（index.json + <category>.md + remind_state.json）
│   │   ├── skills/           # 技能脚本目录
│   │   └── workspace/        # exec_shell 默认 cwd
│   │       ├── tmp/          # 临时文件
│   │       └── output/       # 输出文件
│   └── <custom>/             # 自定义 Agent
├── sessions/                 # 各 session 的 JSONL 持久化文件
│   ├── qqbot_c2c_<openid>.jsonl
│   ├── qqbot_c2c_<openid>.code.jsonl   # Code 模式独立文件
│   └── cli_<uuid>.jsonl
├── cron/
│   ├── jobs/                 # 每个 job 独立 JSON 文件（<id>.json），调度器热加载
│   └── logs/                 # 每次 run 的结果日志（<id>.jsonl，追加写入）
├── news/                     # news MCP server 的新闻存档
│   ├── YYYY-MM/
│   │   └── YYYY-MM-DD.md     # 每日新闻存档（Markdown，fetch_and_store 写入）
│   ├── seen_urls.db          # L1 URL 精确去重数据库（SQLite）
│   └── .update-pending       # 存在时触发主进程 QMD 重新索引 news 知识库
└── qqbot/
    ├── session.json          # WS Session 持久化（断线续传）
    └── downloads/            # 附件临时文件
```

---

## 模块说明

### LLM 多后端

- 统一 OpenAI-compatible 接口（`LLMClient`）
- 三个命名后端：`daily`（对话）/ `code`（代码任务）/ `summarizer`（摘要压缩）
- 配置格式：`[providers.*]` 管理凭证，`[llm.backends.*]` 的 `model` 字段使用 `"provider/model-id"` symbol
  - `"copilot/auto"` → 自动选择 Copilot 默认模型
  - `"copilot/claude-sonnet-4.5"` → 指定具体模型
  - `"openai/gpt-4o"` → OpenAI-compatible 后端
- `registry.get(name)` 运行时取后端实例，`registry.init()` 在 main.ts 中异步预初始化所有后端
- 每个后端携带 `supportsToolCalls` 标志（Copilot 后端从模型元数据自动推断）：
  - `true`（默认）→ 通过 OpenAI `tools` 参数进行 function calling
  - `false` → 自动切换为**文本模式工具调用**：系统提示注入工具列表与格式规则，LLM 以 `<tool_call>` XML 块响应，Agent 正则解析后执行
- 所有 LLM 调用均受**连接稳定性**保护（重试 / idle timeout / jitter），详见 [RETRY_AND_STABILITY.md](./RETRY_AND_STABILITY.md)


#### OpenAI-compatible（`provider` 不填 / 为 `"openai"`）

手动提供 `baseUrl` + `apiKey` + `model`，方便对接任意兼容 API。

#### GitHub Copilot（`provider = "copilot"`）

| 步骤 | 实现 | 说明 |
|------|------|------|
| 1. GitHub OAuth 认证 | `copilotSetup.ts` | RFC 8628 Device Flow，首次跳出浏览器授权，令牌写入 `~/.tinyclaw/.github_token`（0600） |
| 2. Token 解析优先级 | `copilot.ts` `resolveGitHubToken()` | token 文件 → `gh` CLI → Device Flow（同进程内缓存，不重复触发） |
| 3. Copilot token 换取 | `copilot.ts` `getCopilotToken()` | `GET /copilot_internal/v2/token`，TTL 缓存自动刷新 |
| 4. 模型动态发现 | `copilot.ts` `getCopilotModels()` | `GET /models`，回传 vendor / category / maxOutput / contextWindow 等 |
| 5. 乘数查表 | `copilot.ts` `MODEL_MULTIPLIERS_PAID` | 按官方文档静态表查 premium request 倍数；企业账号优先用 API 返回值 |
| 6. LLMClient 构建 | `copilot.ts` `buildCopilotClient()` | 注入自刷新 copilotFetch，每请求动态换 token |

**模型选择（`model = "auto"` 时）：**
```
is_chat_default → versatile+picker → powerful+picker → any picker → 第一个
```

**premium request 乘数表（付费计划）：**

| 乘数 | 模型 |
|------|------|
| free (×0) | GPT-4o · GPT-4.1 · GPT-5 mini · Raptor mini |
| ×0.25 | Grok Code Fast 1 |
| ×0.33 | Claude Haiku 4.5 · Gemini 3 Flash · GPT-5.1-Codex-Mini |
| ×1 | Claude Sonnet 系列 · GPT-5.x · Gemini 2.5/3 Pro 系列 |
| ×3 | Claude Opus 4.5 / 4.6 |
| ×30 | Claude Opus 4.6 (fast mode, preview) |

来源：[github/docs `data/tables/copilot/model-multipliers.yml`](https://github.com/github/docs/blob/main/data/tables/copilot/model-multipliers.yml)

### QMD 向量记忆

- 每轮对话追加写入 `~/.tinyclaw/memory/sessions/YYYY-MM-DD.md`
- 新对话开始前自动 `qmd.search(userInput)` 注入相关历史记忆
- token 超 80% 阈值 → summarizer LLM 生成摘要 → 归档进 QMD → 无缝开新 session
- 默认 embedding 模型：`Qwen3-Embedding-0.6B`（中文优化，~640MB，首次自动下载）

### Microsoft MFA

tinyclaw 支持三种 MFA 接口（通过 `auth.mfa.interface` 配置）：

**Interface A — 文字确认（`simple`，默认）**
- 向用户发送操作描述，等待回复"确认" / 其他内容（取消）

**Interface B — MSAL number-matching（`msal`）**
- Azure AD App Registration + Microsoft Authenticator 推送通知
- token 缓存在 `~/.tinyclaw/auth/msal-cache.json`，静默刷新

**Interface C — TOTP 验证码（`totp`）**
- 用户通过 Authenticator App（Google/Microsoft Authenticator 等）生成 6 位码回复确认
- 初次配置：`tinyclaw auth mfa-setup` → 生成二维码扫码绑定 → 密钥保存到 `~/.tinyclaw/auth/totp.key`

所有接口：超时 60s（可配）或用户拒绝 → 操作 abort  
高危工具范围：`exec_shell` / `delete_file` / `write_file` / `edit_file`（以及 `config.toml` 自定义黑名单）

### 代码/日常操作分离（code_assist 双子 Agent）

**code_assist 工具**：Master Agent 将代码任务委派给两个后台子 Agent 协作完成，不污染主对话历史。

#### 架构图

```
用户
 │ 发出代码任务
 ▼
Master Agent（chat 模式，daily LLM）
 │ 调用 code_assist(task)
 ▼
code_assist.runInternal()
 ├─ 一次性 MFA 预授权（两个子 Agent 共享）
 ├─ 创建 dailySession（slaveDepth=1，mfaPreApproved）
 │   绑定（parentId = masterSession）
 ├─ 创建 codeSession（slaveDepth=2，mfaPreApproved）
 │   绑定（parentId = dailySession）
 └─ slaveManager.fork(dailySession, task, dailyRunFn)
       │  后台异步运行
       ▼
  Daily 协调 Agent（daily LLM，系统提示：DAILY_SUBAGENT_SYSTEM）
   │  分析任务、制订计划、指挥 code 执行
   │
   ├─ 调用 run_code_subagent(instruction)
   │       └─ 同步等待 Code Agent 完成（ctx.codeRunFn）
   │
   ├─ 调用 ask_master(question, context, planPath?)
   │       ├─ 将问题 + plan.md 渲染为图片发给用户（mdToImage）
   │       ├─ 阻塞等待用户回复（session.pendingSlaveQuestion）
   │       └─ main.ts 拦截用户消息 → resolve() 解除阻塞
   │
   └─ 任务完成 → onSlaveComplete → Master 注入结果 → 通知用户
               ↕
  Code 执行 Agent（code LLM，系统提示：CODE_SUBAGENT_SYSTEM）
   读文件 / 写文件 / 执行命令 / 提交代码 …
```

#### 关键设计点

- **MFA 预授权**：`code_assist` 调用时触发一次 MFA，授权两个子 Agent 的 `mfaPreApproved = true`，后续工具调用跳过 MFA 弹窗
- **Session 绑定**：`session.bindParent()` 存储父子关系（`parentId` / `childIds[]`），便于追踪和清理
- **ask_master 阻塞机制**：daily 子 Agent 调用 `ask_master` → 在 `session.pendingSlaveQuestion` 上设置 Promise → `main.ts` 拦截用户下条消息 → resolve unblock → daily 子 Agent 继续运行
- **代码隔离**：code 子 Agent `slaveDepth=2`，无法再触发 fork，也不能调用 `ask_master`
- **反向汇报链**：code → daily（同步，工具返回值）；daily → master（异步，`onSlaveComplete`）；master → 用户（connector.send）

**Code 模式（`/code` 命令）**：切换为代码专注会话，独立 JSONL 文件，滑动窗口压缩，工具轮次上限 25（可配）。  
内置 **Plan / Auto 子模式**（`/plan` / `/auto`）：Plan 模式下 AI 先规划，调用 `exit_plan_mode` 工具提交计划摘要，用户确认后再执行。

### QQBot Connector

QQBot 是**内置 connector**，无需插件，填配置即用。

| 层 | 文件 | 职责 |
|---|---|---|
| API | `api.ts` | QQ REST API 封装（token singleflight、send 系列方法；`markdownSupport` 开启时以 `msg_type: 2 + markdown.content` 发送，否则 `msg_type: 0 + content`） |
| 传输 | `gateway.ts` | WebSocket 协议（Hello/Identify/Resume/Heartbeat/Reconnect） |
| 队列 | `gateway.ts` | 每 peerId 独立串行队列，跨用户并行（最多 10 并发） |
| 重连 | `gateway.ts` | 递增延迟重连（1s→60s），三档 Intent 权限自动降级 |
| 发送 | `outbound.ts` | 被动回复限流（1h/4次），超限自动降级主动消息，长文本分块 |
| 接口 | `index.ts` | 实现 `Connector` 接口，胶水层 |

**事件类型映射：**

| QQ 事件 | `InboundMessage.type` |
|---|---|
| `C2C_MESSAGE_CREATE` | `"c2c"` |
| `AT_MESSAGE_CREATE` | `"guild"` |
| `DIRECT_MESSAGE_CREATE` | `"dm"` |
| `GROUP_AT_MESSAGE_CREATE` | `"group"` |

Session 持久化到 `~/.tinyclaw/qqbot/session.json`，重启后自动 Resume，appId 变更自动失效。

### Cron 定时任务

- 数据存储：`~/.tinyclaw/cron/jobs/` （每个 job 独立 `<id>.json` 文件）
- 支持三种调度：`once`（ISO 8601 一次性）/ `every`（固定间隔秒数）/ `daily`（每天 HH:MM）
- 触发后启动独立 Agent 会话执行任务，结果通过 `Connector.send()` 主动推送
- 通知策略：`always`（每次）/ `on_change`（仅结果变化时）/ `on_error`（仅出错时）/ `never`
- 支持跨 run 对话历史（`stateful = true`）

**两种运行模式：**

1. **单步模式**（默认，向后兼容）：触发后对 `message` 字段执行一次 `runAgent()`，LLM 全权处理任务
2. **Pipeline 模式**：job 含 `steps` 字段时激活，多步骤串行执行，共享同一个 stateful session：
   - `{ type: "tool", name, args }`：直接调用指定工具（不走 LLM），输出注入 session 上下文供后续步骤感知
   - `{ type: "msg", content }`：向 session 注入 user 消息，触发完整 `runAgent()`（LLM 生成回复）
   - 最后一个 `msg` step 的 LLM 输出作为最终推送内容；若无 `msg` step，则取最后一个 `tool` step 的输出
   - 典型用例：`tool(exec_shell, curl …)` → `msg("根据以上数据生成简报")` → 推送给用户

详见 [CRON_PIPELINE.md](./CRON_PIPELINE.md)。

### Agent Fork（Master-Slave）

- `agent_fork` 工具：在后台启动 Slave agent，继承 Master 上下文快照，异步执行耗时任务
- Slave 完成后自动通知 Master，Master 注入结果并生成回复推送给用户
- `agent_status` / `agent_abort` 工具：查询进度 / 软中断 Slave
- 最大嵌套深度 1：Slave 内不允许再 fork

### MCP 支持

- 启动时只读取 `~/.tinyclaw/mcp.toml`，不连接任何 server
- Agent 通过 `mcp_list_servers` / `mcp_enable_server` / `mcp_disable_server` 按需懒加载
- 工具命名规范：`mcp_{serverName}_{toolName}`（最长 64 字符）
- `enabled` 字段控制 LLM 可见性；底层连接保持，disable 后可零延迟重 enable

---

## Connector 接口（`src/connectors/base.ts`）

```typescript
export interface Attachment {
  contentType: string
  url: string
  filename?: string
}

export interface InboundMessage {
  type: "c2c" | "group" | "guild" | "dm"
  senderId: string      // QQ openid
  peerId: string        // 路由 key（私聊=senderId，群=groupOpenid）
  content: string
  messageId: string
  timestamp: string
  attachments?: Attachment[]
}

export interface Connector {
  start(): Promise<void>
  stop(): Promise<void>
  onMessage(handler: (msg: InboundMessage) => Promise<string>): void
  send(peerId: string, type: InboundMessage["type"], text: string, replyToId?: string): Promise<void>
}
```

---

## 实现阶段

| Phase | 内容 | v1 状态 |
|-------|------|---------|
| 1 | 地基：package.json · tsconfig · config schema/loader | ✅ 完成 |
| 2 | LLM 多后端：client · registry | ✅ 完成 |
| 3 | QMD 记忆：qmd · store · summarizer | ✅ 完成 |
| 4 | MFA：mfa · guard | ✅ 完成 |
| 5 | 工具层：registry · codex · copilot · system | ✅ 完成 |
| 6 | Agent 主循环：session · router · agent | ✅ 完成 |
| 7 | QQBot：api · outbound · gateway · index + main.ts | ✅ 完成 |
| 8 | Cron：scheduler · runner · tools | ⏸ 预留，不实现 |
| 9 | GitHub Copilot 后端：token 换取 · 模型发现 · 乘数表 | ✅ 完成 |
| 10 | CLI 配置入口：model/config/auth/status/restart/completions | ✅ 完成 |
| 11 | 连接稳定性：重试策略 · jitter · stream idle timeout · 429 Retry-After | ✅ 完成 |
---

## CLI 配置工具（`tinyclaw`）

通过 `bun link` 将项目注册为全局命令，无需每次用 `bun run` 调用。

**安装：**
```bash
cd /path/to/tinyclaw && bun link
tinyclaw completions install && source ~/.bashrc
```

**命令列表：**

| 命令 | 说明 |
|------|------|
| `tinyclaw model show` | 显示三个后端当前模型 |
| `tinyclaw model list [backend]` | 列出可用模型（Copilot 后端实时查 API） |
| `tinyclaw model set [backend]` | 交互式数字菜单选模型 → 写入 config.toml → 可选 restart |
| `tinyclaw config show` | 格式化显示配置（密钥脱敏） |
| `tinyclaw config edit` | 用 `$EDITOR` 打开 config.toml |
| `tinyclaw config set <key> <val>` | dotted path 修改字段（自动推断 bool/int/string） |
| `tinyclaw auth github` | 重新执行 Device Flow OAuth |
| `tinyclaw auth status` | 检查 token 有效性 |
| `tinyclaw status` | 服务进程 + 配置摘要 + channel 状态 |
| `tinyclaw restart` | 向 `.service_pid` 指向的进程发送 SIGTERM |
| `tinyclaw completions install` | 自动写入 `~/.bashrc` / `~/.zshrc` / fish completions |

**扩展方式（注册新命令）：**

在 `src/cli/index.ts` 的 `COMMANDS` 对象和 `SUBCOMMANDS` 表各加一行即可，Tab 补全自动生效。

**Tab 补全机制：**
```
tinyclaw mo<Tab>
  → shell 调用 tinyclaw --complete "mo"
  → 输出全量候选（model config auth ...）
  → compgen -W 按前缀过滤 → 显示 model
```

补全覆盖层级：顶层命令 → 子命令 → backend 名（model set/list）→ shell 类型（completions install）

---

## 配置文件示例（`config.example.toml`）

```toml
# ── LLM 后端（方案 A：OpenAI-compatible） ────────────────────────────────────

[llm.backends.daily]
baseUrl = "https://api.openai.com/v1"
apiKey  = "sk-..."
model   = "gpt-4o"

[llm.backends.code]
baseUrl = "https://api.openai.com/v1"
apiKey  = "sk-..."
model   = "o4-mini"

[llm.backends.summarizer]
baseUrl = "https://api.openai.com/v1"
apiKey  = "sk-..."
model   = "gpt-4o-mini"

# ── LLM 后端（方案 B：GitHub Copilot 订阅） ──────────────────────────────────
# 需先运行 `gh auth login`，或通过首次启动的 Device Flow 完成授权
# token 持久化在 ~/.tinyclaw/.github_token，后续无需重新授权

# [llm.backends.daily]
# provider    = "copilot"
# githubToken = "gh_cli"   # "gh_cli" | "env"（$GITHUB_TOKEN）| 直接填 token
# model       = "auto"     # "auto" 或具体 model ID，如 "claude-sonnet-4.6"

# ── Microsoft MFA ──────────────────────────────────────────────────────────────
# 需要一个 Azure AD App Registration
# 注册地址：https://portal.azure.com → App registrations → New registration
# 获取 tenantId 和 clientId 后填入下方

[auth.mfa]
tenantId = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
clientId = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"

# ── QQ Bot ─────────────────────────────────────────────────────────────────────
# 官方 QQ 开放平台：https://q.qq.com/

[channels.qqbot]
appId        = "102xxxxx"
clientSecret = "your-client-secret"

# ── 向量记忆 ───────────────────────────────────────────────────────────────────
# embedModel 首次运行自动下载（~640MB）
# 支持 Qwen3-Embedding-0.6B（中文优化）或 embeddinggemma-300M（英文，更小）

[memory]
embedModel     = "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf"
tokenThreshold = 0.8   # 达到上下文 80% 时触发摘要压缩
```
