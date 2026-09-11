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
        "Use this when the request is ambiguous, several reasonable directions exist, or the " +
        "user must decide. Offers 2-5 preset options (with a recommended flag) and still allows " +
        "free-form input. Works in both Chat and Code mode. Do not use it to ask about anything " +
        "you can confirm yourself by reading files or running commands.",
      parameters: {
        type: "object" as const,
        properties: {
          question: {
            type: "string",
            description: "Question text shown to the user, short and unambiguous.",
          },
          options: {
            type: "array",
            description:
              "Preset option list (optional, 2-5 items recommended). Each item has a label, an " +
              "optional description, and a recommended flag.",
            items: {
              type: "object",
              properties: {
                label: {
                  type: "string",
                  description: "Option label, short and clear (e.g. edit the existing file).",
                },
                description: {
                  type: "string",
                  description: "Extra explanation for the option (optional, e.g. keep a backup).",
                },
                recommended: {
                  type: "boolean",
                  description: "Whether this is the recommended option. Default false.",
                },
              },
              required: ["label"],
            },
          },
          allow_freeform: {
            type: "boolean",
            description:
              "Whether to allow free-form user input (default true). When false, the user can " +
              "only pick one of the preset options.",
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
        ...(result.imagePaths && result.imagePaths.length > 0
          ? { image_paths: result.imagePaths }
          : {}),
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
