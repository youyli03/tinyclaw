#!/usr/bin/env bun
/**
 * Exa MCP Server
 * 提供网页/推文/学术/新闻多平台语义搜索能力
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const EXA_API_KEY = process.env.EXA_API_KEY!;
const BASE_URL = "https://api.exa.ai";

async function exaSearch(params: {
  query: string;
  numResults?: number;
  type?: "neural" | "keyword" | "auto";
  includeDomains?: string[];
  excludeDomains?: string[];
  startPublishedDate?: string;
  endPublishedDate?: string;
  useAutoprompt?: boolean;
  contents?: { text?: { maxCharacters?: number }; highlights?: { numSentences?: number } };
}) {
  const res = await fetch(`${BASE_URL}/search`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": EXA_API_KEY,
    },
    body: JSON.stringify({
      numResults: 5,
      useAutoprompt: true,
      contents: { text: { maxCharacters: 2000 }, highlights: { numSentences: 3 } },
      ...params,
    }),
  });
  if (!res.ok) throw new Error(`Exa API error ${res.status}: ${await res.text()}`);
  return res.json() as Promise<{
    results: Array<{
      id: string;
      url: string;
      title: string;
      publishedDate?: string;
      author?: string;
      text?: string;
      highlights?: string[];
      score?: number;
    }>;
    autopromptString?: string;
  }>;
}

const server = new McpServer({
  name: "exa",
  version: "1.0.0",
});

server.tool(
  "exa_search",
  "使用 Exa AI 进行语义网络搜索，支持推文、新闻、学术、Reddit 等多平台",
  {
    query: z.string().describe("搜索查询，支持自然语言"),
    numResults: z.number().min(1).max(20).optional().default(5).describe("返回结果数"),
    type: z.enum(["neural", "keyword", "auto"]).optional().default("auto").describe("搜索类型：neural=语义/keyword=关键词/auto=自动"),
    includeDomains: z.array(z.string()).optional().describe("限定域名，如 ['twitter.com','x.com']"),
    excludeDomains: z.array(z.string()).optional().describe("排除域名"),
    startPublishedDate: z.string().optional().describe("发布日期下限，ISO 格式如 2024-01-01"),
    endPublishedDate: z.string().optional().describe("发布日期上限，ISO 格式"),
    useAutoprompt: z.boolean().optional().default(true).describe("是否让 Exa 自动优化查询"),
  },
  async (args) => {
    const { query, numResults, type, includeDomains, excludeDomains, startPublishedDate, endPublishedDate, useAutoprompt } = args;
    const data = await exaSearch({
      query,
      numResults,
      type,
      includeDomains,
      excludeDomains,
      startPublishedDate,
      endPublishedDate,
      useAutoprompt,
    });

    const lines: string[] = [];
    if (data.autopromptString) {
      lines.push(`> 优化后查询: ${data.autopromptString}\n`);
    }
    for (const r of data.results) {
      lines.push(`**${r.title || "无标题"}**`);
      lines.push(`URL: ${r.url}`);
      if (r.publishedDate) lines.push(`发布: ${r.publishedDate}`);
      if (r.author) lines.push(`作者: ${r.author}`);
      if (r.highlights?.length) lines.push(`摘要: ${r.highlights.join(" | ")}`);
      else if (r.text) lines.push(`内容: ${r.text.slice(0, 500)}...`);
      lines.push("");
    }
    return { content: [{ type: "text", text: lines.join("\n") || "无结果" }] };
  }
);

server.tool(
  "exa_find_similar",
  "基于给定 URL 找到相似内容（适合追踪同类文章/推文）",
  {
    url: z.string().url().describe("参考 URL"),
    numResults: z.number().min(1).max(10).optional().default(5),
    excludeSourceDomain: z.boolean().optional().default(false).describe("是否排除与 url 相同的域名"),
  },
  async ({ url, numResults, excludeSourceDomain }) => {
    const res = await fetch(`${BASE_URL}/findSimilar`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": EXA_API_KEY },
      body: JSON.stringify({ url, numResults, excludeSourceDomain, contents: { text: { maxCharacters: 1000 } } }),
    });
    if (!res.ok) throw new Error(`Exa API error ${res.status}: ${await res.text()}`);
    const data = await res.json() as { results: Array<{ url: string; title: string; text?: string; publishedDate?: string }> };
    const lines = data.results.map((r) => `**${r.title}**\n${r.url}${r.publishedDate ? ` (${r.publishedDate})` : ""}\n${r.text?.slice(0, 300) ?? ""}`);
    return { content: [{ type: "text", text: lines.join("\n\n") || "无结果" }] };
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
