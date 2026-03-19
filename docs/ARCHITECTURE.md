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
│   ├── main.ts               # 入口：加载配置 → 启动 QQBot → 优雅退出
│   ├── core/
│   │   ├── agent.ts          # ReAct 主循环（think → tool_call → observe → respond）
│   │   ├── session.ts        # messages[] + token 计数 + 摘要钩子
│   │   └── router.ts         # 意图路由：daily-ops / code
│   ├── llm/
│   │   ├── client.ts         # OpenAI-compatible 统一接口（chat / streamChat）
│   │   ├── registry.ts       # 多后端注册，get(name) 运行时切换；async init() 预初始化 Copilot
│   │   ├── copilot.ts        # GitHub Copilot 后端：token 换取（缓存）+ 模型发现 + LLMClient 构建
│   │   └── copilotSetup.ts   # RFC 8628 Device Flow OAuth + ~/.tinyclaw/.github_token 持久化
│   ├── memory/
│   │   ├── qmd.ts            # @tobilu/qmd SDK 封装（search / updateIndex）
│   │   ├── store.ts          # 对话 → ~/.tinyclaw/memory/sessions/YYYY-MM-DD.md
│   │   └── summarizer.ts     # token >80% → 摘要 → 压缩 messages[]，用户无感
│   ├── auth/
│   │   ├── mfa.ts            # MSAL Device Code Flow + Azure AD number-matching push
│   │   └── guard.ts          # withMFA() 高阶包装，超时/拒绝则 abort
│   ├── tools/
│   │   ├── registry.ts       # 工具注册表（name / schema / requiresMFA 标记）
│   │   ├── codex.ts          # spawn codex CLI 子进程，返回 stdout
│   │   ├── copilot.ts        # spawn gh copilot suggest，返回 stdout
│   │   └── system.ts         # exec_shell / write_file / delete_file（均标 MFA）
│   ├── connectors/
│   │   ├── base.ts           # Connector 接口 + InboundMessage + QQ 事件类型
│   │   └── qqbot/
│   │       ├── index.ts      # 实现 Connector 接口，胶水层
│   │       ├── gateway.ts    # WS 协议 + 消息队列 + 重连 + Session 持久化
│   │       ├── api.ts        # QQ REST API 封装（token singleflight + send 方法 + markdown/text 消息类型派发）
│   │       └── outbound.ts   # 发送限流（1h/4次）+ 降级主动消息 + 长文本分块
│   ├── cron/                 # 【Phase 8，v1 不实现，接口预留】
│   │   ├── scheduler.ts      # 轮询 jobs.json，到时触发
│   │   ├── runner.ts         # 启动独立 Agent 会话执行 message
│   │   └── tools.ts          # cron_add / cron_list / cron_remove
│   ├── cli/
│   │   ├── index.ts          # 主入口：COMMANDS 注册表 + --complete 补全处理器
│   │   ├── ui.ts             # 终端 UI 工具（ANSI 颜色、对齐表格、prompt/select/confirm）
│   │   └── commands/
│   │       ├── model.ts      # model show / list / set
│   │       ├── config.ts     # config show / edit / path / set
│   │       ├── auth.ts       # auth github / status
│   │       ├── status.ts     # 运行状态概览
│   │       ├── restart.ts    # SIGTERM 重启
│   │       └── completions.ts # bash/zsh/fish 补全脚本生成与安装
│   └── config/
│       ├── schema.ts         # Zod schema（全部配置的类型定义）
│       ├── loader.ts         # 读 ~/.tinyclaw/config.toml，不存在时自动复制模板
│       └── writer.ts         # 保留注释的 TOML 行级补丁（供 CLI config set 使用）
├── bin/
│   └── tinyclaw.ts           # 全局命令入口（bun link 后注册为 tinyclaw）
├── docs/
│   └── ARCHITECTURE.md       # 本文件
├── config.example.toml       # 配置模板，无真实值，供参考
└── package.json              # bin.tinyclaw 字段声明全局命令
```

### 运行时数据（`~/.tinyclaw/`，不进仓库）

```
~/.tinyclaw/
├── config.toml               # 所有敏感配置（API key、Azure ID、QQ secret）
├── .service_pid              # 主进程 PID（tinyclaw restart 读取）
├── .github_token             # GitHub OAuth token（0600 权限，由 Device Flow 写入）
├── auth/
│   └── msal-cache.json       # MSAL token 缓存（自动维护）
├── memory/
│   ├── sessions/             # YYYY-MM-DD.md 对话记录（QMD 索引源）
│   └── index.sqlite          # QMD 向量数据库
├── cron/
│   ├── jobs.json             # 定时任务持久化（同 openclaw 格式）
│   └── runs/                 # 每次运行日志
└── qqbot/
    ├── downloads/            # 附件临时文件
    └── images/               # 图床缓存
```

---

## 模块说明

### LLM 多后端

- 统一 OpenAI-compatible 接口（`LLMClient`）
- 三个命名后端：`daily`（对话）/ `code`（代码任务）/ `summarizer`（摘要压缩）
- `registry.get(name)` 运行时取后端实例，`registry.init()` 在 main.ts 中异步预初始化所有后端
- 支持两种 backend 类型（由 `CopilotBackendSchema` / `OpenAIBackendSchema` 区分）
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

- Azure AD App Registration（需配置 `tenantId` + `clientId`）
- 触发高危工具时：显示 2 位数字 → 微软推送到手机 → 用户点击对应数字确认
- token 缓存在 `~/.tinyclaw/auth/msal-cache.json`，静默刷新，后续只需点推送
- 超时 60s 或用户拒绝 → 操作 abort
- 高危工具范围：`exec_shell` / `delete_file` / `write_file` / `mass_send`

### 代码/日常操作分离

- `router.ts` 判断意图：代码类 → dispatch 到 codex/copilot 子进程
- 主 Agent 只收 stdout 结果，不将代码上下文塞入主 messages[]
- codex / copilot 可使用独立的 `code` LLM 后端

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

### Cron（预留，v1 不实现）

- 数据格式与 openclaw 保持兼容（`~/.tinyclaw/cron/jobs.json`）
- 支持三种调度：`cron`（Cron 表达式）/ `every`（固定间隔）/ `at`（一次性）
- 触发后启动独立 Agent 会话执行 `payload.message`，结果通过 `Connector.send()` 主动推送

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
