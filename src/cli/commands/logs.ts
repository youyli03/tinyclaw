/**
 * CLI 命令：logs
 *
 * 查看 tinyclaw 主服务的运行日志。**自动识别日志来源**：
 *
 * | 服务怎么起的 | 日志在哪 | 本命令做什么 |
 * |---|---|---|
 * | `systemctl --user start tinyclaw` | journal | `journalctl --user -u tinyclaw -o cat` |
 * | `tinyclaw start` | `~/.tinyclaw/service.log` | `tail` |
 *
 * 用法：
 *   tinyclaw logs                最近 100 行
 *   tinyclaw logs -f             实时追踪（Ctrl+C 退出）
 *   tinyclaw logs -n 200 -f      先看 200 行历史再追踪
 *   tinyclaw logs -l warn        只看 WARN 及以上
 *   tinyclaw logs --since "30 min ago" -f
 *   tinyclaw logs --grep qqbot   按正则过滤
 *   tinyclaw logs --source file  强制读 service.log（journal 也保留时用）
 */

import * as fs from "node:fs";
import { spawn } from "node:child_process";
import { bold, yellow, dim } from "../ui.js";
import { SERVICE_LOG_FILE } from "./start.js";
import {
  SYSTEMD_UNIT,
  journalctlAvailable,
  systemdUnitPath,
  systemdUnitState,
} from "../systemd.js";

export const subcommands = [
  "-f",
  "--follow",
  "-n",
  "-l",
  "--level",
  "--since",
  "--grep",
  "--source",
  "help",
] as const;
export const description = "查看主服务日志（systemd 走 journal，否则走 service.log）";
export const usage = "logs [-f] [-n <lines>] [-l <level>] [--since <time>] [--grep <re>] [--source journal|file]";

const LEVELS = ["trace", "debug", "info", "warn", "error"] as const;
type Level = (typeof LEVELS)[number];

function printHelp(): void {
  console.log(`
${bold("用法：")}
  logs                          显示最近 100 行日志
  logs -n <N>                   显示最近 N 行
  logs -f, --follow             持续追踪（Ctrl+C 退出）
  logs -l <level>               最低级别：trace | debug | info | warn | error
  logs --since <time>           起始时间（仅 journal，如 "30 min ago"、"2026-09-11 08:00"）
  logs --grep <regex>           只显示匹配的行（大小写不敏感）
  logs --source <journal|file>  强制日志来源（默认自动识别）

${bold("日志来源：")}
  systemd 托管（systemctl --user start ${SYSTEMD_UNIT}）→ journalctl --user -u ${SYSTEMD_UNIT}
  旧的自启动（tinyclaw start）                          → ${SERVICE_LOG_FILE}
`);
}

/** 解析 "-n 200" / "-l warn" 这类「带值参数」，返回值和剩余位置参数 */
function parseArgs(args: string[]): {
  follow: boolean;
  lines: number;
  level?: Level;
  since?: string;
  grep?: string;
  source?: "journal" | "file";
  error?: string;
} {
  let follow = false;
  let lines = 100;
  let level: Level | undefined;
  let since: string | undefined;
  let grep: string | undefined;
  let source: "journal" | "file" | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    const next = (): string => args[++i] ?? "";
    if (arg === "-f" || arg === "--follow") {
      follow = true;
    } else if (arg === "-n") {
      const n = parseInt(next(), 10);
      if (Number.isNaN(n) || n <= 0) return { follow, lines, error: "-n 需要一个正整数" };
      lines = n;
    } else if (arg === "-l" || arg === "--level") {
      const v = next().toLowerCase() as Level;
      if (!LEVELS.includes(v)) {
        return { follow, lines, error: `--level 只支持 ${LEVELS.join(" | ")}` };
      }
      level = v;
    } else if (arg === "--since") {
      since = next();
      if (!since) return { follow, lines, error: "--since 需要一个时间参数" };
    } else if (arg === "--grep") {
      grep = next();
      if (!grep) return { follow, lines, error: "--grep 需要一个正则" };
    } else if (arg === "--source") {
      const v = next();
      if (v !== "journal" && v !== "file") {
        return { follow, lines, error: "--source 只支持 journal | file" };
      }
      source = v;
    } else {
      return { follow, lines, error: `未知参数 "${arg}"` };
    }
  }
  return {
    follow,
    lines,
    ...(level !== undefined ? { level } : {}),
    ...(since !== undefined ? { since } : {}),
    ...(grep !== undefined ? { grep } : {}),
    ...(source !== undefined ? { source } : {}),
  };
}

/** 日志行里的级别标记（logger 输出形如 `[2026-09-11 15:26:02] [INFO ] [global] ...`） */
const LEVEL_RE = /\[(TRACE|DEBUG|INFO|WARN|ERROR|SILENT)\s*\]/;

function lineLevel(line: string): Level | null {
  const m = LEVEL_RE.exec(line);
  if (!m) return null;
  const label = m[1]!.toLowerCase();
  if (label === "silent") return null;
  return LEVELS.includes(label as Level) ? (label as Level) : null;
}

/** 是否需要逐行过滤（tty 下也走，用于剥掉进度条的 ANSI 控制符） */
function needsFilter(level?: Level, grep?: string): boolean {
  return level !== undefined || grep !== undefined || process.stdout.isTTY === true;
}

/**
 * 剥掉 ANSI/光标控制符。
 *
 * 为什么需要：Agent 的进度条（`▶ 0.0 KB`）带 `\r` 与 `[K`，写进 journal 后会变成
 * 一行里的乱码碎片；人在终端看日志时应当只看到文字。
 */
/** ANSI/光标控制符（含 `\r`）——剥控制符的匹配本身就必然命中控制字符 */
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]|\r/g;

export function stripAnsi(line: string): string {
  return line.replace(ANSI_RE, "");
}

function makeFilter(level?: Level, grep?: string): (line: string) => boolean {
  const minIdx = level ? LEVELS.indexOf(level) : -1;
  const re = grep ? new RegExp(grep, "i") : null;
  const strip = process.stdout.isTTY === true;
  return (line: string): boolean => {
    if (re && !re.test(line)) return false;
    if (minIdx >= 0) {
      const lv = lineLevel(line);
      // 没有级别标记的行（如堆栈续行）在过滤时保留，避免把上下文切断
      if (lv !== null && LEVELS.indexOf(lv) < minIdx) return false;
    }
    return strip ? stripAnsi(line).length > 0 : true;
  };
}

/** 决定读哪个来源。`--source` 可强制。 */
function resolveSource(
  source: "journal" | "file" | undefined
): { source: "journal" | "file"; reason: string } | { source: null; reason: string } {
  const state = systemdUnitState();
  const managed = systemdUnitPath() !== null;
  const canJournal = journalctlAvailable();
  const fileHasData = fs.existsSync(SERVICE_LOG_FILE) && fs.statSync(SERVICE_LOG_FILE).size > 0;

  if (source === "journal") {
    return canJournal
      ? { source: "journal", reason: "按 --source 指定" }
      : { source: null, reason: "本机没有 journalctl" };
  }
  if (source === "file") {
    return fs.existsSync(SERVICE_LOG_FILE)
      ? { source: "file", reason: "按 --source 指定" }
      : { source: null, reason: `${SERVICE_LOG_FILE} 不存在` };
  }

  if (managed && canJournal && (state === "active" || state === "activating" || state === "reloading")) {
    return { source: "journal", reason: `服务由 systemd 托管（${state}），输出在 journal` };
  }
  if (fileHasData) {
    return { source: "file", reason: "service.log 有内容（CLI 自启动的旧服务）" };
  }
  if (managed && canJournal) {
    return { source: "journal", reason: `服务未运行，读取 systemd 保存的历史日志（${state}）` };
  }
  if (fs.existsSync(SERVICE_LOG_FILE)) {
    return { source: "file", reason: "只有 service.log 可读（当前为空）" };
  }
  return {
    source: null,
    reason: `既没有 systemd unit（${SYSTEMD_UNIT}）也没有 ${SERVICE_LOG_FILE}`,
  };
}

export async function run(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h") || args.includes("help")) {
    printHelp();
    return;
  }

  const parsed = parseArgs(args);
  if (parsed.error) {
    console.error(yellow(`参数错误：${parsed.error}`));
    console.log(dim(`用法：${usage}`));
    process.exitCode = 1;
    return;
  }

  const resolved = resolveSource(parsed.source);
  if (resolved.source === null) {
    console.log(yellow("读不到日志。"));
    console.log(dim(`原因：${resolved.reason}`));
    console.log(dim(`提示：tinyclaw start 启动的服务日志在 ${SERVICE_LOG_FILE}`));
    return;
  }

  const filter = makeFilter(parsed.level, parsed.grep);
  const useFilter = needsFilter(parsed.level, parsed.grep);

  let cmd: string;
  let cmdArgs: string[];
  if (resolved.source === "journal") {
    cmd = "journalctl";
    cmdArgs = ["--user", "-u", SYSTEMD_UNIT, "-o", "cat", "--no-pager", "-n", String(parsed.lines)];
    if (parsed.since) cmdArgs.push("--since", parsed.since);
    if (parsed.follow) cmdArgs.push("-f");
  } else {
    cmd = "tail";
    cmdArgs = parsed.follow
      ? ["-f", "-n", String(parsed.lines), SERVICE_LOG_FILE]
      : ["-n", String(parsed.lines), SERVICE_LOG_FILE];
  }

  console.log(
    dim(`来源：${resolved.source === "journal" ? `journalctl --user -u ${SYSTEMD_UNIT}` : SERVICE_LOG_FILE}`) +
      dim(`（${resolved.reason}）`)
  );

  const child = useFilter
    ? spawn(cmd, cmdArgs, { stdio: ["ignore", "pipe", "inherit"] })
    : spawn(cmd, cmdArgs, { stdio: ["ignore", "inherit", "inherit"] });

  let matched = 0;
  if (useFilter && child.stdout) {
    // 逐行过滤；行未完整时先缓冲，保证不切断堆栈续行
    const strip = process.stdout.isTTY === true;
    let buf = "";
    child.stdout.setEncoding("utf-8");
    const emit = (line: string): void => {
      if (!filter(line)) return;
      matched++;
      process.stdout.write((strip ? stripAnsi(line) : line) + "\n");
    };
    child.stdout.on("data", (chunk: string) => {
      buf += chunk;
      const parts = buf.split("\n");
      buf = parts.pop() ?? "";
      for (const line of parts) emit(line);
    });
    child.stdout.on("end", () => {
      if (buf) emit(buf);
    });
  }

  const kill = (): void => {
    child.kill("SIGTERM");
  };
  process.once("SIGINT", kill);
  process.once("SIGTERM", kill);

  await new Promise<void>((resolve) => {
    child.on("exit", (code) => {
      if (code !== 0 && code !== null) {
        console.error(yellow(`${cmd} 退出码 ${code}`));
      }
      resolve();
    });
    child.on("error", (err) => {
      console.error(yellow(`无法执行 ${cmd}：${err.message}`));
      resolve();
    });
  });

  if (useFilter && !parsed.follow && matched === 0) {
    console.log(dim("（这些行里没有匹配项：放宽 -l/--grep，或加大 -n / 用 --since 扩大时间范围）"));
  }
}
