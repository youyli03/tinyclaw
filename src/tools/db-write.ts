/**
 * db_write tool — AI 主动将业务指标写入 Dashboard 数据库
 *
 * 直接调用 db.ts 的 insertMetric()，不通过 HTTP 接口。
 * 无 MFA，数据量小，写入操作安全。
 *
 * 使用场景：
 *   - AI 采集到电费余额后写入 (category=electric, key=balance)
 *   - AI 统计当日高级请求次数后写入 (category=copilot, key=daily_count)
 *   - 自定义任何业务数值
 */

import { registerTool } from "./registry.js";
import { insertMetric } from "../web/backend/db.js";

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "db_write",
      description:
        "Write one business metric into the Dashboard local database (~/.tinyclaw/dashboard.db). " +
        "Use it to record values that change over time, such as an electricity balance or the " +
        "number of premium requests. Written data shows up as a line or bar chart on the " +
        "Dashboard overview and metrics pages.\n\n" +
        "Category suggestions: electric (electricity), copilot (AI requests), custom (custom)\n" +
        "Key suggestions: balance (remaining balance), daily_count (daily usage), " +
        "total_count (cumulative total)",
      parameters: {
        type: "object",
        properties: {
          category: {
            type: "string",
            description: "Data category, e.g. electric / copilot / custom",
          },
          key: {
            type: "string",
            description: "Metric key name, e.g. balance / daily_count / total_count",
          },
          value: {
            type: "number",
            description: "Metric value",
          },
          note: {
            type: "string",
            description: "Optional note, e.g. top-up reason or data source",
          },
          ts: {
            type: "number",
            description: "Optional timestamp (Unix seconds), defaults to the current time",
          },
        },
        required: ["category", "key", "value"],
      },
    },
  },
  execute: async (args: Record<string, unknown>): Promise<string> => {
    const category = String(args["category"] ?? "").trim();
    const key = String(args["key"] ?? "").trim();
    const value = Number(args["value"]);
    const note = args["note"] ? String(args["note"]) : undefined;
    const ts = args["ts"] ? Number(args["ts"]) : undefined;

    if (!category) return "错误：缺少 category 参数";
    if (!key) return "错误：缺少 key 参数";
    if (isNaN(value)) return "错误：value 必须是数字";

    try {
      insertMetric({
        category,
        key,
        value,
        ...(note !== undefined && { note }),
        ...(ts !== undefined && { ts }),
      });
      const tsStr = ts
        ? new Date(ts * 1000).toLocaleString("zh-CN")
        : new Date().toLocaleString("zh-CN");
      return `已写入: ${category}/${key} = ${value}${note ? `（${note}）` : ""}  [${tsStr}]`;
    } catch (e) {
      return `写入失败: ${String(e)}`;
    }
  },
});
