/**
 * tinyclaw News MCP Server
 *
 * 工具（agent 侧名前缀 mcp_news_*）：
 *   fetch_and_store   — 按 topics 多源抓取新闻，去重后写入日期 Markdown 文件
 *   read_day          — 读取指定日期的新闻存档（默认今天）
 *   list_days         — 列出已有存档的日期列表
 *   search_local      — 在本地存档中做简单关键词全文搜索
 *   search_trendradar    — 在 TrendRadar 热榜 SQLite DB 中做关键词检索(中文财经热榜)
 *   rebuild_index     — 写入 .update-pending 标记，触发主进程侧 QMD 重新索引
 *
 * 启动方式：node --import tsx/esm /path/to/mcp-servers/news/index.ts
 * 配置方式：~/.tinyclaw/mcp.toml [servers.news]
 *
 * 数据目录：~/.tinyclaw/news/
 *   YYYY-MM/YYYY-MM-DD.md   每日存档（Markdown）
 *   seen_urls.db             L1 URL 去重数据库（由 Python 脚本维护）
 *   .update-pending          存在时由主进程 memory/news-watcher.ts 监听到并触发 QMD 增量索引
 *                            （启动时也会清理残留标记；不再依赖 search_store 的懒触发）
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";

// ── 数据目录 ───────────────────────────────────────────────────────────────────
const NEWS_DATA_DIR =
  process.env["NEWS_DATA_DIR"] ??
  path.join(os.homedir(), ".tinyclaw", "news");

const PENDING_MARKER = path.join(NEWS_DATA_DIR, ".update-pending");

fs.mkdirSync(NEWS_DATA_DIR, { recursive: true });

// news_fetch.py 路径（与本文件同目录的 lib/）
const FETCH_SCRIPT = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "lib",
  "news_fetch.py"
);

// search_trendradar.py 路径
const TRENDRADAR_SCRIPT = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "lib",
  "search_trendradar.py"
);

// fetch_newsnow.py 路径
const NEWSNOW_SCRIPT = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  "lib",
  "fetch_newsnow.py"
);

// ── 辅助函数 ───────────────────────────────────────────────────────────────────

/** 今日日期字符串 YYYY-MM-DD */
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** 根据日期返回存档文件路径 */
function dayFilePath(date: string): string {
  const ym = date.slice(0, 7); // YYYY-MM
  return path.join(NEWS_DATA_DIR, ym, `${date}.md`);
}

/** 将抓取到的新闻条目列表追加写入当日 Markdown 存档 */
function appendToDay(date: string, items: NewsItem[]): { written: number; path: string } {
  if (items.length === 0) return { written: 0, path: dayFilePath(date) };

  const filePath = dayFilePath(date);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  const now = new Date().toISOString();
  let md = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf-8") : `# 新闻存档 ${date}\n\n`;

  md += `\n## 抓取批次 ${now}\n\n`;
  for (const item of items) {
    const score = item.score > 0 ? ` ⭐${item.score}` : "";
    const topic = item.topic ? ` \`[${item.topic}]\`` : "";
    md += `### ${item.title}${score}${topic}\n`;
    md += `- **来源**：${item.source}\n`;
    md += `- **链接**：${item.url}\n`;
    if (item.date) md += `- **发布**：${item.date}\n`;
    if (item.author) md += `- **作者**：${item.author}\n`;
    if (item.text) md += `\n${item.text.slice(0, 300)}\n`;
    md += "\n";
  }

  fs.writeFileSync(filePath, md, "utf-8");
  return { written: items.length, path: filePath };
}

/** 写入 .update-pending 标记，触发主进程 QMD 索引 */
function markUpdatePending(stores: string[] = ["news"]): void {
  fs.writeFileSync(PENDING_MARKER, stores.join(","), "utf-8");
}

/** 调用 Python 脚本抓取新闻，返回条目列表 */
interface NewsItem {
  source: string;
  id: string;
  title: string;
  url: string;
  text: string;
  topic: string;
  score: number;
  date: string;
  author: string;
}

function runFetchScript(params: {
  topics: string;
  sinceHours: number;
  sources: string;
  max: number;
  date?: string;      // L1 去重日期（YYYY-MM-DD），默认今天
  noDedup?: boolean;
}): { items: NewsItem[]; stderr: string; error?: string } {
  const args = [
    FETCH_SCRIPT,
    "--topics", params.topics,
    "--since-hours", String(params.sinceHours),
    "--sources", params.sources,
    "--max", String(params.max),
    "--date", params.date ?? today(),   // 传入日期，实现按天分区去重
  ];
  if (params.noDedup) args.push("--no-dedup");

  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    NEWS_DATA_DIR,
  };

  const result = spawnSync("python3", args, {
    encoding: "utf-8",
    timeout: 120_000,
    env,
  });

  if (result.error) {
    return { items: [], stderr: "", error: String(result.error) };
  }
  if (result.status !== 0) {
    return {
      items: [],
      stderr: result.stderr ?? "",
      error: `Python 脚本退出码 ${result.status}：${result.stderr}`,
    };
  }

  let items: NewsItem[] = [];
  try {
    items = JSON.parse(result.stdout ?? "[]");
  } catch (e) {
    return { items: [], stderr: result.stderr ?? "", error: `JSON 解析失败：${e}` };
  }
  return { items, stderr: result.stderr ?? "" };
}

// ── MCP Server ────────────────────────────────────────────────────────────────
const server = new Server(
  { name: "news", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

// ── 工具列表 ───────────────────────────────────────────────────────────────────
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "fetch_and_store",
      description:
        "Fetch news by topics from multiple sources (HackerNews, RSS, ...), deduplicate " +
        "automatically and append the result to today's Markdown archive.\n" +
        "After writing it records the QMD index update marker; tinyclaw's main process " +
        "rebuilds the index automatically when that marker appears.",
      inputSchema: {
        type: "object",
        properties: {
          topics: {
            type: "string",
            description: "Comma-separated topic keywords, e.g. 'AI,LLM,open source'",
          },
          since_hours: {
            type: "number",
            description: "Only fetch items published within the last N hours, defaults to 24",
          },
          sources: {
            type: "string",
            description:
              "Comma-separated data sources: hn (HackerNews), rss (RSS aggregation), " +
              "default 'hn,rss'",
          },
          max: {
            type: "number",
            description: "Maximum number of items to keep after deduplication, defaults to 50",
          },
        },
        required: ["topics"],
      },
    },
    {
      name: "read_day",
      description:
        "Read the local news archive of a given date (Markdown format). Returns today's " +
        "archive when no date is given.",
      inputSchema: {
        type: "object",
        properties: {
          date: {
            type: "string",
            description: "Date in YYYY-MM-DD format, defaults to today",
          },
        },
      },
    },
    {
      name: "list_days",
      description:
        "List the dates of the local news archives available (most recent N days, defaults to 30).",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "Maximum number of dates to return, defaults to 30",
          },
        },
      },
    },
    {
      name: "search_local",
      description:
        "Full-text keyword search over the local news archives (plain text matching, no vector " +
        "index required). Space-separated keywords are ORed: a hit on any single keyword counts.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search keywords (multiple keywords supported, space-separated)",
          },
          days: {
            type: "number",
            description: "Only search archives from the last N days, defaults to 7",
          },
          max_results: {
            type: "number",
            description: "Maximum number of results to return, defaults to 20",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "rebuild_index",
      description:
        "Write the .update-pending marker file, which makes tinyclaw's main process rebuild " +
        "the news knowledge base index automatically.\n" +
        "Normally called after the archive files have been edited by hand.",
      inputSchema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "search_trendradar",
      description:
        "Run a keyword search over the TrendRadar hot-list SQLite DB and return Chinese finance " +
        "hot-list entries (Wallstreetcn/CLS/Weibo/Zhihu ...).\n" +
        "Data source: /home/lyy/TrendRadar/output/news/*.db; only hot-list title + rank are " +
        "stored, no article body.\n" +
        "Suited to looking up recent finance topics and stock/company related hot searches.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search keywords (e.g. NVDA, Micron, chips)",
          },
          days: {
            type: "number",
            description: "Search data from the last N days, defaults to 7",
          },
          limit: {
            type: "number",
            description: "Maximum number of results to return, defaults to 30",
          },
          platforms: {
            type: "string",
            description:
              "Platform filter, comma-separated (e.g. '华尔街见闻,财联社热门'); all " +
              "platforms are searched when omitted",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "fetch_newsnow",
      description:
        "Fetch the Chinese finance hot lists from the public NewsNow API " +
        "(Wallstreetcn/CLS/Zhihu/Weibo ...),\n" +
        "storing them into ~/.tinyclaw/newsnow/YYYY-MM-DD.db.\n" +
        "The result can be searched with search_trendradar right away. Each run takes " +
        "about 10-30 seconds.",
      inputSchema: {
        type: "object",
        properties: {
          platforms: {
            type: "string",
            description:
              "Comma-separated platform IDs (e.g. wallstreetcn-hot,cls-hot); all 11 " +
              "platforms are fetched when omitted",
          },
          date: {
            type: "string",
            description: "Write date YYYY-MM-DD (defaults to today)",
          },
        },
        required: [],
      },
    },
  ],
}));

// ── 工具执行 ───────────────────────────────────────────────────────────────────
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;

  try {
    switch (name) {
      // ── fetch_and_store ───────────────────────────────────────────────
      case "fetch_and_store": {
        const topics = String(args["topics"] ?? "").trim();
        if (!topics) return err("缺少 topics 参数");

        const sinceHours = Math.max(1, Number(args["since_hours"] ?? 24));
        const sources = String(args["sources"] ?? "hn,rss").trim();
        const max = Math.min(200, Math.max(1, Number(args["max"] ?? 50)));

        const { items, stderr, error } = runFetchScript({ topics, sinceHours, sources, max });

        if (error) {
          return err(`抓取失败：${error}\nstderr: ${stderr}`);
        }

        const date = today();
        const { written, path: filePath } = appendToDay(date, items);

        if (written > 0) {
          markUpdatePending(["news"]);
        }

        return ok({
          date,
          written,
          file: filePath,
          stderr: stderr.trim() || undefined,
          message: written > 0
            ? `已写入 ${written} 条新闻到 ${filePath}，QMD 索引已标记待更新。`
            : "本次抓取无新内容（全部已去重）。",
        });
      }

      // ── read_day ──────────────────────────────────────────────────────
      case "read_day": {
        const date = String(args["date"] ?? today()).trim();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
          return err(`日期格式错误：${date}，应为 YYYY-MM-DD`);
        }
        const filePath = dayFilePath(date);
        if (!fs.existsSync(filePath)) {
          return ok({ date, found: false, message: `${date} 暂无存档` });
        }
        const content = fs.readFileSync(filePath, "utf-8");
        return ok({ date, found: true, path: filePath, content });
      }

      // ── list_days ─────────────────────────────────────────────────────
      case "list_days": {
        const limit = Math.min(365, Math.max(1, Number(args["limit"] ?? 30)));
        const days: string[] = [];

        // 遍历 YYYY-MM 子目录
        try {
          const months = fs.readdirSync(NEWS_DATA_DIR)
            .filter((d) => /^\d{4}-\d{2}$/.test(d))
            .sort()
            .reverse();

          for (const month of months) {
            const monthDir = path.join(NEWS_DATA_DIR, month);
            const files = fs.readdirSync(monthDir)
              .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
              .sort()
              .reverse();
            for (const f of files) {
              days.push(f.replace(".md", ""));
              if (days.length >= limit) break;
            }
            if (days.length >= limit) break;
          }
        } catch { /* ignore */ }

        return ok({ total: days.length, days });
      }

      // ── search_local ──────────────────────────────────────────────────
      case "search_local": {
        const query = String(args["query"] ?? "").trim();
        if (!query) return err("缺少 query 参数");

        const days = Math.min(365, Math.max(1, Number(args["days"] ?? 7)));
        const maxResults = Math.min(100, Math.max(1, Number(args["max_results"] ?? 20)));
        const keywords = query.toLowerCase().split(/\s+/).filter(Boolean);

        // 收集最近 N 天的存档文件
        const cutoff = new Date();
        cutoff.setDate(cutoff.getDate() - days);
        const targetFiles: string[] = [];

        try {
          const months = fs.readdirSync(NEWS_DATA_DIR)
            .filter((d) => /^\d{4}-\d{2}$/.test(d))
            .sort()
            .reverse();
          for (const month of months) {
            const monthDir = path.join(NEWS_DATA_DIR, month);
            const files = fs.readdirSync(monthDir)
              .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
              .sort()
              .reverse();
            for (const f of files) {
              const dateStr = f.replace(".md", "");
              if (new Date(dateStr) >= cutoff) {
                targetFiles.push(path.join(monthDir, f));
              }
            }
          }
        } catch { /* ignore */ }

        const matches: Array<{ date: string; line: string }> = [];
        for (const filePath of targetFiles) {
          if (matches.length >= maxResults) break;
          try {
            const lines = fs.readFileSync(filePath, "utf-8").split("\n");
            const date = path.basename(filePath, ".md");
            for (const line of lines) {
              if (matches.length >= maxResults) break;
              const ll = line.toLowerCase();
              if (keywords.some((kw) => ll.includes(kw))) {
                matches.push({ date, line: line.trim() });
              }
            }
          } catch { /* ignore */ }
        }

        if (matches.length === 0) {
          return ok({ query, found: 0, message: "未找到匹配内容" });
        }

        const resultText = matches
          .map((m) => `[${m.date}] ${m.line}`)
          .join("\n");
        return ok({ query, found: matches.length, results: resultText });
      }

      // ── rebuild_index ─────────────────────────────────────────────────
      case "rebuild_index": {
        markUpdatePending(["news"]);
        return ok({
          message:
            "已写入 .update-pending 标记，tinyclaw 主进程的 news-watcher 会自动重建 news 索引（无需再调用 search_store）。",
        });
      }

      // ── search_trendradar ────────────────────────────────────────
      case "search_trendradar": {
        const query = String(args["query"] ?? "").trim();
        if (!query) return err("缺少 query 参数");

        const days = Math.min(30, Math.max(1, Number(args["days"] ?? 7)));
        const limit = Math.min(100, Math.max(1, Number(args["limit"] ?? 30)));
        const platforms = String(args["platforms"] ?? "").trim();

        const scriptArgs = [
          TRENDRADAR_SCRIPT,
          "--query", query,
          "--days", String(days),
          "--limit", String(limit),
        ];
        if (platforms) scriptArgs.push("--platforms", platforms);

        const result = spawnSync("python3", scriptArgs, {
          encoding: "utf-8",
          timeout: 15_000,
        });

        if (result.error) return err(String(result.error));
        if (result.status !== 0) {
          return err(`search_trendradar 脚本错误:${result.stderr}`);
        }

        let parsed: { results: unknown[]; count: number; error?: string };
        try {
          parsed = JSON.parse(result.stdout ?? "{}");
        } catch {
          return err(`JSON 解析失败: ${result.stdout?.slice(0, 200)}`);
        }

        if (parsed.error) return err(parsed.error);
        return ok(parsed);
      }

      // ── fetch_newsnow ─────────────────────────────────────────────────
      case "fetch_newsnow": {
        const fetchPlatforms = String(args["platforms"] ?? "").trim();
        const fetchDate = String(args["date"] ?? "").trim();

        const fetchArgs = [NEWSNOW_SCRIPT];
        if (fetchPlatforms) fetchArgs.push("--platforms", fetchPlatforms);
        if (fetchDate) fetchArgs.push("--date", fetchDate);

        const fetchResult = spawnSync("python3", fetchArgs, {
          encoding: "utf-8",
          timeout: 60_000,
        });

        if (fetchResult.error) return err(String(fetchResult.error));
        if (fetchResult.status !== 0) {
          return err(`fetch_newsnow 脚本错误:\n${fetchResult.stderr}`);
        }

        let fetchParsed: { date: string; db: string; platforms: number; inserted: number };
        try {
          fetchParsed = JSON.parse(fetchResult.stdout ?? "{}");
        } catch {
          return err(`JSON 解析失败: ${fetchResult.stdout?.slice(0, 200)}`);
        }

        return ok({
          ...fetchParsed,
          message: `已抓取 ${fetchParsed.platforms} 个平台,插入 ${fetchParsed.inserted} 条热榜数据`,
        });
      }

      default:
        return err(`未知工具：${name}`);
    }
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
});

// ── 响应辅助 ───────────────────────────────────────────────────────────────────
function ok(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

function err(message: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

// ── 启动 ──────────────────────────────────────────────────────────────────────
process.on("SIGINT", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));

const transport = new StdioServerTransport();
await server.connect(transport);
