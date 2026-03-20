/**
 * exit_plan_mode 工具
 *
 * Plan 子模式下，AI 完成分析后调用此工具展示计划摘要，
 * 暂停执行并等待用户确认后再开始修改代码。
 *
 * 参数：
 *   summary          — 计划摘要（必填，展示给用户）
 *   planPath?        — 已写入的详细计划文件路径（可选）
 *   actions?         — 可选操作列表，默认 ["autopilot", "interactive", "exit_only"]
 *   recommendedAction? — 推荐选项，默认 "autopilot"
 *
 * 返回给 AI 的 JSON：
 *   { approved: boolean, selectedAction?: string, feedback?: string }
 */

import { registerTool, type ToolContext } from "../tools/registry.js";

const DEFAULT_ACTIONS = ["autopilot", "interactive", "exit_only"];
const DEFAULT_RECOMMENDED = "autopilot";

registerTool({
  spec: {
    type: "function",
    function: {
      name: "exit_plan_mode",
      description:
        "规划阶段完成后调用。向用户展示计划摘要，暂停执行并等待用户选择操作（批准 / 修改反馈）。" +
        "plan 子模式下必须先调用此工具获得批准，再修改任何源代码文件。" +
        "auto 子模式下无需调用此工具，直接执行任务即可。",
      parameters: {
        type: "object" as const,
        properties: {
          summary: {
            type: "string",
            description: "计划摘要，清晰列出要修改/创建的文件、每处修改内容和预期效果。展示给用户。",
          },
          planPath: {
            type: "string",
            description: "已写入的详细计划文件路径（可选，如 PLAN.md）。展示给用户供参阅。",
          },
          actions: {
            type: "array",
            items: { type: "string" },
            description:
              '展示给用户的操作列表，默认 ["autopilot", "interactive", "exit_only"]。' +
              '"exit_only" 通常作为最后一项，表示取消执行。',
          },
          recommendedAction: {
            type: "string",
            description: '推荐操作，默认 "autopilot"。在用户界面中会被标注为推荐。',
          },
        },
        required: ["summary"],
      },
    },
  },
  requiresMFA: false,
  execute: async (args: Record<string, unknown>, ctx?: ToolContext): Promise<string> => {
    const summary = String(args["summary"] ?? "");
    const planPath = args["planPath"] ? String(args["planPath"]) : undefined;
    const actions = Array.isArray(args["actions"])
      ? (args["actions"] as string[])
      : DEFAULT_ACTIONS;
    const recommendedAction = args["recommendedAction"]
      ? String(args["recommendedAction"])
      : DEFAULT_RECOMMENDED;

    // 非 plan 子模式 / onPlanRequest 未注入时，自动批准（auto 模式或 CLI 模式）
    if (!ctx?.onPlanRequest) {
      return JSON.stringify({ approved: true, selectedAction: recommendedAction });
    }

    try {
      const result = await ctx.onPlanRequest(summary, actions, recommendedAction, planPath);
      return JSON.stringify(result);
    } catch (err) {
      // 超时或中断
      return JSON.stringify({
        approved: false,
        feedback: err instanceof Error ? err.message : "操作超时或被中断",
      });
    }
  },
});
