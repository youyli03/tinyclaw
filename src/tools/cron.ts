/**
 * Agent 工具：cron_add / cron_list / cron_remove / cron_enable / cron_disable / cron_run
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
      description: `创建定时任务。

⚠️ 调用此工具前，必须先向用户确认以下信息，不得跳过：
1. 任务意图与执行流程（做什么、操作对象、数据来源/关键步骤）
2. 调度时间（具体时间点 / 间隔 / 一次性时间）
3. 是否需要推送到 QQ（若是，推送给谁）
4. 通知策略（每次推送 / 仅变化时 / 仅出错时 / 不推送）
5. 输出要求（输出什么内容、格式；若不需要输出则说明）

只有在用户明确回答了以上关键信息后，才能调用此工具创建任务。
若用户描述模糊（如"帮我设置个天气提醒"），须追问细节后再创建。`,
      parameters: {
        type: "object",
        properties: {
          message:       { type: "string",  description: "发给 cron agent 的自然语言任务指令。cron agent 拥有完整工具调用能力，支持语义理解，无需手写 shell 命令。指令须包含以下四个要素：\n① 意图：做什么、操作对象是什么（例：查上海实时天气）\n② 执行流程：数据来源 / 关键步骤（例：用 exec_shell 调用 curl wttr.in/Shanghai 获取 JSON）\n③ 约束：异常处理方式、数据必须实时获取而非凭知识编造（例：curl 失败时报错而非捏造数值）\n④ 输出要求：输出什么内容、用什么格式；若不需要输出则明确说明（例：中文输出\"城市/温度/天气/穿衣建议\"）\n\n示例（好）：'查询上海实时天气，用 exec_shell 执行 curl wttr.in/Shanghai?format=j1，提取温度和天气描述，若 curl 失败则输出\"数据获取失败\"，最终中文输出：城市/温度/天气/穿衣建议'\n示例（坏）：'查询天气'——缺少城市、数据来源、输出格式，cron agent 无法可靠执行" },
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

// ── cron_run ──────────────────────────────────────────────────────────────────

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "cron_run",
      description: "立即触发一次指定 cron job（不影响其定时计划）。执行结果会按 job 的 notify 策略决定是否推送。",
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
