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
        "列举对当前 Agent 可见的所有活跃 session（经 access.toml 双向权限过滤）。\n\n" +
        "返回 JSON 数组，每项包含：\n" +
        "- sessionId：会话标识符\n" +
        "- agentId：绑定的 Agent ID\n" +
        "- running：当前是否正在执行任务\n" +
        "- isLoop：是否为 loop session（有定时任务配置）\n\n" +
        "权限说明：需要在 access.toml 中配置 can_access（发送方）和 allow_from（接收方）双向授权。",
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
        "向指定 session 注入一条消息，触发该 session 的 Agent 处理任务。\n\n" +
        "工作流程：\n" +
        "1. 检查 access.toml 双向权限\n" +
        "2. 若目标 session 正在运行，等待当前任务完成\n" +
        "3. 注入消息，走完整 runAgent 路径\n\n" +
        "适用场景：loop session 向普通 session 汇报结果、Master Agent 分派任务给专用 Agent 等。\n\n" +
        "权限说明：需要在 access.toml 中配置 can_access（发送方）和 allow_from（接收方）双向授权。\n" +
        "可用 session_get 工具查看有权访问的 session 列表。",
      parameters: {
        type: "object",
        properties: {
          target_session_id: {
            type: "string",
            description:
              "目标 session 的 ID（可通过 session_get 获取可用列表）",
          },
          message: {
            type: "string",
            description: "要注入的消息内容",
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
    return ctx.sessionSendFn(targetSessionId, message, fromAgentId);
  },
});
