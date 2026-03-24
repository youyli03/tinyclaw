/**
 * QMD 向量记忆存储
 *
 * 每个 Agent 拥有独立的 QMDStore，存储在 ~/.tinyclaw/agents/<id>/memory/
 * dbPath = agents/<id>/memory/index.sqlite
 * 集合监控 agents/<id>/memory/*.md（压缩摘要文件）
 *
 * searchMemory() 实现四层增强：
 * 1. 混合搜索：BM25(searchLex) × 0.3 + 向量(searchVector) × 0.7，互补精确与语义
 * 2. 时间衰减：指数衰减 e^(-λ×days)，半衰期 30 天，旧记忆自然淡出
 * 3. 常青记忆（Evergreen）：MEM.md / MEMORY.md 等核心文件豁免衰减，永远保持全权重
 * 4. MMR 多样性重排：Jaccard 集合相似度去冗余，避免同一文档多段占满结果
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { QMDStore, UpdateProgress, UpdateResult, EmbedProgress, EmbedResult, SearchResult } from "@tobilu/qmd";
import { loadConfig, loadMemStoresConfig } from "../config/loader.js";

// ── 时间衰减常量 ──────────────────────────────────────────────────────────────

/** 半衰期（天），30 天后分数衰减为原来的 50% */
const DECAY_HALF_LIFE_DAYS = 30;
/** 衰减系数 λ = ln(2) / T½ */
const DECAY_LAMBDA = Math.LN2 / DECAY_HALF_LIFE_DAYS;

/** 混合搜索权重：向量 */
const WEIGHT_VECTOR = 0.7;
/** 混合搜索权重：BM25 */
const WEIGHT_LEX = 0.3;

/** MMR 多样性参数 λ（越大越倾向相关性，越小越倾向多样性） */
const MMR_LAMBDA = 0.7;

/**
 * 常青记忆路径关键词列表：匹配这些路径的 chunk 豁免时间衰减。
 * 对应 MEM.md（持久偏好）、MEMORY.md（精华知识）、patterns.md（模式总结）等长期稳定文件。
 */
const EVERGREEN_PATH_KEYWORDS = ["MEM.md", "MEMORY.md", "patterns.md", "mem.md", "memory.md"];

// ── 工具函数 ──────────────────────────────────────────────────────────────────

/**
 * 从 SearchResult 的 filepath / displayPath 或 modifiedAt 中推断文档日期。
 * 优先使用 modifiedAt（ISO 字符串），fallback 到路径名中的 YYYY-MM-DD 模式。
 * 无法解析时返回 null（调用方应按今天处理，即 daysAgo=0，不衰减）。
 */
function extractDateFromResult(r: SearchResult): Date | null {
  // 优先：modifiedAt 字段
  const modifiedAt = (r as unknown as { modifiedAt?: string }).modifiedAt;
  if (modifiedAt) {
    const d = new Date(modifiedAt);
    if (!isNaN(d.getTime())) return d;
  }
  // Fallback：从 filepath 或 displayPath 中用正则提取 YYYY-MM-DD
  const pathStr = r.filepath ?? r.displayPath ?? "";
  const m = pathStr.match(/(\d{4}-\d{2}-\d{2})/);
  if (m) {
    const d = new Date(m[1]!);
    if (!isNaN(d.getTime())) return d;
  }
  return null;
}

/**
 * 判断某条搜索结果是否属于常青记忆（豁免时间衰减）。
 * 检查 displayPath 和 filepath 是否包含任意常青关键词。
 */
function isEvergreen(r: SearchResult): boolean {
  const combined = `${r.filepath ?? ""}|${r.displayPath ?? ""}`;
  return EVERGREEN_PATH_KEYWORDS.some((kw) => combined.includes(kw));
}

/**
 * 计算时间衰减因子。
 * 常青记忆返回 1.0（无衰减）；其余按指数模型计算。
 */
function decayFactor(r: SearchResult, now: Date): number {
  if (isEvergreen(r)) return 1.0;
  const date = extractDateFromResult(r);
  if (!date) return 1.0; // 无法解析日期，不衰减
  const daysAgo = Math.max(0, (now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));
  return Math.exp(-DECAY_LAMBDA * daysAgo);
}

/**
 * 将文本分词为 token 集合，用于 Jaccard 相似度计算。
 * 使用空格拆分 + 3-gram 字符切片，兼顾英文词语和中文短语。
 */
function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  // 空格拆分（英文词）
  const words = text.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  for (const w of words) tokens.add(w);
  // 3-gram（中文及连续字符）
  for (let i = 0; i + 3 <= text.length; i++) {
    tokens.add(text.slice(i, i + 3));
  }
  return tokens;
}

/**
 * 计算两个 token 集合的 Jaccard 相似度（0~1）。
 */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) {
    if (b.has(t)) intersection++;
  }
  return intersection / (a.size + b.size - intersection);
}

/**
 * MMR（Maximal Marginal Relevance）多样性重排。
 * 每轮从候选集中选择 score×λ - maxSimilarity×(1-λ) 最大的结果，直到选出 k 条。
 * @param candidates 已按 decayedScore 降序排列的候选列表
 * @param k 最终选出条数
 * @param lambda 相关性 vs 多样性权衡（0=纯多样，1=纯相关）
 */
function applyMMR(
  candidates: Array<SearchResult & { decayedScore: number; blendedScore: number }>,
  k: number,
  lambda = MMR_LAMBDA
): Array<SearchResult & { decayedScore: number; blendedScore: number }> {  if (candidates.length <= k) return candidates;

  // 预计算所有候选的 token 集合，按原始下标索引（避免移动元素后丢失映射）
  const allTokenSets: Set<string>[] = candidates.map((r) => tokenize(r.body ?? ""));

  // 用 available 布尔数组标记哪些候选尚未被选中
  const available = new Array<boolean>(candidates.length).fill(true);
  const selectedOriginalIndices: number[] = [];

  while (selectedOriginalIndices.length < k) {
    let bestIdx = -1;
    let bestMMRScore = -Infinity;

    for (let i = 0; i < candidates.length; i++) {
      if (!available[i]) continue;
      const relevance = candidates[i]!.decayedScore;
      // 与已选集合的最大 Jaccard 相似度
      let maxSim = 0;
      for (const selIdx of selectedOriginalIndices) {
        const sim = jaccard(allTokenSets[i]!, allTokenSets[selIdx]!);
        if (sim > maxSim) maxSim = sim;
      }
      const mmrScore = lambda * relevance - (1 - lambda) * maxSim;
      if (mmrScore > bestMMRScore) {
        bestMMRScore = mmrScore;
        bestIdx = i;
      }
    }

    if (bestIdx === -1) break; // 所有候选已选完
    available[bestIdx] = false;
    selectedOriginalIndices.push(bestIdx);
  }

  return selectedOriginalIndices.map((i) => candidates[i]!);
}

const storeMap = new Map<string, QMDStore>();

/**
 * 内部：展开 ~ 为用户主目录
 */
function expandHome(p: string): string {
  if (p.startsWith("~/") || p === "~") {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

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

  // 基础 memory collection
  const collections: Record<string, { path: string; pattern: string }> = {
    memory: {
      path: agentMemDir,
      pattern: "**/*.md",
    },
  };

  // 注册 memstores.toml 中启用的额外 store
  const memStoresCfg = loadMemStoresConfig();
  for (const store of memStoresCfg.stores) {
    if (!store.enabled) continue;
    const storePath = expandHome(store.path);
    fs.mkdirSync(storePath, { recursive: true });
    collections[store.name] = {
      path: storePath,
      pattern: store.pattern,
    };
  }

  const s = await createStore({
    dbPath: path.join(agentMemDir, "index.sqlite"),
    config: { collections },
  });

  storeMap.set(agentId, s);
  return s;
}

/**
 * 在指定 Agent 的 QMD 中搜索与 query 相关的历史记忆片段。
 *
 * 四层增强检索流程：
 * 1. 混合搜索：同时调用 searchVector（向量语义）和 searchLex（BM25 关键词），各取 limit×2 条
 * 2. 加权融合：向量结果 ×0.7，BM25 结果 ×0.3，按 filepath 合并取最高分
 * 3. 时间衰减：decayedScore = blendedScore × e^(-λ×daysAgo)；常青文件（MEM.md 等）豁免衰减
 * 4. MMR 重排：Jaccard 集合相似度去冗余，确保结果多样性
 *
 * 返回格式化好的字符串，可直接注入 system prompt。
 * 无结果时返回空字符串；memory 未启用时返回 null。
 */
export async function searchMemory(query: string, agentId = "default", limit = 5): Promise<string | null> {
  const s = await getQMDStore(agentId);
  if (!s) return null; // memory 未启用

  // ── 1. 混合搜索：各取 limit×2 条备选，确保融合后有足够候选 ─────────────────
  const fetchLimit = limit * 2;
  const [vecResults, lexResults] = await Promise.all([
    s.searchVector(query, { limit: fetchLimit, collection: "memory" }).catch(() => [] as SearchResult[]),
    s.searchLex(query, { limit: fetchLimit, collection: "memory" }).catch(() => [] as SearchResult[]),
  ]);

  if (vecResults.length === 0 && lexResults.length === 0) return "";

  // ── 2. 加权融合：按 filepath 为键合并，向量 ×0.7，BM25 ×0.3 ─────────────────
  // 用 Map 按 filepath 去重，同一 chunk 取加权合并后的最高分
  const blendMap = new Map<string, SearchResult & { blendedScore: number }>();

  for (const r of vecResults) {
    const key = r.filepath ?? r.displayPath;
    const weighted = r.score * WEIGHT_VECTOR;
    const existing = blendMap.get(key);
    if (!existing || existing.blendedScore < weighted) {
      blendMap.set(key, { ...r, blendedScore: weighted });
    }
  }

  for (const r of lexResults) {
    const key = r.filepath ?? r.displayPath;
    const weighted = r.score * WEIGHT_LEX;
    const existing = blendMap.get(key);
    if (existing) {
      // 同一 chunk 出现在两路结果中：累加得分（体现双重命中的价值）
      existing.blendedScore += weighted;
    } else {
      blendMap.set(key, { ...r, blendedScore: weighted });
    }
  }

  // ── 3. 时间衰减：常青文件豁免，日记文件指数衰减 ──────────────────────────────
  type BlendedResult = SearchResult & { blendedScore: number };
  type DecayedResult = BlendedResult & { decayedScore: number };

  const now = new Date();
  const decayed: DecayedResult[] = Array.from(blendMap.values()).map((r) => ({
    ...r,
    decayedScore: r.blendedScore * decayFactor(r, now),
  }));

  // 按 decayedScore 降序排列
  decayed.sort((a, b) => b.decayedScore - a.decayedScore);

  // ── 4. MMR 多样性重排：避免同文档多段占满结果 ────────────────────────────────
  const reranked = applyMMR(decayed, limit);

  if (reranked.length === 0) return "";

  // ── 格式化输出 ────────────────────────────────────────────────────────────────
  const lines = reranked.map((r) => {
    // 显示原始融合分（不显示衰减后分，避免用户困惑于低分旧记忆）
    const score = Math.round(r.blendedScore * 100);
    const evergreen = isEvergreen(r) ? " 🌿" : "";
    // r.body 即为命中 chunk 的完整文本（QMD 直接在结果中携带）
    // 注意：r.filepath 是 "qmd://..." 虚拟路径，不能用 fs.readFileSync 读取
    const preview = (r.body ?? "").trim();
    return `[${score}%${evergreen}] ${r.title || r.displayPath}\n${preview}`.trim();
  });

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

/**
 * 在指定 MemStore collection 中做向量搜索。
 * 返回格式化后的 Markdown 字符串，可直接交给 LLM；无结果返回空字符串；未启用返回 null。
 */
export async function searchStore(
  name: string,
  query: string,
  agentId = "default",
  limit = 8
): Promise<string | null> {
  const s = await getQMDStore(agentId);
  if (!s) return null;

  const results = await s.searchVector(query, { limit, collection: name });
  if (results.length === 0) return "";

  const lines = results.map((r) => {
    const score = Math.round(r.score * 100);
    // r.body 即为命中 chunk 的完整文本，r.filepath 是 "qmd://..." 虚拟路径无法直接读取
    const preview = (r.body ?? "").trim();
    return `[${score}%] ${r.title || r.displayPath}\n${preview}`.trim();
  });

  return `## Store: ${name} 搜索结果\n\n${lines.join("\n\n---\n\n")}`;
}

/**
 * 触发指定 MemStore collection 的增量索引更新。
 * 在 MCP server 写入新文件后调用，确保向量库与文件保持同步。
 */
export async function updateStore(name: string, agentId = "default"): Promise<void> {
  const s = await getQMDStore(agentId);
  if (!s) return;
  await s.update({ collections: [name] });
  await s.embed();
}
