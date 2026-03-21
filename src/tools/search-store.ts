/**
 * search_store 工具
 *
 * 对 memstores.toml 中已启用的 MemStore collection 做向量相似度搜索。
 * 在调用前会检测 ~/.tinyclaw/news/.update-pending 标记文件，
 * 若存在则先触发增量索引更新，再执行搜索。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { registerTool, type ToolContext } from "./registry.js";
import { loadMemStoresConfig } from "../config/loader.js";
import { searchStore, updateStore } from "../memory/qmd.js";

/** 更新挂起标记文件路径（由 news MCP server 在 fetch_and_store 后写入） */
const PENDING_MARKER = path.join(os.homedir(), ".tinyclaw", "news", ".update-pending");

/**
 * 检查并处理更新挂起标记。
 * 若文件存在，读取其内容（逗号分隔的 store 名列表），触发各 store 的增量索引，再删除标记。
 */
async function flushPendingUpdates(agentId: string): Promise<void> {
  if (!fs.existsSync(PENDING_MARKER)) return;
  let names: string[] = [];
  try {
    const content = fs.readFileSync(PENDING_MARKER, "utf-8").trim();
    names = content
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  } catch { /* ignore */ }

  if (names.length === 0) {
    names = ["news"];
  }

  for (const name of names) {
    try {
      await updateStore(name, agentId);
    } catch (e) {
      console.warn(`[search_store] updateStore(${name}) 失败：${e}`);
    }
  }

  try {
    fs.unlinkSync(PENDING_MARKER);
  } catch { /* ignore */ }
}

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
          "在本地知识库（MemStore）中做语义向量搜索。当前没有已启用的 MemStore，" +
          "请在 ~/.tinyclaw/memstores.toml 中配置并设置 enabled = true。",
        parameters: {
          type: "object",
          properties: {
            store: { type: "string", description: "MemStore 名称" },
            query: { type: "string", description: "搜索查询" },
            limit: { type: "number", description: "最多返回结果数，默认 8" },
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
  const storeTitles = enabledStores
    .map((s) => `- \`${s.name}\`：${s.title}`)
    .join("\n");

  registerTool({
    requiresMFA: false,
    spec: {
      type: "function",
      function: {
        name: "search_store",
        description:
          `在本地知识库（MemStore）中做语义向量搜索。\n\n` +
          `**可用的知识库：**\n${storeTitles}\n\n` +
          `适用场景：查询历史新闻、笔记、文档等本地存档内容。` +
          `首次调用前若有新数据写入，会自动触发增量索引更新。`,
        parameters: {
          type: "object",
          properties: {
            store: {
              type: "string",
              enum: storeNames,
              description: `要搜索的知识库名称，可选：${storeNames.join(" / ")}`,
            },
            query: {
              type: "string",
              description: "搜索查询（自然语言，支持中英文）",
            },
            limit: {
              type: "number",
              description: "最多返回结果数，默认 8，最大 20",
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

      // 先处理待更新标记
      await flushPendingUpdates(agentId);

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
