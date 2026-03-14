import { z } from "zod";

// ── LLM 后端 ─────────────────────────────────────────────────────────────────

/** OpenAI-compatible 后端（显式 baseUrl + apiKey） */
const OpenAIBackendSchema = z.object({
  /** 区分器，缺省时默认视为 openai */
  provider: z.literal("openai").optional(),
  baseUrl: z.string().url(),
  apiKey: z.string().min(1),
  model: z.string().min(1),
  /** 最大输出 token 数，默认 4096 */
  maxTokens: z.number().int().positive().default(4096),
  /** 请求超时（毫秒），默认 60000 */
  timeoutMs: z.number().int().positive().default(60_000),
});

/** 向后兼容：OpenAI 后端的推导类型 */
export type LLMBackend = z.infer<typeof OpenAIBackendSchema>;

/** GitHub Copilot 后端（自动发现模型和能力参数） */
export const CopilotBackendSchema = z.object({
  provider: z.literal("copilot"),
  /**
   * GitHub OAuth token 来源：
   * - `"gh_cli"` → 运行 `gh auth token` 动态获取（默认）
   * - `"env"`    → 读取 `$GITHUB_TOKEN` 环境变量
   * - 其他字符串  → 直接作为 token 使用
   */
  githubToken: z.string().min(1).default("gh_cli"),
  /**
   * 模型 ID，或 `"auto"`（默认）：使用 Copilot 标记的 is_chat_default 模型。
   * 运行时从 /models 接口动态发现所有可用模型。
   */
  model: z.string().default("auto"),
  /** 请求超时（毫秒），默认 60000 */
  timeoutMs: z.number().int().positive().default(60_000),
});

export type CopilotBackendConfig = z.infer<typeof CopilotBackendSchema>;

/**
 * 任意后端联合类型。
 * Zod 先尝试 CopilotBackendSchema（要求 provider=copilot），失败则尝试 OpenAIBackendSchema。
 */
const AnyBackendSchema = z.union([CopilotBackendSchema, OpenAIBackendSchema]);
export type AnyLLMBackend = z.infer<typeof AnyBackendSchema>;

const LLMBackendsSchema = z.object({
  /** 日常对话后端 */
  daily: AnyBackendSchema,
  /** 代码任务后端（供 codex/copilot router 使用） */
  code: AnyBackendSchema.optional(),
  /** 摘要压缩后端 */
  summarizer: AnyBackendSchema.optional(),
});

const LLMSchema = z.object({
  backends: LLMBackendsSchema,
});

// ── Microsoft MFA ─────────────────────────────────────────────────────────────

const MFASchema = z.object({
  tenantId: z.string().uuid("auth.mfa.tenantId 必须是有效的 UUID"),
  clientId: z.string().uuid("auth.mfa.clientId 必须是有效的 UUID"),
  /** MFA 确认超时（秒），默认 60 */
  timeoutSecs: z.number().int().positive().default(60),
});

const AuthSchema = z.object({
  mfa: MFASchema,
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
   * QMD embedding 模型（HuggingFace URI）
   * 默认 Qwen3-Embedding-0.6B，中文优化，~640MB 首次自动下载
   */
  embedModel: z
    .string()
    .default(
      "hf:Qwen/Qwen3-Embedding-0.6B-GGUF/Qwen3-Embedding-0.6B-Q8_0.gguf"
    ),
  /**
   * 触发摘要的 token 使用率阈值（0-1），默认 0.8
   * 达到模型上下文长度的该比例时，自动压缩对话历史
   */
  tokenThreshold: z.number().min(0.1).max(0.99).default(0.8),
  /** 上下文最大 token 数，用于计算阈值，默认 128000 */
  contextWindow: z.number().int().positive().default(128_000),
});

// ── 根配置 ────────────────────────────────────────────────────────────────────

export const ConfigSchema = z.object({
  llm: LLMSchema,
  auth: AuthSchema,
  channels: ChannelsSchema.default({}),
  memory: MemorySchema.default({}),
});

export type Config = z.infer<typeof ConfigSchema>;
export type QQBotConfig = z.infer<typeof QQBotSchema>;
export type MFAConfig = z.infer<typeof MFASchema>;
