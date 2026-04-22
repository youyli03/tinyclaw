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

// ── TTY raw mode 交互基础 ─────────────────────────────────────────────────────

/** 是否有可用的 TTY（stdin 是终端） */
function hasTTY(): boolean {
  return Boolean(process.stdin.isTTY);
}

/**
 * 在 raw mode 下读取一个按键，返回按键标识字符串。
 * 调用者负责在调用前后设置/恢复 raw mode。
 */
function readKey(): Promise<string> {
  return new Promise((resolve) => {
    const onData = (buf: Buffer) => {
      process.stdin.removeListener("data", onData);
      const s = buf.toString();
      // 方向键转义序列
      if (s === "\x1b[A") { resolve("up");    return; }
      if (s === "\x1b[B") { resolve("down");  return; }
      if (s === "\r" || s === "\n") { resolve("enter"); return; }
      if (s === " ")                { resolve("space"); return; }
      if (s === "\x1b" || s === "q" || s === "\x03") { resolve("quit"); return; }
      resolve(s);
    };
    process.stdin.once("data", onData);
  });
}

/** 用 ANSI 上移 n 行并清除到底部，用于重绘菜单 */
function clearLines(_n: number): void {
  // 用 cursor restore + clear-to-end 代替逐行清除，避免终端滚动导致菜单上飘
  process.stdout.write("\x1b[u\x1b[J");
}

function saveCursor(): void {
  process.stdout.write("\x1b[s");
}

// ── singleSelect ──────────────────────────────────────────────────────────────

/**
 * 单选菜单：↑↓ 移动，Enter 确认。
 * 非 TTY 时 fallback 到数字编号输入（与现有 select() 行为一致）。
 */
export async function singleSelect<T>(
  title: string,
  items: { label: string; value: T; note?: string }[],
): Promise<T> {
  if (!hasTTY()) {
    return select(title, items);
  }

  let cursor = 0;
  const pageSize = Math.max(5, (process.stdout.rows ?? 24) - 6);
  let scrollTop = 0;

  const buildLines = (): string[] => {
    if (cursor < scrollTop) scrollTop = cursor;
    if (cursor >= scrollTop + pageSize) scrollTop = cursor - pageSize + 1;
    const visible = items.slice(scrollTop, scrollTop + pageSize);
    const out: string[] = [];
    out.push(bold(title));
    if (scrollTop > 0) out.push("  " + dim("\u2191 " + String(scrollTop) + " \u9879..."));
    for (let i = 0; i < visible.length; i++) {
      const item = visible[i]!;
      const abs = scrollTop + i;
      const note = item.note ? "  " + dim(item.note) : "";
      const pfx = abs === cursor ? cyan("\u276f ") : "  ";
      const lbl = abs === cursor ? bold(item.label) : item.label;
      out.push(pfx + lbl + note);
    }
    const rem = items.length - scrollTop - visible.length;
    if (rem > 0) out.push("  " + dim("\u2193 " + String(rem) + " \u9879..."));
    out.push(dim("\u2191\u2193 \u79fb\u52a8  Enter \u786e\u8ba4"));
    return out;
  };

  let lastN = 0;
  const printLines = (ls: string[]) => {
    process.stdout.write(ls.join("\n") + "\n");
    lastN = ls.length;
  };
  const redraw = () => {
    process.stdout.write("\x1b[" + String(lastN) + "A\x1b[J");
    printLines(buildLines());
  };

  process.stdout.write("\n");
  printLines(buildLines());

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf-8");

  try {
    while (true) {
      const key = await readKey();
      if (key === "up")         { cursor = (cursor - 1 + items.length) % items.length; redraw(); }
      else if (key === "down")  { cursor = (cursor + 1) % items.length; redraw(); }
      else if (key === "enter") { process.stdout.write("\x1b[" + String(lastN) + "A\x1b[J"); break; }
      else if (key === "quit")  { process.exit(0); }
    }
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }

  return items[cursor]!.value;
}

// ── multiSelect ───────────────────────────────────────────────────────────────

/**
 * 多选菜单：↑↓ 移动，空格切换勾选，Enter 确认，返回已勾选的 value 数组。
 * 非 TTY 时 fallback 到逗号/空格分隔输入。
 */
export async function multiSelect(
  title: string,
  items: { value: string; label?: string }[],
  initialSelected: string[] = [],
): Promise<string[]> {
  if (!hasTTY()) {
    // fallback：显示列表，让用户输入空格分隔的 value
    console.log(`\n${bold(title)}`);
    console.log(dim("可选项：") + items.map((i) => i.value).join("  "));
    if (initialSelected.length > 0) {
      console.log(dim("当前已选：") + initialSelected.join(", "));
    }
    const answer = await prompt("输入选中项（空格分隔，直接回车保持不变）: ");
    const t = answer.trim();
    if (!t) return initialSelected;
    return t.split(/[\s,]+/).filter((v) => items.some((i) => i.value === v));
  }

  const selected = new Set<string>(initialSelected);
  let cursor = 0;

  const render = (first: boolean) => {
    if (!first) clearLines(items.length + 2);
    console.log(`\n${bold(title)}`);
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      const label = item.label ?? item.value;
      const checked = selected.has(item.value) ? green("[✓]") : dim("[ ]");
      const arrow = i === cursor ? cyan("❯") : " ";
      const text = i === cursor ? bold(label) : label;
      console.log(`${arrow} ${checked} ${text}`);
    }
  };

  saveCursor();
  render(true);
  console.log(dim("↑↓ 移动  Space 切换  Enter 确认"));

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf-8");

  try {
    while (true) {
      const key = await readKey();
      if (key === "up")    { cursor = (cursor - 1 + items.length) % items.length; render(false); }
      else if (key === "down")  { cursor = (cursor + 1) % items.length; render(false); }
      else if (key === "space") {
        const v = items[cursor]!.value;
        if (selected.has(v)) selected.delete(v); else selected.add(v);
        render(false);
      }
      else if (key === "enter") { clearLines(items.length + 2); break; }
      else if (key === "quit")  { process.exit(0); }
    }
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }

  return Array.from(selected);
}

// ── searchableSelect ──────────────────────────────────────────────────────────

/**
 * 可搜索的单选菜单。
 *
 * TTY 模式:
 *   ↑↓ 在过滤后的列表中移动，Enter 确认
 *   Tab 切换到搜索框 / 从搜索框返回列表
 *   在搜索框中按任意字符追加过滤词，Backspace 删除
 *
 * 非 TTY fallback:先 prompt 输入关键词，再数字编号选择。
 */
export async function searchableSelect<T>(
  title: string,
  allItems: { label: string; value: T; note?: string }[],
): Promise<T> {
  if (!hasTTY()) {
    const kw = await prompt("\u641c\u7d22\u5173\u952e\u8bcd (\u76f4\u63a5\u56de\u8f66\u8df3\u8fc7): ");
    const filtered = kw.trim()
      ? allItems.filter((i) =>
          i.label.toLowerCase().includes(kw.toLowerCase()) ||
          String(i.value).toLowerCase().includes(kw.toLowerCase())
        )
      : allItems;
    return select(title, filtered.length > 0 ? filtered : allItems);
  }

  let searchMode = false;
  let query = "";
  let cursor = 0;
  const pageSize = Math.max(5, (process.stdout.rows ?? 24) - 8);
  let scrollTop = 0;

  const getFiltered = () => {
    if (!query) return allItems;
    const q = query.toLowerCase();
    return allItems.filter(
      (i) => i.label.toLowerCase().includes(q) || String(i.value).toLowerCase().includes(q)
    );
  };

  const buildLines = (): string[] => {
    const list = getFiltered();
    if (cursor >= list.length) cursor = Math.max(0, list.length - 1);
    if (cursor < scrollTop) scrollTop = cursor;
    if (cursor >= scrollTop + pageSize) scrollTop = cursor - pageSize + 1;
    const visible = list.slice(scrollTop, scrollTop + pageSize);

    const out: string[] = [];
    out.push(bold(title));
    if (scrollTop > 0) out.push("  " + dim("\u2191 " + String(scrollTop) + " \u9879..."));
    for (let i = 0; i < visible.length; i++) {
      const item = visible[i]!;
      const abs = scrollTop + i;
      const note = item.note ? "  " + dim(item.note) : "";
      const pfx = abs === cursor ? cyan("\u276f ") : "  ";
      const lbl = abs === cursor ? bold(item.label) : item.label;
      out.push(pfx + lbl + note);
    }
    const rem = list.length - scrollTop - visible.length;
    if (rem > 0) out.push("  " + dim("\u2193 " + String(rem) + " \u9879..."));
    if (list.length === 0) out.push("  " + dim("(\u65e0\u5339\u914d\u7ed3\u679c)"));
    const searchLine = searchMode
      ? "  \u641c\u7d22: " + cyan(query) + "\u2588"
      : "  \u641c\u7d22: " + dim("(Tab \u6fc0\u6d3b)");
    out.push(searchLine);
    out.push(searchMode
      ? dim("Enter \u786e\u8ba4  Esc \u6e05\u7a7a  \u2191\u2193 \u79fb\u52a8")
      : dim("\u2191\u2193 \u79fb\u52a8  Enter \u786e\u8ba4  Tab \u641c\u7d22"));
    return out;
  };

  let lastN = 0;
  const printLines = (ls: string[]) => {
    process.stdout.write(ls.join("\n") + "\n");
    lastN = ls.length;
  };
  const redraw = () => {
    process.stdout.write("\x1b[" + String(lastN) + "A\x1b[J");
    printLines(buildLines());
  };

  process.stdout.write("\n");
  printLines(buildLines());

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.setEncoding("utf-8");

  try {
    while (true) {
      const key = await readKey();
      if (key === "quit") process.exit(0);

      if (key === "\t") { searchMode = !searchMode; redraw(); continue; }

      if (key === "\x1b") {
        if (query) { query = ""; cursor = 0; scrollTop = 0; }
        searchMode = false;
        redraw();
        continue;
      }

      if (key === "up") {
        const list = getFiltered();
        if (list.length > 0) cursor = (cursor - 1 + list.length) % list.length;
        redraw();
        continue;
      }

      if (key === "down") {
        const list = getFiltered();
        if (list.length > 0) cursor = (cursor + 1) % list.length;
        redraw();
        continue;
      }

      if (key === "enter") {
        const list = getFiltered();
        if (list.length === 0) continue;
        process.stdout.write("\x1b[" + String(lastN) + "A\x1b[J");
        return list[cursor]!.value;
      }

      if (searchMode) {
        if (key === "\x7f" || key === "backspace") {
          query = query.slice(0, -1);
        } else if (key.length === 1 && key >= " ") {
          query += key;
        }
        cursor = 0;
        scrollTop = 0;
        redraw();
      }
    }
  } finally {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
}
