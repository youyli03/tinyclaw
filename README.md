# tinyclaw

极简模块化 AI Agent 框架。Bun + TypeScript，内置 QQBot，支持 Microsoft MFA 高危操作鉴权。

## 特性

- **安全**：高危工具（exec_shell / write_file / edit_file / delete_file）支持三种 MFA 鉴权接口：Azure AD number-matching 推送、TOTP 验证码、文字确认
- **Agent 工作区**：每个 Agent 独立人格（SYSTEM.md）+ 持久记忆（MEM.md）+ 技能目录（SKILLS.md）+ 独立向量记忆命名空间
- **QMD 向量记忆**：对话摘要自动索引至对应 Agent 命名空间，token 超 80% 自动摘要压缩
- **Code 模式**：`/code` 切换为代码专注会话，独立历史、滑动窗口压缩、更高工具轮次上限；内置 Plan / Auto 子模式（AI 先规划后执行）
- **内置工具集**：exec_shell / write_file / edit_file / delete_file / read_file / code_assist / render_diagram / notify_user / create_skill / agent_fork / cron_* / mcp_*
- **Agent Fork**：agent_fork 工具在后台启动 Slave agent 异步执行耗时任务，不阻塞主对话，完成后自动通知用户
- **Cron 定时任务**：内置调度器，支持一次性 / 固定间隔 / 每日定时三种类型，结果按策略推送到 QQ
- **MCP 支持**：懒加载 MCP server，Agent 按需 enable/disable，不占用多余 token
- **内置 QQBot**：无需插件，填配置即用；三档权限自动降级，自动重连，每用户串行消息队列；支持 Markdown 消息（`msg_type: 2`）
- **GitHub Copilot 后端**：凭 Copilot 订阅自动发现所有可用模型，无需手动填 apiKey / baseUrl；自动检测模型 function calling 能力
- **文本模式工具调用**：不支持 function calling 的模型自动切换为 `<tool_call>` XML 文本协议，工具能力不降级
- **CLI 工具**：`tinyclaw` 全局命令，管理 Agent、会话、模型、Cron、记忆、配置；支持 bash/zsh/fish tab 补全
- **会话持久化**：JSONL 崩溃恢复，进程重启不丢上下文
- **进程守护**：supervisor 自动重启异常退出的 main 进程，支持退避策略，最多重启 20 次
- **并发安全**：同一会话新消息到达时软中断旧 run，等待工具完成后安全切换
- **可扩展**：`Connector` 接口预留 TG / WhatsApp 等平台接入点

## 快速开始

```bash
# 1. 安装依赖
bun install

# 2. 注册全局命令（一次性）
bun link
# → 创建 ~/.bun/bin/tinyclaw 快捷命令

# 3. 安装 tab 补全（可选）
tinyclaw completions install && source ~/.bashrc

# 4. 启动（首次自动复制配置模板）
bun src/main.ts
# → 提示：配置文件已复制到 ~/.tinyclaw/config.toml，请填入真实值后重启

# 5. 查看/编辑配置
tinyclaw config show      # 脱敏预览
tinyclaw config edit      # 用 $EDITOR 打开

# 6. 重启
tinyclaw restart          # 或 bun src/main.ts
```

## 配置

配置全部在 `~/.tinyclaw/config.toml`（不进仓库）。模板见 [config.example.toml](config.example.toml)。

**最小化配置（使用 GitHub Copilot 账号）：**

```toml
[providers.copilot]
githubToken = "gh_cli"   # 需先运行 gh auth login，或通过首次启动的 Device Flow 完成授权

[llm.backends]
daily     = { model = "copilot/auto" }   # 自动选择 Copilot 默认模型
summarizer = { model = "copilot/auto" }

[auth.mfa]
tenantId = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
clientId = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"

[channels.qqbot]
appId        = "你的 AppID"
clientSecret = "你的 ClientSecret"
```

**最小化配置（OpenAI-compatible）：**

```toml
[providers.openai]
apiKey  = "sk-..."
baseUrl = "https://api.openai.com/v1"

[llm.backends]
daily     = { model = "openai/gpt-4o" }
summarizer = { model = "openai/gpt-4o-mini" }

[auth.mfa]
tenantId = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
clientId = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"

[channels.qqbot]
appId        = "你的 AppID"
clientSecret = "你的 ClientSecret"
```

## 目录结构

```
bin/
└── tinyclaw.ts               # 全局命令入口（bun link 注册为 tinyclaw）
src/
├── main.ts                   # 服务入口（写 .service_pid，供 restart 使用）
├── main-supervisor.ts        # 进程守护（crash 后退避重启，最多 20 次）
├── cli/                      # tinyclaw CLI 配置工具
│   ├── index.ts              # 主入口 + COMMANDS 注册表 + --complete 补全处理
│   ├── ui.ts                 # ANSI 颜色、对齐表格、prompt/select/confirm
│   └── commands/
│       ├── model.ts          # model show/list/set
│       ├── config.ts         # config show/edit/path/get/set
│       ├── auth.ts           # auth github/status/mfa-setup
│       ├── status.ts         # 运行状态概览
│       ├── restart.ts        # 发送 SIGTERM 重启
│       ├── start.ts          # 启动 supervisor 守护进程
│       ├── logs.ts           # 跟踪日志输出
│       ├── agent.ts          # agent new/edit/list/show/delete/repair
│       ├── chat.ts           # chat new/list/send/bind
│       ├── cron.ts           # cron add/list/remove/enable/disable/run/logs
│       ├── memory.ts         # memory save/list/search/index
│       ├── session.ts        # session list/abort/memory
│       └── completions.ts    # 生成并安装 bash/zsh/fish 补全脚本
├── config/                   # Zod schema + config loader + TOML writer
├── llm/                      # LLM 多后端（OpenAI-compatible + Copilot）
│   ├── client.ts             # OpenAI-compatible 统一接口
│   ├── registry.ts           # 多后端注册 + 异步 init()
│   ├── copilot.ts            # GitHub Copilot：token 换取 + 模型发现 + LLMClient 构建
│   └── copilotSetup.ts       # RFC 8628 Device Flow OAuth + token 持久化
├── memory/                   # QMD 向量记忆 + 对话持久化 + 摘要压缩
├── auth/                     # MFA 鉴权（MSAL / TOTP / simple 三种接口）
├── tools/                    # 工具注册表与所有内置工具
│   ├── registry.ts           # 工具注册/执行接口 + ToolContext 定义
│   ├── system.ts             # exec_shell / write_file / edit_file / delete_file / read_file
│   ├── code-assist.ts        # code_assist（委派代码任务给子进程/API）
│   ├── render-diagram.ts     # render_diagram（mermaid / python 图表渲染为图片）
│   ├── notify.ts             # notify_user（不等 run 结束即推送消息）
│   ├── skill-creator.ts      # create_skill（创建 Skill 文档并注册到 SKILLS.md）
│   ├── agent-fork.ts         # agent_fork / agent_status / agent_abort
│   ├── cron.ts               # cron_add / cron_list / cron_remove / cron_enable / cron_disable / cron_run
│   └── mcp-manager.ts        # mcp_list_servers / mcp_enable_server / mcp_disable_server
├── code/                     # Code 模式（/code 斜杠命令）
│   ├── index.ts              # 副作用入口，import 触发命令注册
│   ├── commands.ts           # /code /chat /plan /auto /new 命令实现
│   ├── system-prompt.ts      # buildCodeSystemPrompt()
│   ├── exit-plan-mode-tool.ts # exit_plan_mode 工具（Plan 子模式计划审批）
│   └── backends/             # 代码后端扩展点（stub）
├── commands/                 # 斜杠命令注册表（/help /status /code /plan 等）
│   ├── registry.ts           # 注册表 + 执行入口
│   └── builtin.ts            # 内置斜杠命令
├── cron/                     # Cron 定时任务调度器
│   ├── scheduler.ts          # 轮询 jobs，到时触发 runner
│   ├── runner.ts             # 启动独立 Agent 会话执行 message
│   ├── store.ts              # jobs.json CRUD
│   └── schema.ts             # Job 类型定义（Zod）
├── ipc/                      # Unix socket IPC（CLI chat ↔ daemon）
│   ├── server.ts             # daemon 端 IPC server
│   ├── client.ts             # CLI 端 IPC client
│   └── protocol.ts           # 消息类型定义
├── mcp/                      # MCP client 管理器（懒加载）
│   └── client.ts             # MCPManager：连接 / 注册工具 / 启用停用
├── core/                     # Agent ReAct 循环 + Session + 路由
│   ├── agent.ts              # runAgent()：ReAct 循环、MFA、压缩、心跳、auto-fork
│   ├── session.ts            # messages[] + 持久化 + 并发控制 + 压缩
│   ├── router.ts             # 意图路由（保留扩展点）
│   ├── agent-manager.ts      # Agent 工作区管理（创建/查找/路径）
│   └── slave-manager.ts      # Slave agent 生命周期管理
└── connectors/
    ├── base.ts               # Connector 接口（平台无关）
    ├── utils/
    │   └── media-parser.ts   # 视觉消息内容解析（图片 → ContentPart[]）
    └── qqbot/                # QQBot 实现
        ├── api.ts            # QQ REST API（token / send）
        ├── gateway.ts        # WebSocket 协议 + 消息队列 + 重连
        ├── outbound.ts       # 发送限流（1h/4次）+ 自动降级 + 媒体预检
        ├── attachments.ts    # 附件下载与内容注入
        └── index.ts          # Connector 接口胶水层
```

运行时数据存储在 `~/.tinyclaw/`（不进仓库）：

```
~/.tinyclaw/
├── config.toml               # 所有敏感配置
├── mcp.toml                  # MCP server 配置（独立文件）
├── .service_pid              # supervisor 进程 PID（供 tinyclaw restart 使用）
├── .github_token             # GitHub OAuth token（权限 0600）
├── auth/msal-cache.json      # MSAL token 缓存
├── auth/totp.key             # TOTP 共享密钥（auth mfa-setup 生成）
├── agents/                   # Agent 工作区
│   ├── default/              # 默认 Agent（进程启动时自动创建）
│   │   ├── agent.toml        # 元数据与绑定规则
│   │   ├── SYSTEM.md         # Agent 系统提示（可选）
│   │   ├── MEM.md            # 持久记忆（跨 session 偏好与结论）
│   │   ├── SKILLS.md         # 技能目录（工具/脚本使用说明）
│   │   ├── memory/           # 独立向量索引 + 压缩摘要
│   │   ├── skills/           # 技能脚本目录
│   │   └── workspace/        # exec_shell 默认 cwd
│   │       ├── tmp/          # 临时文件
│   │       └── output/       # 输出文件
│   └── <custom>/             # 自定义 Agent（tinyclaw agent new <id>）
├── sessions/                 # 对话 JSONL（崩溃恢复）
├── cron/                     # Cron 任务存储
│   ├── jobs.json             # 定时任务持久化
│   └── runs/                 # 每次运行日志
├── qqbot/session.json        # WS Session 持久化（断线续传）
└── qqbot/downloads/          # 附件临时文件
```

## CLI 命令速查

```bash
# Agent 管理
tinyclaw agent new work              # 创建 work Agent
tinyclaw agent edit work             # 用 $EDITOR 编辑 work 的系统提示
tinyclaw agent list                  # 列出所有 Agent
tinyclaw agent show work             # 查看 work 的详情与绑定
tinyclaw agent delete work           # 删除 work（含记忆）
tinyclaw agent repair                # 补全所有 Agent 缺失的目录与模板文件
tinyclaw agent repair work           # 只补全 work Agent

# 会话管理
tinyclaw chat new                    # 新建终端会话（默认 Agent）
tinyclaw chat new --agent work       # 新建绑定到 work 的会话
tinyclaw chat list                   # 查看所有会话（只读，合并磁盘+内存）
tinyclaw chat -s cli:<uuid> 你好     # 向指定会话发消息
tinyclaw chat -s cli:<uuid> bind work  # 将会话绑定到 work Agent

# 模型管理
tinyclaw model show                    # 查看三个后端当前模型
tinyclaw model list [daily|code|summarizer]  # 列出可用模型（Copilot 后端查 API）
tinyclaw model set  [daily|code|summarizer]  # 交互式选择模型并写入配置

# 配置管理
tinyclaw config show                   # 格式化显示配置（密钥脱敏）
tinyclaw config edit                   # 用 $EDITOR 打开配置文件
tinyclaw config get llm.backends.daily.model  # 读取指定字段
tinyclaw config set llm.backends.daily.model copilot/gpt-4o  # 直接设置字段

# Cron 定时任务
tinyclaw cron list                     # 列出所有定时任务
tinyclaw cron add                      # 交互式创建定时任务
tinyclaw cron remove <id>              # 删除定时任务
tinyclaw cron enable <id>              # 启用定时任务
tinyclaw cron disable <id>             # 停用定时任务
tinyclaw cron run <id>                 # 立即触发一次

# 记忆管理
tinyclaw memory list [agentId]         # 列出 Agent 的记忆摘要文件
tinyclaw memory search <query>         # 向量搜索记忆
tinyclaw memory index [agentId]        # 重建向量索引

# 会话管理
tinyclaw session list                  # 列出所有内存中的会话
tinyclaw session abort <sessionId>     # 软中断指定会话的当前 run

# 认证
tinyclaw auth github                   # 重新执行 GitHub Device Flow OAuth
tinyclaw auth status                   # 检查 token 有效性
tinyclaw auth mfa-setup                # 设置 TOTP MFA（生成二维码扫描绑定）

# 服务管理
tinyclaw start                         # 以 supervisor 守护模式启动服务
tinyclaw status                        # 服务状态 + 配置摘要
tinyclaw restart                       # 发送 SIGTERM（supervisor 自动重启）
tinyclaw logs [-f]                     # 查看/跟踪日志

# Tab 补全
tinyclaw completions install           # 自动写入 ~/.bashrc 或 ~/.zshrc
tinyclaw completions bash/zsh/fish     # 输出补全脚本（手动 eval）
```

## 文档

| 文档 | 说明 |
|---|---|
| [docs/AGENT_LOOP.md](docs/AGENT_LOOP.md) | Agent 运行循环详细流程（ReAct、MFA、压缩、并发） |
| [docs/SESSIONS_AND_AGENTS.md](docs/SESSIONS_AND_AGENTS.md) | Agent 工作区与会话生命周期 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 整体架构与模块关系 |
| [docs/CODE_MODE.md](docs/CODE_MODE.md) | Code 模式详解（Plan/Auto 子模式、持久化、上下文管理） |
| [docs/RETRY_AND_STABILITY.md](docs/RETRY_AND_STABILITY.md) | LLM 连接稳定性（重试策略、流式 idle timeout、CA 证书） |

## 接入新平台

实现 `Connector` 接口即可：

```typescript
import type { Connector, InboundMessage } from "./src/connectors/base.js";

class TelegramConnector implements Connector {
  onMessage(handler: (msg: InboundMessage) => Promise<string>) { ... }
  async start() { ... }
  async stop() { ... }
  async send(peerId, type, text, replyToId?) { ... }
}
```

## 依赖

| 包 | 用途 |
|---|---|
| `openai` | LLM 客户端（OpenAI-compatible） |
| `@tobilu/qmd` | 本地向量记忆（BM25 + 向量 + LLM 重排序） |
| `@azure/msal-node` | Microsoft MFA（MSAL Interface B） |
| `@modelcontextprotocol/sdk` | MCP client |
| `ws` | QQBot WebSocket |
| `zod` | 配置验证 |
| `smol-toml` | TOML 解析 |
| `otpauth` | TOTP 验证码生成与验证 |
| `qrcode-terminal` | TOTP 绑定时在终端显示二维码 |

> Copilot 后端无额外依赖，直接使用 `fetch` 调用 GitHub API。

## License

MIT
