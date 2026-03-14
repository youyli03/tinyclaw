import { createStore, type QMDStore } from "@tobilu/qmd";
import { getDataPath, getDataFile } from "../config/loader.js";
import { loadConfig } from "../config/loader.js";

let store: QMDStore | null = null;

/**
 * 获取（或初始化）QMD store 单例。
 * 当 config.memory.enabled = false 时返回 null，所有上层函数视作 no-op。
 * dbPath 固定在 ~/.tinyclaw/memory/index.sqlite
 * embedding 模型从 config.memory.embedModel 读取。
 */
async function getQMDStore(): Promise<QMDStore | null> {
  const cfg = loadConfig();
  if (!cfg.memory.enabled) return null;
  if (store) return store;

  // 确保目录存在
  getDataPath("memory");

  process.env["QMD_EMBED_MODEL"] = cfg.memory.embedModel;

  store = await createStore({
    dbPath: getDataFile("memory", "index.sqlite"),
    config: {
      collections: {
        sessions: {
          path: getDataPath("memory", "sessions"),
          pattern: "**/*.md",
        },
      },
    },
  });

  return store;
}

/**
 * 在 QMD 中搜索与 query 相关的历史记忆片段。
 * 返回格式化好的字符串，可直接注入 system prompt。
 * 无结果时返回空字符串。
 */
export async function searchMemory(query: string, limit = 5): Promise<string> {
  const s = await getQMDStore();
  if (!s) return ""; // memory disabled
  const results = await s.search({ query, limit, minScore: 0.3 });

  if (results.length === 0) return "";

  const lines = results.map((r) => {
    const score = Math.round(r.score * 100);
    return `[${score}%] ${r.title ?? r.displayPath}\n${r.bestChunk ?? ""}`.trim();
  });

  return `## 相关历史记忆\n\n${lines.join("\n\n---\n\n")}`;
}

/**
 * 触发 QMD 对 sessions 集合的增量索引。
 * 在写入新的对话记录后调用。
 */
export async function updateMemoryIndex(): Promise<void> {
  const s = await getQMDStore();
  if (!s) return; // memory disabled
  await s.update({ collections: ["sessions"] });
}

export async function closeQMDStore(): Promise<void> {
  if (store) {
    await store.close();
    store = null;
  }
}
