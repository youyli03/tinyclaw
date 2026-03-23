import { z } from "zod";

// ── Pipeline Step Schema ──────────────────────────────────────────────────────

/**
 * 流水线步骤（两种类型）：
 * - `tool`：直接执行指定工具（不走 LLM），输出注入 session 上下文供后续步骤感知
 * - `msg` ：向 session 注入 user 消息，触发完整 runAgent（LLM 生成回复）
 *
 * 多个步骤共享同一个 stateful session，前步的工具输出对后续 LLM 步骤完全可见。
 */
export const PipelineStepSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("tool"),
    /** 工具名称（需已注册，如 exec_shell / send_report / notify_user 等） */
    name: z.string().min(1),
    /** 传给工具的参数 */
    args: z.record(z.unknown()).default({}),
  }),
  z.object({
    type: z.literal("msg"),
    /** 注入给 agent 的 user 消息内容，将触发一次 runAgent */
    content: z.string().min(1),
  }),
]);

export type PipelineStep = z.infer<typeof PipelineStepSchema>;

// ── Job 输出配置 ──────────────────────────────────────────────────────────────

const CronOutputSchema = z.object({
  /** 推送目标 sessionId（如 "qqbot:c2c:OPENID"），null = 仅写 log */
  sessionId: z.string().nullable().default(null),
  /** connector.send 目标 peerId */
  peerId: z.string().nullable().default(null),
  /** 消息类型 */
  msgType: z.enum(["c2c", "group", "guild", "dm"]).default("c2c"),
  /**
   * 通知策略：
   * - always    — 每次完成都推送
   * - on_change — 结果与上次不同时推送
   * - on_error  — 仅出错时推送
   * - never     — 仅写 log，不推送
   */
  notify: z.enum(["always", "on_change", "on_error", "never"]).default("always"),
});

// ── CronJob Schema ────────────────────────────────────────────────────────────

export const CronJobSchema = z.object({
  /** nanoid */
  id: z.string(),
  /** 是否启用 */
  enabled: z.boolean().default(true),
  /** 使用的 agent（默认 "default"） */
  agentId: z.string().default("default"),
  /** 触发时传给 agent 的 prompt */
  message: z.string().min(1),

  // ── 调度类型（三选一）────────────────────────────────────────────────────
  type: z.enum(["once", "every", "daily"]),

  /** "once": ISO 8601 时间戳，到达后触发一次后删除 */
  runAt: z.string().optional(),
  /** "every": 间隔秒数 */
  intervalSecs: z.number().int().positive().optional(),
  /** "daily": "HH:MM" 本地时间，每天触发一次 */
  timeOfDay: z.string().regex(/^\d{2}:\d{2}$/).optional(),

  // ── 输出配置 ──────────────────────────────────────────────────────────────
  output: CronOutputSchema,

  /**
   * 是否保留跨 run 的对话历史：
   * - false：每次使用独立 session（sessionId = cron:<id>:<ts>），run 完删除 JSONL
   * - true ：固定 session（sessionId = cron:<id>），JSONL 持久化
   */
  stateful: z.boolean().default(false),

  /**
   * 创建 job 时经过 MFA 验证：true = 运行时自动通过 MFA，无需用户实时确认
   */
  mfaExempt: z.boolean().default(false),

  /**
   * 运行此 job 使用的模型（格式同 config.toml，如 "copilot/claude-sonnet-4.6"）。
   * 不填则使用 daily 后端模型。
   */
  model: z.string().optional(),

  /**
   * 流水线步骤列表（Pipeline 模式）。
   *
   * 提供此字段时，job 以 Pipeline 模式运行（忽略 `message` 字段的 prompt 用途，仅作描述）：
   * - 步骤按顺序串行执行，共享同一个 stateful session
   * - `tool` 步骤：直接调用工具，输出以合成 tool call 对（assistant+tool_calls / role:tool）注入 session
   * - `msg` 步骤：向 session 注入 user 消息，触发 LLM 生成回复
   * - 最后一个 `msg` 步骤的 LLM 输出作为 job 的最终 resultText（用于推送/日志）
   * - 若无 `msg` 步骤，最后一个 `tool` 步骤的输出作为 resultText
   *
   * 不提供此字段时，job 走原有 `message` 单步模式。
   */
  steps: z.array(PipelineStepSchema).optional(),

  /**
   * Pipeline 模式每次运行前是否清空 session 历史（默认 true，即未设置时视为 true）。
   *
   * - 未设置或 true：每次运行前删除 session JSONL，避免跨 run 的历史消息（含旧数据）污染上下文
   * - false：保留历史，适用于需要跨 run 记忆的场景
   *
   * 仅当 stateful=false 且 isPipeline=true 时生效；stateful job 不受此字段影响。
   */
  clearSessionOnRun: z.boolean().optional(),

  // ── 运行记录 ──────────────────────────────────────────────────────────────
  createdAt: z.string(),
  lastRunAt: z.string().optional(),
  lastRunStatus: z.enum(["success", "error"]).optional(),
  /** on_change 策略比对用，存储上次结果摘要 */
  lastRunResult: z.string().optional(),
});

export type CronJob = z.infer<typeof CronJobSchema>;
export type CronOutput = z.infer<typeof CronOutputSchema>;

// ── jobs.json 根结构 ──────────────────────────────────────────────────────────

export const CronJobsFileSchema = z.object({
  version: z.literal(1).default(1),
  jobs: z.array(CronJobSchema).default([]),
});

export type CronJobsFile = z.infer<typeof CronJobsFileSchema>;
