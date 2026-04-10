import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { agentManager } from "../core/agent-manager.js";

export const CARD_TYPES = [
  "preference",
  "constraint",
  "profile",
  "relationship",
  "routine",
  "open_loop",
  "life_event",
  "decision",
  "task_state",
  "project_fact",
  "pattern",
] as const;

export const CARD_STATUSES = ["active", "obsolete", "resolved"] as const;

export type MemoryCardType = typeof CARD_TYPES[number];
export type MemoryCardStatus = typeof CARD_STATUSES[number];

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
  tags?: string[];
  supersedes?: string[];
}

function normalizeSlug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "card";
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
  const ts = tsRaw && !Number.isNaN(new Date(tsRaw).getTime()) ? new Date(tsRaw).toISOString() : new Date().toISOString();

  const importanceRaw = Number(obj.importance ?? 0.7);
  const importance = Math.min(1, Math.max(0, Number.isFinite(importanceRaw) ? importanceRaw : 0.7));

  const idRaw = String(obj.id ?? "").trim();
  const id = idRaw || `${ts.slice(0, 10)}-${type}-${normalizeSlug(title)}`;

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
  return [
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
  ].join("\n");
}

function parseFrontmatterValue(line: string): string {
  const idx = line.indexOf(":");
  return idx >= 0 ? line.slice(idx + 1).trim() : "";
}

function parseFrontmatterArray(raw: string): string[] {
  const trimmed = raw.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return [];
  return trimmed.slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean);
}

export function readExistingCards(agentId: string): MemoryCard[] {
  const root = agentManager.cardsDir(agentId);
  if (!fs.existsSync(root)) return [];

  const files = fs.readdirSync(root, { recursive: true, withFileTypes: true });
  const cards: MemoryCard[] = [];
  for (const entry of files) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const fullPath = path.join(entry.parentPath, entry.name);
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
      summary: match[3]!.trim(),
    });
    if (normalized) cards.push(normalized);
  }
  return cards;
}

function isSimilarCard(a: MemoryCard, b: MemoryCard): boolean {
  const titleA = a.title.trim().toLowerCase();
  const titleB = b.title.trim().toLowerCase();
  return a.type === b.type && a.scope === b.scope && (titleA === titleB || titleA.includes(titleB) || titleB.includes(titleA));
}

export function saveCards(cards: MemoryCard[], agentId: string): { saved: number; obsoleted: number } {
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
