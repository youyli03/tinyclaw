import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { agentManager } from "../core/agent-manager.js";

export const CARD_TYPES = [
  "preference",
  "constraint",
  // "profile",  // 已禁用：用户特征描述，没有行动价值
  "relationship",
  "routine",
  "open_loop",
  "life_event",
  "decision",
  "task_state",
  "project_fact",
  // "pattern",  // 已禁用：行为模式观察，只是描述而非约束
] as const;

export const CARD_STATUSES = ["active", "obsolete", "resolved"] as const;

export type MemoryCardType = (typeof CARD_TYPES)[number];
export type MemoryCardStatus = (typeof CARD_STATUSES)[number];

export interface MemoryCard {
  id: string;
  type: MemoryCardType;
  scope: string;
  facet: string;
  status: MemoryCardStatus;
  importance: number;
  ts: string;
  title: string;
  summary: string;
  /**
   * 支撑该卡片的**逐字原文片段**（取自 transcript 逐字层）。
   * 卡片是有损摘要，细节容易丢；带上原文引用后，检索/注入时能看到原话。
   */
  quote?: string;
  /** 原文来源文件（相对 agent 目录，如 `memory/transcript/2026-09-09.md`） */
  source?: string;
  tags?: string[];
  supersedes?: string[];
}

function normalizeSlug(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "card"
  );
}

function safeArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((x): x is string => typeof x === "string" && x.trim().length > 0);
}

function normalizeCard(raw: unknown): MemoryCard | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const type = String(obj.type ?? "").trim() as MemoryCardType;
  if (!(CARD_TYPES as readonly string[]).includes(type)) return null;

  const statusRaw = String(obj.status ?? "active").trim();
  const status = (CARD_STATUSES as readonly string[]).includes(statusRaw)
    ? (statusRaw as MemoryCardStatus)
    : "active";

  const title = String(obj.title ?? "").trim();
  const summary = String(obj.summary ?? "").trim();
  const scope = String(obj.scope ?? "general").trim() || "general";
  const facet = String(obj.facet ?? type).trim() || type;
  if (!title || !summary) return null;

  const tsRaw = String(obj.ts ?? "").trim();
  const ts =
    tsRaw && !Number.isNaN(new Date(tsRaw).getTime())
      ? new Date(tsRaw).toISOString()
      : new Date().toISOString();

  const importanceRaw = Number(obj.importance ?? 0.7);
  const importance = Math.min(1, Math.max(0, Number.isFinite(importanceRaw) ? importanceRaw : 0.7));

  const idRaw = String(obj.id ?? "").trim();
  const id = idRaw || `${ts.slice(0, 10)}-${type}-${normalizeSlug(title)}`;

  const quote = String(obj.quote ?? "").trim();
  const source = String(obj.source ?? "").trim();

  return {
    id,
    type,
    scope,
    facet,
    status,
    importance,
    ts,
    title,
    summary,
    ...(quote ? { quote } : {}),
    ...(source ? { source } : {}),
    tags: safeArray(obj.tags),
    supersedes: safeArray(obj.supersedes),
  };
}

export function parseCardJson(raw: string): MemoryCard[] {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "无新增") return [];
  const jsonMatch = trimmed.match(/\[[\s\S]*\]|\{[\s\S]*\}/);
  if (!jsonMatch) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch {
    return [];
  }

  const list = Array.isArray(parsed) ? parsed : [parsed];
  const cards: MemoryCard[] = [];
  for (const item of list) {
    const normalized = normalizeCard(item);
    if (normalized) cards.push(normalized);
  }
  return cards;
}

function monthDirFor(agentId: string, ts: string): string {
  const month = ts.slice(0, 7);
  return path.join(agentManager.cardsDir(agentId), month);
}

function cardPath(agentId: string, card: MemoryCard): string {
  return path.join(monthDirFor(agentId, card.ts), `${card.id}.md`);
}

function serializeCard(card: MemoryCard): string {
  const tags = (card.tags ?? []).join(", ");
  const supersedes = (card.supersedes ?? []).join(", ");
  const out = [
    "---",
    `id: ${card.id}`,
    `type: ${card.type}`,
    `scope: ${card.scope}`,
    `facet: ${card.facet}`,
    `status: ${card.status}`,
    `importance: ${card.importance}`,
    `ts: ${card.ts}`,
    `tags: [${tags}]`,
    `supersedes: [${supersedes}]`,
    "---",
    "",
    `# ${card.title}`,
    "",
    card.summary,
    "",
  ];
  // 原文引用（逐字）放在正文里，确保卡片被检索/注入时能看到原话
  if (card.quote) {
    out.push(`> **原文**：${card.quote.replace(/\n+/g, " ").trim()}`, "");
    if (card.source) out.push(`> 来源：\`${card.source}\``, "");
  }
  return out.join("\n");
}

function parseFrontmatterValue(line: string): string {
  const idx = line.indexOf(":");
  return idx >= 0 ? line.slice(idx + 1).trim() : "";
}

function parseFrontmatterArray(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return [];
  return trimmed
    .slice(1, -1)
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function readExistingCards(agentId: string): MemoryCard[] {
  const root = agentManager.cardsDir(agentId);
  if (!fs.existsSync(root)) return [];

  const files = fs.readdirSync(root, { recursive: true, withFileTypes: true });
  const cards: MemoryCard[] = [];
  for (const entry of files) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    // Node 20.12 起 Dirent 用 parentPath；更早版本（含 RK3588 上的 20.11）只有 path。
    // 不做兼容会导致 path.join(undefined, ...) 抛错，卡片读取整条链路失效。
    const dirent = entry as unknown as { parentPath?: string; path?: string };
    const dirPath = dirent.parentPath ?? dirent.path ?? root;
    const fullPath = path.join(dirPath, entry.name);
    const content = fs.readFileSync(fullPath, "utf-8");
    const match = content.match(/^---\n([\s\S]*?)\n---\n\n#\s+(.+)\n\n([\s\S]*)$/);
    if (!match) continue;
    const metaLines = match[1]!.split("\n");
    const meta: Record<string, string> = {};
    for (const line of metaLines) {
      const key = line.split(":", 1)[0]?.trim();
      if (!key) continue;
      meta[key] = parseFrontmatterValue(line);
    }
    const bodyRaw = match[3]!.trim();
    // 正文里可能带「> **原文**：…」引用块，需从 summary 中剥离
    const quoteIdx = bodyRaw.indexOf("\n\n> **原文**：");
    const summaryText = (quoteIdx >= 0 ? bodyRaw.slice(0, quoteIdx) : bodyRaw).trim();
    const quoteBlock = quoteIdx >= 0 ? bodyRaw.slice(quoteIdx) : "";
    const quote = quoteBlock.match(/^> \*\*原文\*\*：(.+)$/m)?.[1]?.trim();
    const source = quoteBlock.match(/^> 来源：`(.+)`$/m)?.[1]?.trim();

    const normalized = normalizeCard({
      id: meta.id,
      type: meta.type,
      scope: meta.scope,
      facet: meta.facet,
      status: meta.status,
      importance: Number(meta.importance),
      ts: meta.ts,
      tags: parseFrontmatterArray(meta.tags ?? "[]"),
      supersedes: parseFrontmatterArray(meta.supersedes ?? "[]"),
      title: match[2]!.trim(),
      summary: summaryText,
      ...(quote ? { quote } : {}),
      ...(source ? { source } : {}),
    });
    if (normalized) cards.push(normalized);
  }
  return cards;
}

function isSimilarCard(a: MemoryCard, b: MemoryCard): boolean {
  if (a.type !== b.type || a.scope !== b.scope) return false;
  // preference/constraint: 同 facet 即视为重复，无需比较标题（避免同义卡片堆积）
  if ((a.type === "preference" || a.type === "constraint") && a.facet === b.facet) return true;
  const titleA = a.title.trim().toLowerCase();
  const titleB = b.title.trim().toLowerCase();
  return titleA === titleB || titleA.includes(titleB) || titleB.includes(titleA);
}

export function saveCards(
  cards: MemoryCard[],
  agentId: string
): { saved: number; obsoleted: number } {
  if (cards.length === 0) return { saved: 0, obsoleted: 0 };

  const existing = readExistingCards(agentId);
  let obsoleted = 0;

  for (const card of cards) {
    fs.mkdirSync(monthDirFor(agentId, card.ts), { recursive: true });

    for (const oldCard of existing) {
      if (oldCard.status !== "active") continue;
      if (!isSimilarCard(oldCard, card)) continue;
      oldCard.status = card.status === "resolved" ? "resolved" : "obsolete";
      oldCard.supersedes = Array.from(new Set([...(oldCard.supersedes ?? []), card.id]));
      fs.writeFileSync(cardPath(agentId, oldCard), serializeCard(oldCard), "utf-8");
      obsoleted++;
    }

    fs.writeFileSync(cardPath(agentId, card), serializeCard(card), "utf-8");
  }

  return { saved: cards.length, obsoleted };
}

export function appendCard(card: MemoryCard, agentId: string): string {
  const normalized = normalizeCard(card);
  if (!normalized) throw new Error("无效的记忆卡片");
  const result = saveCards([normalized], agentId);
  return `已写入记忆卡片 ${normalized.id}(saved=${result.saved}, obsoleted=${result.obsoleted})`;
}

export function cardsRootPath(agentId: string): string {
  return path.join(os.homedir(), ".tinyclaw", "agents", agentId, "cards");
}

// ── 卡片时间衰减评分 ──────────────────────────────────────────────────────

/** 卡片类型对应的半衰期(天) — 类型越稳定半衰期越长 */
const CARD_TYPE_HALF_LIFE: Record<string, number> = {
  preference:   180,  // 用户偏好,高度稳定
  constraint:   180,  // 行为约束,几乎永不过期
  decision:      60,  // 设计决策,中等周期
  project_fact:  60,  // 项目事实,随项目演进
  relationship:  90,  // 人际关系,较稳定
  routine:       45,  // 例行习惯,可能变化
  life_event:   365,  // 人生事件,长期记忆
  open_loop:     14,  // 待办/进行中,短期活跃
  task_state:    14,  // 任务状态,短期
};

/**
 * 计算卡片在当前时间的衰减分数。
 * score = importance × 2^(-daysSinceCreation / halfLife)
 * - 刚创建: 衰减因子 ≈ 1, score ≈ importance
 * - 经过 halfLife 天: 衰减因子 = 0.5, score = 0.5 × importance
 * - 长期: 趋近于 0 但始终 > 0
 */
export function scoreCard(card: MemoryCard, now: Date = new Date()): number {
  const ts = new Date(card.ts);
  if (isNaN(ts.getTime())) return card.importance;
  const daysSince = Math.max(0, (now.getTime() - ts.getTime()) / (1000 * 60 * 60 * 24));
  const halfLife = CARD_TYPE_HALF_LIFE[card.type] ?? 45;
  const decay = Math.pow(2, -daysSince / halfLife);
  return card.importance * decay;
}

/**
 * 按衰减分数排序卡片,返回 Top-N。
 * score < minScore 的卡片会被过滤(默认 0.15)。
 */
export function sortCardsByScore(
  cards: MemoryCard[],
  maxCount: number,
  minScore = 0.15,
  now?: Date
): MemoryCard[] {
  const scored = cards
    .map((c) => ({ card: c, score: scoreCard(c, now) }))
    .filter((s) => s.score >= minScore);
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxCount).map((s) => s.card);
}

/**
 * 将超过 maxAgeDays 天未更新的 open_loop 卡片标记为 obsolete。
 * 不删除文件，保留历史可查。
 */
export function ageOpenLoopCards(agentId: string, maxAgeDays = 30): { aged: number } {
  const now = new Date();
  const existing = readExistingCards(agentId);
  let aged = 0;
  for (const card of existing) {
    if (card.type !== "open_loop" || card.status !== "active") continue;
    const ts = new Date(card.ts);
    if (isNaN(ts.getTime())) continue;
    const daysOld = (now.getTime() - ts.getTime()) / (1000 * 60 * 60 * 24);
    if (daysOld >= maxAgeDays) {
      card.status = "obsolete";
      const filePath = cardPath(agentId, card);
      if (fs.existsSync(filePath)) {
        fs.writeFileSync(filePath, serializeCard(card), "utf-8");
        aged++;
      }
    }
  }
  return { aged };
}
