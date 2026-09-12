/**
 * grep / glob 工具 —— 基于 ripgrep 的代码检索（只读）。
 *
 * 设计要点（对齐 AGENTS.md §6/§7.1）：
 *  1. **不自己 spawn**：把命令交给 `execShellImpl`（exec_shell 的实现）执行，
 *     从而白拿沙箱（bwrap）／提权策略／超时／审计／密钥掩码那一整套，
 *     避免出现"绕过沙箱的第二条执行路径"。
 *  2. **模型侧描述英文、返回给模型的文本中文**（§6：工具结果会被原样转述给用户）。
 *  3. **密钥保护**：目标路径命中运行时密钥（`isRuntimeSecretPath`）直接拒绝；
 *     沙箱未开启时再追加 ripgrep 排除规则，避免把密钥内容打进输出。
 *  4. 二进制来自 `@vscode/ripgrep`（按平台预编译，aarch64 有 linux-arm64 包，无需编译）。
 */

import * as fs from "node:fs";
import * as path from "node:path";

import { registerTool, type ToolContext } from "./registry.js";
import { isRuntimeSecretPath, runtimeRoot, checkReadPath } from "./path-guard.js";
import { loadConfig } from "../config/loader.js";
import { execShellImpl } from "./system.js";
import { rgPath } from "@vscode/ripgrep";

/** 默认最多返回多少条命中/文件（防止塞爆上下文） */
const DEFAULT_MAX_RESULTS = 40;
/** 单文件最多取几条命中（rg 的 -m） */
const PER_FILE_MAX_MATCHES = 5;
/** 单行最长显示宽度（rg 的 --max-columns） */
const MAX_COLUMN_CHARS = 240;

/** 把字符串安全地放进 `bash -c` 的单引号里 */
function shq(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** 解析目标目录：相对路径基于 ctx.cwd（与 read_file/write_file 一致），默认 ctx.cwd 或进程 cwd */
function resolveTarget(raw: string, ctx?: ToolContext): string {
  const base = ctx?.cwd ?? process.cwd();
  const expanded = raw.startsWith("~") ? path.join(process.env["HOME"] ?? "", raw.slice(1)) : raw;
  return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(base, expanded);
}

/** 沙箱未开启时的兜底排除：把运行时密钥按绝对路径排除掉，避免内容进输出 */
function secretExcludes(): string[] {
  const root = runtimeRoot();
  const targets = [
    path.join(root, "config.toml"),
    path.join(root, "secrets.toml"),
    path.join(root, "mcp.toml"),
    path.join(root, "env"),
    path.join(root, "auth"),
    path.join(root, ".github_token"),
  ];
  const globs = targets.flatMap((t) => [`--glob`, `!${t}`, `--glob`, `!${t}/**`]);
  return globs;
}

/** 沙箱是否生效（沙箱开启时密钥已被空文件掩码，无需额外排除） */
function sandboxActive(): boolean {
  try {
    const cfg = loadConfig().sandbox;
    return cfg.enabled && cfg.execShell === "sandbox";
  } catch {
    return false;
  }
}

/** 统一的执行 + 结果整形：把 rg 的"退出码 1 = 无匹配"翻译成友好中文 */
async function runRg(
  command: string,
  ctx: ToolContext | undefined,
  emptyHint: string
): Promise<string> {
  const out = await execShellImpl({ command, timeout_sec: 60 }, ctx);
  const trimmed = out.trim();
  if (trimmed === "" || /^（退出码 1，无输出）$/.test(trimmed)) return emptyHint;
  // exec_shell 对"无匹配"会返回 "（退出码 1，无输出）"，上面已处理；其余退出码原样带出
  return trimmed;
}

/** 截断结果并附中文提示 */
function cap(text: string, maxResults: number, unit: string): string {
  const lines = text.split("\n");
  if (lines.length <= maxResults) return text;
  const kept = lines.slice(0, maxResults);
  return `${kept.join("\n")}\n\n（已截断：仅显示前 ${maxResults} ${unit}，共 ${lines.length} ${unit}。请缩小范围或加更精确的 pattern/glob。）`;
}

// ── grep ──────────────────────────────────────────────────────────────────────

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "grep",
      description:
        "Search file contents with ripgrep (regular expressions) — read-only, much faster and safer " +
        "than piping grep through exec_shell. Respects .gitignore by default, also searches hidden " +
        "files except .git. Returns `path:line:text` rows.\n" +
        "Use it to locate symbols, strings or configuration before editing, instead of guessing paths. " +
        "Secret files under the runtime directory are never searchable. When the sandbox is enabled " +
        "the search runs inside it, so only visible (unmasked) paths are searched.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description:
              "Regular expression to search for (ripgrep syntax, e.g. `function\\s+\\w+`). Use a plain " +
              "string for a literal search.",
          },
          path: {
            type: "string",
            description:
              "File or directory to search (default: the current working directory). Relative paths " +
              "resolve against the working directory.",
          },
          glob: {
            type: "string",
            description: "Only search files matching this glob, e.g. `*.ts` or `!**/test/**`.",
          },
          ignore_case: {
            type: "boolean",
            description: "Case-insensitive search (default false).",
          },
          max_results: {
            type: "integer",
            description: `Maximum number of result rows to return (default ${DEFAULT_MAX_RESULTS}).`,
          },
        },
        required: ["pattern"],
      },
    },
  },
  execute: async (args: Record<string, unknown>, ctx?: ToolContext): Promise<string> => {
    const pattern = String(args["pattern"] ?? "");
    if (!pattern) return "错误：缺少 pattern 参数";
    if (!fs.existsSync(rgPath)) {
      return `错误：找不到 ripgrep 二进制（${rgPath}）。请在仓库里执行 npm i @vscode/ripgrep。`;
    }

    const target = resolveTarget(String(args["path"] ?? "."), ctx);
    if (!fs.existsSync(target)) return `路径不存在：${target}`;
    if (isRuntimeSecretPath(target)) return `已拒绝：${target} 属于密钥路径，禁止检索`;
    const readCheck = checkReadPath(target);
    if (!readCheck.allow) return `已拒绝：${target}（${readCheck.reason}）`;

    const maxResults = Math.max(1, Math.min(200, Number(args["max_results"] ?? DEFAULT_MAX_RESULTS) || DEFAULT_MAX_RESULTS));
    const quoted: string[] = [shq(rgPath), "--no-heading", "--line-number", "--color", "never", "--hidden", "--glob", "!.git/**"];
    if (args["ignore_case"] === true) quoted.push("--ignore-case");
    const globArg = String(args["glob"] ?? "").trim();
    if (globArg) quoted.push("--glob", shq(globArg));
    if (!sandboxActive()) quoted.push(...secretExcludes().map(shq));
    quoted.push("--max-columns", String(MAX_COLUMN_CHARS), "--max-columns-preview");
    quoted.push("--max-count", String(PER_FILE_MAX_MATCHES));
    // 搜索目标用 "."：配合上面的 cd，rg 会输出**相对路径**（绝对路径又长又难读）
    quoted.push("-e", shq(pattern), "--", ".");

    // 注意：这里不拼 shell 元字符，全部参数走单引号包裹；pattern 里的引号已被 shq 转义。
    // 先 cd 到目标目录再跑，让 rg 输出**相对路径**（绝对值长且噪音大）
    const dir = fs.statSync(target).isDirectory() ? target : path.dirname(target);
    const command = `cd ${shq(dir)} && ${quoted.join(" ")}`;
    const out = await runRg(
      command,
      ctx,
      `未找到匹配：pattern=「${pattern}」 path=${target}${globArg ? ` glob=${globArg}` : ""}`
    );
    return cap(out, maxResults, "行");
  },
});

// ── glob ──────────────────────────────────────────────────────────────────────

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "glob",
      description:
        "List files by glob pattern with ripgrep (read-only), fastest way to answer " +
        "\"which files are there / where is this file\". Respects .gitignore, includes hidden files " +
        "except .git, sorted by path. Returns one relative path per line.\n" +
        "Prefer it over `find` in exec_shell: no shell quoting traps and no secret leakage.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Glob to match file paths against, e.g. `**/*.ts`, `src/**/api/*.ts`, `*.md`.",
          },
          path: {
            type: "string",
            description: "Directory to search (default: the current working directory).",
          },
          max_results: {
            type: "integer",
            description: `Maximum number of paths to return (default ${DEFAULT_MAX_RESULTS}).`,
          },
        },
        required: ["pattern"],
      },
    },
  },
  execute: async (args: Record<string, unknown>, ctx?: ToolContext): Promise<string> => {
    const pattern = String(args["pattern"] ?? "");
    if (!pattern) return "错误：缺少 pattern 参数";
    if (!fs.existsSync(rgPath)) {
      return `错误：找不到 ripgrep 二进制（${rgPath}）。请在仓库里执行 npm i @vscode/ripgrep。`;
    }

    const target = resolveTarget(String(args["path"] ?? "."), ctx);
    const dir = fs.existsSync(target) && fs.statSync(target).isDirectory() ? target : path.dirname(target);
    if (!fs.existsSync(dir)) return `路径不存在：${dir}`;
    if (isRuntimeSecretPath(dir)) return `已拒绝：${dir} 属于密钥路径，禁止检索`;
    const readCheck = checkReadPath(dir);
    if (!readCheck.allow) return `已拒绝：${dir}（${readCheck.reason}）`;

    const maxResults = Math.max(1, Math.min(500, Number(args["max_results"] ?? DEFAULT_MAX_RESULTS) || DEFAULT_MAX_RESULTS));
    const quoted: string[] = [
      shq(rgPath),
      "--files",
      "--hidden",
      "--sort",
      "path",
      "--glob",
      "!.git/**",
      "--glob",
      shq(pattern),
    ];
    if (!sandboxActive()) quoted.push(...secretExcludes().map(shq));
    quoted.push("--", ".");
    const out = await runRg(
      `cd ${shq(dir)} && ${quoted.join(" ")}`,
      ctx,
      `未找到匹配：glob=「${pattern}」 dir=${dir}`
    );
    return cap(out, maxResults, "个文件");
  },
});
