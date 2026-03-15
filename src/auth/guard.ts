import { MFAError } from "./mfa.js";
import type { MFAConfig } from "../config/schema.js";

/**
 * 判断某次工具调用是否需要 MFA 验证。
 *
 * 规则（由 config.toml [auth.mfa] 控制）：
 * - `tools[]` 中列出的工具名：整工具触发 MFA
 * - `exec_shell`：仅当命令中包含 `exec_shell_patterns.patterns[]` 中的关键词时触发
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
    return matchesExecShellPatterns(command, cfg.exec_shell_patterns.patterns);
  }

  return false;
}

function matchesExecShellPatterns(command: string, patterns: string[]): boolean {
  for (const p of patterns) {
    // 转义正则特殊字符，使用 word-boundary 匹配避免误杀（如 "rm" 不匹配 "permission"）
    const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\b${escaped}\\b`).test(command)) return true;
  }
  return false;
}

export { MFAError };
