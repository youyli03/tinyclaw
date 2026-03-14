/**
 * CLI 终端 UI 工具
 *
 * 提供：ANSI 颜色、对齐表格、readline 交互（prompt / select / confirm）。
 * 无外部依赖，完全基于 node:readline/promises。
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

// ── ANSI 颜色 ─────────────────────────────────────────────────────────────────

const ESC = "\x1b[";

export const ansi = {
  reset:   "\x1b[0m",
  bold:    "\x1b[1m",
  dim:     "\x1b[2m",
  green:   "\x1b[32m",
  red:     "\x1b[31m",
  yellow:  "\x1b[33m",
  cyan:    "\x1b[36m",
  blue:    "\x1b[34m",
  magenta: "\x1b[35m",
  white:   "\x1b[37m",
};

export const bold    = (s: string) => `${ansi.bold}${s}${ansi.reset}`;
export const dim     = (s: string) => `${ansi.dim}${s}${ansi.reset}`;
export const green   = (s: string) => `${ansi.green}${s}${ansi.reset}`;
export const red     = (s: string) => `${ansi.red}${s}${ansi.reset}`;
export const yellow  = (s: string) => `${ansi.yellow}${s}${ansi.reset}`;
export const cyan    = (s: string) => `${ansi.cyan}${s}${ansi.reset}`;
export const blue    = (s: string) => `${ansi.blue}${s}${ansi.reset}`;
export const magenta = (s: string) => `${ansi.magenta}${s}${ansi.reset}`;

// ── 表格打印 ──────────────────────────────────────────────────────────────────

/**
 * 打印对齐的 ASCII 表格（支持 ANSI 颜色字符，宽度计算会跳过 ANSI 转义序列）。
 */
export function printTable(headers: string[], rows: (string | undefined)[][]): void {
  const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
  const visLen = (s: string) => stripAnsi(s).length;

  const allRows = [headers, ...rows];
  const widths = headers.map((_, col) =>
    Math.max(...allRows.map((r) => visLen(r[col] ?? "")))
  );

  const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - visLen(s)));
  const sep = "  ";

  // 表头
  console.log(bold(widths.map((w, i) => pad(headers[i] ?? "", w)).join(sep)));
  // 分隔线
  console.log(dim(widths.map((w) => "─".repeat(w)).join(sep)));
  // 数据行
  for (const row of rows) {
    console.log(widths.map((w, i) => pad(row[i] ?? "", w)).join(sep));
  }
}

// ── Readline 单例 ─────────────────────────────────────────────────────────────

let _rl: ReturnType<typeof createInterface> | null = null;

function rl(): ReturnType<typeof createInterface> {
  if (!_rl) _rl = createInterface({ input: stdin, output: stdout });
  return _rl;
}

export function closeRl(): void {
  _rl?.close();
  _rl = null;
}

// ── 交互式输入 ────────────────────────────────────────────────────────────────

/** 读取一行用户输入 */
export async function prompt(question: string): Promise<string> {
  return rl().question(question);
}

/** 数字编号选择菜单，返回所选项的 value */
export async function select<T>(
  title: string,
  items: { label: string; value: T; note?: string }[]
): Promise<T> {
  console.log(`\n${bold(title)}`);
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const note = item.note ? `  ${dim(item.note)}` : "";
    console.log(`  ${cyan(String(i + 1).padStart(2))}. ${item.label}${note}`);
  }
  while (true) {
    const answer = await prompt(`\n请输入编号 [1-${items.length}]: `);
    const n = parseInt(answer.trim(), 10);
    if (n >= 1 && n <= items.length) return items[n - 1]!.value;
    console.log(red(`  无效编号，请输入 1 到 ${items.length} 之间的整数`));
  }
}

/** yes/no 确认 */
export async function confirm(question: string, defaultYes = true): Promise<boolean> {
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  const answer = await prompt(`${question} ${dim(hint)}: `);
  const t = answer.trim().toLowerCase();
  if (!t) return defaultYes;
  return t === "y" || t === "yes";
}

// ── 分割线 ────────────────────────────────────────────────────────────────────

export function hr(char = "─", width = 60): void {
  console.log(dim(char.repeat(width)));
}

export function section(title: string): void {
  console.log(`\n${bold(title)}`);
  hr();
}
