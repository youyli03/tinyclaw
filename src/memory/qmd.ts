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
import type { QMDStore, UpdateProgress, UpdateResult, EmbedProgress, EmbedResult } from "@tobilu/qmd";
import { loadConfig } from "../config/loader.js";

const storeMap = new Map<string, QMDStore>();

async function getQMDStore(agentId = "default"): Promise<QMDStore | null> {
  const cfg = loadConfig();
  if (!cfg.memory.enabled) return null;

  const existing = storeMap.get(agentId);
  if (existing) return existing;

  const agentMemDir = path.join(os.homedir(), ".tinyclaw", "agents", agentId, "memory");
  fs.mkdirSync(agentMemDir, { recursive: true });

  // 禁用 Vulkan 编译尝试（此机器无 Vulkan，避免每次启动触发 cmake 噪音）
  // 必须在 @tobilu/qmd 动态 import 之前设置，否则 node-llama-cpp 已经加载
  process.env["NODE_LLAMA_CPP_GPU"] = "false";
  process.env["QMD_EMBED_MODEL"] = cfg.memory.embedModel;

  const { createStore } = await import("@tobilu/qmd");

  const s = await createStore({
    dbPath: path.join(agentMemDir, "index.sqlite"),
    config: {
      collections: {
        memory: {
          path: agentMemDir,
          pattern: "**/*.md",
        },
      },
    },
  });

  storeMap.set(agentId, s);
  return s;
}

/**
 * 在指定 Agent 的 QMD 中搜索与 query 相关的历史记忆片段。
 * 使用 searchVector（仅 embedding 模型，不触发 LLM query expansion）。
 * 返回格式化好的字符串，可直接注入 system prompt。
 * 无结果时返回空字符串；memory 未启用时返回 null。
 */
export async function searchMemory(query: string, agentId = "default", limit = 5): Promise<string | null> {
  const s = await getQMDStore(agentId);
  if (!s) return null;  // memory 未启用
  const results = await s.searchVector(query, { limit });

  if (results.length === 0) return "";

  const lines = await Promise.all(results.map(async (r) => {
    const score = Math.round(r.score * 100);
    // 取文档前 30 行作为预览
    const body = await s.getDocumentBody(r.filepath, { maxLines: 30 });
    const preview = body?.trim() ?? "";
    return `[${score}%] ${r.title || r.displayPath}\n${preview}`.trim();
  }));

  return `## 相关历史记忆\n\n${lines.join("\n\n---\n\n")}`;
}

/**
 * 触发指定 Agent 的 QMD 增量索引（扫描文件 + 生成 embedding）。
 * 在写入新的压缩摘要后调用。
 */
export async function updateMemoryIndex(agentId = "default"): Promise<void> {
  const s = await getQMDStore(agentId);
  if (!s) return;
  await s.update({ collections: ["memory"] });
  await s.embed();
}

export type { UpdateProgress, UpdateResult, EmbedProgress, EmbedResult };

/**
 * 带进度回调的全量重建索引，供 CLI `memory index` 命令使用。
 * 先扫描文件（update），再生成 embedding（embed）。
 * @returns null 表示 memory 未启用
 */
export async function rebuildMemoryIndex(
  agentId = "default",
  onUpdateProgress?: (info: UpdateProgress) => void,
  onEmbedProgress?: (info: EmbedProgress) => void
): Promise<{ update: UpdateResult; embed: EmbedResult } | null> {
  const s = await getQMDStore(agentId);
  if (!s) return null;
  const updateResult = await s.update({
    collections: ["memory"],
    ...(onUpdateProgress ? { onProgress: onUpdateProgress } : {}),
  });
  const embedResult = await s.embed(
    onEmbedProgress ? { onProgress: onEmbedProgress } : undefined
  );
  return { update: updateResult, embed: embedResult };
}

export async function closeQMDStore(): Promise<void> {
  for (const [, s] of storeMap) {
    await s.close().catch(() => {});
  }
  storeMap.clear();
}
