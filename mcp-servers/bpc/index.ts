#!/usr/bin/env bun
/**
 * bpc MCP Server
 * 绕付费墙抓取文章全文，基于 bpc-fetch CLI
 *
 * 工具：
 *   bpc_fetch   — 抓取单篇文章全文（返回 markdown）
 *   bpc_search  — 在支持的付费墙站点中搜索文章
 *   bpc_sites   — 列出所有支持的站点
 *
 * 部署：先运行 setup.sh
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { spawnSync } from "node:child_process";

const server = new McpServer({
  name: "bpc",
  version: "1.0.0",
});

/** 调用 bpc-fetch CLI，返回解析后的 JSON 对象 */
function runBpc(args: string[]): unknown {
  const result = spawnSync("bpc-fetch", args, {
    encoding: "utf-8",
    timeout: 60_000,
    env: { ...process.env },
  });
  if (result.error) throw new Error(`bpc-fetch 启动失败: ${result.error.message}`);
  const raw = result.stdout?.trim();
  if (!raw) {
    const err = result.stderr?.trim();
    throw new Error(`bpc-fetch 无输出${err ? ": " + err : ""}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    return { raw };
  }
}

// ── bpc_fetch ──────────────────────────────────────────────────────────────────
server.tool(
  "bpc_fetch",
  "绕付费墙抓取文章全文，返回 Markdown 格式正文。适合 FT、经济学人、NYT 等付费墙站点。",
  {
    url: z.string().url().describe("文章 URL"),
    use_browser: z
      .boolean()
      .optional()
      .describe("强制使用 Playwright 浏览器抓取（默认自动判断）"),
  },
  async ({ url, use_browser }) => {
    const args = ["fetch", url, "--compact"];
    if (use_browser === true) args.push("--browser");
    if (use_browser === false) args.push("--no-browser");

    const data = runBpc(args) as Record<string, unknown>;
    if (!data["ok"]) {
      return {
        content: [{ type: "text", text: `❌ 抓取失败: ${data["error"] ?? JSON.stringify(data)}` }],
      };
    }

    const lines: string[] = [];
    if (data["title"]) lines.push(`# ${data["title"]}\n`);
    if (data["author"]) lines.push(`**作者**: ${data["author"]}`);
    if (data["date"]) lines.push(`**日期**: ${data["date"]}`);
    lines.push(`**来源**: ${url}`);
    if (data["strategy"]) lines.push(`**策略**: ${data["strategy"]}`);
    lines.push("");
    lines.push((data["text"] as string) ?? "（无正文）");

    return {
      content: [{ type: "text", text: lines.join("\n") }],
    };
  }
);

// ── bpc_search ─────────────────────────────────────────────────────────────────
server.tool(
  "bpc_search",
  "在 bpc-fetch 支持的付费墙站点中搜索文章，返回标题+URL列表。",
  {
    query: z.string().describe("搜索关键词或短语"),
    limit: z.number().min(1).max(20).optional().default(10).describe("最多返回结果数"),
  },
  async ({ query, limit }) => {
    const args = ["search", query, "--limit", String(limit), "--compact"];
    const data = runBpc(args) as Record<string, unknown>;

    const results = (data["results"] as Array<Record<string, unknown>>) ?? [];
    if (!results.length) {
      return { content: [{ type: "text", text: "未找到相关文章。" }] };
    }

    const lines = results.map(
      (r, i) => `${i + 1}. **${r["title"] ?? "无标题"}**\n   ${r["url"]}`
    );
    return { content: [{ type: "text", text: lines.join("\n\n") }] };
  }
);

// ── bpc_sites ──────────────────────────────────────────────────────────────────
server.tool(
  "bpc_sites",
  "列出 bpc-fetch 支持的付费墙站点（可按关键词过滤）。",
  {
    filter: z.string().optional().describe("按站点名/域名过滤，留空列出全部（最多50条）"),
  },
  async ({ filter }) => {
    const args = ["sites", "--compact", "--limit", "50"];
    if (filter) args.push("--filter", filter);
    const data = runBpc(args) as Record<string, unknown>;

    const sites = (data["sites"] as Array<Record<string, unknown>>) ?? [];
    if (!sites.length) return { content: [{ type: "text", text: "无结果。" }] };

    const lines = sites.map(
      (s) => `- **${s["name"] ?? s["domain"]}** \`${s["domain"]}\` [${s["bypass_type"]}]`
    );
    return {
      content: [
        {
          type: "text",
          text: `共 ${data["total"] ?? sites.length} 个支持站点（显示 ${sites.length} 条）：\n\n${lines.join("\n")}`,
        },
      ],
    };
  }
);

// ── 启动 ───────────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
