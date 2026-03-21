/**
 * run_code_subagent 工具 — daily subagent 向 code subagent 发送指令
 *
 * 此工具注册为 hidden=true，不出现在默认工具列表中。
 * 通过 AgentRunOptions.customTools 显式注入给 daily subagent。
 *
 * 工作流：
 * daily subagent 调用此工具，传入明确的代码指令（文件路径 + 目标）。
 * 工具内部调用 ctx.codeRunFn(instruction)，后者是 code_assist 注入的闭包，
 * 实际执行 runAgent(codeSession, instruction, ...)，同步等待结果。
 * code subagent 的 session 跨调用持久化，具备上下文记忆。
 */

import { registerTool, type ToolContext } from "./registry.js";

registerTool({
  requiresMFA: false,
  hidden: true,
  spec: {
    type: "function",
    function: {
      name: "run_code_subagent",
      description:
        "向代码执行子 Agent 发送指令，同步等待执行结果。\n\n" +
        "**使用规范**：\n" +
        "- 每次调用传入一个完整、可独立执行的代码指令\n" +
        "- 指令必须自包含：包含相关文件路径、期望的修改目标、验证方式\n" +
        "- 代码子 Agent 有上下文记忆，可基于上次执行结果继续\n" +
        "- 执行失败时会返回错误信息，你可以调整指令后重试",
      parameters: {
        type: "object",
        properties: {
          instruction: {
            type: "string",
            description:
              "给代码子 Agent 的具体指令，需包含：相关文件路径、具体修改目标、验证方法（如何确认完成）",
          },
        },
        required: ["instruction"],
      },
    },
  },
  execute: async (args: Record<string, unknown>, ctx?: ToolContext): Promise<string> => {
    const instruction = String(args["instruction"] ?? "").trim();
    if (!instruction) return "错误：缺少 instruction 参数";

    if (!ctx?.codeRunFn) {
      return "⚠️ run_code_subagent 只能在 code_assist 创建的 daily subagent 中调用（codeRunFn 未注入）";
    }

    return ctx.codeRunFn(instruction);
  },
});
