import * as path from "node:path";
import * as os from "node:os";
import { agentManager } from "../core/agent-manager.js";
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
  ctx?: ToolContext,
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

  // ── 检查本轮已授权路径 ────────────────────────────────────────────────────
  const approvedSet = ctx?.masterSession?.approvedOutOfBoundPaths;
  if (approvedSet?.has(resolvedPath)) {
    return { allow: true };
  }

  // ── 第1层：白名单检查 ─────────────────────────────────────────────────────
  const agentId = ctx?.agentId ?? "default";
  const bases: string[] = [
    agentManager.workspaceDir(agentId),   // ~/.tinyclaw/agents/<id>/workspace
    agentManager.agentDir(agentId),       // ~/.tinyclaw/agents/<id>
    path.join(os.tmpdir()),               // /tmp 或系统临时目录
    "/tmp",                               // 明确包含 /tmp（tmpdir() 可能返回 /var/folders/... on macOS）
  ];

  // code 模式下 ctx.cwd = codeWorkdir，若不在现有 bases 内则额外加入
  if (ctx?.cwd) {
    const cwd = ctx.cwd;
    if (!bases.some((b) => cwd === b || cwd.startsWith(b + sep))) {
      bases.push(cwd);
    }
  }

  const inWhitelist = bases.some(
    (b) => resolvedPath === b || resolvedPath.startsWith(b + sep),
  );

  if (inWhitelist) {
    return { allow: true };
  }

  return {
    allow: false,
    isDangerous: false,
    reason: `路径 "${resolvedPath}" 超出允许的工作目录范围`,
  };
}
