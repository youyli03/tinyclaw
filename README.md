# tinyclaw

极简 AI Agent 框架。Bun + TypeScript，内置 QQBot，支持 MFA 高危操作鉴权。

## 特性

- **多后端 LLM**：GitHub Copilot（凭订阅自动发现模型）或任意 OpenAI-compatible API
- **内置工具集**：文件读写、Shell 执行、图表渲染、Cron 定时、MCP 集成、Agent Fork 等
- **Cron Pipeline**：`steps` 数组精确编排 tool → msg 多步流水线，结果推送到 QQ
- **Agent Fork**：后台启动 Slave agent 异步执行耗时任务，完成后自动通知
- **MCP 支持**：懒加载，按需 enable/disable，内置 Browser / News 两个 MCP server
- **MFA 鉴权**：高危工具支持 Azure AD number-matching 推送、TOTP 验证码、文字确认三种方式
- **向量记忆**：对话摘要自动向量化，token 超阈值时自动压缩；多 Agent 独立命名空间
- **Code 模式**：`/code` 切换代码专注会话，内置 Plan / Auto 子模式
- **语音输入**：QQBot 收到语音消息自动转写（本地 faster-whisper）
- **进程守护**：supervisor 自动重启，崩溃恢复不丢上下文
- **可扩展**：实现 `Connector` 接口即可接入新平台（TG / WhatsApp 等）

## 快速开始

```bash
bun install          # 安装依赖
bun link             # 注册全局命令 tinyclaw（一次性）
bun src/main.ts      # 首次启动，自动生成 ~/.tinyclaw/config.toml
# 编辑配置后重启
tinyclaw restart
```

## 配置

所有配置在 `~/.tinyclaw/config.toml`（不进仓库），模板见 [config.example.toml](config.example.toml)。

**GitHub Copilot：**
```toml
[providers.copilot]
githubToken = "gh_cli"   # 需先 gh auth login，或首次启动时走 Device Flow 授权

[llm.backends]
daily      = { model = "copilot/auto" }
summarizer = { model = "copilot/auto" }
```

**OpenAI-compatible：**
```toml
[providers.openai]
apiKey  = "sk-..."
baseUrl = "https://api.openai.com/v1"

[llm.backends]
daily      = { model = "openai/gpt-4o" }
summarizer = { model = "openai/gpt-4o-mini" }
```

**QQBot + MFA（可选）：**
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
tinyclaw chat loop enable <sessionId>      # 启用（或新建）loop
tinyclaw chat loop disable <sessionId>     # 禁用 loop
tinyclaw chat loop set <sessionId> <k=v>   # 修改配置字段
tinyclaw chat loop trigger <sessionId>     # 立即触发一次 tick

tinyclaw config show / edit            # 查看（脱敏）/ 编辑配置
tinyclaw auth github / mfa-setup       # GitHub 授权 / TOTP 绑定

tinyclaw completions install           # 安装 tab 补全
```

## 运行时目录

```
~/.tinyclaw/
├── config.toml          # 配置（含密钥，不进仓库）
├── mcp.toml             # MCP server 配置
├── agents/default/      # 默认 Agent 工作区
│   ├── SYSTEM.md        # 系统提示
│   ├── MEM.md           # 持久记忆
│   ├── SKILLS.md        # 技能目录
│   └── workspace/       # Shell 命令默认 cwd
├── sessions/            # 对话 JSONL（崩溃恢复）+ loop 配置 .toml
└── cron/jobs/           # 定时任务持久化
```

## 系统依赖（可选）

| 功能 | 依赖 |
|------|------|
| 消息图片渲染 | `chromium-browser` + `pip install markdown-it-py Pillow` |
| 语音转文字 | `pip install faster-whisper pilk` |
| News MCP | `pip install requests beautifulsoup4 lxml` |

## 文档

**架构**

- [architecture/overview.md](docs/architecture/overview.md) — 整体架构、模块说明、IPC 协议、操作速查
- [architecture/agent-loop.md](docs/architecture/agent-loop.md) — ReAct 循环、MFA、压缩、并发处理
- [architecture/retry.md](docs/architecture/retry.md) — 连接稳定性与重试策略

**功能命令参考**

- [commands/code-mode.md](docs/commands/code-mode.md) — Code 模式（/code /plan /auto）
- [commands/cron-pipeline.md](docs/commands/cron-pipeline.md) — Cron Pipeline 多步流水线
- [commands/loop-session.md](docs/commands/loop-session.md) — Loop Session 持续自主执行

**MCP Server**

- [mcp/news.md](docs/mcp/news.md) — 多源新闻抓取/存档/检索
- [mcp/notes.md](docs/mcp/notes.md) — 结构化笔记知识库

## License

MIT
