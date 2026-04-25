/**
 * QMD 向量记忆存储
 *
 * 每个 Agent 拥有独立的 QMDStore,存储在 ~/.tinyclaw/agents/<id>/memory/
 * dbPath = agents/<id>/memory/index.sqlite
 * 集合监控 agents/<id>/memory/*.md(压缩摘要文件)
 *
 * searchMemory() 实现四层增强:
 * 1. 混合搜索:BM25(searchLex) × 0.3 + 向量(searchVector) × 0.7,互补精确与语义
 * 2. 时间衰减:指数衰减 e^(-λ×days),半衰期 30 天,旧记忆自然淡出
 * 3. 常青记忆(Evergreen):MEM.md / ACTIVE.md / cards 等核心文件豁免衰减,永远保持全权重
 * 4. MMR 多样性重排:Jaccard 集合相似度去冗余,避免同一文档多段占满结果
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { QMDStore, UpdateProgress, UpdateResult, EmbedProgress, EmbedResult, SearchResult } from "@tobilu/qmd";
import { loadConfig, loadMemStoresConfig } from "../config/loader.js";
import { agentManager } from "../core/agent-manager.js";
import { CARD_TYPES, type MemoryCardType } from "./cards.js";

const DECAY_HALF_LIFE_DAYS = 30;
const DECAY_LAMBDA = Math.LN2 / DECAY_HALF_LIFE_DAYS;
const WEIGHT_VECTOR = 0.7;
const WEIGHT_LEX = 0.3;
const MMR_LAMBDA = 0.7;
const ROUTED_FETCH_LIMIT_FACTOR = 2;

const MEMORY_COLLECTION = "memory";
const ACTIVE_COLLECTION = "active";
const CARDS_COLLECTION = "cards";
const CODE_NOTES_COLLECTION = "code_notes";

const EVERGREEN_PATH_KEYWORDS = ["MEM.md", "ACTIVE.md", "MEMORY.md", "patterns.md", "/cards/", "mem.md", "active.md", "memory.md"];

type MemoryQueryKind = "preference_query" | "active_context_query" | "decision_query" | "profile_query" | "general_query";
type MemorySource = "长期记忆" | "当前活跃上下文" | "相关卡片" | "近期日记" | "项目记忆";
type SearchCandidate = SearchResult & { blendedScore: number; decayedScore: number; memorySource: MemorySource };

function classifyMemoryQuery(query: string): MemoryQueryKind {
  const q = query.toLowerCase();
  if (/(喜欢|偏好|默认|不要|每次都要|习惯|风格|简洁|详细)/.test(query) || /(prefer|default|don't|style|habit)/.test(q)) {
    return "preference_query";
  }
  if (/(最近|当前|现在|做到哪了|还在跟进吗|未完成|正在做|近况)/.test(query)) {
    return "active_context_query";
  }
  if (/(为什么|当时怎么定|原因|决策|为什么这么做)/.test(query)) {
    return "decision_query";
  }
  if (/(我之前提过谁|我一般|我的习惯|关系|家人|朋友|身份)/.test(query)) {
    return "profile_query";
  }
  return "general_query";
}

function queryCardTypes(kind: MemoryQueryKind): MemoryCardType[] {
  switch (kind) {
    case "preference_query":
      return ["preference", "constraint", "routine"];
    case "active_context_query":
      return ["open_loop", "task_state"];
    case "decision_query":
      return ["decision", "pattern", "project_fact"];
    case "profile_query":
      return ["profile", "relationship", "routine"];
    default:
      return [...CARD_TYPES];
  }
}

function extractDateFromResult(r: SearchResult): Date | null {
  const modifiedAt = (r as unknown as { modifiedAt?: string }).modifiedAt;
  if (modifiedAt) {
    const d = new Date(modifiedAt);
    if (!isNaN(d.getTime())) return d;
  }
  const pathStr = r.filepath ?? r.displayPath ?? "";
  const m = pathStr.match(/(\d{4}-\d{2}-\d{2})/);
  if (m) {
    const d = new Date(m[1]!);
    if (!isNaN(d.getTime())) return d;
  }
  return null;
}

function isEvergreen(r: SearchResult): boolean {
  const combined = `${r.filepath ?? ""}|${r.displayPath ?? ""}`;
  return EVERGREEN_PATH_KEYWORDS.some((kw) => combined.includes(kw));
}

function decayFactor(r: SearchResult, now: Date): number {
  if (isEvergreen(r)) return 1.0;
  const date = extractDateFromResult(r);
  if (!date) return 1.0;
  const daysAgo = Math.max(0, (now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24));
  return Math.exp(-DECAY_LAMBDA * daysAgo);
}

function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  const words = text.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  for (const w of words) tokens.add(w);
  for (let i = 0; i + 3 <= text.length; i++) tokens.add(text.slice(i, i + 3));
  return tokens;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

function applyMMR<T extends SearchResult & { decayedScore: number; blendedScore: number }>(
  candidates: T[],
  k: number,
  lambda = MMR_LAMBDA
): T[] {
  if (candidates.length <= k) return candidates;
  const allTokenSets = candidates.map((r) => tokenize(r.body ?? ""));
  const available = new Array<boolean>(candidates.length).fill(true);
  const selectedOriginalIndices: number[] = [];

  while (selectedOriginalIndices.length < k) {
    let bestIdx = -1;
    let bestMMRScore = -Infinity;
    for (let i = 0; i < candidates.length; i++) {
      if (!available[i]) continue;
      const relevance = candidates[i]!.decayedScore;
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
    if (bestIdx === -1) break;
    available[bestIdx] = false;
    selectedOriginalIndices.push(bestIdx);
  }

  return selectedOriginalIndices.map((i) => candidates[i]!);
}

const storeMap = new Map<string, QMDStore>();
const storeInitLock = new Map<string, Promise<QMDStore | null>>();

function expandHome(p: string): string {
  if (p.startsWith("~/") || p === "~") return path.join(os.homedir(), p.slice(2));
  return p;
}

async function getQMDStore(agentId = "default"): Promise<QMDStore | null> {
  const cfg = loadConfig();
  if (!cfg.memory.enabled) return null;

  const existing = storeMap.get(agentId);
  if (existing) return existing;
  const inflight = storeInitLock.get(agentId);
  if (inflight) return inflight;

  const init = (async (): Promise<QMDStore | null> => {
    const already = storeMap.get(agentId);
    if (already) return already;

    const agentMemDir = path.join(os.homedir(), ".tinyclaw", "agents", agentId, "memory");
    fs.mkdirSync(agentMemDir, { recursive: true });

    process.env["NODE_LLAMA_CPP_GPU"] = "false";
    process.env["QMD_EMBED_MODEL"] = cfg.memory.embedModel;

    const { createStore } = await import("@tobilu/qmd");
    const codeProjectsDir = agentManager.codeProjectsDir(agentId);
    fs.mkdirSync(codeProjectsDir, { recursive: true });
    const collections: Record<string, { path: string; pattern: string }> = {
      [MEMORY_COLLECTION]: { path: agentMemDir, pattern: "**/*.md" },
      [ACTIVE_COLLECTION]: { path: path.dirname(agentManager.activePath(agentId)), pattern: "ACTIVE.md" },
      [CARDS_COLLECTION]: { path: agentManager.cardsDir(agentId), pattern: "**/*.md" },
      [CODE_NOTES_COLLECTION]: { path: codeProjectsDir, pattern: "**/NOTES.md" },
    };

    const memStoresCfg = loadMemStoresConfig();
    for (const store of memStoresCfg.stores) {
      if (!store.enabled) continue;
      const storePath = expandHome(store.path);
      fs.mkdirSync(storePath, { recursive: true });
      collections[store.name] = { path: storePath, pattern: store.pattern };
    }

    const s = await createStore({
      dbPath: path.join(agentMemDir, "index.sqlite"),
      config: { collections },
    });

    storeMap.set(agentId, s);
    return s;
  })();

  storeInitLock.set(agentId, init);
  try {
    return await init;
  } finally {
    storeInitLock.delete(agentId);
  }
}

async function hybridSearchCollection(
  s: QMDStore,
  collection: string,
  query: string,
  limit: number,
  source: MemorySource
): Promise<SearchCandidate[]> {
  const fetchLimit = Math.max(limit * ROUTED_FETCH_LIMIT_FACTOR, limit);
  const [vecResults, lexResults] = await Promise.all([
    s.searchVector(query, { limit: fetchLimit, collection }).catch(() => [] as SearchResult[]),
    s.searchLex(query, { limit: fetchLimit, collection }).catch(() => [] as SearchResult[]),
  ]);
  if (vecResults.length === 0 && lexResults.length === 0) return [];

  const blendMap = new Map<string, SearchResult & { blendedScore: number }>();
  for (const r of vecResults) {
    const key = r.filepath ?? r.displayPath;
    const weighted = r.score * WEIGHT_VECTOR;
    const existing = blendMap.get(key);
    if (!existing || existing.blendedScore < weighted) blendMap.set(key, { ...r, blendedScore: weighted });
  }
  for (const r of lexResults) {
    const key = r.filepath ?? r.displayPath;
    const weighted = r.score * WEIGHT_LEX;
    const existing = blendMap.get(key);
    if (existing) existing.blendedScore += weighted;
    else blendMap.set(key, { ...r, blendedScore: weighted });
  }

  const now = new Date();
  return Array.from(blendMap.values()).map((r) => ({
    ...r,
    decayedScore: r.blendedScore * decayFactor(r, now),
    memorySource: source,
  })).sort((a, b) => b.decayedScore - a.decayedScore);
}

async function searchCardsByType(s: QMDStore, query: string, limit: number, types: MemoryCardType[]): Promise<SearchCandidate[]> {
  const results = await hybridSearchCollection(s, CARDS_COLLECTION, query, Math.max(limit * 2, limit), "相关卡片");
  return results.filter((r) => {
    const body = (r.body ?? "").toLowerCase();
    return types.some((type) => body.includes(`type: ${type}`));
  });
}

function formatMemorySections(results: SearchCandidate[]): string {
  if (results.length === 0) return "";
  const groups = new Map<MemorySource, SearchCandidate[]>();
  for (const r of results) {
    const existing = groups.get(r.memorySource) ?? [];
    existing.push(r);
    groups.set(r.memorySource, existing);
  }

  const orderedSources: MemorySource[] = ["长期记忆", "当前活跃上下文", "相关卡片", "近期日记", "项目记忆"];
  const sections: string[] = [];
  for (const source of orderedSources) {
    const group = groups.get(source);
    if (!group || group.length === 0) continue;
    const lines = group.map((r) => {
      const score = Math.round(r.blendedScore * 100);
      const evergreen = isEvergreen(r) ? " 🌿" : "";
      const preview = (r.body ?? "").trim();
      return `[${score}%${evergreen}] ${r.title || r.displayPath}\n${preview}`.trim();
    });
    sections.push(`## ${source}\n\n${lines.join("\n\n---\n\n")}`);
  }
  return sections.join("\n\n");
}

export async function searchMemory(query: string, agentId = "default", limit = 5): Promise<string | null> {
  const s = await getQMDStore(agentId);
  if (!s) return null;

  const kind = classifyMemoryQuery(query);
  if (kind === "general_query") {
    const generalResults = await hybridSearchCollection(s, MEMORY_COLLECTION, query, limit, "近期日记");
    if (generalResults.length === 0) return "";
    const reranked = applyMMR(generalResults, limit);
    if (reranked.length === 0) return "";
    return `## 近期日记\n\n${reranked.map((r) => {
      const score = Math.round(r.blendedScore * 100);
      const evergreen = isEvergreen(r) ? " 🌿" : "";
      const preview = (r.body ?? "").trim();
      return `[${score}%${evergreen}] ${r.title || r.displayPath}\n${preview}`.trim();
    }).join("\n\n---\n\n")}`;
  }

  const candidates: SearchCandidate[] = [];
  if (kind === "preference_query" || kind === "decision_query" || kind === "profile_query") {
    const memResults = await hybridSearchCollection(s, MEMORY_COLLECTION, query, limit, "长期记忆");
    candidates.push(...memResults.filter((r) => isEvergreen(r)));
  }
  if (kind === "active_context_query" || kind === "preference_query") {
    const activeResults = await hybridSearchCollection(s, ACTIVE_COLLECTION, query, limit, "当前活跃上下文");
    candidates.push(...activeResults);
  }

  const cardResults = await searchCardsByType(s, query, limit, queryCardTypes(kind));
  candidates.push(...cardResults.slice(0, limit));

  const diaryResults = await hybridSearchCollection(s, MEMORY_COLLECTION, query, limit, "近期日记");
  if (kind === "active_context_query") candidates.push(...diaryResults.filter((r) => !isEvergreen(r)));
  else candidates.push(...diaryResults.slice(0, limit));

  // Code 模式项目记忆(NOTES.md 向量+词法检索)
  const codeNotesResults = await hybridSearchCollection(s, CODE_NOTES_COLLECTION, query, limit, "项目记忆");
  candidates.push(...codeNotesResults.slice(0, limit));

  if (candidates.length === 0) return "";
  const reranked = applyMMR(candidates.sort((a, b) => b.decayedScore - a.decayedScore), limit);
  if (reranked.length === 0) return "";
  return formatMemorySections(reranked);
}

export async function updateMemoryIndex(agentId = "default"): Promise<void> {
  const s = await getQMDStore(agentId);
  if (!s) return;
  await s.update({ collections: [MEMORY_COLLECTION] });
  await s.embed();
}

export type { UpdateProgress, UpdateResult, EmbedProgress, EmbedResult };

export async function rebuildMemoryIndex(
  agentId = "default",
  onUpdateProgress?: (info: UpdateProgress) => void,
  onEmbedProgress?: (info: EmbedProgress) => void
): Promise<{ update: UpdateResult; embed: EmbedResult } | null> {
  const s = await getQMDStore(agentId);
  if (!s) return null;
  const updateResult = await s.update({
    collections: [MEMORY_COLLECTION, ACTIVE_COLLECTION, CARDS_COLLECTION, CODE_NOTES_COLLECTION],
    ...(onUpdateProgress ? { onProgress: onUpdateProgress } : {}),
  });
  const embedResult = await s.embed(onEmbedProgress ? { onProgress: onEmbedProgress } : undefined);
  return { update: updateResult, embed: embedResult };
}

export async function closeQMDStore(): Promise<void> {
  for (const [, s] of storeMap) {
    await s.close().catch(() => {});
  }
  storeMap.clear();
}

export async function searchStore(name: string, query: string, agentId = "default", limit = 8): Promise<string | null> {
  const s = await getQMDStore(agentId);
  if (!s) return null;
  const results = await s.searchVector(query, { limit, collection: name });
  if (results.length === 0) return "";
  const lines = results.map((r) => {
    const score = Math.round(r.score * 100);
    const preview = (r.body ?? "").trim();
    return `[${score}%] ${r.title || r.displayPath}\n${preview}`.trim();
  });
  return `## Store: ${name} 搜索结果\n\n${lines.join("\n\n---\n\n")}`;
}

export async function updateStore(name: string, agentId = "default"): Promise<void> {
  const s = await getQMDStore(agentId);
  if (!s) return;
  await s.update({ collections: [name] });
  await s.embed();
}
