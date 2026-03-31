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
  /**
   * 手动覆盖 Copilot 后端有效 context window（tokens），可选。
   * 设置后直接替换自动检测结果，可向下限制或向上扩展：
   * - 向下：如 oswe-vscode-prime 上报 256k 但实际 prompt 上限 200k，设为 200000 防溢出
   * - 向上：如 claude-sonnet-4.6 的 API 返回 128k 但实际支持 200k，设为 200000 解锁
   * 注意：设置超过模型实际支持值可能导致 400 错误。
   */
  maxContextWindow: z.number().int().positive().optional(),
});
export type BackendRole = z.infer<typeof BackendRoleSchema>;

const LLMBackendsSchema = z.object({
  /** 日常对话后端 */
  daily: BackendRoleSchema,
  /** 代码专注后端（未配置时回退到 daily） */
  code: BackendRoleSchema.optional(),
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
  /** MFA 确认超时（秒），0 = 不超时（永久等待），默认 0 */
  timeoutSecs: z.number().int().min(0).default(0),
  /** MSAL Interface B 专用：Azure AD 租户 ID */
  tenantId: z.string().min(1).optional(),
  /** MSAL Interface B 专用：Azure AD 应用客户端 ID */
  clientId: z.string().min(1).optional(),
  /**
   * write_file / edit_file / delete_file 写入路径超出 workspace 白名单时的确认方式：
   * - `"simple"` — 发文字警告，等待用户回复确认/取消（默认，与 interface = "simple" 配套）
   * - `"totp"`   — 用户用 Authenticator App 生成 TOTP 码确认（与 interface = "totp" 配套）
   * - `"msal"`   — Microsoft Authenticator 推送确认（与 interface = "msal" 配套）
   * - `"ask"`    — 通过 onAskUser 弹"允许/拒绝"选择框，不需要验证码
   * - `"deny"`   — 直接拒绝，不询问用户
   */
  path_guard_mode: z.enum(["simple", "totp", "msal", "ask", "deny"]).default("simple"),
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

  // ── 混合搜索（BM25 + 向量语义） ──────────────────────────────────────────
  /**
   * 是否启用 BM25 + 向量语义混合搜索（默认 true）。
   * 关闭时退化为纯向量搜索（向后兼容）。
   * BM25 擅长精确关键词匹配，向量搜索擅长语义理解，两路融合效果更佳。
   */
  hybridSearchEnabled: z.boolean().default(true),
  /**
   * BM25 在混合搜索中的权重（0-1），默认 0.3。
   * 向量权重 = 1 - bm25Weight。推荐 0.2～0.4，向量主导语义方向。
   */
  bm25Weight: z.number().min(0).max(1).default(0.3),

  // ── 时间衰减（模拟遗忘曲线） ──────────────────────────────────────────────
  /**
   * 时间衰减半衰期（天），默认 30 天。
   * 记忆 chunk 的检索权重按 e^(-ln2/halfLife * daysSince) 随时间指数衰减。
   * 0 = 禁用时间衰减，所有记忆等权。
   */
  decayHalfLifeDays: z.number().min(0).default(30),
  /**
   * 豁免时间衰减的文件名模式列表（文件名包含任一字符串即豁免）。
   * 这些"常青记忆"文件代表长期稳定的核心知识，不随时间衰减。
   * 默认：MEM.md、MEMORY.md、patterns.md
   */
  evergreenPatterns: z
    .array(z.string())
    .default(["MEM.md", "MEMORY.md", "patterns.md"]),

  // ── MMR 多样性重排（去除冗余结果） ───────────────────────────────────────
  /**
   * 是否启用 MMR（Maximal Marginal Relevance）多样性重排（默认 true）。
   * 防止搜索结果集中于同一文档的不同段落，提高 LLM 上下文信息密度。
   */
  mmrEnabled: z.boolean().default(true),
  /**
   * MMR 相关性权重（0-1），默认 0.7。
   * MMR(d) = lambda * relevance(d) - (1-lambda) * max(similarity(d, selected))
   * 值越大越偏向相关性，越小越偏向多样性。推荐 0.6～0.8。
   */
  mmrLambda: z.number().min(0).max(1).default(0.7),

  // ── 记忆写入安全审查 ──────────────────────────────────────────────────────
  /**
   * 是否在写入长期记忆前做安全审查（默认 true）。
   * 通过 summarizer LLM 检测摘要内容是否含提示词注入特征
   * （如 ignore previous instructions、API key 外泄、URL 外发等）。
   * 审查失败时跳过写入并输出告警日志，不中断对话。
   */
  memorySafetyCheck: z.boolean().default(true),

  // ── 内置每日记忆维护调度器 ────────────────────────────────────────────────
  /**
   * 是否启用内置每日记忆维护（默认 true）。
   * 启用后进程启动时自动定时对所有 Agent 执行：
   * 1. QMD 向量索引全量重建（补全 exec_shell/write_file 直写文件的盲区）
   * 2. diary → MEM.md 增量知识提炼（summarizer LLM）
   * 同时自动禁用旧版 mem-distill cron job（若存在）。
   */
  dailyMaintenanceEnabled: z.boolean().default(true),
  /**
   * 内置每日维护的触发时间（本地时间 HH:MM，默认 "04:00"）。
   */
  dailyMaintenanceTime: z.string().regex(/^\d{2}:\d{2}$/).default("04:00"),
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
  /**
   * Code 模式下 ReAct 循环的最大工具调用轮次，默认 0（无限制）。
   * 0 = 无限制，agent 将持续执行直到任务完成或被用户中断。
   * 复杂代码任务（重构、调试、多文件修改）建议使用无限制。
   * chat 模式轮次由 maxChatToolRounds 控制。
   */
  maxCodeToolRounds: z.number().int().min(0).default(0),
  /**
   * Chat/Cron 模式下 ReAct 循环的最大工具调用轮次，默认 0（无限制）。
   * 0 = 无限制，agent 将持续执行直到任务完成或被用户中断。
   * 若需限制轮次（如节省 token），可设为正整数（如 20）。
   * cron 任务无人值守，推荐保持 0（无限制）确保复杂工作流能完整执行。
   */
  maxChatToolRounds: z.number().int().min(0).default(0),
  /**
   * 工具执行结果的最大字符数，超出时自动截断并附加说明，默认 20000。
   * 防止大文件读取或冗长命令输出占满 context window。
   * 0 = 不限制。
   */
  maxToolResultChars: z.number().int().min(0).default(20_000),
  /**
   * 工具调用参数中单个字符串字段值的最大字符数，超出时截断该字段值（保留合法 JSON），默认 8000。
   * 防止 edit_file 等工具的大 old_str/new_str 参数写入 messages[] 后撑爆 context window。
   * 截断只影响存储副本（message history），工具实际执行仍使用 LLM 返回的完整参数。
   * 注意：必须按字段值截断再重新序列化，而非截断整个 JSON 字符串（后者产生不合法 JSON）。
   * 0 = 不限制。
   */
  maxToolCallArgChars: z.number().int().min(0).default(8_000),
}).default({});

// ── MemStore 配置（独立文件 ~/.tinyclaw/memstores.toml）──────────────────────────

/**
 * 单个额外 QMD 可搜索库的配置项。
 * 每个 store 对应一个独立的 Markdown 目录，由同一个 QMD SQLite 索引（collection 隔离）。
 */
export const MemStoreSchema = z.object({
  /** collection 名，同时作为 search_store 工具的 store 参数枚举值 */
  name: z.string().min(1),
  /** 展示给 LLM 的描述，出现在 search_store 工具 description 和搜索结果标头 */
  title: z.string().min(1),
  /** Markdown 文件根目录（支持 ~ 展开） */
  path: z.string().min(1),
  /** glob 匹配模式，默认 **\/*.md */
  pattern: z.string().default("**/*.md"),
  /** 是否启用，false 时不注册 collection 也不出现在 search_store 枚举中 */
  enabled: z.boolean().default(true),
});
export type MemStoreConfig = z.infer<typeof MemStoreSchema>;

export const MemStoresConfigSchema = z.object({
  stores: z.array(MemStoreSchema).default([]),
}).default({ stores: [] });
export type MemStoresConfig = z.infer<typeof MemStoresConfigSchema>;

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

// ── 重试策略配置 ──────────────────────────────────────────────────────────────

const RetryConfigSchema = z.object({
  /** 最多重试次数（不含首次尝试），默认 3；-1 = 无限重试 */
  maxAttempts: z.number().int().min(-1).default(-1),
  /** 5xx 服务端错误的最大连续重试次数（独立于 maxAttempts），默认 5；-1 = 无限重试 */
  max5xxAttempts: z.number().int().min(-1).default(5),
  /** 每次重试等待的固定延迟（毫秒），默认 1000 */
  baseDelayMs: z.number().int().positive().default(1000),
  /** 429 限流是否重试，默认 true */
  retry429: z.boolean().default(true),
  /** 5xx 服务端错误是否重试，默认 true */
  retry5xx: z.boolean().default(true),
  /** 传输层错误（ECONNRESET / socket 等）是否重试，默认 true */
  retryTransport: z.boolean().default(true),
  /** 请求超时是否重试，默认 false（保持现有行为） */
  retryTimeout: z.boolean().default(false),
  /**
   * 流式（streamChat）chunk 间空闲超时（毫秒），默认 60000。
   * 超过该时间无 chunk 到达则中断流并触发重试；0 = 禁用。
   * 设为 60s 是因为复杂推理任务（o1/claude 等）首个 chunk 可能延迟较长。
   */
  streamIdleTimeoutMs: z.number().int().min(0).default(60_000),
  /**
   * 整个重试循环的最大总时长（毫秒）；0 = 不限制。
   * 超过后抛出 LLMConnectionError，用于配合 maxAttempts=-1 避免无限等待。
   * 例：120000 表示无论重试多少次，最多累计等待 2 分钟。
   */
  maxRetryDurationMs: z.number().int().min(0).default(0),
}).default({});
export type RetryConfig = z.infer<typeof RetryConfigSchema>;

// ── 并发控制配置 ──────────────────────────────────────────────────────────────

const ConcurrencySchema = z.object({
  /**
   * 全局 LLM 推理最大并发数。
   * 仅统计正在进行 LLM HTTP 请求的 session 数，工具执行期间不占用槽位。
   * 0 = 不限制（默认），设为正整数（如 3~5）可防止高并发时触发 API Rate Limit。
   * 推荐值：Copilot Pro/Pro+ 用户设 3，企业用户可按套餐设更大值。
   */
  maxConcurrentLLMRequests: z.number().int().min(0).default(0),
}).default({});
export type ConcurrencyConfig = z.infer<typeof ConcurrencySchema>;

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

// ── 语音识别配置 ──────────────────────────────────────────────────────────────

const VoiceSchema = z.object({
  /**
   * faster-whisper 模型大小。
   * 越大越准确但首次下载和推理越慢。
   * 推荐：中文内容用 "small" 或 "medium"；纯英文可用 "tiny"。
   * 可选值：tiny / base / small / medium / large-v2 / large-v3
   */
  model: z.string().default("small"),
  /**
   * 语言代码（ISO 639-1），留空则自动检测。
   * 示例：zh / en / ja / ko
   */
  language: z.string().default(""),
}).default({});
export type VoiceConfig = z.infer<typeof VoiceSchema>;

// ── 根配置 ────────────────────────────────────────────────────────────────────

export const ConfigSchema = z.object({
  providers: ProvidersSchema,
  llm: LLMSchema,
  agent: AgentSchema,
  concurrency: ConcurrencySchema,
  auth: AuthSchema.default({}),
  channels: ChannelsSchema.default({}),
  memory: MemorySchema.default({}),
  tools: ToolsSchema,
  retry: RetryConfigSchema,
  voice: VoiceSchema,
});

export type Config = z.infer<typeof ConfigSchema>;
export type QQBotConfig = z.infer<typeof QQBotSchema>;
export type MFAConfig = z.infer<typeof MFASchema>;

// ── Secrets（~/.tinyclaw/secrets.toml） ───────────────────────────────────────

/**
 * 单个 secret 条目。
 * - `value`         — 真实凭证值，仅在 http_request 工具内部使用，不暴露给 LLM
 * - `allowed_hosts` — 该凭证允许发往的域名列表（空数组 = 不限制）
 */
const SecretEntrySchema = z.object({
  value: z.string(),
  allowed_hosts: z.array(z.string()).default([]),
});
export type SecretEntry = z.infer<typeof SecretEntrySchema>;

/**
 * secrets.toml 整体结构：`{ [KEY]: { value, allowed_hosts } }`
 * KEY 建议全大写+下划线，与 http_request headers 中的 `$KEY` 占位符对应。
 */
export const SecretsConfigSchema = z.record(z.string(), SecretEntrySchema);
export type SecretsConfig = z.infer<typeof SecretsConfigSchema>;
