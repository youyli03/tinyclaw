import { z } from "zod";

// ── Pipeline Step Schema ──────────────────────────────────────────────────────

/**
 * 流水线步骤(两种类型):
 * - `tool`:直接执行指定工具(不走 LLM),输出注入 session 上下文供后续步骤感知
 * - `msg` :向 session 注入 user 消息,触发完整 runAgent(LLM 生成回复)
 *
 * 多个步骤共享同一个 stateful session,前步的工具输出对后续 LLM 步骤完全可见。
 */
export const PipelineStepSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("tool"),
    /** 工具名称(需已注册,如 exec_shell / send_report / notify_user 等) */
    name: z.string().min(1),
    /** 传给工具的参数 */
    args: z.record(z.unknown()).default({}),
  }),
  z.object({
    type: z.literal("msg"),
    /** 注入给 agent 的 user 消息内容,将触发一次 runAgent */
    content: z.string().min(1),
  }),
]);

export type PipelineStep = z.infer<typeof PipelineStepSchema>;

// ── Job 输出配置 ──────────────────────────────────────────────────────────────

const CronOutputSchema = z.object({
  /** 推送目标 sessionId(如 "qqbot:c2c:OPENID"),null = 仅写 log */
  sessionId: z.string().nullable().default(null),
  /** connector.send 目标 peerId */
  peerId: z.string().nullable().default(null),
  /** 消息类型 */
  msgType: z.enum(["c2c", "group", "guild", "dm"]).default("c2c"),
  /** 指定使用哪个 QQBot connector (config.toml channels.qqbots 中的 key，如 "main"/"chat")，不填则用默认 connector */
  botId: z.string().nullable().optional(),
  /**
   * 通知策略:
   * - always    — 每次完成都推送
   * - on_change — 结果与上次不同时推送
   * - on_error  — 仅出错时推送
   * - never     — 仅写 log,不推送
   * - llm       — 由 LLM 决定:输出包含 [NOTIFY]...[/NOTIFY] 块时推送,内容为块内文字
   */
  notify: z.enum(["always", "on_change", "on_error", "never", "llm"]).default("always"),
});

// ── CronJob Schema ────────────────────────────────────────────────────────────

export const CronJobSchema = z
  .object({
    /** nanoid */
    id: z.string(),
    /** 是否启用 */
    enabled: z.boolean().default(true),
    /** 使用的 agent(默认 "default") */
    agentId: z.string().default("default"),
    /** 短名称/描述,用于列表展示与日志标识;不填则回退到 message 截断 */
    name: z.string().optional(),
    /**
     * 触发时传给 agent 的 prompt(Message 模式须含四要素:意图/执行流程/约束/输出要求,≥15 字;
     * Pipeline 模式仅作描述,≥5 字即可)
     */
    message: z.string().min(1),

  // ── 调度类型(四选一)────────────────────────────────────────────────────
  /**
   * - once   — 指定时间触发一次，触发后自动删除
   * - every  — 固定间隔秒数循环触发；可配合 timeRange 限制触发时段
   * - daily  — 每天固定 HH:MM 触发一次
   * - manual — 无自动调度，只能通过 cron_run 手动触发
   */
  type: z.enum(["once", "every", "daily", "manual"]),

  /** "once": ISO 8601 时间戳，到达后触发一次后删除 */
  runAt: z.string().optional(),
  /** "every": 间隔秒数 */
  intervalSecs: z.number().int().positive().optional(),
  /** "daily": "HH:MM" 本地时间，每天触发一次 */
  /** "daily": "HH:MM" 本地时间,每天触发一次(单时段;多时段请用 timesOfDay) */
  timeOfDay: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .optional(),
  /** "daily": 多个触发时间点,格式 ["HH:MM", ...](优先于 timeOfDay) */
  timesOfDay: z.array(z.string().regex(/^\d{2}:\d{2}$/)).optional(),
  /**
   * "every" 模式专用:限制触发时段(段外跳过,不触发)
   * - start/end: "HH:MM" 目标时区时间(支持跨午夜,如 21:30→04:00)
   * - weekdays: 允许触发的星期数组(0=周日, 1=周一 … 6=周六),不填=每天
   * - timezone: IANA 时区名(如 "America/New_York"),不填=本地时区;DST 夏令时自动处理
   */
  timeRange: z
    .object({
      start: z.string().regex(/^\d{2}:\d{2}$/),
      end: z.string().regex(/^\d{2}:\d{2}$/),
      weekdays: z.array(z.number().int().min(0).max(6)).optional(),
      timezone: z.string().optional(),
    })
    .optional(),

  // ── 输出配置 ──────────────────────────────────────────────────────────────
  output: CronOutputSchema,

  /**
   * 是否保留跨 run 的对话历史:
   * - false:每次使用独立 session(sessionId = cron:<id>:<ts>),run 完删除 JSONL
   * - true :固定 session(sessionId = cron:<id>),JSONL 持久化
   */
  stateful: z.boolean().default(false),

  /**
   * 创建 job 时经过 MFA 验证:true = 运行时自动通过 MFA,无需用户实时确认
   */
  mfaExempt: z.boolean().default(false),

  /**
   * 运行此 job 使用的模型(格式同 config.toml,如 "copilot/claude-sonnet-4.6")。
   * 不填则使用 daily 后端模型。
   */
  model: z.string().optional(),

  /**
   * 流水线步骤列表(Pipeline 模式)。
   *
   * 提供此字段时,job 以 Pipeline 模式运行(忽略 `message` 字段的 prompt 用途,仅作描述):
   * - 步骤按顺序串行执行,共享同一个 stateful session
   * - `tool` 步骤:直接调用工具,输出以合成 tool call 对(assistant+tool_calls / role:tool)注入 session
   * - `msg` 步骤:向 session 注入 user 消息,触发 LLM 生成回复
   * - 最后一个 `msg` 步骤的 LLM 输出作为 job 的最终 resultText(用于推送/日志)
   * - 若无 `msg` 步骤,最后一个 `tool` 步骤的输出作为 resultText
   *
   * 不提供此字段时,job 走原有 `message` 单步模式。
   */
  steps: z.array(PipelineStepSchema).optional(),

  /**
   * 此 cron job 的日志级别:
   * - "normal" (默认):记录每次运行的完整日志(启动/步骤/结果/推送)
   * - "quiet":仅记录错误和最终结果(中间步骤日志静默)
   * - "silent":完全不输出日志(但 notify=on_error 的推送不受此限制)
   */
  logLevel: z.enum(["normal", "quiet", "silent"]).default("normal").optional(),

  /**
   * Pipeline 模式每次运行前是否清空 session 历史(默认 true,即未设置时视为 true)。
   *
   * - 未设置或 true:每次运行前删除 session JSONL,避免跨 run 的历史消息(含旧数据)污染上下文
   * - false:保留历史,适用于需要跨 run 记忆的场景
   *
   * 仅当 stateful=false 且 isPipeline=true 时生效;stateful job 不受此字段影响。
   */
  clearSessionOnRun: z.boolean().optional(),

  // ── 运行记录 ──────────────────────────────────────────────────────────────
  createdAt: z.string(),
  lastRunAt: z.string().optional(),
  lastRunStatus: z.enum(["success", "error"]).optional(),
  /** on_change 策略比对用,存储上次结果摘要 */
  lastRunResult: z.string().optional(),
  })
  .superRefine((job, ctx) => {
    // ── 交叉校验:type 与调度参数必须匹配 ───────────────────────────────────
    if (job.type === "once" && !job.runAt) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["runAt"],
        message: "type=once 的 job 必须提供 runAt(ISO 8601 触发时间,如 2026-08-02T15:00:00+08:00)",
      });
    }
    if (job.type === "every" && !job.intervalSecs) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["intervalSecs"],
        message: "type=every 的 job 必须提供 intervalSecs(间隔秒数,如 300=每5分钟)",
      });
    }
    if (
      job.type === "daily" &&
      !job.timeOfDay &&
      !(job.timesOfDay && job.timesOfDay.length > 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["timeOfDay"],
        message: "type=daily 的 job 必须提供 timeOfDay 或 timesOfDay(触发时间点,如 \"08:00\")",
      });
    }
    // ── timezone 合法性:IANA 时区名,Intl 试构造验证 ─────────────────────────
    if (job.timeRange?.timezone) {
      try {
        new Intl.DateTimeFormat("en-US", { timeZone: job.timeRange.timezone });
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["timeRange", "timezone"],
          message: `无效的 IANA 时区名 "${job.timeRange.timezone}"(示例: America/New_York, Asia/Shanghai)`,
        });
      }
    }
    // ── message 长度:Message 模式须四要素齐全 ───────────────────────────────
    const isPipeline = Array.isArray(job.steps) && job.steps.length > 0;
    const minLen = isPipeline ? 5 : 15;
    if ((job.message ?? "").trim().length < minLen) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["message"],
        message: isPipeline
          ? `message 太短(${(job.message ?? "").trim().length} 字),至少 ${minLen} 字:简要描述任务用途`
          : `message 太短(${(job.message ?? "").trim().length} 字),至少 ${minLen} 字:须包含意图/执行流程/约束/输出要求四要素`,
      });
    }
  });

export type CronJob = z.infer<typeof CronJobSchema>;
export type CronOutput = z.infer<typeof CronOutputSchema>;

// ── jobs.json 根结构 ──────────────────────────────────────────────────────────

export const CronJobsFileSchema = z.object({
  version: z.literal(1).default(1),
  jobs: z.array(CronJobSchema).default([]),
});

export type CronJobsFile = z.infer<typeof CronJobsFileSchema>;
