/**
 * search_store 工具
 *
 * 对 memstores.toml 中已启用的 MemStore collection 做向量相似度搜索。
 * 增量索引由 `memory/news-watcher.ts` 负责（监听 ~/.tinyclaw/news/.update-pending，
 * 启动时也会处理残留标记），本工具不再自己做懒触发。
 */

import { registerTool, type ToolContext } from "./registry.js";
import { loadMemStoresConfig } from "../config/loader.js";
import { searchStore } from "../memory/qmd.js";

// ── 注册时读取配置，构建 spec ────────────────────────────────────────────────

const memStoresCfg = loadMemStoresConfig();
const enabledStores = memStoresCfg.stores.filter((s) => s.enabled);

if (enabledStores.length === 0) {
  registerTool({
    requiresMFA: false,
    spec: {
      type: "function",
      function: {
        name: "search_store",
        description:
          "Run semantic vector search over local MemStore knowledge bases. No MemStore is enabled " +
          "right now; configure one in ~/.tinyclaw/memstores.toml and set enabled = true.",
        parameters: {
          type: "object",
          properties: {
            store: { type: "string", description: "MemStore name" },
            query: { type: "string", description: "Search query" },
            limit: { type: "number", description: "Maximum number of results to return, default 8" },
          },
          required: ["store", "query"],
        },
      },
    },
    execute: async () => {
      return "当前没有已启用的 MemStore。请配置 ~/.tinyclaw/memstores.toml。";
    },
  });
} else {
  const storeNames = enabledStores.map((s) => s.name);
  const storeTitles = enabledStores.map((s) => `- \`${s.name}\`：${s.title}`).join("\n");

  registerTool({
    requiresMFA: false,
    spec: {
      type: "function",
      function: {
        name: "search_store",
        description:
          `Run semantic vector search over local MemStore knowledge bases.\n\n` +
          `**Available knowledge bases:**\n${storeTitles}\n\n` +
          `Use it for archived local content such as past news, notes, and documents. ` +
          `If new data was written before the first call, an incremental index update runs ` +
          `automatically.\n\n` +
          `⚠️ This tool only searches **archived** historical content. To get the latest ` +
          `news, first use \`mcp_list_servers\` to find the news server, then ` +
          `\`mcp_enable_server\` to enable it, and finally call ` +
          `\`mcp_news_fetch_and_store\` to fetch the latest content.`,
        parameters: {
          type: "object",
          properties: {
            store: {
              type: "string",
              enum: storeNames,
              description: `Name of the knowledge base to search, one of: ${storeNames.join(" / ")}`,
            },
            query: {
              type: "string",
              description: "Search query (natural language; Chinese and English are both fine)",
            },
            limit: {
              type: "number",
              description: "Maximum number of results to return, default 8, max 20",
            },
          },
          required: ["store", "query"],
        },
      },
    },
    execute: async (args: Record<string, unknown>, ctx?: ToolContext): Promise<string> => {
      const store = String(args["store"] ?? "").trim();
      const query = String(args["query"] ?? "").trim();
      const limit = Math.min(20, Math.max(1, Number(args["limit"] ?? 8)));
      const agentId = ctx?.agentId ?? "default";

      if (!store) return "错误：缺少 store 参数";
      if (!query) return "错误：缺少 query 参数";
      if (!storeNames.includes(store)) {
        return `错误：未知的 store "${store}"，可选：${storeNames.join(", ")}`;
      }

      // 直接搜索（索引已由 news-watcher 主动维护，无需懒触发）
      const result = await searchStore(store, query, agentId, limit);
      if (result === null) {
        return "向量记忆功能未启用（memory.enabled = false），无法搜索。";
      }
      if (result === "") {
        return `在知识库 "${store}" 中未找到与 "${query}" 相关的内容。`;
      }
      return result;
    },
  });
}
