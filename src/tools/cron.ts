/**
 * Agent 工具：cron_add / cron_list / cron_remove / cron_enable / cron_disable
 *
 * 这些工具在 agent session 中调用时，output.sessionId 会从 ToolContext.sessionId
 * 自动注入，确保 cron job 的结果推送回调用它的那个 QQ 对话。
 */

import { registerTool, type ToolContext } from "./registry.js";
import { addJob, removeJob, loadJobs, updateJob, getJob } from "../cron/store.js";
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

// ── cron_add ──────────────────────────────────────────────────────────────────

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "cron_add",
      description: "创建定时任务。output.sessionId 自动绑定当前对话，运行结果会推送到本对话。",
      parameters: {
        type: "object",
        properties: {
          message:       { type: "string",  description: "触发时传给 agent 的指令（prompt）" },
          type:          { type: "string",  enum: ["once", "every", "daily"], description: "调度类型" },
          runAt:         { type: "string",  description: "[once] ISO 8601 触发时间" },
          intervalSecs:  { type: "number",  description: "[every] 间隔秒数" },
          timeOfDay:     { type: "string",  description: "[daily] 触发时间，格式 HH:MM（本地时间）" },
          agentId:       { type: "string",  description: "使用的 agent（默认 default）" },
          notify:        { type: "string",  enum: ["always","on_change","on_error","never"], description: "通知策略（默认 always）" },
          stateful:      { type: "boolean", description: "是否保留跨 run 对话历史（默认 false）" },
          peerId:        { type: "string",  description: "推送目标的 QQ peerId（不填则仅写 log）" },
          msgType:       { type: "string",  enum: ["c2c","group","guild","dm"], description: "消息类型（默认 c2c）" },
        },
        required: ["message", "type"],
      },
    },
  },
  execute: async (args: Record<string, unknown>, ctx?: ToolContext) => {
    const message = String(args["message"] ?? "").trim();
    const type = args["type"] as "once" | "every" | "daily";
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
      agentId: String(args["agentId"] ?? "default"),
      message,
      type,
      runAt: args["runAt"] ? String(args["runAt"]) : undefined,
      intervalSecs: args["intervalSecs"] ? Number(args["intervalSecs"]) : undefined,
      timeOfDay: args["timeOfDay"] ? String(args["timeOfDay"]) : undefined,
      output: {
        sessionId,
        peerId,
        msgType,
        notify: (args["notify"] as "always" | "on_change" | "on_error" | "never") ?? "always",
      },
      stateful: Boolean(args["stateful"] ?? false),
      mfaExempt: true, // agent 调用本身已经过 MFA，默认豁免
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
      description: "列出所有 cron jobs，返回 JSON 字符串。",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  execute: async () => {
    const jobs = loadJobs();
    if (jobs.length === 0) return "暂无 cron jobs";
    return JSON.stringify(
      jobs.map((j) => ({
        id: j.id,
        enabled: j.enabled,
        type: j.type,
        schedule: j.type === "once" ? j.runAt : j.type === "every" ? `每 ${j.intervalSecs}s` : `每天 ${j.timeOfDay}`,
        message: j.message.slice(0, 60),
        lastRunAt: j.lastRunAt,
        lastRunStatus: j.lastRunStatus,
        output: j.output,
      })),
      null, 2
    );
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
