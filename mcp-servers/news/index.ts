/**
 * tinyclaw News MCP Server
 *
 * 工具（agent 侧名前缀 mcp_news_*）：
 *   fetch_and_store   — 按 topics 多源抓取新闻，去重后写入日期 Markdown 文件
 *   read_day          — 读取指定日期的新闻存档（默认今天）
 *   list_days         — 列出已有存档的日期列表
 *   search_local      — 在本地存档中做简单关键词全文搜索
 *   rebuild_index     — 写入 .update-pending 标记，触发主进程侧 QMD 重新索引
 *
 * 启动方式：bun run /path/to/mcp-servers/news/index.ts
 * 配置方式：~/.tinyclaw/mcp.toml [servers.news]
 *
 * 数据目录：~/.tinyclaw/news/
 *   YYYY-MM/YYYY-MM-DD.md   每日存档（Markdown）
 *   seen_urls.db             L1 URL 去重数据库（由 Python 脚本维护）
 *   .update-pending          存在时，主进程 search_store 会触发 QMD 重新索引
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
  noDedup?: boolean;
}): { items: NewsItem[]; stderr: string; error?: string } {
  const args = [
    FETCH_SCRIPT,
    "--topics", params.topics,
    "--since-hours", String(params.sinceHours),
    "--sources", params.sources,
    "--max", String(params.max),
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
        "从 HackerNews、RSS 等多源按 topics 抓取新闻，自动去重后写入当日 Markdown 存档。\n" +
        "写入完成后标记 QMD 索引更新（下次 search_store 调用时自动生效）。",
      inputSchema: {
        type: "object",
        properties: {
          topics: {
            type: "string",
            description: "逗号分隔的话题关键词，如 'AI,LLM,开源'",
          },
          since_hours: {
            type: "number",
            description: "只抓取最近 N 小时内的内容，默认 24",
          },
          sources: {
            type: "string",
            description: "逗号分隔的数据源：hn（HackerNews）、rss（RSS 聚合），默认 'hn,rss'",
          },
          max: {
            type: "number",
            description: "最多保留条目数（去重后），默认 50",
          },
        },
        required: ["topics"],
      },
    },
    {
      name: "read_day",
      description: "读取指定日期的本地新闻存档（Markdown 格式）。不传日期则返回今天的存档。",
      inputSchema: {
        type: "object",
        properties: {
          date: {
            type: "string",
            description: "日期，格式 YYYY-MM-DD，默认今天",
          },
        },
      },
    },
    {
      name: "list_days",
      description: "列出本地已有新闻存档的日期列表（最近 N 天，默认 30）。",
      inputSchema: {
        type: "object",
        properties: {
          limit: {
            type: "number",
            description: "最多返回的日期数量，默认 30",
          },
        },
      },
    },
    {
      name: "search_local",
      description: "在本地新闻存档中做全文关键词搜索（简单文本匹配，不依赖向量索引）。",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "搜索关键词（支持多关键词，空格分隔）",
          },
          days: {
            type: "number",
            description: "只搜索最近 N 天的存档，默认 7",
          },
          max_results: {
            type: "number",
            description: "最多返回结果数，默认 20",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "rebuild_index",
      description:
        "写入 .update-pending 标记文件，触发主进程（tinyclaw agent）在下次 search_store 调用时重新索引 news 知识库。\n" +
        "通常在手动编辑存档文件后调用。",
      inputSchema: {
        type: "object",
        properties: {},
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
              if (keywords.every((kw) => ll.includes(kw))) {
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
            "已写入 .update-pending 标记。下次在 tinyclaw 中调用 search_store 时将自动重建 news 索引。",
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
