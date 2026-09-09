/**
 * feedback-writer — 用户行为纠正（feedback.md）的读写
 *
 * chat 模式：~/.tinyclaw/agents/<id>/feedback.md
 * code 模式：~/.tinyclaw/agents/<id>/code/feedback.md
 *
 * 格式：`- [YYYY-MM-DD] 纠正内容`
 *
 * 与旧版的区别：
 *  - 写入时**去重**（规范化后相同则跳过），避免同一条纠正被反复追加；
 *  - 写入时**裁剪**，文件超过 MAX_FEEDBACK_CHARS 时从最早条目开始丢弃，
 *    避免无上限增长（旧版只增不减，注入 prompt 时也不截断）；
 *  - 读取时可**限定长度**（保留最近的部分），供 prompt 注入使用。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { agentManager } from "./agent-manager.js";

/** 反馈文件的字符上限；超出时从最早的条目开始裁剪 */
export const MAX_FEEDBACK_CHARS = 4_000;

/** 注入 system prompt 时的最大字符数（只保留最近的部分）；chat / code 共用 */
export const FEEDBACK_INJECT_MAX_CHARS = 3_000;

/** 单条反馈的最大字符数 */
const MAX_ENTRY_CHARS = 300;

/** 规范化条目用于去重：去掉日期前缀与所有空白、统一小写 */
function normalizeEntry(line: string): string {
  return line
    .replace(/^-\s*\[\d{4}-\d{2}-\d{2}\]\s*/, "")
    .replace(/\s+/g, "")
    .toLowerCase();
}

/** 读取文件中的所有条目行（已 trim） */
function readEntries(feedbackPath: string): string[] {
  if (!fs.existsSync(feedbackPath)) return [];
  return fs
    .readFileSync(feedbackPath, "utf-8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- "));
}

/** 把条目数组按上限裁剪后写回 */
function writeEntries(feedbackPath: string, entries: string[]): string {
  const lines = [...entries];
  let out = lines.join("\n") + (lines.length > 0 ? "\n" : "");
  while (out.length > MAX_FEEDBACK_CHARS && lines.length > 1) {
    lines.shift();
    out = lines.join("\n") + "\n";
  }
  fs.mkdirSync(path.dirname(feedbackPath), { recursive: true });
  fs.writeFileSync(feedbackPath, out, "utf-8");
  return out;
}

/**
 * 追加一条用户反馈记录（自动去重 + 裁剪）。
 * @returns `added=false` 表示内容为空或已存在同义条目
 */
export function appendFeedback(
  agentId: string,
  mode: "chat" | "code",
  content: string
): { added: boolean } {
  const entry = content.trim().replace(/\s*\n\s*/g, " ").slice(0, MAX_ENTRY_CHARS);
  if (!entry) return { added: false };

  const feedbackPath = agentManager.feedbackPath(agentId, mode);
  const entries = readEntries(feedbackPath);
  const target = normalizeEntry(entry);
  if (entries.some((l) => normalizeEntry(l) === target)) return { added: false };

  const date = new Date().toISOString().slice(0, 10);
  entries.push(`- [${date}] ${entry}`);
  writeEntries(feedbackPath, entries);
  return { added: true };
}

/**
 * 压缩既有 feedback 文件：去重 + 按上限裁剪。
 * 供每日维护调用（历史文件可能是旧版无上限写入的）。
 */
export function compactFeedback(
  agentId: string,
  mode: "chat" | "code"
): { before: number; after: number } {
  const feedbackPath = agentManager.feedbackPath(agentId, mode);
  if (!fs.existsSync(feedbackPath)) return { before: 0, after: 0 };
  const before = fs.statSync(feedbackPath).size;

  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const line of readEntries(feedbackPath)) {
    const key = normalizeEntry(line);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(line);
  }
  const out = writeEntries(feedbackPath, deduped);
  return { before, after: out.length };
}

/**
 * 读取指定模式的 feedback.md 内容。
 * @param maxChars 可选：只保留末尾 maxChars 个字符（较早的用省略标记代替）
 */
export function readFeedback(
  agentId: string,
  mode: "chat" | "code",
  maxChars?: number
): string | null {
  const feedbackPath = agentManager.feedbackPath(agentId, mode);
  if (!fs.existsSync(feedbackPath)) return null;
  const content = fs.readFileSync(feedbackPath, "utf-8").trim();
  if (content.length === 0) return null;
  if (maxChars !== undefined && maxChars > 0 && content.length > maxChars) {
    return `…（较早的反馈已省略）\n${content.slice(-maxChars)}`;
  }
  return content;
}
