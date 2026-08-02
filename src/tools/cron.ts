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
      description: `创建定时任务。
- 模式: pipeline(steps,纯工具零消耗,推荐)/ message(调 LLM,创建前须告知用户)/ manual(仅手动触发)
- 创建前须确认: 意图与执行流程 / 调度时间 / 推送给谁 / 通知策略 / 输出要求 / 是否需 LLM;描述模糊先 ask_user
- 详细教程与 JSON 模板见 skill cron-creator(说"定时任务/每天提醒/每N分钟"等自动触发)`,
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "任务短名称(可选),列表与日志展示;不填则用 message 截断",
          },
          message: {
            type: "string",
            description:
              "发给 cron agent 的自然语言任务指令(无需手写 shell)。须含四要素:①意图(做什么)②执行流程(数据来源/关键步骤)③约束(失败处理,禁止编造)④输出要求(内容+格式)。模板见 skill cron-creator",
          },
          type: {
            type: "string",
            enum: ["once", "every", "daily", "manual"],
            description: "调度类型。once/every/daily 三选一;manual=无自动调度,仅 cron_run 手动触发",
          },
          runAt: { type: "string", description: "[once] ISO 8601 触发时间(type=once 时必填)" },
          intervalSecs: { type: "number", description: "[every] 间隔秒数,如 300=每5分钟(type=every 时必填)" },
          timeOfDay: {
            type: "string",
            description:
              "[daily] 单个触发时间,格式 HH:MM(本地时间);type=daily 时必填 timeOfDay 或 timesOfDay;多时段请用 timesOfDay",
          },
          timesOfDay: {
            type: "array",
            items: { type: "string" },
            description:
              '[daily] 多个触发时间点,格式 ["HH:MM", ...],优先于 timeOfDay。例:["09:00","12:00","20:00"];type=daily 时必填其一',
          },
          timeRange: {
            type: "object",
            description:
              '[every] 限制触发时段;格式 {start:"HH:MM", end:"HH:MM", weekdays?:[0-6]},0=周日...6=周六,不填=每天。段外跳过不触发',
          },
          agentId: {
            type: "string",
            description:
              "使用的 agent(默认 default)。交互式会话中由调用方 agent 决定,仅 CLI 等无 agent 上下文场景生效",
          },
          notify: {
            type: "string",
            enum: ["always", "on_change", "on_error", "never", "llm"],
            description: "通知策略(默认 always)。llm=由LLM决定,输出含[NOTIFY]块时才推送",
          },
          stateful: { type: "boolean", description: "是否保留跨 run 对话历史(默认 false)" },
          peerId: { type: "string", description: "推送目标的 QQ peerId(不填则仅写 log)" },
          msgType: {
            type: "string",
            enum: ["c2c", "group", "guild", "dm"],
            description: "消息类型(默认 c2c)",
          },
          botId: {
            type: "string",
            description:
              "(可选)指定推送用 QQBot connector,对应 config.toml [channels.qqbots] 的 key(如 main/chat)。不填自动从 session 推断",
          },
          model: {
            type: "string",
            description:
              '(可选)运行模型,格式 "provider/model-id",如 "copilot/claude-sonnet-4.6"。不填用 daily 后端',
          },
          steps: {
            type: "array",
            description:
              "【Pipeline 模式】串行步骤: {type:'tool',name,args}=直接调工具不走 LLM; {type:'msg',content}=注入消息触发 LLM。最后 msg 的 LLM 输出为推送内容;无 msg 则取最后 tool 输出。模板见 skill cron-creator",
            items: {
              type: "object",
              description:
                "Pipeline 步骤:{ type: 'tool', name, args } 或 { type: 'msg', content }",
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
        ? (args["timeRange"] as { start: string; end: string; weekdays?: number[] })
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
      mfaExempt: true, // agent 调用本身已经过 MFA，默认豁免
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
          ? `每 ${job.intervalSecs}s${job.timeRange ? ` [时段 ${job.timeRange.start}-${job.timeRange.end}${job.timeRange.weekdays && job.timeRange.weekdays.length > 0 ? ` 周${job.timeRange.weekdays.join("/")}` : ""}]` : ""}`
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
      description: "列出 cron jobs(含调度/状态/结果摘要/下次触发时间),includeLogs 可附加最近 3 条日志",
      parameters: {
        type: "object",
        properties: {
          includeLogs: {
            type: "boolean",
            description: "附加最近 3 条日志(默认 false)",
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
            ? `每 ${j.intervalSecs}s${j.timeRange ? ` [时段 ${j.timeRange.start}-${j.timeRange.end}]` : ""}`
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
      description: "删除指定 id 的 cron job。",
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
      description: "启用指定 id 的 cron job。",
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
      description: "停用指定 id 的 cron job。",
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
        "立即触发一次指定 cron job（不影响其定时计划）。执行结果会按 job 的 notify 策略决定是否推送。",
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
