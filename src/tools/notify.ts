/**
 * notify_user 工具 — Agent 主动向用户推送消息
 *
 * 不等当前任务结束，立即将消息发送给用户。
 * 适用于长任务中途汇报发现、进度片段或需要提前告知的信息。
 */

import { registerTool, type ToolContext } from "./registry.js";

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "notify_user",
      description:
        "Send the user a message immediately, without waiting for the current task to finish. " +
        "Use it for mid-task findings, progress snippets, or info the user should know early. " +
        "The current task keeps running after the call; later tool calls are unaffected.",
      parameters: {
        type: "object",
        properties: {
          message: {
            type: "string",
            description: "Message content to send to the user",
          },
        },
        required: ["message"],
      },
    },
  },
  execute: async (args: Record<string, unknown>, ctx?: ToolContext): Promise<string> => {
    const message = String(args["message"] ?? "").trim();
    if (!message) return "错误：缺少 message 参数";

    if (ctx?.onNotify) {
      await ctx.onNotify(message);
    } else {
      // CLI 模式兜底：打印到 stdout
      console.log(`[notify_user] ${message}`);
    }

    return "通知已发送";
  },
});
