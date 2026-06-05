import { MFAError } from "./mfa.js";
import type { MFAConfig } from "../config/schema.js";

/**
 * 判断某次工具调用是否需要 MFA 验证。
 *
 * 规则(由 config.toml [auth.mfa] 控制):
 * - `tools[]` 中列出的工具名:整工具触发 MFA
 * - `exec_shell`:仅当命令中包含 `exec_shell_patterns.patterns[]` 中的关键词时触发
 * - 所有工具:参数中任意 string 值含 `--force` 或独立 `-f` flag 时触发 MFA
 */
export function toolNeedsMFA(
  toolName: string,
  args: Record<string, unknown>,
  cfg: MFAConfig | undefined
): boolean {
  if (!cfg) return false;

  // 整工具黑名单
  if (cfg.tools.includes(toolName)) return true;

  // exec_shell 命令级黑名单
  if (toolName === "exec_shell") {
    const command = String(args["command"] ?? "");
    if (matchesExecShellPatterns(command, cfg.exec_shell_patterns.patterns)) return true;
  }

  // 所有工具：参数含 --force 或独立 -f 时触发 MFA
  if (argsContainForceFlag(args)) return true;

  return false;
}

function matchesExecShellPatterns(command: string, patterns: string[]): boolean {
  for (const p of patterns) {
    // 转义正则特殊字符,使用 word-boundary 匹配避免误杀(如 "rm" 不匹配 "permission")
    const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\b${escaped}\\b`).test(command)) return true;
  }
  return false;
}

/**
 * 检测单个字符串是否包含 --force 或独立的 -f flag。
 *
 * - `--force`：使用词边界匹配（`\b`）
 * - `-f`：前面必须是行首或空白，后面必须是行尾、空白（避免将 `-format`、`-fps` 等误判为 -f）
 */
export function containsForceFlag(value: string): boolean {
  // --force（词边界匹配）
  if (/\b--force\b/.test(value)) return true;
  // 独立 -f：前有空白/行首，后有空白/行尾
  if (/(^|\s)-f(\s|$)/.test(value)) return true;
  return false;
}

/**
 * 递归扫描工具参数中所有 string 类型的值，检测是否含有 --force 或独立 -f。
 * 扫描深度最多 2 层（避免过深递归）。
 */
export function argsContainForceFlag(
  args: Record<string, unknown>,
  depth = 0
): boolean {
  if (depth > 2) return false;
  for (const value of Object.values(args)) {
    if (typeof value === "string") {
      if (containsForceFlag(value)) return true;
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === "string" && containsForceFlag(item)) return true;
        if (typeof item === "object" && item !== null && depth < 2) {
          if (argsContainForceFlag(item as Record<string, unknown>, depth + 1)) return true;
        }
      }
    } else if (typeof value === "object" && value !== null && depth < 2) {
      if (argsContainForceFlag(value as Record<string, unknown>, depth + 1)) return true;
    }
  }
  return false;
}

export { MFAError };
