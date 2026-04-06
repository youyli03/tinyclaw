# tinyclaw

极简 AI Agent 框架。Bun + TypeScript,内置 QQBot,支持 MFA 高危操作鉴权。

## 特性

- **多后端 LLM**:GitHub Copilot(凭订阅自动发现模型)或任意 OpenAI-compatible API
- **内置工具集**:文件读写、Shell 执行、HTTP 请求、图表渲染、Cron 定时、MCP 集成、Agent Fork 等
- **Cron Pipeline**:`steps` 数组精确编排 tool → msg 多步流水线,结果推送到 QQ
- **Agent Fork**:后台启动 Slave agent 异步执行耗时任务;`agent_wait` 汇总多 Slave 结果
- **跨 Session 通信**:`session_get / session_send` 实现不同 Agent session 之间消息互传
- **MCP 支持**:懒加载,按需 enable/disable,内置 Browser / News / Notes / Polymarket 等 MCP server
- **MFA 鉴权**:高危工具支持 Azure AD number-matching 推送、TOTP 验证码、文字确认三种方式
- **向量记忆**:对话摘要自动向量化,token 超阈值时自动压缩;`/compact` 手动压缩;多 Agent 独立命名空间
- **Dashboard**:内置 Web UI(`tinyclaw web`),展示指标趋势图、日报存档、Cron 任务状态
- **Code 模式**:`/code` 切换代码专注会话,内置 Plan / Auto 子模式,滑动窗口压缩保留最近上下文
- **语音输入**:QQBot 收到语音消息自动转写(本地 faster-whisper)
- **图片识别**:QQBot 接收图片消息自动转为 vision 内容;`read_image` 工具主动读取本地图片
- **进程守护**:supervisor 自动重启,崩溃恢复不丢上下文
- **可扩展**:实现 `Connector` 接口即可接入新平台(TG / WhatsApp 等)

## 快速开始

```bash
bun install          # 安装依赖
bun link             # 注册全局命令 tinyclaw(一次性)
bun src/main.ts      # 首次启动,自动生成 ~/.tinyclaw/config.toml
# 编辑配置后重启
tinyclaw restart
```

## 配置

所有配置在 `~/.tinyclaw/config.toml`(不进仓库),模板见 [config.example.toml](config.example.toml)。

**GitHub Copilot:**
```toml
[providers.copilot]
githubToken = "gh_cli"   # 需先 gh auth login,或首次启动时走 Device Flow 授权

[llm.backends]
daily      = { model = "copilot/auto" }
summarizer = { model = "copilot/auto" }
```

**OpenAI-compatible:**
```toml
[providers.openai]
apiKey  = "sk-..."
baseUrl = "https://api.openai.com/v1"

[llm.backends]
daily      = { model = "openai/gpt-4o" }
summarizer = { model = "openai/gpt-4o-mini" }
```

**QQBot + MFA(可选):**
```toml
[channels.qqbot]
appId        = "你的 AppID"
clientSecret = "你的 ClientSecret"

[auth.mfa]
tenantId = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
clientId = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

## CLI 速查

```bash
tinyclaw status                        # 服务状态
tinyclaw start / restart / logs [-f]   # 启动 / 重启 / 查看日志

tinyclaw agent new <id>                # 创建 Agent
tinyclaw agent edit <id>               # 编辑系统提示
tinyclaw agent list                    # 列出所有 Agent

tinyclaw model list [backend]          # 可用模型列表
tinyclaw model set [daily|code|summarizer]  # 交互式切换模型

tinyclaw cron list                     # 定时任务列表
tinyclaw cron add / remove / run <id>  # 添加 / 删除 / 立即触发

tinyclaw chat loop list                    # 查看所有 loop session
tinyclaw chat loop enable <sessionId>      # 启用(或新建)loop
tinyclaw chat loop disable <sessionId>     # 禁用 loop
tinyclaw chat loop set <sessionId> <k=v>   # 修改配置字段
tinyclaw chat loop trigger <sessionId>     # 立即触发一次 tick

tinyclaw web                           # 显示 Dashboard 访问地址

tinyclaw config show / edit            # 查看(脱敏)/ 编辑配置
tinyclaw auth github / mfa-setup       # GitHub 授权 / TOTP 绑定

tinyclaw completions install           # 安装 tab 补全
```

### 对话内斜杠命令

| 命令 | 说明 |
|------|------|
| `/code` | 切换到 Code 模式(独立 JSONL,滑动窗口压缩) |
| `/chat` | 返回 Chat 模式 |
| `/plan` | Code 模式下切换到 Plan 子模式(先规划再执行) |
| `/auto` | Code 模式下切换到 Auto 子模式(直接执行,默认) |
| `/compact` | 手动触发上下文压缩(无需等 token 自动超限) |
| `/new` | 新建会话 |

## 内置工具速查

### 文件与系统

| 工具 | 说明 |
|------|------|
| `exec_shell` | 执行 Shell 命令(MFA 可配) |
| `write_file` | 写入文件(MFA 可配) |
| `edit_file` | 精确替换文件片段(MFA 可配) |
| `delete_file` | 删除文件或目录(MFA 可配) |
| `read_file` | 读取文件内容(≤50KB) |
| `read_image` | 读取本地图片返回 base64,供视觉模型分析 |
| `http_request` | 发送 HTTPS 请求,headers 支持 `$SECRET_NAME` 占位符 |

### Agent 协作

| 工具 | 说明 |
|------|------|
| `agent_fork` | 后台 fork Slave agent 异步执行任务(`result_mode: inject\|wait`) |
| `agent_status` | 查询 Slave 状态与进度 |
| `agent_wait` | 等待指定 Slave(或所有 Slave)完成并返回结果 |
| `agent_abort` | 软中断 Slave |
| `session_get` | 列举对当前 Agent 可见的所有活跃 session |
| `session_send` | 向指定 session 注入消息,触发 Agent 处理 |
| `ask_user` | 暂停并向用户提问(含预设选项) |

### 记忆与知识库

| 工具 | 说明 |
|------|------|
| `memory_read_mem` | 读取当前 Agent 的 MEM.md |
| `memory_write_mem` | 写入 MEM.md(覆盖或追加) |
| `memory_append` | 追加一条记忆到当日历史存档并触发向量索引更新 |
| `memory_search` | 手动触发 QMD 向量搜索历史记忆 |
| `search_store` | 在本地知识库(如 `news`)做语义向量搜索 |

### 可视化与报告

| 工具 | 说明 |
|------|------|
| `render_diagram` | 渲染 mermaid/python 图表为图片(返回 `<img>` 标签) |
| `send_report` | 将 Markdown/mermaid/python 渲染为图片立即推送给用户 |
| `notify_user` | 立即发送纯文本通知(不等任务结束) |
| `write_report` | 将日报写入本地文件供 Dashboard 展示 |
| `db_write` | 将业务指标数据写入 Dashboard 数据库(折线图/柱状图) |

### Cron 与 MCP

| 工具 | 说明 |
|------|------|
| `cron_add / list / remove` | 管理定时任务 |
| `cron_enable / disable / run` | 启用 / 禁用 / 立即触发任务 |
| `mcp_list_servers` | 列出所有 MCP server |
| `mcp_enable_server` | 启用并加载 MCP server 工具 |
| `mcp_disable_server` | 隐藏 MCP server 工具(底层连接保持) |

### Code 模式专用

| 工具 | 说明 |
|------|------|
| `exit_plan_mode` | Plan 子模式下提交计划摘要,等待用户审批 |
| `create_skill` | 创建 Skill 文档并注册到 SKILLS.md |

## 运行时目录

```
~/.tinyclaw/
├── config.toml          # 配置(含密钥,不进仓库)
├── mcp.toml             # MCP server 配置
├── memstores.toml       # 向量知识库配置(news 等)
├── dashboard.db         # Dashboard 指标数据库(SQLite)
├── agents/default/      # 默认 Agent 工作区
│   ├── SYSTEM.md        # 系统提示
│   ├── MEM.md           # 持久记忆
│   ├── SKILLS.md        # 技能目录
│   ├── TASK.md          # Loop Session 默认任务指令
│   ├── access.toml      # 跨 session 通信权限(can_access / allow_from)
│   ├── memory/          # 向量索引(index.sqlite) + 压缩摘要 YYYY-MM-DD.md
│   ├── notes/           # Notes MCP 数据
│   ├── skills/          # Skill 脚本目录
│   └── workspace/       # Shell 命令默认 cwd
│       ├── tmp/         # 临时文件
│       └── output/      # 输出文件
├── sessions/            # 对话 JSONL(崩溃恢复)+ loop 配置 .toml
├── cron/
│   ├── jobs/            # 定时任务持久化(<id>.json)
│   └── logs/            # 每次 run 的结果日志
├── reports/             # 日报存档(<type>/<date>.md,供 Dashboard 展示)
└── news/                # News MCP 新闻存档(YYYY-MM/YYYY-MM-DD.md)
```

## 系统依赖(可选)

| 功能 | 依赖 |
|------|------|
| 消息图片渲染 | `chromium-browser` + `pip install markdown-it-py Pillow` |
| 语音转文字 | `pip install faster-whisper pilk` |
| News MCP | `pip install requests beautifulsoup4 lxml` |
| Python 图表 | `pip install matplotlib` |

## 文档

**架构**

- [architecture/overview.md](docs/architecture/overview.md) — 整体架构、模块说明、IPC 协议、操作速查
- [architecture/agent-loop.md](docs/architecture/agent-loop.md) — ReAct 循环、MFA、压缩、并发处理
- [architecture/retry.md](docs/architecture/retry.md) — 连接稳定性与重试策略(含 WebSocket 路径)

**功能命令参考**

- [commands/code-mode.md](docs/commands/code-mode.md) — Code 模式(/code /plan /auto /compact)
- [commands/cron-pipeline.md](docs/commands/cron-pipeline.md) — Cron Pipeline 多步流水线
- [commands/loop-session.md](docs/commands/loop-session.md) — Loop Session 持续自主执行
- [commands/session-bridge.md](docs/commands/session-bridge.md) — 跨 Session 通信(session_get/send)

**MCP Server**

- [mcp/news.md](docs/mcp/news.md) — 多源新闻抓取/存档/检索
- [mcp/notes.md](docs/mcp/notes.md) — 结构化笔记知识库

## License

MIT
