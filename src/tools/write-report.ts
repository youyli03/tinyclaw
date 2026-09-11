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
        "Write a report (Markdown) to a local file for the Dashboard reports page.\n\n" +
        "type is the report type tag; suggested values:\n" +
        "  stock   - stock market report\n" +
        "  weather - weather report\n" +
        "  daily   - daily summary\n" +
        "  news    - news summary\n" +
        "  custom  - custom\n\n" +
        "date format is YYYY-MM-DD; when omitted it writes to today. Writing the same type+date " +
        "again overwrites the existing file.",
      parameters: {
        type: "object",
        properties: {
          type: {
            type: "string",
            description: "Report type tag (e.g. stock, weather, daily)",
          },
          content: {
            type: "string",
            description: "Report body in Markdown",
          },
          title: {
            type: "string",
            description: "Report title (optional), prepended when there is no leading # heading",
          },
          date: {
            type: "string",
            description: "Date (YYYY-MM-DD, optional, defaults to today)",
          },
        },
        required: ["type", "content"],
      },
    },
  },
  execute: async (args: Record<string, unknown>) => {
    const type = String(args["type"] ?? "");
    const content = String(args["content"] ?? "");
    const title = args["title"] ? String(args["title"]) : undefined;
    const date = args["date"] ? String(args["date"]) : undefined;

    if (!type) return JSON.stringify({ error: "type 不能为空" });
    if (!content) return JSON.stringify({ error: "content 不能为空" });

    try {
      const opts: Parameters<typeof writeReport>[0] = { type, content };
      if (title) opts.title = title;
      if (date) opts.date = date;
      const file = writeReport(opts);
      return JSON.stringify({ success: true, file });
    } catch (e) {
      return JSON.stringify({ error: String(e) });
    }
  },
});
