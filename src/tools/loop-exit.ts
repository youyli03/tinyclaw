/**
 * loop_exit 工具 — 允许 AI 主动退出当前 loop 时间窗口
 *
 * 仅在 loop trigger 的 allowExit=true 时通过 customTools 注入到 LLM。
 * execute 调用 ctx.onLoopExit(),由 loop-trigger 设置退出标志。
 */

import { registerTool, type ToolContext } from "./registry.js";

registerTool({
  requiresMFA: false,
  hidden: true,
  spec: {
    type: "function",
    function: {
      name: "loop_exit",
      description:
        "Exit the current loop monitoring window. After calling it, no more ticks run in this " +
        "time window; monitoring restarts at the next window. Call it only when the task is " +
        "clearly done or the user asks to stop.",
      parameters: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description: "Reason for exiting (short explanation)",
          },
        },
        required: [],
      },
    },
  },
  execute: async (args: Record<string, unknown>, ctx?: ToolContext): Promise<string> => {
    if (!ctx?.onLoopExit) {
      return "错误：当前 loop 不允许 AI 自主退出（allowExit=false）";
    }
    const reason = String(args["reason"] ?? "").trim();
    ctx.onLoopExit();
    return `已退出本次监控窗口${reason ? `（${reason}）` : ""}，下一个时间窗口自动重置。`;
  },
});
