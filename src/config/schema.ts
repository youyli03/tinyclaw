import { z } from "zod";

// ── Provider 认证配置 ─────────────────────────────────────────────────────────
// 凭证与后端角色分离：providers.* 管理认证信息，后端只引用模型 symbol。

/** OpenAI-compatible 提供商（显式 baseUrl + apiKey） */
const OpenAIProviderSchema = z.object({
  apiKey: z.string().min(1),
  /** API base URL，默认 https://api.openai.com/v1 */
  baseUrl: z.string().url().default("https://api.openai.com/v1"),
  /** 最大输出 token 数，默认 4096（可被后端角色覆盖） */
  maxTokens: z.number().int().positive().default(4096),
  /** 请求超时（毫秒），默认 120000（可被后端角色覆盖） */
  timeoutMs: z.number().int().positive().default(120_000),
});
export type OpenAIProviderConfig = z.infer<typeof OpenAIProviderSchema>;

/** GitHub Copilot 提供商（自动获取 token，动态发现模型） */
const CopilotProviderSchema = z.object({
  /**
   * GitHub OAuth token 来源：
   * - `"gh_cli"` → 运行 `gh auth token` 动态获取（默认）
   * - `"env"`    → 读取 `$GITHUB_TOKEN` 环境变量
   * - 其他字符串  → 直接作为 token 使用
   */
  githubToken: z.string().min(1).default("gh_cli"),
  /** 请求超时（毫秒），默认 120000（可被后端角色覆盖） */
  timeoutMs: z.number().int().positive().default(120_000),
});
export type CopilotProviderConfig = z.infer<typeof CopilotProviderSchema>;

const ProvidersSchema = z.object({
  openai: OpenAIProviderSchema.optional(),
  copilot: CopilotProviderSchema.optional(),
}).default({});
export type ProvidersConfig = z.infer<typeof ProvidersSchema>;

// ── 后端角色配置 ──────────────────────────────────────────────────────────────
// 每个角色（daily / code / summarizer）只需声明使用哪个模型 symbol。
// 凭证统一由 providers.* 管理，后端可选覆盖超时和 token 上限。

/**
 * 后端角色：指定模型 symbol 及可选参数覆盖。
 *
 * 模型 symbol 格式：`"provider/model-id"`
 * 示例：`"copilot/gpt-4o"`、`"openai/gpt-4o-mini"`、`"copilot/auto"`
 *
 * `provider` 必须在 `[providers.*]` 中配置了对应凭证。
 */
const BackendRoleSchema = z.object({
  model: z.string().min(1),
  /** 覆盖 provider 级 maxTokens（可选） */
  maxTokens: z.number().int().positive().optional(),
  /** 覆盖 provider 级 timeoutMs（可选） */
  timeoutMs: z.number().int().positive().optional(),
  /** 是否支持视觉（图片输入）能力，默认 false */
  supportsVision: z.boolean().optional(),
});
export type BackendRole = z.infer<typeof BackendRoleSchema>;

const LLMBackendsSchema = z.object({
  /** 日常对话后端 */
  daily: BackendRoleSchema,
  /** 摘要压缩后端（未配置时回退到 daily） */
  summarizer: BackendRoleSchema.optional(),
});

const LLMSchema = z.object({
  backends: LLMBackendsSchema,
});

// ── Microsoft MFA ─────────────────────────────────────────────────────────────

const ExecShellPatternsSchema = z.object({
  /** exec_shell 命令中包含这些关键词时触发 MFA（word-boundary 匹配） */
  patterns: z
    .array(z.string())
    .default(["rm", "sudo", "chmod", "chown", "dd", "mv"]),
});

const MFASchema = z.object({
  /**
   * MFA 接口类型：
   * - `"simple"` — Interface A：发送文字警告，等待用户回复 确认/取消（默认）
   * - `"totp"`   — Interface C：用户通过 Authenticator App 生成 6 位 TOTP 码回复确认
   * - `"msal"`   — Interface B：Microsoft Authenticator number-matching 推送
   */
  interface: z.enum(["simple", "totp", "msal"]).default("simple"),
  /** TOTP 专用：共享密钥文件路径（由 auth mfa-setup 生成，默认 ~/.tinyclaw/auth/totp.key） */
  totpSecretPath: z.string().optional(),
  /** 整工具黑名单：列出的工具名总是触发 MFA */
  tools: z.array(z.string()).default(["delete_file", "write_file"]),
  /** exec_shell 命令级黑名单 */
  exec_shell_patterns: ExecShellPatternsSchema.default({}),
  /** MFA 确认超时（秒），默认 60 */
  timeoutSecs: z.number().int().positive().default(60),
  /** MSAL Interface B 专用：Azure AD 租户 ID */
  tenantId: z.string().min(1).optional(),
  /** MSAL Interface B 专用：Azure AD 应用客户端 ID */
  clientId: z.string().min(1).optional(),
});

const AuthSchema = z.object({
  mfa: MFASchema.optional(),
});

// ── QQBot ─────────────────────────────────────────────────────────────────────

const QQBotSchema = z.object({
  appId: z.string().min(1),
  clientSecret: z.string().min(1),
  /** 允许私信的用户 openid 列表，空表示全开放 */
  allowFrom: z.array(z.string()).default([]),
  /** 账户级系统提示词 */
  systemPrompt: z.string().optional(),
  /** 图床服务器公网地址，用于发送图片 */
  imageServerBaseUrl: z.string().url().optional(),
  /** 是否支持 markdown 消息，默认 true */
  markdownSupport: z.boolean().default(true),
  /** 图床服务器端口，默认 18765 */
  imageServerPort: z.number().int().positive().default(18765),
});

const ChannelsSchema = z.object({
  qqbot: QQBotSchema.optional(),
});

// ── 向量记忆 ─────────────────────────────────────────────────────────────────

const MemorySchema = z.object({
  /**
   * 是否启用向量记忆（需要下载 embedding 模型，首次约 380MB）。
   * 默认关闭，避免首次启动时触发大文件下载。
   * 开启方式：在 config.toml 里设 [memory] enabled = true
   */
  enabled: z.boolean().default(false),
  /**
   * QMD embedding 模型（HuggingFace URI）
   * 默认 Qwen3-Embedding-0.6B Q4_K_M，中文优化，~380MB
   * 如需更高精度可改为 Q8_0（~640MB）
   */
  embedModel: z
    .string()
    .default(
      "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf"
    ),
  /**
   * 触发摘要的 token 使用率阈值（0-1），默认 0.8
   * 达到模型上下文长度的该比例时，自动压缩对话历史
   */
  tokenThreshold: z.number().min(0.1).max(0.99).default(0.8),
  /** 上下文最大 token 数，用于计算阈值，默认 128000 */
  contextWindow: z.number().int().positive().default(128_000),
});

// ── 工具配置 ─────────────────────────────────────────────────────────────────

const CodeAssistSchema = z.object({
  /**
   * 底层执行后端：
   * - `"copilot"` — 调用 `copilot -p <task> --allow-all -s [--model <model>]`（默认）
   * - `"codex"`   — 调用 `codex --quiet [--model <model>] <task>`
   * - `"api"`     — 直接用 daily LLM 做一次无历史调用，忽略 model 字段
   */
  backend: z.enum(["copilot", "codex", "api"]).default("copilot"),
  /**
   * 透传给 CLI 的 --model 参数（可选）。
   * backend = "api" 时此字段无效（使用 daily backend 的模型）。
   */
  model: z.string().optional(),
  /**
   * 每次用户消息处理中 code_assist 工具的最大调用次数，默认 5。
   * 0 = 不限制。超出后注入限制提示，LLM 告知用户需再次发送消息继续。
   */
  maxCallsPerRun: z.number().int().min(0).default(5),
});
export type CodeAssistConfig = z.infer<typeof CodeAssistSchema>;

const ToolsSchema = z.object({
  code_assist: CodeAssistSchema.default({}),
}).default({});

// ── MCP 服务器配置（独立文件 ~/.tinyclaw/mcp.toml）────────────────────────────

const MCPStdioServerSchema = z.object({
  enabled: z.boolean().default(true),
  transport: z.literal("stdio"),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string()).optional(),
  /** 在 mcp_list_servers 中展示给 Agent 的服务描述 */
  description: z.string().optional(),
});

const MCPSSEServerSchema = z.object({
  enabled: z.boolean().default(true),
  transport: z.literal("sse"),
  url: z.string().url(),
  headers: z.record(z.string()).optional(),
  /** 在 mcp_list_servers 中展示给 Agent 的服务描述 */
  description: z.string().optional(),
});

const MCPServerSchema = z.discriminatedUnion("transport", [
  MCPStdioServerSchema,
  MCPSSEServerSchema,
]);
export type MCPServerConfig = z.infer<typeof MCPServerSchema>;

export const MCPConfigSchema = z.object({
  servers: z.record(MCPServerSchema).default({}),
}).default({ servers: {} });
export type MCPConfig = z.infer<typeof MCPConfigSchema>;

// ── Agent 行为配置 ────────────────────────────────────────────────────────────

const AgentSchema = z.object({
  /**
   * LLM 流式调用期间的心跳推送间隔（秒）。
   * 模型思考时间较长时，每隔该时间向用户推送"仍在处理中"提示，避免用户误以为卡死。
   * 0 = 关闭心跳。默认 120（2 分钟）。
   */
  heartbeatIntervalSecs: z.number().int().min(0).default(120),
}).default({});
export type AgentConfig = z.infer<typeof AgentSchema>;

// ── 根配置 ────────────────────────────────────────────────────────────────────

export const ConfigSchema = z.object({
  providers: ProvidersSchema,
  llm: LLMSchema,
  agent: AgentSchema,
  auth: AuthSchema.default({}),
  channels: ChannelsSchema.default({}),
  memory: MemorySchema.default({}),
  tools: ToolsSchema,
});

export type Config = z.infer<typeof ConfigSchema>;
export type QQBotConfig = z.infer<typeof QQBotSchema>;
export type MFAConfig = z.infer<typeof MFASchema>;
