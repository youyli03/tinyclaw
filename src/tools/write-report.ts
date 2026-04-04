/**
 * write_report tool — AI 将日报写入本地文件
 *
 * 存储路径: ~/.tinyclaw/reports/<type>/<date>.md
 * 支持多种日报类型（stock / weather / daily / 自定义）
 */

import { registerTool } from "./registry.js";
import { writeReport } from "../web/backend/reports.js";

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "write_report",
      description:
        "将一篇日报（Markdown 格式）写入本地文件，供 Dashboard 日报页展示。\n\n" +
        "type 为日报类型标签，建议值：\n" +
        "  stock   — 股市日报\n" +
        "  weather — 天气日报\n" +
        "  daily   — 每日摘要\n" +
        "  news    — 新闻摘要\n" +
        "  custom  — 自定义\n\n" +
        "date 格式 YYYY-MM-DD，不填则写入今天。同一 type+date 重复写入会覆盖。",
      parameters: {
        type: "object",
        properties: {
          type: {
            type: "string",
            description: "日报类型标签（如 stock、weather、daily）",
          },
          content: {
            type: "string",
            description: "日报正文，Markdown 格式",
          },
          title: {
            type: "string",
            description: "日报标题（可选），若内容开头没有 # 标题则自动前置",
          },
          date: {
            type: "string",
            description: "日期（YYYY-MM-DD，可选，默认今天）",
          },
        },
        required: ["type", "content"],
      },
    },
  },
  execute: async (args: Record<string, unknown>) => {
    const type    = String(args["type"] ?? "");
    const content = String(args["content"] ?? "");
    const title   = args["title"] ? String(args["title"]) : undefined;
    const date    = args["date"]  ? String(args["date"])  : undefined;

    if (!type)    return JSON.stringify({ error: "type 不能为空" });
    if (!content) return JSON.stringify({ error: "content 不能为空" });

    try {
      const opts: Parameters<typeof writeReport>[0] = { type, content };
      if (title) opts.title = title;
      if (date)  opts.date  = date;
      const file = writeReport(opts);
      return JSON.stringify({ success: true, file });
    } catch (e) {
      return JSON.stringify({ error: String(e) });
    }
  },
});
