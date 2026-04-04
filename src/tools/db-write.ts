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
        "将一条业务指标数据写入 Dashboard 本地数据库（~/.tinyclaw/dashboard.db）。" +
        "用于记录随时间变化的数值，如电费余额、高级请求次数、自定义指标等。" +
        "数据写入后可在 Dashboard 概览页和指标页以折线图/柱状图展示。\n\n" +
        "category 建议值：electric（电费）、copilot（AI请求）、custom（自定义）\n" +
        "key 建议值：balance（余额）、daily_count（日用量）、total_count（累计）",
      parameters: {
        type: "object",
        properties: {
          category: {
            type: "string",
            description: "数据分类，如 electric / copilot / custom",
          },
          key: {
            type: "string",
            description: "指标键名，如 balance / daily_count / total_count",
          },
          value: {
            type: "number",
            description: "指标数值",
          },
          note: {
            type: "string",
            description: "可选备注，如充值原因、数据来源等",
          },
          ts: {
            type: "number",
            description: "可选时间戳（Unix 秒），默认为当前时间",
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
      insertMetric({ category, key, value, ...(note !== undefined && { note }), ...(ts !== undefined && { ts }) });      const tsStr = ts
        ? new Date(ts * 1000).toLocaleString("zh-CN")
        : new Date().toLocaleString("zh-CN");
      return `已写入: ${category}/${key} = ${value}${note ? `（${note}）` : ""}  [${tsStr}]`;
    } catch (e) {
      return `写入失败: ${String(e)}`;
    }
  },
});
