# tinyclaw

极简模块化 AI Agent 框架。Bun + TypeScript，内置 QQBot，支持 Microsoft MFA 高危操作鉴权。

## 特性

- **极简**：全项目 ~1000 行，无框架依赖
- **安全**：高危工具（exec_shell / write_file / delete_file）统一 Azure AD number-matching MFA 鉴权
- **QMD 向量记忆**：对话历史自动索引，新会话注入相关历史；token 超 80% 自动摘要压缩
- **代码/日常分离**：代码任务 spawn codex/copilot 子进程，不污染主 Agent 上下文
- **内置 QQBot**：无需插件，填配置即用；三档权限自动降级，自动重连，每用户串行消息队列
- **GitHub Copilot 后端**：凭 Copilot 订阅自动发现所有可用模型，无需手动填 apiKey / baseUrl
- **可扩展**：`Connector` 接口预留 TG / WhatsApp 等平台接入点

## 快速开始

```bash
# 1. 安装依赖
bun install

# 2. 启动（首次自动复制配置模板）
bun src/main.ts
# → 提示：配置文件已复制到 ~/.tinyclaw/config.toml，请填入真实值后重启

# 3. 编辑配置
nano ~/.tinyclaw/config.toml

# 4. 重启
bun src/main.ts
```

## 配置

配置全部在 `~/.tinyclaw/config.toml`（不进仓库）。模板见 [config.example.toml](config.example.toml)。

**最小化配置（使用 GitHub Copilot 账号）：**

```toml
[llm.backends.daily]
provider    = "copilot"
githubToken = "gh_cli"   # 需先运行 gh auth login
model       = "auto"     # 自动选择 Copilot 默认模型

[auth.mfa]
tenantId = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
clientId = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"

[channels.qqbot]
appId        = "你的 AppID"
clientSecret = "你的 ClientSecret"
```

**最小化配置（OpenAI-compatible）：**

```toml
[llm.backends.daily]
baseUrl = "https://api.openai.com/v1"
apiKey  = "sk-..."
model   = "gpt-4o"

[auth.mfa]
tenantId = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
clientId = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"

[channels.qqbot]
appId        = "你的 AppID"
clientSecret = "你的 ClientSecret"
```

## 目录结构

```
src/
├── main.ts                   # 入口
├── config/                   # Zod schema + config loader
├── llm/                      # LLM 多后端（OpenAI-compatible + Copilot）
│   ├── client.ts             # OpenAI-compatible 统一接口
│   ├── registry.ts           # 多后端注册 + 异步 init()
│   ├── copilot.ts            # GitHub Copilot：token 换取 + 模型发现 + LLMClient 构建
│   └── copilotSetup.ts       # RFC 8628 Device Flow OAuth + token 持久化
├── memory/                   # QMD 向量记忆 + 对话持久化 + 摘要压缩
├── auth/                     # Azure AD MSAL MFA
├── tools/                    # 工具注册表（codex / copilot / system）
├── core/                     # Agent ReAct 循环 + Session + 路由
└── connectors/
    ├── base.ts               # Connector 接口（平台无关）
    └── qqbot/                # QQBot 实现
        ├── api.ts            # QQ REST API（token / send）
        ├── gateway.ts        # WebSocket 协议 + 消息队列 + 重连
        ├── outbound.ts       # 发送限流（1h/4次）+ 自动降级
        └── index.ts          # Connector 接口胶水层
```

运行时数据存储在 `~/.tinyclaw/`（不进仓库）：

```
~/.tinyclaw/
├── config.toml               # 所有敏感配置
├── auth/msal-cache.json      # MSAL token 缓存
├── memory/                   # QMD 向量数据库 + 对话记录
├── qqbot/session.json        # WS Session 持久化（断线续传）
└── qqbot/downloads/          # 附件临时文件
```

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
| `@azure/msal-node` | Microsoft MFA |
| `ws` | QQBot WebSocket |
| `zod` | 配置验证 |
| `smol-toml` | TOML 解析 |

> Copilot 后端无额外依赖，直接使用 `fetch` 调用 GitHub API。

## License

MIT
