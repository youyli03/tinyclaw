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
        "立即向用户发送一条通知消息，不等当前任务结束。" +
        "适用于长任务中途汇报发现、进度片段或需要提前告知的信息。" +
        "调用后继续执行当前任务，不影响后续工具调用。",
      parameters: {
        type: "object",
        properties: {
          message: {
            type: "string",
            description: "要发送给用户的消息内容",
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
