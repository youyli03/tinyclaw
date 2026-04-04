/**
 * 日报文件读写工具
 *
 * 存储路径: ~/.tinyclaw/reports/<type>/<YYYY-MM-DD>.md
 * type 为任意字符串标签，如 stock / weather / daily
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export const REPORTS_DIR = path.join(os.homedir(), ".tinyclaw", "reports");

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/** 列出所有已有日报类型（子目录名） */
export function listReportTypes(): string[] {
  ensureDir(REPORTS_DIR);
  return fs
    .readdirSync(REPORTS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .map(d => d.name)
    .sort();
}

/** 列出某类型下所有日期（降序，最新在前） */
export function listReportDates(type: string): string[] {
  const dir = path.join(REPORTS_DIR, sanitizeSegment(type));
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
    .map(f => f.replace(/\.md$/, ""))
    .sort()
    .reverse();
}

/** 读取一篇日报的 Markdown 内容，不存在返回 null */
export function readReport(type: string, date: string): string | null {
  const file = reportPath(type, date);
  if (!fs.existsSync(file)) return null;
  return fs.readFileSync(file, "utf-8");
}

/** 写入一篇日报（覆盖已有同日期同类型） */
export function writeReport(opts: {
  type: string;
  date?: string;   // 默认今天 YYYY-MM-DD
  content: string;
  title?: string;  // 可选，会作为 H1 前置到内容里（若内容本身已有 # 则跳过）
}): string {
  const { type, content, title } = opts;
  const date = opts.date ?? todayStr();

  validateSegment(type, "type");
  validateSegment(date, "date");

  const dir = path.join(REPORTS_DIR, type);
  ensureDir(dir);

  let body = content.trim();
  // 如果指定了 title 且内容没有以 # 开头，前置标题
  if (title && !body.startsWith("#")) {
    body = `# ${title}\n\n${body}`;
  }

  const file = reportPath(type, date);
  fs.writeFileSync(file, body, "utf-8");
  return file;
}

// ── 内部工具 ──────────────────────────────────────────────────────────────────

function reportPath(type: string, date: string): string {
  return path.join(REPORTS_DIR, sanitizeSegment(type), `${sanitizeSegment(date)}.md`);
}

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function sanitizeSegment(s: string): string {
  // 只允许字母数字、连字符、下划线、点
  return s.replace(/[^a-zA-Z0-9\-_.]/g, "_");
}

function validateSegment(s: string, name: string): void {
  if (!s || s.length > 64) throw new Error(`${name} 无效: "${s}"`);
}
