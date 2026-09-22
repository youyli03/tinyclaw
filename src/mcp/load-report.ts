/**
 * MCP 载入诊断的展示层（纯函数，无 IO）
 *
 * 同一份文本被三处消费：`mcp_list_servers` 工具返回、CLI `tinyclaw mcp status`、启动日志汇总。
 * 单独放一个文件是为了让 CLI 不必 import `mcp/client.ts`（那会连带拉起 MCP SDK 与工具注册表）。
 */

import type { McpLoadDiagnostic } from "../config/loader.js";

/** 载入触发来源 */
export type McpLoadTrigger = "startup" | "reload" | "watch" | "cli";

/** 汇总一行，如 `3 server(s), 1 error(s)` */
export function summarizeLoad(diagnostics: McpLoadDiagnostic[], serverCount: number): string {
  const errors = diagnostics.filter((d) => d.level === "error").length;
  const infos = diagnostics.length - errors;
  const parts = [`${serverCount} server(s)`];
  if (errors > 0) parts.push(`${errors} error(s)`);
  if (infos > 0) parts.push(`${infos} info`);
  return parts.join(", ");
}

/**
 * 诊断文本行（Markdown / 终端通用）。无诊断时返回空数组。
 *
 * @param level `"error"` 只看错误（启动日志用），`"all"` 含 info（agent 工具 / CLI 用）
 */
export function formatDiagnostics(
  diagnostics: McpLoadDiagnostic[],
  level: "all" | "error" = "all"
): string[] {
  const rows = level === "error" ? diagnostics.filter((d) => d.level === "error") : diagnostics;
  if (rows.length === 0) return [];
  const hasError = rows.some((d) => d.level === "error");
  const lines = [`## ${hasError ? "⚠️ MCP 载入告警" : "ℹ️ MCP 载入提示"} (${rows.length})`];
  for (const d of rows) {
    const where = d.scope === "server" && d.server !== undefined ? `servers.${d.server}` : "mcp.toml";
    lines.push(`- [${d.level}][${d.code}] ${where}: ${d.message}`);
    if (d.hint !== undefined) lines.push(`  → ${d.hint}`);
  }
  return lines;
}
