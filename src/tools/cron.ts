/**
 * Agent 工具：cron_add / cron_list / cron_remove / cron_enable / cron_disable / cron_run
 *
 * 这些工具在 agent session 中调用时，output.sessionId 会从 ToolContext.sessionId
 * 自动注入，确保 cron job 的结果推送回调用它的那个 QQ 对话。
 */

import { registerTool, type ToolContext } from "./registry.js";
import { addJob, removeJob, loadJobs, updateJob, getJob, readLogs } from "../cron/store.js";
import { cronScheduler } from "../cron/scheduler.js";
import { ZodError } from "zod";

// ── nanoid 轻量替代 ───────────────────────────────────────────────────────────

function nanoid(size = 8): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < size; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

// ── 下次触发时间估算(不依赖 timer 状态,纯计算) ───────────────────────────────

function estimateNextRun(job: import("../cron/schema.js").CronJob): string | null {
  if (!job.enabled) return null;
  switch (job.type) {
    case "once":
      return job.runAt ?? null;
    case "every": {
      if (!job.intervalSecs) return null;
      const base = job.lastRunAt
        ? new Date(job.lastRunAt).getTime() + job.intervalSecs * 1000
        : Date.now();
      return new Date(Math.max(base, Date.now())).toISOString();
    }
    case "daily": {
      const times =
        job.timesOfDay && job.timesOfDay.length > 0
          ? job.timesOfDay
          : job.timeOfDay
            ? [job.timeOfDay]
            : [];
      if (times.length === 0) return null;
      const now = new Date();
      for (const t of times) {
        const [hh, mm] = t.split(":").map(Number);
        const d = new Date(now);
        d.setHours(hh!, mm!, 0, 0);
        if (d.getTime() > now.getTime()) return d.toISOString();
      }
      // 今天全部已过 → 明天最早时段
      const [hh, mm] = times[0]!.split(":").map(Number);
      const d = new Date(now);
      d.setDate(d.getDate() + 1);
      d.setHours(hh!, mm!, 0, 0);
      return d.toISOString();
    }
    case "manual":
      return null;
  }
}

// ── cron_add ──────────────────────────────────────────────────────────────────

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "cron_add",
      description:
        "Create a scheduled task.\n" +
        "- Modes: pipeline (steps, pure tool calls, zero LLM cost, recommended) / " +
        "message (calls the LLM, tell the user first) / manual (trigger only)\n" +
        "- Confirm before creating: intent and execution flow / schedule time / push target / " +
        "notify policy / output requirements / whether an LLM is needed; ask_user if vague\n" +
        "- Full tutorial and JSON templates: skill cron-creator " +
        '(auto-triggers on "scheduled task / daily reminder / every N minutes")',
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description:
              "Short task name (optional), shown in lists and logs; " +
              "defaults to a truncated message",
          },
          message: {
            type: "string",
            description:
              "Natural-language task instruction sent to the cron agent (no shell needed). " +
              "Must contain four parts: (1) intent (what to do) (2) execution flow (data " +
              "source / key steps) (3) constraints (failure handling, no fabrication) " +
              "(4) output requirements (content + format). Template: skill cron-creator",
          },
          type: {
            type: "string",
            enum: ["once", "every", "daily", "manual"],
            description:
              "Schedule type. Choose one of once/every/daily; manual = no automatic " +
              "schedule, only cron_run triggers it",
          },
          runAt: {
            type: "string",
            description: "[once] ISO 8601 trigger time; required when type=once",
          },
          intervalSecs: {
            type: "number",
            description:
              "[every] Interval in seconds, e.g. 300 = every 5 minutes; required for type=every",
          },
          timeOfDay: {
            type: "string",
            description:
              "[daily] Single trigger time, format HH:MM (local time); for type=daily provide " +
              "either timeOfDay or timesOfDay; use timesOfDay for multiple times",
          },
          timesOfDay: {
            type: "array",
            items: { type: "string" },
            description:
              '[daily] Multiple trigger times, format ["HH:MM", ...], takes precedence over ' +
              'timeOfDay. Example: ["09:00","12:00","20:00"]; for type=daily provide one of the two',
          },
          timeRange: {
            type: "object",
            description:
              "[every] Restrict the trigger window; format " +
              '{start:"HH:MM", end:"HH:MM", weekdays?:[0-6], timezone?:IANA name}, ' +
              "0=Sunday...6=Saturday, omit = every day. Ticks outside the window are skipped; " +
              "crossing midnight is supported (e.g. 21:30 -> 04:00); " +
              'timezone e.g. "America/New_York", omit = local timezone',
          },
          agentId: {
            type: "string",
            description:
              "Agent to use (default default). In interactive sessions the caller decides; " +
              "it only takes effect in contexts without an agent, such as CLI",
          },
          notify: {
            type: "string",
            enum: ["always", "on_change", "on_error", "never", "llm"],
            description:
              "Notify policy (default always). llm = decided by the LLM, pushes only when the " +
              "output contains a [NOTIFY] block",
          },
          stateful: {
            type: "boolean",
            description: "Keep conversation history across runs (default false)",
          },
          mfaExempt: {
            type: "boolean",
            description:
              "Whether to exempt this scheduled task from MFA confirmation (default false). " +
              "When false, high-risk tools such as write_file/delete_file still go through one " +
              "confirmation (if the task has an interactive output target); when unattended " +
              "and it cannot be delivered, [sandbox.unattended].mfaFallback applies. " +
              "Pass true only when you are sure this task needs no human review.",
          },
          writablePaths: {
            type: "array",
            items: { type: "string" },
            description:
              "Sandbox write exemptions (default empty). In the sandbox an unattended task " +
              "can only write its own agent directory by default; when a script needs to " +
              "write elsewhere, list it **explicitly**, e.g. " +
              '["~/.tinyclaw/data", "~/.tinyclaw/dashboard.db", "~/FinanceSkill"]. ' +
              "Applies only to this job and does not relax the secret mask.",
          },
          secrets: {
            type: "array",
            items: { type: "string" },
            description:
              "Secret names this task declares it needs to read (names in secrets.toml, e.g. " +
              "DEEPSEEK_API_KEY; default empty). The sandbox masks it to an empty file by " +
              "default; once declared, only **these keys** are exposed to this task's scripts at " +
              "runtime (bound to the original path, no script change needed). Not declared = " +
              "the script reads an empty file.",
          },
          peerId: {
            type: "string",
            description: "QQ peerId of the push target (omitted = log only)",
          },
          msgType: {
            type: "string",
            enum: ["c2c", "group", "guild", "dm"],
            description: "Message type (default c2c)",
          },
          botId: {
            type: "string",
            description:
              "(Optional) QQBot connector to push with, the key in config.toml [channels.qqbots] " +
              "(e.g. main/chat). If omitted, it is inferred from the session",
          },
          model: {
            type: "string",
            description:
              '(Optional) Model to run, format "provider/model-id", e.g. ' +
              '"deepseek/deepseek-v4-flash". provider must be a configured [providers.*] in ' +
              "config.toml (copilot/openai/openrouter/deepseek/mimo/google); on a parse failure it " +
              "falls back to the daily backend and logs an error. If omitted, the daily backend " +
              "is used directly.",
          },
          steps: {
            type: "array",
            description:
              "[Pipeline mode] Serial steps: {type:'tool',name,args} = call the tool " +
              "directly, no LLM; {type:'msg',content} = inject a message to trigger the LLM. " +
              "The LLM output of the last msg is the pushed content; if there is no msg, the " +
              "last tool output is used. Template: skill cron-creator",
            items: {
              type: "object",
              description:
                "Pipeline step: { type: 'tool', name, args } or { type: 'msg', content }",
            },
          },
        },
        required: ["message", "type"],
      },
    },
  },
  execute: async (args: Record<string, unknown>, ctx?: ToolContext) => {
    const message = String(args["message"] ?? "").trim();
    const type = args["type"] as "once" | "every" | "daily" | "manual";
    if (!message) return "错误：message 不能为空";

    // output 绑定：优先用传入的 peerId，否则从 sessionId 解析
    const peerId = args["peerId"]
      ? String(args["peerId"])
      : ctx?.sessionId
        ? (() => {
            // sessionId 格式 "qqbot:c2c:OPENID" → OPENID
            const parts = ctx.sessionId!.split(":");
            return parts.length >= 3 ? parts.slice(2).join(":") : null;
          })()
        : null;

    const sessionId = ctx?.sessionId ?? null;
    const msgType = (args["msgType"] as "c2c" | "group" | "guild" | "dm") ?? "c2c";

    try {
    const job = addJob({
      id: nanoid(),
      enabled: true,
      agentId: ctx?.agentId ?? String(args["agentId"] ?? "default"),
      name: args["name"] ? String(args["name"]).trim() : undefined,
      message,
      type,
      runAt: args["runAt"] ? String(args["runAt"]) : undefined,
      intervalSecs: args["intervalSecs"] ? Number(args["intervalSecs"]) : undefined,
      timeOfDay: args["timesOfDay"]
        ? undefined
        : args["timeOfDay"]
          ? String(args["timeOfDay"])
          : undefined,
      timesOfDay:
        Array.isArray(args["timesOfDay"]) && args["timesOfDay"].length > 0
          ? (args["timesOfDay"] as string[])
          : args["timeOfDay"]
            ? undefined
            : undefined,
      timeRange: args["timeRange"]
        ? (args["timeRange"] as { start: string; end: string; weekdays?: number[]; timezone?: string })
        : undefined,
      output: {
        sessionId,
        peerId,
        msgType,
        botId: args["botId"] ? String(args["botId"]) : ctx?.botId,
        notify:
          (args["notify"] as "always" | "on_change" | "on_error" | "never" | "llm") ?? "always",
      },
      stateful: Boolean(args["stateful"] ?? false),
      // MFA 豁免：默认 **false** —— 新建的定时任务在"改文件/删文件"这类高危工具上
      // 仍需要一次确认（能送达就送达）。只有显式传 mfaExempt=true 才豁免。
      // 历史实现写死 true，等于"创建即豁免"，与"无人值守最严"相反。
      mfaExempt: args["mfaExempt"] === true,
      // 沙箱可写豁免：无人值守默认只能写自己的 agent 目录，脚本需要写别处时显式列出
      writablePaths: Array.isArray(args["writablePaths"])
        ? (args["writablePaths"] as string[]).map((p) => String(p))
        : [],
      // 该任务声明要读的密钥（方案 B：沙箱内只暴露这几把 key）
      secrets: Array.isArray(args["secrets"]) ? (args["secrets"] as string[]).map((s) => String(s)) : [],
      ...(args["model"] ? { model: String(args["model"]) } : {}),
      ...(Array.isArray(args["steps"]) && args["steps"].length > 0
        ? { steps: args["steps"] as import("../cron/schema.js").PipelineStep[] }
        : {}),
    });

    cronScheduler.reschedule(job.id);

    // 回显完整配置供 LLM 自查(含 nextRunAt 估算)与用户复核
    const schedule =
      job.type === "once"
        ? job.runAt ?? "-"
        : job.type === "every"
          ? `每 ${job.intervalSecs}s${job.timeRange ? ` [时段 ${job.timeRange.start}-${job.timeRange.end}${job.timeRange.weekdays && job.timeRange.weekdays.length > 0 ? ` 周${job.timeRange.weekdays.join("/")}` : ""}${job.timeRange.timezone ? ` ${job.timeRange.timezone}` : ""}]` : ""}`
          : job.type === "daily"
            ? `每天 ${job.timesOfDay && job.timesOfDay.length > 0 ? job.timesOfDay.join(", ") : (job.timeOfDay ?? "-")}`
            : "手动触发(cron_run)";
    return `✓ 已创建 cron job: ${job.id}（类型: ${job.type}，绑定 session: ${sessionId ?? "无"}）

${JSON.stringify(
  {
    id: job.id,
    name: job.name ?? "(未填 name,列表将显示 message 截断)",
    type: job.type,
    schedule,
    nextRunAt: estimateNextRun(job),
    notify: job.output.notify,
    pushTo: job.output.peerId ? `${job.output.msgType}:${job.output.peerId}` : "仅写日志(未绑定推送)",
    model: job.model ?? "daily(默认)",
    mode: job.steps && job.steps.length > 0 ? `pipeline(${job.steps.length} steps)` : "message",
    message: message.slice(0, 80) + (message.length > 80 ? "…" : ""),
  },
  null,
  2
)}`;
    } catch (err) {
      if (err instanceof ZodError) {
        const issues = err.issues
          .map((i) => `- ${i.path.join(".") || "整体"}: ${i.message}`)
          .join("\n");
        return `❌ 创建失败,请修正后重试:\n${issues}`;
      }
      throw err;
    }
  },
});

// ── cron_list ─────────────────────────────────────────────────────────────────

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "cron_list",
      description:
        "List cron jobs (schedule/state/result summary/next run); includeLogs adds " +
        "the last 3 logs",
      parameters: {
        type: "object",
        properties: {
          includeLogs: {
            type: "boolean",
            description: "Append the last 3 logs (default false)",
          },
        },
        required: [],
      }
    },
  },
  execute: async (args: Record<string, unknown>) => {
    const jobs = loadJobs();
    if (jobs.length === 0) return "暂无 cron jobs";
    const includeLogs = Boolean(args["includeLogs"]);
    const result = jobs.map((j) => ({
      id: j.id,
      name: j.name ?? null,
      enabled: j.enabled,
      type: j.type,
      schedule:
        j.type === "once"
          ? j.runAt
          : j.type === "every"
            ? `每 ${j.intervalSecs}s${j.timeRange ? ` [时段 ${j.timeRange.start}-${j.timeRange.end}${j.timeRange.weekdays && j.timeRange.weekdays.length > 0 ? ` 周${j.timeRange.weekdays.join("/")}` : ""}${j.timeRange.timezone ? ` ${j.timeRange.timezone}` : ""}]` : ""}`
            : j.type === "daily"
              ? `每天 ${(j.timesOfDay && j.timesOfDay.length > 0 ? j.timesOfDay : j.timeOfDay ? [j.timeOfDay] : []).join(", ")}`
              : "手动触发",
      nextRunAt: estimateNextRun(j),
      message: j.message.slice(0, 60),
      model: j.model ?? "daily(默认)",
      lastRunAt: j.lastRunAt,
      lastRunStatus: j.lastRunStatus,
      lastResultBrief: (j.lastRunResult ?? "").replace(/\n+/g, " ").slice(0, 100),
      ...(includeLogs
        ? {
            recentLogs: readLogs(j.id, 3).map((l) => ({
              ts: l.ts,
              status: l.status,
              durationMs: l.durationMs,
              trigger: l.trigger,
            })),
          }
        : {}),
    }));
    return JSON.stringify(result, null, 2);
  },
});

// ── cron_remove ───────────────────────────────────────────────────────────────

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "cron_remove",
      description: "Delete the cron job with the given id.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "job ID" },
        },
        required: ["id"],
      },
    },
  },
  execute: async (args) => {
    const id = String(args["id"] ?? "");
    if (!getJob(id)) return `未找到 job "${id}"`;
    removeJob(id);
    cronScheduler.reschedule(id);
    return `✓ 已删除 job: ${id}`;
  },
});

// ── cron_enable ───────────────────────────────────────────────────────────────

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "cron_enable",
      description: "Enable the cron job with the given id.",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "job ID" } },
        required: ["id"],
      },
    },
  },
  execute: async (args) => {
    const id = String(args["id"] ?? "");
    if (!updateJob(id, { enabled: true })) return `未找到 job "${id}"`;
    cronScheduler.reschedule(id);
    return `✓ job ${id} 已启用`;
  },
});

// ── cron_disable ──────────────────────────────────────────────────────────────

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "cron_disable",
      description: "Disable the cron job with the given id.",
      parameters: {
        type: "object",
        properties: { id: { type: "string", description: "job ID" } },
        required: ["id"],
      },
    },
  },
  execute: async (args) => {
    const id = String(args["id"] ?? "");
    if (!updateJob(id, { enabled: false })) return `未找到 job "${id}"`;
    cronScheduler.reschedule(id);
    return `✓ job ${id} 已停用`;
  },
});

// ── cron_run ──────────────────────────────────────────────────────────────────

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "cron_run",
      description:
        "Trigger the given cron job once immediately (does not affect its schedule). " +
        "Whether the result is pushed follows the job's notify policy.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "job ID" },
        },
        required: ["id"],
      },
    },
  },
  execute: async (args: Record<string, unknown>, ctx?: ToolContext) => {
    const id = String(args["id"] ?? "");
    const job = getJob(id);
    if (!job) return `未找到 job "${id}"`;

    // fire-and-forget：由 scheduler 内部使用持有的 connector 执行
    // 结果按 job.output.notify 策略推送到绑定的 peerId，不向 agent 暴露内容
    const ok = cronScheduler.triggerJob(id);
    if (!ok) return `触发失败：未找到 job "${id}"`;
    return `✓ job ${id} 已触发，结果将按通知策略推送到绑定输出`;
  },
});
