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
        "Search NewsNow trending news (Chinese finance platforms: Wallstreetcn, Cailianpress, " +
        "Zhihu, Weibo, etc.).\n" +
        "Uses vector semantic retrieval (RKLLM NPU embedding) and ranks the results by " +
        "semantic relevance.\n" +
        "With fresh=true it first fetches the latest trending lists and then searches " +
        "(about 20-30 seconds extra), suited to cases that need the newest data.\n" +
        "Data contains trending titles and ranks only, no article body.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description:
              "Search query (natural language, e.g. chip prices falling, nonfarm payrolls, " +
              "central bank policy)",
          },
          days: {
            type: "number",
            description: "Search data from the last N days (default 7)",
          },
          limit: {
            type: "number",
            description: "Maximum number of results to return (default 10)",
          },
          fresh: {
            type: "boolean",
            description:
              "true = fetch the latest trending lists before searching (about 20-30 seconds); " +
              "false = search the existing local data directly (default)",
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
      "--query",
      query,
      "--days",
      String(days),
      "--limit",
      String(limit),
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
