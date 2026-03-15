import { z } from "zod";

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
