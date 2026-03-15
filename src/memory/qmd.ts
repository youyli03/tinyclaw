/**
 * QMD 向量记忆存储
 *
 * 每个 Agent 拥有独立的 QMDStore，存储在 ~/.tinyclaw/agents/<id>/memory/
 * dbPath = agents/<id>/memory/index.sqlite
 * 集合监控 agents/<id>/memory/*.md（压缩摘要文件）
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createStore, type QMDStore } from "@tobilu/qmd";
import { loadConfig } from "../config/loader.js";

const storeMap = new Map<string, QMDStore>();

async function getQMDStore(agentId = "default"): Promise<QMDStore | null> {
  const cfg = loadConfig();
  if (!cfg.memory.enabled) return null;

  const existing = storeMap.get(agentId);
  if (existing) return existing;

  const agentMemDir = path.join(os.homedir(), ".tinyclaw", "agents", agentId, "memory");
  fs.mkdirSync(agentMemDir, { recursive: true });

  process.env["QMD_EMBED_MODEL"] = cfg.memory.embedModel;

  const s = await createStore({
    dbPath: path.join(agentMemDir, "index.sqlite"),
    config: {
      collections: {
        memory: {
          path: agentMemDir,
          pattern: "*.md",
        },
      },
    },
  });

  storeMap.set(agentId, s);
  return s;
}

/**
 * 在指定 Agent 的 QMD 中搜索与 query 相关的历史记忆片段。
 * 返回格式化好的字符串，可直接注入 system prompt。
 * 无结果时返回空字符串。
 */
export async function searchMemory(query: string, agentId = "default", limit = 5): Promise<string> {
  const s = await getQMDStore(agentId);
  if (!s) return "";
  const results = await s.search({ query, limit, minScore: 0.3 });

  if (results.length === 0) return "";

  const lines = results.map((r) => {
    const score = Math.round(r.score * 100);
    return `[${score}%] ${r.title ?? r.displayPath}\n${r.bestChunk ?? ""}`.trim();
  });

  return `## 相关历史记忆\n\n${lines.join("\n\n---\n\n")}`;
}

/**
 * 触发指定 Agent 的 QMD 增量索引。
 * 在写入新的压缩摘要后调用。
 */
export async function updateMemoryIndex(agentId = "default"): Promise<void> {
  const s = await getQMDStore(agentId);
  if (!s) return;
  await s.update({ collections: ["memory"] });
}

export async function closeQMDStore(): Promise<void> {
  for (const [, s] of storeMap) {
    await s.close().catch(() => {});
  }
  storeMap.clear();
}
