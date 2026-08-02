/**
 * Agent 工具：cron_add / cron_list / cron_remove / cron_enable / cron_disable / cron_run
 *
 * 这些工具在 agent session 中调用时，output.sessionId 会从 ToolContext.sessionId
 * 自动注入，确保 cron job 的结果推送回调用它的那个 QQ 对话。
 */

import { registerTool, type ToolContext } from "./registry.js";
import { addJob, removeJob, loadJobs, updateJob, getJob, readLogs } from "../cron/store.js";
import { cronScheduler } from "../cron/scheduler.js";

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

## 运行模式
- **Pipeline 模式(steps,推荐)**:纯工具步骤,不调用 LLM,零配额消耗。适合定期脚本/监控/固定通知
- **Message 模式(message)**:调用 LLM,消耗配额。适合语义推理/总结类任务,创建前必须明确告知用户并获得确认

## 创建前必须确认(不得跳过)
1. 任务意图与执行流程(做什么、操作对象、数据来源/关键步骤)
2. 调度时间(具体时间点/间隔/一次性)
3. 是否需要推送到 QQ(若是,推送给谁)
4. 通知策略(每次/仅变化/仅出错/不推送)
5. 输出要求(内容与格式)
6. 是否需要 LLM 推理(若否用 Pipeline 模式;若是需用户确认)

用户描述模糊(如"设置个天气提醒")时须追问细节后再创建。

## message 指令四要素(Message 模式)
① 意图:做什么、操作对象 ② 执行流程:数据来源/关键步骤(如"用 exec_shell 执行 curl wttr.in/Shanghai") ③ 约束:失败时输出"数据获取失败:原因",禁止编造数值 ④ 输出要求:输出什么、什么格式
示例:'查询上海实时天气,用 exec_shell 执行 curl wttr.in/Shanghai?format=j1,提取温度和天气描述,失败则输出"数据获取失败",最终中文输出:城市/温度/天气/穿衣建议'`,
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "任务短名称/描述(可选),用于列表与日志展示;不填则用 message 截断",
          },
          message: {
            type: "string",
            description:
              "发给 cron agent 的自然语言任务指令。cron agent 拥有完整工具调用能力，支持语义理解，无需手写 shell 命令。指令须包含以下四个要素：\n① 意图：做什么、操作对象是什么（例：查上海实时天气）\n② 执行流程：数据来源 / 关键步骤（例：用 exec_shell 调用 curl wttr.in/Shanghai 获取 JSON）\n③ 约束：异常处理方式、数据必须实时获取而非凭知识编造（例：curl 失败时报错而非捏造数值）\n④ 输出要求：输出什么内容、用什么格式；若不需要输出则明确说明（例：中文输出\"城市/温度/天气/穿衣建议\"）\n\n示例（好）：'查询上海实时天气，用 exec_shell 执行 curl wttr.in/Shanghai?format=j1，提取温度和天气描述，若 curl 失败则输出\"数据获取失败\"，最终中文输出：城市/温度/天气/穿衣建议'\n示例（坏）：'查询天气'——缺少城市、数据来源、输出格式，cron agent 无法可靠执行",
          },
          type: {
            type: "string",
            enum: ["once", "every", "daily", "manual"],
            description: "调度类型（once/every/daily/manual）",
          },
          runAt: { type: "string", description: "[once] ISO 8601 触发时间" },
          intervalSecs: { type: "number", description: "[every] 间隔秒数" },
          timeOfDay: {
            type: "string",
            description: "[daily] 单个触发时间,格式 HH:MM(本地时间);多时段请用 timesOfDay",
          },
          timesOfDay: {
            type: "array",
            items: { type: "string" },
            description:
              '[daily] 多个触发时间点,格式 ["HH:MM", ...],优先于 timeOfDay。例:["09:00","12:00","20:00"]',
          },
          timeRange: {
            type: "object",
            description:
              '[every] 限制触发时段；格式 {start:"HH:MM", end:"HH:MM", weekdays?:[0-6]}，0=周日...6=周六，不填=每天。段外跳过不触发',
          },
          agentId: {
            type: "string",
            description:
              "使用的 agent（默认 default）。注意：在交互式会话中，实际使用的 agentId 由调用方 agent 决定，此参数仅在 CLI 等无 agent 上下文的场景下生效。",
          },
          notify: {
            type: "string",
            enum: ["always", "on_change", "on_error", "never", "llm"],
            description: "通知策略（默认 always）。llm=由LLM决定，输出含[NOTIFY]块时才推送",
          },
          stateful: { type: "boolean", description: "是否保留跨 run 对话历史（默认 false）" },
          peerId: { type: "string", description: "推送目标的 QQ peerId（不填则仅写 log）" },
          msgType: {
            type: "string",
            enum: ["c2c", "group", "guild", "dm"],
            description: "消息类型（默认 c2c）",
          },
          botId: {
            type: "string",
            description:
              "(可选)指定使用哪个 QQBot connector。对应 config.toml [channels.qqbots] 中的 key(如 \"main\"/\"chat\")。多 QQBot 部署时用于指定由哪个 Bot 推送定时结果。不填则自动从当前调用 session 推断。",
          },
          model: {
            type: "string",
            description:
              '（可选）运行此 job 使用的模型，格式 "provider/model-id"，如 "copilot/claude-sonnet-4.6"。不填则使用 daily 后端。',
          },
          steps: {
            type: "array",
            description:
              "【Pipeline 模式】多步骤流水线列表。提供此字段时，job 以 Pipeline 模式运行（忽略 message 字段的 prompt 用途，仅作描述）。所有步骤共享同一个 stateful session，前步的工具输出对后续 LLM 步骤完全可见。步骤按顺序串行执行：\n- { type: 'tool', name: '工具名', args: {...} }：直接调用工具，不走 LLM，输出注入 session 上下文\n- { type: 'msg', content: '...' }：向 session 注入 user 消息，触发 LLM 生成回复\n最后一个 msg step 的 LLM 输出作为最终推送内容；若无 msg step，则取最后一个 tool step 的输出。",
            items: {
              type: "object",
              description:
                "Pipeline 步骤：{ type: 'tool', name, args } 或 { type: 'msg', content }",
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
    return `✓ 已创建 cron job: ${job.id}（类型: ${job.type}，绑定 session: ${sessionId ?? "无"}）`;
  },
});

// ── cron_list ─────────────────────────────────────────────────────────────────

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "cron_list",
      description: "列出所有 cron jobs(含调度/状态/最近结果摘要/下次触发时间)。可选 includeLogs=true 附加每个 job 最近 3 条运行日志。",
      parameters: {
        type: "object",
        properties: {
          includeLogs: {
            type: "boolean",
            description: "是否附加每个 job 最近 3 条运行日志(默认 false)",
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
