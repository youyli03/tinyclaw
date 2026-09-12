import * as path from "node:path";
import * as os from "node:os";
import { agentManager } from "../core/agent-manager.js";
import { loadConfig } from "../config/loader.js";
import type { ToolContext } from "./registry.js";

// ── 黑名单常量 ────────────────────────────────────────────────────────────────

/**
 * 危险目录名列表。
 * 目标路径的任意 segment 匹配即拒绝（无论是否在白名单内）。
 */
export const DANGEROUS_DIRECTORIES: string[] = [".git", ".ssh"];

/**
 * 危险文件名列表。
 * 目标路径的 basename 匹配即拒绝（无论是否在白名单内）。
 */
export const DANGEROUS_FILES: string[] = [
  ".gitconfig",
  ".bashrc",
  ".bash_profile",
  ".zshrc",
  ".zprofile",
  ".profile",
  ".ssh/config",
  ".ssh/authorized_keys",
];

// ── exec_shell 危险写操作检测 ─────────────────────────────────────────────────

/**
 * 危险系统路径前缀列表。
 * exec_shell 命令若写入/覆盖这些路径下的文件，将被拦截。
 */
export const DANGEROUS_SYSTEM_PATHS: string[] = [
  "/etc/ufw",
  "/etc/iptables",
  "/etc/network",
  "/etc/systemd",
  "/etc/hosts",
  "/etc/resolv.conf",
  "/etc/fstab",
  "/etc/crontab",
  "/etc/sudoers",
  "/etc/ssh",
  "/etc/apt",
  "/etc/docker",
];

export type ExecCheckResult =
  { blocked: false } | { blocked: true; mode: "overwrite" | "append"; path: string };

/**
 * 检测 exec_shell 命令是否对危险系统路径进行写入/覆盖。
 *
 * 检测模式：
 * - 覆盖：`tee <path>`、`> <path>`、`cat/echo ... > <path>`、`cp <src> <path>`、`mv <src> <path>`、`sed -i ... <path>`
 * - 追加：`tee -a <path>`、`>> <path>`
 */
export function checkExecCommand(cmd: string): ExecCheckResult {
  // 提取所有 (path, isAppend) 候选
  const candidates: Array<{ filePath: string; isAppend: boolean }> = [];

  // 1. tee [-a] <path>
  for (const m of cmd.matchAll(/\btee\s+(-a\s+)?([^\s|&;><"']+)/g)) {
    if (m[2]) candidates.push({ filePath: m[2], isAppend: !!m[1] });
  }

  // 2. >> <path>  (追加重定向)
  for (const m of cmd.matchAll(/>>[ \t]*([^\s|&;><"']+)/g)) {
    if (m[1]) candidates.push({ filePath: m[1], isAppend: true });
  }

  // 3. > <path>  (覆盖重定向，排除 >>)
  for (const m of cmd.matchAll(/(?<!>)>[ \t]*([^\s|&;><"']+)/g)) {
    if (m[1]) candidates.push({ filePath: m[1], isAppend: false });
  }

  // 4. cp <src> <dest>
  for (const m of cmd.matchAll(/\bcp\s+(?:-[rRfp]+\s+)*\S+\s+([^\s|&;><"']+)/g)) {
    if (m[1]) candidates.push({ filePath: m[1], isAppend: false });
  }

  // 5. mv <src> <dest>
  for (const m of cmd.matchAll(/\bmv\s+(?:-[f]+\s+)*\S+\s+([^\s|&;><"']+)/g)) {
    if (m[1]) candidates.push({ filePath: m[1], isAppend: false });
  }

  // 6. sed -i ... <path>
  for (const m of cmd.matchAll(
    /\bsed\s+(?:[^|&;]*\s)?-i\S*\s+(?:'[^']*'\s+|"[^"]*"\s+|\S+\s+)?([^\s|&;><"']+)/g
  )) {
    if (m[1]) candidates.push({ filePath: m[1], isAppend: false });
  }

  for (const { filePath, isAppend } of candidates) {
    const isDangerous = DANGEROUS_SYSTEM_PATHS.some(
      (p) => filePath === p || filePath.startsWith(p + "/")
    );
    if (isDangerous) {
      return { blocked: true, mode: isAppend ? "append" : "overwrite", path: filePath };
    }
  }

  return { blocked: false };
}

// ── 运行时目录（~/.tinyclaw）自指访问 ─────────────────────────────────────────
//
// 设计目标（用户指令）：被授权的 agent 对**自己的运行时目录**拥有完整访问权，
// 但**密钥例外** —— 密钥既不可读、也不可写、不可删，且不因"已授权"而放宽。

/** 运行时根目录：agent 的"自身"数据目录 */
export function runtimeRoot(): string {
  return path.join(os.homedir(), ".tinyclaw");
}

/** 路径是否位于运行时目录内（含根本身） */
export function isInsideRuntime(absPath: string): boolean {
  const root = path.resolve(runtimeRoot());
  const abs = path.resolve(absPath);
  return abs === root || abs.startsWith(root + path.sep);
}

/** 运行时目录内视为密钥的文件名（小写比较） */
const SECRET_BASENAMES = new Set([
  "config.toml", // providers 的 apiKey / githubToken
  "secrets.toml", // 所有第三方 token
  "mcp.toml", // MCP server 的 env（可能含 token）
  "env",
  ".env",
  ".github_token",
  "yingli_token.json",
]);

/** 运行时目录内含密钥的目录名（小写比较） */
const SECRET_DIR_NAMES = new Set(["auth"]);

/** 任何位置都视为私钥的扩展名 */
const SECRET_EXTENSIONS = [".key", ".pem", ".p12", ".pfx"];

/** 运行时目录内的 token 命名（yingli_token.json / tokens.json / token-usage.json …） */
const SECRET_TOKEN_NAME_RE = /(^|[._-])tokens?([._-]|$)/i;

/**
 * 是否为不可向 Agent 暴露的密钥路径。
 *
 * 判定口径：
 * - **全局**：`*.key` / `*.pem` / `*.p12` / `*.pfx` 一律视为私钥
 * - **运行时目录内**：`config.toml` / `secrets.toml` / `mcp.toml` / `env` / 名字含 token 的文件 /
 *   `auth/` 下的任何内容
 *
 * 注意 `.key` 是全局规则（工作区里也不能被读写），文件名类规则只在运行时目录内生效，
 * 避免误伤工作区里的同名普通文件（如项目里的 `config.toml`）。
 */
export function isRuntimeSecretPath(absPath: string): boolean {
  const abs = path.resolve(absPath);
  const base = path.basename(abs);
  if (SECRET_EXTENSIONS.some((e) => base.toLowerCase().endsWith(e))) return true;

  if (!isInsideRuntime(abs)) return false;
  const lower = base.toLowerCase();
  if (SECRET_BASENAMES.has(lower)) return true;
  if (SECRET_TOKEN_NAME_RE.test(base)) return true;

  const rel = path.relative(path.resolve(runtimeRoot()), abs);
  const segs = rel.split(path.sep);
  // 末段是文件名，其余是目录
  for (let i = 0; i < segs.length - 1; i++) {
    if (SECRET_DIR_NAMES.has((segs[i] ?? "").toLowerCase())) return true;
  }
  // 末段本身就是密钥目录（如 `~/.tinyclaw/auth`）——列目录同样属于暴露密钥，必须一并拒绝
  if (SECRET_DIR_NAMES.has(lower)) return true;
  return false;
}

/**
 * 读路径检查（`read_file` / `read_image` / 自指工具共用）。
 *
 * 历史上读路径**完全没有检查**（可读 `~/.ssh/id_rsa`、`secrets.toml`），
 * 这里补上"密钥 + 受保护目录"两层拒绝。
 */
export function checkReadPath(
  resolvedPath: string
): { allow: true } | { allow: false; reason: string } {
  const abs = path.resolve(resolvedPath);
  if (isRuntimeSecretPath(abs)) {
    return { allow: false, reason: `"${path.basename(abs)}" 属于密钥/凭据` };
  }
  for (const seg of abs.split(path.sep)) {
    if (DANGEROUS_DIRECTORIES.includes(seg)) {
      return { allow: false, reason: `路径包含受保护目录 "${seg}"` };
    }
  }
  const base = path.basename(abs);
  if (DANGEROUS_FILES.includes(base)) {
    return { allow: false, reason: `禁止读取敏感配置文件 "${base}"` };
  }
  return { allow: true };
}

/**
 * 该 agent 是否被授予**自指运行权限**（`config.toml` 的 `[self_access].grantedAgents`）。
 *
 * 未授权时整个自指能力不可用（工具返回"已拒绝"），授权后 `~/.tinyclaw` 树内
 * 可自由读写，但密钥路径始终被上层拒绝。
 */
export function isSelfAccessGranted(agentId: string): boolean {
  try {
    const cfg = loadConfig().selfAccess;
    return cfg.grantedAgents.includes(agentId) || cfg.grantedAgents.includes("*");
  } catch {
    return false;
  }
}

/**
 * 该 agent 是否把**整棵 `~/.tinyclaw`** 视为可写（`[selfAccess].wideWriteAccess`）。
 *
 * 与 `isSelfAccessGranted()`（决定 `self_runtime_*` 工具可用性）分开：磁盘清理需要自指工具，
 * 但不等于要把整个运行时目录开放给 generic 写入。
 */
export function hasWideRuntimeWrite(agentId: string): boolean {
  try {
    const cfg = loadConfig().selfAccess;
    if (!cfg.wideWriteAccess) return false;
    return cfg.grantedAgents.includes(agentId) || cfg.grantedAgents.includes("*");
  } catch {
    return false;
  }
}

function expandTilde(p: string): string {
  return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

/** 递归收集参数里所有"看起来是绝对路径"的字符串 */
function collectAbsolutePaths(value: unknown, out: string[], depth = 0): void {
  if (depth > 3) return;
  if (typeof value === "string") {
    const s = value.trim();
    if (s.startsWith("/") || s.startsWith("~")) out.push(path.resolve(expandTilde(s)));
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectAbsolutePaths(item, out, depth + 1);
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const item of Object.values(value as Record<string, unknown>)) {
      collectAbsolutePaths(item, out, depth + 1);
    }
  }
}

/**
 * 一次工具调用是否"只动自己的范围"——用于免除 MFA。
 *
 * 覆盖范围（任一命中即可）：
 * - 自己的 agent 目录 / workspace（`agents/<id>`，含 `workspace/`）
 * - 系统临时目录（`/tmp` 等）
 * - 运行时目录内**且**开了 `[selfAccess].wideWriteAccess`
 * - 会话内 `fs_grant` 已授权的路径
 *
 * 必须**至少有一个绝对路径**参数，否则不豁免（防止 `restart_tool` 这类无路径工具被误放行）；
 * 一旦出现范围外的路径，同样不豁免。
 */
export function argsAreWithinOwnScope(args: Record<string, unknown>, ctx?: ToolContext): boolean {
  const paths: string[] = [];
  collectAbsolutePaths(args, paths);
  if (paths.length === 0) return false;
  const agentId = ctx?.agentId ?? "default";
  const own = [agentManager.workspaceDir(agentId), os.tmpdir(), "/tmp"];
  const session = ctx?.masterSession;
  const wideRuntime = hasWideRuntimeWrite(agentId);

  return paths.every((p) => {
    if (isRuntimeSecretPath(p)) return false;
    if (own.some((base) => p === base || p.startsWith(path.resolve(base) + path.sep))) return true;
    if (wideRuntime && isInsideRuntime(p)) return true;
    return session?.isWritePathGranted?.(p) === true;
  });
}

/**
 * 兼容旧名（等价于 `argsAreWithinOwnScope`）。
 * @deprecated 用 `argsAreWithinOwnScope` —— 语义已从"只动运行时目录"扩展到"只动自己的范围"。
 */
export const argsAreSelfRuntimeOnly = argsAreWithinOwnScope;

// ── 路径写入检查 ──────────────────────────────────────────────────────────────

/**
 * 检查目标路径是否允许写入。
 *
 * 返回值：
 * - `{ allow: true }` — 白名单内 或 本轮已授权，放行
 * - `{ allow: false, isDangerous: true,  reason }` — 命中黑名单，直接拒绝，不走确认
 * - `{ allow: false, isDangerous: false, reason }` — 超出白名单，走越界确认流程
 */
export function checkWritePath(
  resolvedPath: string,
  ctx?: ToolContext
): { allow: true } | { allow: false; isDangerous: boolean; reason: string } {
  const sep = path.sep;

  // ── 第2层：黑名单检查 ─────────────────────────────────────────────────────
  // 1. 路径各 segment 是否含危险目录名
  const segments = resolvedPath.split(sep);
  for (const seg of segments) {
    if (DANGEROUS_DIRECTORIES.includes(seg)) {
      return {
        allow: false,
        isDangerous: true,
        reason: `路径包含受保护目录 "${seg}"`,
      };
    }
  }
  // 2. 文件名（或路径末端）是否为危险文件名，或以危险文件路径片段结尾
  const basename = path.basename(resolvedPath);
  if (DANGEROUS_FILES.includes(basename)) {
    return {
      allow: false,
      isDangerous: true,
      reason: `禁止写入敏感配置文件 "${basename}"`,
    };
  }
  // 路径是否包含带斜杠的危险文件路径（如 .ssh/config）
  for (const dangerousFile of DANGEROUS_FILES) {
    if (dangerousFile.includes("/")) {
      const normalized = dangerousFile.split("/").join(sep);
      if (resolvedPath.endsWith(sep + normalized) || resolvedPath === normalized) {
        return {
          allow: false,
          isDangerous: true,
          reason: `禁止写入敏感配置文件 "${dangerousFile}"`,
        };
      }
    }
  }

  // ── 密钥路径：硬拒（即使本轮已授权、即使 agent 有自指权限也不放行）──────────
  if (isRuntimeSecretPath(resolvedPath)) {
    return {
      allow: false,
      isDangerous: true,
      reason: `"${path.basename(resolvedPath)}" 属于密钥/凭据`,
    };
  }

  // ── 检查本轮已授权路径 ────────────────────────────────────────────────────
  const approvedSet = ctx?.masterSession?.approvedOutOfBoundPaths;
  if (approvedSet?.has(resolvedPath)) {
    return { allow: true };
  }

  // ── 路径级无感授权（fs_grant）：会话内有 TTL 的授权集合 ────────────────────
  if (ctx?.masterSession?.isWritePathGranted?.(resolvedPath)) {
    return { allow: true };
  }

  // ── 自指权限：是否把 ~/.tinyclaw 整棵树都当可写 ────────────────────────────
  // （默认 false：generic 写入只允许自己的 agent 目录，其他位置要 fs_grant 显式申请）
  if (ctx && isInsideRuntime(resolvedPath) && hasWideRuntimeWrite(ctx.agentId ?? "default")) {
    return { allow: true };
  }

  // ── 第1层：白名单检查 ─────────────────────────────────────────────────────
  // **默认只有 workspace**（+ 系统临时目录）。agent 目录下的其他部分（memory / skills /
  // MEM.md / SYSTEM.md / agent.toml …）与运行时目录其他部分都属于"越界"：
  // 由用户确认，或先由 agent 主动 `fs_grant` 申请（路径级、带 TTL、写审计）。
  const agentId = ctx?.agentId ?? "default";
  const bases: string[] = [
    agentManager.workspaceDir(agentId), // ~/.tinyclaw/agents/<id>/workspace
    path.join(os.tmpdir()), // /tmp 或系统临时目录
    "/tmp", // 明确包含 /tmp（tmpdir() 可能返回 /var/folders/... on macOS）
  ];

  // code 模式下 ctx.cwd = codeWorkdir，若不在现有 bases 内则额外加入
  if (ctx?.cwd) {
    const cwd = ctx.cwd;
    if (!bases.some((b) => cwd === b || cwd.startsWith(b + sep))) {
      bases.push(cwd);
    }
  }

  const inWhitelist = bases.some((b) => resolvedPath === b || resolvedPath.startsWith(b + sep));

  if (inWhitelist) {
    return { allow: true };
  }

  return {
    allow: false,
    isDangerous: false,
    reason: `路径 "${resolvedPath}" 超出允许的工作目录范围`,
  };
}
