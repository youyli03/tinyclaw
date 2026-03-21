/**
 * ask_master 工具 — daily subagent 向 master（用户）提问
 *
 * 此工具注册为 hidden=true，不出现在 getAllToolSpecs() 的默认列表中。
 * 通过 AgentRunOptions.customTools 显式注入给 daily subagent。
 *
 * 工作流：
 * 1. daily subagent 调用此工具，传入问题 + 背景 + 可选计划文件路径
 * 2. 若有 plan_path，读取并用 mdToImage 渲染为图片，拼入消息
 * 3. 通过 ctx.onNotify 推送消息给用户
 * 4. 同步阻塞：在 masterSession.pendingSlaveQuestion 上等待用户回复
 * 5. main.ts 收到用户消息后调用 resolve()，工具返回用户的回复
 */

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { registerTool, type ToolContext } from "./registry.js";
import { mdToImage } from "../connectors/utils/md-to-image.js";
import { agentManager } from "../core/agent-manager.js";

registerTool({
  requiresMFA: false,
  hidden: true,
  spec: {
    type: "function",
    function: {
      name: "ask_master",
      description:
        "向用户（通过 Master Agent）提问，同步等待用户回复。\n\n" +
        "**使用场景**：遇到模糊需求、技术选型、架构决策、无法自主判断的问题时调用。\n" +
        "**禁止假设**：不要假设用户技术水平或偏好，有疑问一定要问。\n\n" +
        "若有当前计划文件（plan.md），传入 plan_path 参数，系统会自动将其渲染为图片发给用户。",
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "向用户提出的具体问题（清晰、可直接回答的形式）",
          },
          context: {
            type: "string",
            description: "问题的背景信息（当前任务状态、已做了什么、遇到了什么不确定点）",
          },
          plan_path: {
            type: "string",
            description: "（可选）当前计划文件的绝对路径（plan.md），系统自动渲染为图片发送",
          },
        },
        required: ["question", "context"],
      },
    },
  },
  execute: async (args: Record<string, unknown>, ctx?: ToolContext): Promise<string> => {
    const question = String(args["question"] ?? "").trim();
    const context = String(args["context"] ?? "").trim();
    const planPath = args["plan_path"] ? String(args["plan_path"]).trim() : undefined;

    if (!question) return "错误：缺少 question 参数";

    if (!ctx?.onAskMaster) {
      return "⚠️ ask_master 只能在 code_assist 创建的 daily subagent 中调用（onAskMaster 未注入）";
    }

    return ctx.onAskMaster(question, context, planPath);
  },
});

/**
 * 实现 onAskMaster 回调工厂函数。
 * 由 code_assist 调用，返回的回调注入到 daily subagent 的 AgentRunOptions.onAskMaster。
 *
 * @param masterSession  master 的 Session 对象
 * @param onNotify       main.ts 注入的用户消息推送函数
 * @param agentId        agent ID（用于确定图片输出目录）
 */
export function createAskMasterCallback(
  masterSession: import("../core/session.js").Session,
  onNotify: (message: string) => Promise<void>,
  agentId: string,
): (question: string, context: string, planPath?: string) => Promise<string> {
  return async (question: string, context: string, planPath?: string): Promise<string> => {
    // 构建消息文本
    const lines: string[] = [
      "❓ **子 Agent 需要你的指导**",
      "",
      `**背景**：${context}`,
      "",
      `**问题**：${question}`,
    ];

    // 若有计划文件，尝试渲染为图片
    if (planPath && existsSync(planPath)) {
      try {
        const mdText = readFileSync(planPath, "utf-8");
        const outDir = join(homedir(), ".tinyclaw", "agents", agentId, "workspace", "output", "plans");
        const imgPath = await mdToImage(mdText, outDir);
        lines.push("", `📄 **当前计划**：<img src="${imgPath}"/>`);
      } catch (err) {
        // 渲染失败，降级为内嵌文本
        try {
          const mdText = readFileSync(planPath, "utf-8");
          lines.push("", "📄 **当前计划**（渲染失败，以文本展示）：", "```", mdText.slice(0, 2000), "```");
        } catch {
          // 文件读取也失败，忽略
        }
        console.warn(`[ask_master] 计划文件渲染失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }

    lines.push("", "---", "请直接回复你的答案，系统将自动转发给子 Agent 继续执行。");

    await onNotify(lines.join("\n"));

    // 阻塞等待用户通过 main.ts 回复
    return new Promise<string>((resolve) => {
      masterSession.pendingSlaveQuestion = { question, resolve };
    });
  };
}
