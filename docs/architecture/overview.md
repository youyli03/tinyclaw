# tinyclaw 架构文档

> 极简模块化 AI Agent 框架，Bun + TypeScript

--

### 跨 Session 通信(session_get / session_send)

- `session_get` 工具:列举对当前 Agent 可见的所有活跃 session(经双向 allow-list 过滤)
- `session_send` 工具:向指定 session 注入消息,触发该 session 的 Agent 处理任务
- **权限模型**:基于 `~/.tinyclaw/agents/<agentId>/access.toml` 双向 allow-list:
  - 发送方的 `can_access` 必须包含目标 agentId
  - 目标方的 `allow_from` 必须包含发送方 agentId
  - 任一不满足 → 拒绝(默认 deny)
- **典型用例**:loop session 完成分析后向用户主 session 汇报;主 Agent 向专用 Agent 分派子任务
- 仅在完整服务模式下可用,CLI/cron 模式下返回错误

详见 [commands/session-bridge.md](../commands/session-bridge.md)。

### Dashboard(Web UI)

- 访问方式:`tinyclaw web` 显示访问地址,内置 URL token 认证(cookie 持久化)
- **概览页**:今日系统/AI 请求趋势图,快速状态一览
- **指标页**:按 category/key 分组的折线图/柱状图,由 `db_write` 工具写入 `dashboard.db`
- **日报页**:展示 `write_report` 写入的 Markdown 日报存档,按 type+date 索引
- **Cron 页**:可展开的任务卡片列表,显示最近运行状态与日志

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
│   │   │                     # 支持 MFA 鉴权、__purpose 进度旁白、auto-fork、textMode 文本工具调用
│   │   ├── purpose-arbiter.ts # __purpose 展示仲裁（取代旧心跳：按工具真实耗时决定说不说）
│   │   ├── session.ts        # messages[] + JSONL 持久化 + 并发控制 + 压缩（chat/code 两路）
│   │   ├── router.ts         # 意图路由（扩展点，当前直通）
│   │   ├── agent-manager.ts  # Agent 工作区管理（创建/查找/路径/repair）+ session loop 配置读写
│   │   ├── loop-runner.ts    # Loop Session 引擎：扫描 sessions/*.toml，setInterval tick，runAgent
│   │   └── slave-manager.ts  # Slave agent 生命周期：fork（按轮结构化继承）/ status / abort / 进度推送 / 轨迹归档
│   │        （slave-trajectory.ts # Slave 轨迹归档：~/.tinyclaw/slaves/YYYY-MM/YYYY-MM-DD-<id>/）
│   ├── llm/
│   │   ├── client.ts         # OpenAI-compatible 统一接口（streamChat + withRetry + idle timeout）
│   │   ├── registry.ts       # 多后端注册（providers + backends）；get(name)；async init()
│   │   ├── copilot.ts        # GitHub Copilot：token 换取 + 模型发现 + LLMClient 构建
│   │   └── copilotSetup.ts   # RFC 8628 Device Flow OAuth + ~/.tinyclaw/.github_token 持久化
│   ├── memory/
│   │   ├── qmd.ts            # @tobilu/qmd SDK 封装（search / updateIndex / rebuildMemoryIndex，按 agentId 隔离命名空间）
│   │   ├── rkllm-embed.ts    # RKLLM NPU HTTP Embed 客户端（makeRkllmEmbedLlm，替代本地 LlamaCpp，1024 dim）
│   │   ├── cards.ts          # MemoryCard 结构定义与持久化（11 种类型：preference/constraint/profile 等）
│   │   ├── news-watcher.ts   # 监听 .update-pending 标记文件，自动触发增量索引
│   │   ├── store.ts          # 摘要 → agents/<id>/memory/YYYY-MM-DD.md
│   │   └── summarizer.ts     # chat: 全量压缩；code: 滑动窗口压缩（保留最近 8 条）
│   ├── auth/
│   │   ├── mfa.ts            # MSAL Interface B：Device Code Flow + number-matching push
│   │   ├── totp.ts           # Interface C：TOTP 验证码生成（otpauth）
│   │   └── guard.ts          # toolNeedsMFA() 判断 + withMFA() 高阶包装
│   ├── tools/
│   │   ├── registry.ts       # 工具注册表(spec / requiresMFA / hidden)+ ToolContext 定义
│   │   ├── system.ts         # exec_shell / write_file / edit_file / delete_file / read_file / read_image
│   │   ├── http-request.ts   # http_request(HTTPS GET/POST,headers 支持 $SECRET_NAME 占位符)
│   │   ├── code-assist.ts    # code_assist(双子 Agent 架构:daily 协调 + code 执行)
│   │   ├── ask-master.ts     # ask_master(隐藏工具:daily 子 Agent 暂停向用户提问)
│   │   ├── ask-user-tool.ts  # ask_user(向用户提问,支持预设选项)
│   │   ├── run-code-subagent.ts  # run_code_subagent(隐藏工具:daily 触发 code 子 Agent 执行)
│   │   ├── render-diagram.ts # render_diagram(mermaid mmdc / mermaid.ink;python matplotlib)
│   │   ├── send-report.ts    # send_report(Markdown/mermaid/python → 图片,主动推送给用户)
│   │   ├── notify.ts         # notify_user(不等 run 结束即推送消息)
│   │   ├── write-report.ts   # write_report(日报写入 ~/.tinyclaw/reports/<type>/<date>.md)
│   │   ├── db-write.ts       # db_write(业务指标写入 dashboard.db,Dashboard 折线图展示)
│   │   ├── search-store.ts   # search_store(向量语义搜索本地知识库,如 news)
│   │   ├── memory.ts         # memory_read/write_mem · read/write_active · append_feedback · append_card · append · search
│   │   ├── self-status.ts    # self_status(自省：模型/上下文/缓存命中率/记忆规模/定时任务)
│   │   ├── skill-creator.ts  # create_skill(创建 Skill 文档并注册到 SKILLS.md)
│   │   ├── skill-run.ts      # 技能执行辅助
│   │   ├── agent-fork.ts     # agent_fork / agent_status / agent_wait / agent_trace / agent_abort
│   │   ├── session-bridge.ts # session_get / session_send(跨 session 消息互传,双向 allow-list 权限)
│   │   ├── path-guard.ts     # 路径安全检查(防止越权访问)
│   │   ├── sanitize.ts       # 工具结果清理与截断
│   │   ├── cron.ts           # cron_add / cron_list / cron_remove / cron_enable / cron_disable / cron_run
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
│   │       ├── outbound.ts   # 发送限流（1h/4次）+ 降级主动消息 + 媒体预检 + C2C 流式会话
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
│   ├── polymarket/           # Polymarket 预测市场 MCP server(index.ts 待实现,lib/ 已实现签名逻辑)
│   └── sts2/                 # STS2AIAgent Mod MCP server
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
│   │   ├── agent.toml        # 元数据（id、createdAt、bindings）
│   │   ├── SYSTEM.md         # Agent 系统提示（可选）
│   │   ├── MEM.md            # 持久记忆（跨 session 偏好与结论）
│   │   ├── SKILLS.md         # 技能目录（技能名 → 主文档路径）
│   │   ├── TASK.md           # Loop Session 默认任务指令（相对 agentDir；可在 loop 配置中覆盖）
│   │   ├── memory/           # 向量索引（index.sqlite）+ 逐字层（transcript/）+ 压缩摘要 YYYY-MM-DD.md
│   │   ├── notes/            # Notes MCP 数据（index.json + <category>.md + remind_state.json）
│   │   ├── skills/           # 技能脚本目录
│   │   └── workspace/        # exec_shell 默认 cwd
│   │       ├── tmp/          # 临时文件
│   │       └── output/       # 输出文件
│   └── <custom>/             # 自定义 Agent
├── sessions/                 # 各 session 的持久化文件
│   ├── qqbot_c2c_<openid>.jsonl
│   ├── qqbot_c2c_<openid>.code.jsonl   # Code 模式独立文件
│   ├── cli_<uuid>.jsonl
│   └── <sanitized-sessionId>.toml      # Loop 配置（[loop] 块，chat loop 命令管理）
├── cron/
│   ├── jobs/                 # 每个 job 独立 JSON 文件（<id>.json），调度器热加载
│   └── logs/                 # 每次 run 的结果日志（<id>.jsonl，追加写入）
├── slaves/                   # Slave(sub-agent)轨迹归档（结束时从 sessions/ 移动至此，不再删除）
│   └── YYYY-MM/YYYY-MM-DD-<slaveId>/
│       ├── trajectory.jsonl  # 完整轨迹：继承的上下文 + 本次全部工具调用与结果
│       ├── meta.json         # task / status / toolsUsed / agentId / masterSessionId / 起止时间
│       └── result.md         # 最终结果全文（agent_trace 读取）
├── reports/                  # 日报存档(<type>/<date>.md,write_report 写入,Dashboard 展示)
├── dashboard.db              # Dashboard 业务指标数据库(SQLite,db_write 写入)
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
- 三个命名后端:`daily`(对话)/ `code`(代码任务)/ `summarizer`(摘要压缩)/ `vision`(视觉模型,可选)
- 配置格式：`[providers.*]` 管理凭证，`[llm.backends.*]` 的 `model` 字段使用 `"provider/model-id"` symbol
  - `"copilot/auto"` → 自动选择 Copilot 默认模型
  - `"copilot/claude-sonnet-4.5"` → 指定具体模型
  - `"openai/gpt-4o"` → OpenAI-compatible 后端
- `registry.get(name)` 运行时取后端实例，`registry.init()` 在 main.ts 中异步预初始化所有后端
- 每个后端携带 `supportsToolCalls` 标志（Copilot 后端从模型元数据自动推断；其它 provider 默认 true，可在 `[llm.backends.*]` 用 `supportsToolCalls = false` 手动声明弱模型）：
  - `true`（默认）→ 通过 OpenAI `tools` 参数进行 function calling
  - `false` → 自动切换为**文本模式工具调用**：系统提示注入工具列表与格式规则，LLM 以 `<tool_call>` XML 块响应，Agent 正则解析后执行
- 所有 LLM 调用均受**连接稳定性**保护（重试 / idle timeout / jitter），详见 [RETRY_AND_STABILITY.md](./RETRY_AND_STABILITY.md)


#### OpenAI-compatible（`provider` 不填 / 为 `"openai"`）

手动提供 `baseUrl` + `apiKey` + `model`，方便对接任意兼容 API。

对接不支持 function calling 的弱模型时,在 `[llm.backends.*]` 设 `supportsToolCalls = false`,自动改走 textMode 文本工具调用(详见上文 supportsToolCalls 标志说明):

```toml
[llm.backends.daily]
model = "openai/some-weak-model"
supportsToolCalls = false
```

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
- Embedding 后端（二选一）：
  - **RKLLM NPU HTTP embed**（推荐，RK3588 板子）：`rkllmEmbed.enabled = true`，1024 dim，启动 `~/rkllm-embed-server/start.sh`
  - **本地 GGUF**（默认，CPU）：`rkllmEmbed.enabled = false`（默认），`embedModel = "hf:..."` 指定模型（~380MB）

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
| 发送 | `outbound.ts` | 被动回复限流（1h/4次），超限自动降级主动消息，长文本分块；`C2CStreamSession` 用官方 `/stream_messages` 流式输出**单聊最终回复**（整段只占 1 次额度；失败/前缀不匹配自动回退普通发送） |
| 富媒体 | `utils/media-parser.ts` | `<img>/<audio>/<video>/<file>` 标签解析（含 `qqimg` 等别名与代码块屏蔽）。流式路径额外用 `splitMediaText()` 把正文与媒体标签分开：**正文走流式、媒体单独走普通发送**——`sendMessage()` 才会解析标签并上传文件，若把标签直接流式推给用户，用户只会看到 `<file src=.../>` 裸文本且文件永远发不出去；推送前用 `stripMediaForStream()` 剥离标签并扣住未闭合的标签起始 |
| 富媒体上传 | `api.ts` | `file_type`：**1=图片(png/jpg)、2=视频(mp4)、3=语音(silk)、4=文件(任意)**（顺序不是"音频在视频前"，改这里前先对官方文档）。上传走 `file_data`（base64 内联单次请求，**编码后约 10 MB 为网关上限**）；超出需分片上传（`upload_prepare`→PUT→`upload_part_finish`）**尚未实现**，故本地在发送前按 base64 长度拦截。`img` 的本地球体若服务端拒收该类型，自动回退 `file_type=4` 重发 |
| 接口 | `index.ts` | 实现 `Connector` 接口，胶水层。`send()` 返回 `SendOutcome`（`hadMedia` / `mediaFailed` / `mediaError`）：媒体失败时会静默降级为纯文本，调用方据此判断"是否真的送到了" |

**事件类型映射：**

| QQ 事件 | `InboundMessage.type` |
|---|---|
| `C2C_MESSAGE_CREATE` | `"c2c"` |
| `AT_MESSAGE_CREATE` | `"guild"` |
| `DIRECT_MESSAGE_CREATE` | `"dm"` |
| `GROUP_AT_MESSAGE_CREATE` | `"group"` |

Session 持久化到 `~/.tinyclaw/qqbot/session.json`，重启后自动 Resume，appId 变更自动失效。

**多 QQBot 实例支持：**

除单 bot 配置 `[channels.qqbot]` 外，支持 `[channels.qqbots.<id>]` map 同时运行多个 bot：

```toml
[channels.qqbots.main]
appId        = "102xxxxx"
clientSecret = "secret1"
agentId      = "default"   # 绑定的 Agent

[channels.qqbots.work]
appId        = "103xxxxx"
clientSecret = "secret2"
agentId      = "work"      # 各 bot 可绑定不同 Agent
```

每个 bot 有独立的 token/gateway/session 状态，通过 `botId` 路由，互不干扰。

**InboundMessageBus（消息路由层）：**

`src/connectors/inbound-bus.ts` 是统一入站消息路由器：
- 接收所有 bot 的 `InboundMessage`，根据 `agentId` 路由到对应 Session
- 斜杠命令（`/code`、`/plan`、`/status` 等）在此层拦截，**优先于** LLM runAgent 处理
- plan / ask_user 等待期间，`/status` 等命令仍可即时响应


### Cron 定时任务

- 数据存储：`~/.tinyclaw/cron/jobs/` （每个 job 独立 `<id>.json` 文件）
- 支持三种调度：`once`（ISO 8601 一次性）/ `every`（固定间隔秒数）/ `daily`（每天 HH:MM）；`daily` 同时支持 `timesOfDay`（数组，一天多个时间点）
- 触发后启动独立 Agent 会话执行任务，结果通过 `Connector.send()` 主动推送
- 通知策略：`always`（每次）/ `on_change`（仅结果变化时）/ `on_error`（仅出错时）/ `never`
- 支持跨 run 对话历史（`stateful = true`）
- `model` 字段:每个 job 可单独指定使用的模型(如 `"copilot/claude-haiku-3.5"`),覆盖全局默认
- `mfaExempt: true`:Pipeline 模式的 `tool` step 默认豁免 MFA,Cron 任务无需人工审批

**两种运行模式：**

1. **单步模式**（默认，向后兼容）：触发后对 `message` 字段执行一次 `runAgent()`，LLM 全权处理任务
2. **Pipeline 模式**：job 含 `steps` 字段时激活，多步骤串行执行，共享同一个 stateful session：
   - `{ type: "tool", name, args }`：直接调用指定工具（不走 LLM），输出注入 session 上下文供后续步骤感知
   - `{ type: "msg", content }`：向 session 注入 user 消息，触发完整 `runAgent()`（LLM 生成回复）
   - 最后一个 `msg` step 的 LLM 输出作为最终推送内容；若无 `msg` step，则取最后一个 `tool` step 的输出
   - 典型用例：`tool(exec_shell, curl …)` → `msg("根据以上数据生成简报")` → 推送给用户

详见 [CRON_PIPELINE.md](./CRON_PIPELINE.md)。

### Loop Session（持续自主执行）

Loop Session 将一个普通 Session 标记为"自主持续运行"模式：服务按固定间隔读取 `TASK.md`，调用 LLM 执行任务，结果按策略推送。

- **配置位置**：`~/.tinyclaw/sessions/<sanitized-sessionId>.toml` 中的 `[loop]` 块
- **与 Cron 的区别**：Loop 复用常驻 Session，记忆跨 tick 持续累积；Cron 每次独立 session
- **CLI 管理**：`tinyclaw chat loop list/show/enable/disable/trigger/set`
- **并发保护**：上次 tick 未完成时自动跳过，不叠加执行
- **日志**：`~/.tinyclaw/cron/logs/loop:<sanitized-sessionId>.jsonl`

详见 [LOOP_SESSION.md](./LOOP_SESSION.md)。

### 工具调用的 `__purpose`(进度旁白)

取代了此前的**定时心跳**(`agent.heartbeatIntervalSecs`,默认每 120s 推一句写死的"仍在处理中")。
现在进度提示完全由模型自己写的短旁白驱动。

- **注入**:每个工具的参数 schema 会被加上可选字段 `__purpose`(内置工具、MCP 工具、`customTools` 一视同仁,收口在 `agent.ts` 组装 `tools` 之后)。实现**必须深拷贝**——`getAllToolSpecs()` 返回注册表里的同一对象引用,就地改会让 schema 每轮无限膨胀
- **剥离**:执行前统一从参数中剥离,工具实现与 MCP server 永远看不到它;MFA 判定与告警文案也用剥离后的参数。文本模式(`<tool_call>` XML)走同一条路径
- **进历史**:`__purpose` 就在 assistant 消息的 `tool_calls[].function.arguments` 里,随 JSONL 自然持久化。**不额外插入独立消息**——插在 `assistant(tool_calls)` 与 `tool(result)` 之间会打断配对触发 400
- **展示仲裁**(`core/purpose-arbiter.ts`):每轮 `__purpose` 不设上限,但不是每条都给用户看
  - **只有运行超过 `agent.purposeHoldMs`(默认 4s)的工具才算"用户确实在等"**;快工具静默
  - 两个触发点:①工具运行满 hold ②长工具刚结束且当前无在跑的工具
  - **新鲜度约束**:发送时按**当时的真实进度**重新选取——有工具在跑就取"最后发起"的那条,否则取"最后完成"的那条;已被后续进展超越的候选一律丢弃,**不回放**
  - `agent.purposeMinGapMs`(默认 3s)限制两次展示的间隔;`agent_fork` / `session_send` 这类"秒返回但把活干在后台"的工具跳过 hold 直接展示
- **长度**:`agent.purposeMaxUnits`(默认 10)。计长单位:CJK 按字、连续拉丁串按词,**emoji 不计**;超出按**图形簇边界**截断(`Intl.Segmenter`,不会切断 emoji 或代理对)
- **不因超长拒绝工具调用**——只截断
- 开关:`agent.toolPurpose`(默认 true)

### Agent Fork(Master-Slave)

- `agent_fork` 工具:在后台启动 Slave agent,异步执行耗时任务
  - `context_mode`:继承模式,默认取 `memory.slaveContextMode`
    - `task-only`:不继承历史(system prompt 里的 MEM.md / SKILLS.md 仍然在)。**背景自足时最省**
    - `minimal`:Master 压缩摘要 + 最近 ≤6 轮
    - `standard`(默认):Master 压缩摘要 + 预算内尽可能多的近期轮次
    - `full`:同上但不设轮数上限(仍受预算约束)
  - `context_rounds`:轮数**上限**(与 mode 取更严格者),默认 10,最大 30
  - **预算按窗口比例**:`budgetTokens = clamp(窗口 × memory.slaveContextRatio, 8000, 窗口 − 8000)`。
    固定字符数在不同窗口下不自洽(同一个值在 128k 窗口占 27%、在 800k 窗口只占 4%),故改为比例制。
    Slave 每次 fork 都是新 session,继承内容首次请求**缓存全部未命中、按全价计费**(Master 那边是热的),
    因此**不要全拿**
  - **只取最近**:从最新一轮向前累计直到用满预算即停(不是"取一批再从最旧砍"——那会先把远期拉进来、
    再砍掉近因边缘,顺序是反的)。按轮对齐,起点必须落在 `role:"user"`
  - **继承的职责是"近因"**:本 claw 的 chat 模式是长会话陪伴/管家型,最早那条消息可能来自几个月前。
    远期由三处承担:system prompt 里的 `MEM.md`(长期偏好)、继承时注入的 Master 压缩检查点(本会话中段)、
    以及启动时的**召回层**(见下)
  - **召回层**(`memory.slaveRecall`,默认开):Slave 的自动记忆检索在 `agent.ts` 里被 `!isSlave` 关闭,
    因此启动时补两件事:注入该 Agent 的 `ACTIVE.md`("近期活跃上下文 / 未完成事项 / 最新要求")、
    用 Slave 的 `task` 做一次 QMD 语义检索并注入相关历史片段。把"远期记忆"从"塞进上下文"变成"按需召回"。
    整层带 **3s 超时**(`RECALL_TIMEOUT_MS`)——它位于 `runFn` 之前,耗时直接叠加到 Slave 启动延迟上,
    而检索内部含 embed 服务探活(5s 超时)与 sqlite 回退路径;超时即放弃召回并记日志,绝不拖住 Slave 开工
  - 继承为**结构化复制**(保留 `tool_calls` 与 `role:"tool"`),并同步写入 Slave 自己的 JSONL,使轨迹自包含
  - 继承时**剥掉** Master 消息上的 `_loopTaskRef`:该字段的语义是"最后一条此类消息由 `getMessagesForLLM()` 展开为该路径的文件内容",而 Slave 继承到的 ref 指向 **Master 的** loop 任务文件;保留会让 Slave 侧用它顶掉真正的注入载荷
  - `result_mode: "inject"`(默认):Slave 完成后自动将结果注入 Master session,触发新一轮 LLM 推理后回复用户
  - `result_mode: "wait"`:Slave 完成后静默,Master 需主动调用 `agent_wait(slave_id)` 获取结果;适合并行 fork 多个 Slave 后统一汇总
- `agent_status` 工具:查询单个 Slave 进度(当前阶段 / 已用工具与调用次数 / 实时输出尾部 / 轨迹目录),或列出所有 Slave
- `agent_wait` 工具:等待指定 Slave(或当前会话所有 Slave)完成并返回**结果全文**,支持 `timeout_secs`。
  超时**不改写 Slave 状态**,返回 `timedOut` 标志与仍在运行的 id 列表(超时是调用方的观察结果,不是被观察对象的状态)
- `agent_trace` 工具:检索已归档的 Slave 轨迹(不传参列出最近归档;传 `slave_id` 取结果全文与轨迹路径)
- `agent_abort` 工具:软中断 Slave(只记录中止意图,状态由真正收尾决定,避免状态领先于事实)
- 最大嵌套深度 1:Slave 内不允许再 fork(`agent_fork` 返回错误提示)
- **轨迹归档**:Slave 结束时其 JSONL 被**移动**到 `~/.tinyclaw/slaves/YYYY-MM/YYYY-MM-DD-<slaveId>/`
  (`trajectory.jsonl` + `meta.json` + `result.md`),不再删除;进程重启后遗留的孤立 JSONL 由 `gc()` 归档而非丢弃
- **统一 run 队列**:同一 session 上的一切 `runAgent` 经 `Session.runExclusive()` 严格串行
  (用户消息 / Slave 结果注入 / `session_send` / loop tick / IPC 共用同一队列),避免 messages[] 交错与
  `currentRunPromise` 被覆盖;`Session.waitIdle()` 用于「等待空闲」而非「排队执行」

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

/** 一次发送的结果：文本可能已送达，但其中的媒体标签失败并被静默降级为纯文本 */
export interface SendOutcome {
  hadMedia: boolean
  mediaFailed: boolean
  mediaError?: string
}

export interface Connector {
  start(): Promise<void>
  stop(): Promise<void>
  onMessage(handler: (msg: InboundMessage) => Promise<string>): void
  send(peerId: string, type: InboundMessage["type"], text: string, replyToId?: string): Promise<SendOutcome>
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

# 可选:图片识别专用后端(fallback,用于 read_image 等视觉工具)
# [llm.backends.vision]
# baseUrl = "https://api.openai.com/v1"
# apiKey  = "sk-..."
# model   = "gpt-4o-mini"

# DeepSeek 等支持思维链的模型可关闭 thinking(减少 token 消耗)
# disableThinking = true   # 在对应后端节下添加

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
# 使用 RKLLM NPU embed(推荐,RK3588 板子):先启动 ~/rkllm-embed-server/start.sh
# 可选:自定义额外知识库(如 Obsidian notes),见 ~/.tinyclaw/memstores.toml

[memory]
rkllmEmbed.enabled = true
rkllmEmbed.port    = 11434
tokenThreshold = 0.8   # 达到上下文 80% 时触发摘要压缩

# Subagent（agent_fork）上下文继承预算与模式，见「Agent Fork」节
slaveContextRatio = 0.05        # 预算 = clamp(窗口 × 比例, 8000, 窗口 − 8000)
slaveContextMode  = "standard"  # task-only | minimal | standard | full
slaveRecall       = true        # Slave 启动时注入 ACTIVE.md + 用 task 做 QMD 语义检索

# 工具调用的 __purpose 进度旁白（取代旧心跳），见「工具调用的 __purpose」节
[agent]
toolPurpose      = true    # 是否启用（关掉则完全不注入、不展示）
purposeMaxUnits  = 10      # 长度上限：CJK 按字、拉丁串按词；emoji 不计
purposeHoldMs    = 4000    # 工具跑超过该时长才算"用户在等"；0 = 一开始就展示
purposeMinGapMs  = 3000    # 两次展示的最小间隔
```

---

## IPC 协议对照

| 请求类型 | 参数 | 说明 |
|---|---|---|
| `chat` | `sessionId`, `message` | 向会话发送消息（流式回复） |
| `list` | — | 获取所有内存中的会话快照 |
| `new` | `agentId?` | 创建新终端会话 |
| `memory_rebuild` | `agentId?` | 在服务进程内重建 QMD 向量索引(读取 memstores.toml,使用 RKLLM embed) |

| 响应类型 | 字段 | 说明 |
|---|---|---|
| `chunk` | `delta` | 流式文本片段 |
| `done` | — | 本次回复结束 |
| `error` | `message` | 错误信息 |
| `sessions` | `sessions[]` | 会话列表（响应 `list`） |
| `created` | `sessionId` | 新会话 ID（响应 `new`） |

---

## 子 Agent 绑定（Session Bind）

`code_assist` 等工具会创建子 Agent Session，并通过 **bind** 机制维护父子关系。

### 绑定字段（`session.ts`）

| 字段 | 类型 | 说明 |
|---|---|---|
| `parentId` | `string \| null` | 父 Session ID（Master 或上级 daily Agent）|
| `childIds` | `string[]` | 子 Session ID 列表 |
| `mfaPreApproved` | `boolean` | 是否已通过一次性 MFA 预授权（跳过后续 MFA 弹窗）|
| `pendingSlaveQuestion` | `{ question, resolve } \| null` | daily 子 Agent 调用 `ask_master` 时的挂起问题 |

### 绑定方法

```typescript
// 在子 Session 上调用，同时更新父 Session 的 childIds[]
childSession.bindParent(masterSession);

// 子 Agent 完成时清理父 Session 的 childIds[]
masterSession.removeChild(childSession.sessionId);
```

### ask_master 阻塞流程

```
daily 子 Agent 调用 ask_master(question, context, planPath?)
  └→ 将问题 + plan.md 渲染为图片发给用户
  └→ 在 masterSession.pendingSlaveQuestion 设置 { question, resolve }
  └→ 阻塞等待（async Promise）

用户回复消息
  └→ main.ts handleMessage() 检测 session.pendingSlaveQuestion
  └→ session.pendingSlaveQuestion = null
  └→ resolve(userMessage)  ← 解除 daily 子 Agent 阻塞
  └→ 发送"已收到，已转发给 AI 继续处理..."
  └→ return（不触发 runAgent）

daily 子 Agent 继续运行（获得用户回复作为工具返回值）
```

### 层级关系示意

```
masterSession（chat，slaveDepth=0）
  └─ dailySession（daily LLM，slaveDepth=1，mfaPreApproved=true）
       └─ codeSession（code LLM，slaveDepth=2，mfaPreApproved=true）
```

- `slaveDepth=2` 的 code Session 不允许再 fork（`agent_fork` 返回错误）
- `slaveDepth=2` 的 code Session 不持有 `ask_master` 工具（只注入给 daily）

---

## 常用操作速查

```bash
# Agent 管理
tinyclaw agent new work          # 创建名为 work 的 Agent
tinyclaw agent edit work         # 编辑 work 的系统提示
tinyclaw agent list              # 列出所有 Agent
tinyclaw agent show work         # 查看 work 的详情
tinyclaw agent delete work       # 删除 work（含其记忆）

# 会话操作
tinyclaw chat new                        # 新建终端会话（默认 Agent）
tinyclaw chat new --agent work           # 新建绑定到 work 的会话
tinyclaw chat list                       # 查看所有会话（只读）
tinyclaw chat -s cli:<uuid> 你好         # 发送消息
tinyclaw chat -s cli:<uuid> bind work    # 将会话绑定到 work Agent

# 查看记忆文件
ls ~/.tinyclaw/agents/default/memory/    # 默认 Agent 的压缩摘要
ls ~/.tinyclaw/agents/work/memory/       # work Agent 的压缩摘要
ls ~/.tinyclaw/sessions/                 # 原始对话 JSONL + loop .toml 配置
```
