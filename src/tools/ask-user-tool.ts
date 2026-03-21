/**
 * ask_user 工具
 *
 * AI 遇到需求模糊、有多个合理方向、或需要用户做决策时调用此工具。
 * 支持提供若干预设选项（含推荐标记），同时允许用户自由输入。
 *
 * 用途示例：
 *   - 澄清需求（"你想改哪个配置文件？"）
 *   - 选择后续方向（"接下来做 A 还是 B？"）
 *   - 多选操作菜单（在 Plan 分析阶段遇到分支时询问）
 *
 * 参数：
 *   question       — 必填，问题描述（展示给用户的问题文本）
 *   options?       — 可选，预设选项列表；每项含 label / description? / recommended?
 *   allow_freeform? — 是否允许用户自由输入（默认 true）
 *
 * 返回给 AI 的 JSON：
 *   { answer: string, is_freeform: boolean, skipped?: boolean }
 *   - answer：用户选择的 label 或用户自由输入的文本
 *   - is_freeform：true 表示用户自由输入，false 表示选择了预设选项
 *   - skipped：true 表示用户跳过（无 onAskUser 注入时，如 CLI/cron 模式）
 */

import { registerTool, type ToolContext } from "./registry.js";

export interface AskUserOption {
  label: string;
  description?: string;
  recommended?: boolean;
}

registerTool({
  spec: {
    type: "function",
    function: {
      name: "ask_user",
      description:
        "遇到需求模糊、存在多个合理方向、或需要用户决策时调用此工具向用户提问。" +
        "可提供 2～5 个预设选项（含推荐标记），同时允许用户自由输入。" +
        "Chat 和 Code 模式下均可使用。不要用此工具询问可以通过读取文件/执行命令自行确认的事项。",
      parameters: {
        type: "object" as const,
        properties: {
          question: {
            type: "string",
            description: "展示给用户的问题文本，简洁明确。",
          },
          options: {
            type: "array",
            description: "预设选项列表（可选，建议 2～5 项）。每项包含 label、可选的 description 和 recommended 标记。",
            items: {
              type: "object",
              properties: {
                label: {
                  type: "string",
                description: "选项标签，简短明确（例：直接修改现有文件）。",
                },
                description: {
                  type: "string",
                description: "选项补充说明（可选，例：保留旧文件备份）。",
                },
                recommended: {
                  type: "boolean",
                  description: "是否为推荐选项，默认 false。",
                },
              },
              required: ["label"],
            },
          },
          allow_freeform: {
            type: "boolean",
            description: "是否允许用户自由输入（默认 true）。设为 false 时用户只能选预设选项。",
          },
        },
        required: ["question"],
      },
    },
  },
  requiresMFA: false,
  execute: async (args: Record<string, unknown>, ctx?: ToolContext): Promise<string> => {
    const question = String(args["question"] ?? "");
    const rawOptions = args["options"];
    const options: AskUserOption[] = Array.isArray(rawOptions)
      ? (rawOptions as AskUserOption[]).filter((o) => o && typeof o.label === "string")
      : [];
    const allowFreeform = args["allow_freeform"] !== false; // 默认 true

    // 无 onAskUser 注入（CLI / cron / 非交互模式）→ 跳过
    if (!ctx?.onAskUser) {
      return JSON.stringify({ answer: "", is_freeform: false, skipped: true });
    }

    try {
      const result = await ctx.onAskUser(question, options, allowFreeform);
      return JSON.stringify({
        answer: result.answer,
        is_freeform: result.isFreeform,
      });
    } catch (err) {
      return JSON.stringify({
        answer: "",
        is_freeform: false,
        skipped: true,
        error: err instanceof Error ? err.message : "用户未响应或操作被中断",
      });
    }
  },
});
