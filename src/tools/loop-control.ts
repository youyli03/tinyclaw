/**
 * loop_control 工具 — 允许 chat agent 直接管理 loop 状态
 *
 * 支持三个操作:
 * - pause:  暂停指定 loop(跳过 tick,但循环继续)
 * - resume: 恢复指定 loop
 * - exit:   退出当前时间窗口(等同于 loop_exit,下个窗口自动重置)
 *
 * chat 模式下始终可用;loop 模式下 exit 操作会额外触发 onLoopExit 回调。
 */

import { registerTool, type ToolContext } from "./registry.js";
import { loopTriggerManager } from "../core/loop-trigger.js";
import { loopRunner } from "../core/loop-runner.js";

registerTool({
  requiresMFA: false,
  hidden: false,
  spec: {
    type: "function",
    function: {
      name: "loop_control",
      description:
        "Manage the running state of a Loop trigger. " +
        'Call this tool when the user says things like "stop watching", "pause", ' +
        '"no need to keep an eye on it", or "exit the loop". ' +
        "action=pause pauses the ticks; action=resume resumes; action=exit exits the current " +
        "time window (the next window resets automatically). " +
        'When id is omitted, it defaults to the loop named "monitor".',
      parameters: {
        type: "object",
        properties: {
          action: {
            type: "string",
            enum: ["pause", "resume", "exit"],
            description:
              "Action type: pause = pause / resume = resume / exit = exit this time window",
          },
          id: {
            type: "string",
            description: 'Loop ID (id field in ~/.tinyclaw/loops/<id>.json), default "monitor"',
          },
          reason: {
            type: "string",
            description: "Reason for the action (optional, used for logging)",
          },
        },
        required: ["action"],
      },
    },
  },
  execute: async (args: Record<string, unknown>, ctx?: ToolContext): Promise<string> => {
    const action = String(args["action"] ?? "").trim() as "pause" | "resume" | "exit";
    const id = String(args["id"] ?? "monitor").trim();
    const reason = String(args["reason"] ?? "").trim();

    if (action === "exit") {
      // exit：通过 onLoopExit 回调退出当前窗口（loop trigger 内调用时有效）
      if (ctx?.onLoopExit) {
        ctx.onLoopExit();
        return `已退出 loop「${id}」本次时间窗口${reason ? `（${reason}）` : ""}，下一个时间窗口自动重置。`;
      }
      // 若在 chat 模式直接调用（无 onLoopExit），则等价于 pause
      const ok1 = loopTriggerManager.pause(id);
      const ok2 = loopRunner.pause(id);
      if (!ok1 && !ok2) return `❌ 未找到 loop「${id}」，请用 /loop list 查看可用 ID。`;
      return `⏸️ Loop「${id}」已暂停（chat 模式下 exit 等价于 pause，下次用 /loop resume ${id} 恢复）。${reason ? `\n原因：${reason}` : ""}`;
    }

    if (action === "pause") {
      const ok1 = loopTriggerManager.pause(id);
      const ok2 = loopRunner.pause(id);
      if (!ok1 && !ok2) return `❌ 未找到 loop「${id}」，请用 /loop list 查看可用 ID。`;
      return `⏸️ Loop「${id}」已暂停。${reason ? `\n原因：${reason}` : ""}`;
    }

    if (action === "resume") {
      const ok1 = loopTriggerManager.resume(id);
      const ok2 = loopRunner.resume(id);
      if (!ok1 && !ok2) return `❌ 未找到 loop「${id}」，请用 /loop list 查看可用 ID。`;
      return `▶️ Loop「${id}」已恢复。${reason ? `\n原因：${reason}` : ""}`;
    }

    return `❌ 未知操作「${action}」，支持：pause / resume / exit`;
  },
});
