/**
 * session-bridge 工具集 — 跨 Session 通信
 *
 * 提供两个工具：
 * - session_get   列举对当前 Agent 可见的所有 session（经 access.toml 过滤）
 * - session_send  向指定 session 注入一条消息（等待目标 session 空闲后走完整 runAgent 路径）
 *
 * 权限模型：双向 allow-list（~/.tinyclaw/agents/<agentId>/access.toml），默认 deny。
 */

import { registerTool, type ToolContext } from "./registry.js";

// ── session_get ───────────────────────────────────────────────────────────────

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "session_get",
      description:
        "List all active sessions visible to the current Agent (filtered by bidirectional " +
        "access.toml permissions).\n\n" +
        "Returns a JSON array; each item contains:\n" +
        "- sessionId: session identifier\n" +
        "- agentId: the bound Agent ID\n" +
        "- running: whether a task is currently executing\n" +
        "- isLoop: whether it is a loop session (has a scheduled task config)\n" +
        "- recentActivity: the latest 10 operations (newest first); each has ts " +
        "(timestamp) and event (tool_call/tool_result/error)\n\n" +
        "Permissions: requires can_access (sender) and allow_from (receiver) configured in " +
        "access.toml (bidirectional).",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  execute: async (_args: Record<string, unknown>, ctx?: ToolContext): Promise<string> => {
    if (!ctx?.sessionGetFn) {
      return "错误：session_get 仅在完整服务模式下可用（CLI/cron 模式不支持跨 session 通信）";
    }
    const fromAgentId = ctx.agentId ?? "default";
    const sessions = await ctx.sessionGetFn(fromAgentId);
    if (sessions.length === 0) {
      return "当前没有对此 Agent 可见的 session（请检查 access.toml 双向权限配置）";
    }
    return JSON.stringify(sessions, null, 2);
  },
});

// ── session_send ──────────────────────────────────────────────────────────────

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "session_send",
      description:
        "Inject a message into the given session, triggering that session's Agent " +
        "to handle the task.\n\n" +
        "Workflow:\n" +
        "1. Check the bidirectional access.toml permissions\n" +
        "2. If the target session is running, wait for its current task to finish\n" +
        "3. Inject the message and run the full runAgent path\n\n" +
        "Use cases: a loop session reporting results to a normal session, a Master Agent " +
        "dispatching tasks to a dedicated Agent, and so on.\n\n" +
        "Permissions: requires can_access (sender) and allow_from (receiver) configured in " +
        "access.toml (bidirectional).\n" +
        "Use the session_get tool to see the sessions you may access.",
      parameters: {
        type: "object",
        properties: {
          target_session_id: {
            type: "string",
            description: "ID of the target session (use session_get to list the available ones)",
          },
          message: {
            type: "string",
            description: "Message content to inject",
          },
        },
        required: ["target_session_id", "message"],
      },
    },
  },
  execute: async (args: Record<string, unknown>, ctx?: ToolContext): Promise<string> => {
    const targetSessionId = String(args["target_session_id"] ?? "").trim();
    const message = String(args["message"] ?? "").trim();

    if (!targetSessionId) return "错误：缺少 target_session_id 参数";
    if (!message) return "错误：缺少 message 参数";

    if (!ctx?.sessionSendFn) {
      return "错误：session_send 仅在完整服务模式下可用（CLI/cron 模式不支持跨 session 通信）";
    }

    const fromAgentId = ctx.agentId ?? "default";
    return ctx.sessionSendFn(
      targetSessionId,
      message,
      fromAgentId,
      ...(ctx.sessionId ? [ctx.sessionId] : [])
    );
  },
});
