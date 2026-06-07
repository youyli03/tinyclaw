/**
 * search_newsnow — 搜索 NewsNow 热榜新闻（向量语义检索）
 *
 * 调用 mcp-servers/news/lib/search_newsnow.py：
 * - 优先使用 RKLLM NPU embedding（http://127.0.0.1:11434）做向量 KNN 搜索
 * - 降级为关键词 LIKE 匹配
 * - 可选 fresh=true 先抓取最新热榜再搜索
 *
 * 数据来源：NewsNow API（华尔街见闻/财联社/知乎/微博/百度/头条等中文热榜）
 * 本地存储：~/.tinyclaw/newsnow/YYYY-MM-DD.db（由 mcp_news_fetch_newsnow 维护）
 */
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { registerTool, type ToolContext } from "./registry.js";

const SEARCH_SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../mcp-servers/news/lib/search_newsnow.py"
);

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "search_newsnow",
      description:
        "搜索 NewsNow 热榜新闻（华尔街见闻/财联社/知乎/微博等中文财经平台热榜）。\n" +
        "使用向量语义检索（RKLLM NPU embedding），按语义相关度排序结果。\n" +
        "设 fresh=true 时先实时抓取最新热榜再搜索（额外约 20-30 秒），适合需要最新数据的场景。\n" +
        "数据仅含热榜标题 + 排名，不含文章正文。",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "搜索查询（自然语言，如：芯片下跌、非农数据发布、央行政策）",
          },
          days: {
            type: "number",
            description: "搜索最近 N 天数据（默认 7）",
          },
          limit: {
            type: "number",
            description: "最多返回结果数（默认 10）",
          },
          fresh: {
            type: "boolean",
            description:
              "true = 搜索前先抓取最新热榜（约 20-30 秒）；false = 直接搜索本地已有数据（默认）",
          },
        },
        required: ["query"],
      },
    },
  },

  async execute(args: Record<string, unknown>, _ctx?: ToolContext): Promise<string> {
    const query = String(args["query"] ?? "").trim();
    if (!query) return "错误：缺少 query 参数";

    const days = Math.min(30, Math.max(1, Number(args["days"] ?? 7)));
    const limit = Math.min(50, Math.max(1, Number(args["limit"] ?? 10)));
    const fresh = Boolean(args["fresh"]);

    const spawnArgs = [
      SEARCH_SCRIPT,
      "--query", query,
      "--days", String(days),
      "--limit", String(limit),
    ];
    if (fresh) spawnArgs.push("--fresh");

    const result = spawnSync("python3", spawnArgs, {
      encoding: "utf-8",
      timeout: fresh ? 120_000 : 15_000,
    });

    if (result.error) return `执行失败: ${result.error}`;
    if (result.status !== 0) return `脚本错误:\n${result.stderr}`;

    let parsed: { query: string; results: unknown[]; count: number; fetch?: unknown };
    try {
      parsed = JSON.parse(result.stdout ?? "{}");
    } catch {
      return `JSON 解析失败: ${result.stdout?.slice(0, 200)}`;
    }

    if (!parsed.results?.length) {
      return `未找到与"${query}"相关的热榜新闻（最近 ${days} 天，${fresh ? "已抓取最新" : "本地缓存"}）`;
    }

    const lines: string[] = [
      `**NewsNow 热榜搜索结果** | 查询：${query} | 共 ${parsed.count} 条`,
      ...(parsed.fetch ? [`> 抓取结果：${JSON.stringify(parsed.fetch)}`] : []),
      "",
    ];

    for (const item of parsed.results as Array<Record<string, unknown>>) {
      const dist = item["distance"] != null ? ` (相似度: ${item["distance"]})` : "";
      const type = item["match_type"] === "vector" ? "🔍" : "📝";
      lines.push(`${type} [${item["date"]}] **${item["platform"]}** 第${item["rank"]}位${dist}`);
      lines.push(`   ${item["title"]}`);
      if (item["url"]) lines.push(`   ${item["url"]}`);
    }

    return lines.join("\n");
  },
});
