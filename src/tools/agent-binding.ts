/**
 * "自我管理"类工具的**默认绑定**：默认只有 `default` agent 能用
 *
 * 为什么：这些工具改的是**跑着 agent 的那套配置**（模型、MCP server、config.toml）。
 * 多 agent 场景里，普通 agent 不该有"改自己（和别的 agent）的运行配置"的能力 ——
 * 但 `default` 通常就是那个"管家"角色，所以给它。其他 agent 要放开，就在 `config.toml` 里显式授权：
 *
 * ```toml
 * [tools.selfManagement]
 * agents = ["default", "onlychat"]   # 空数组 = 谁都不给（包括 default）
 * ```
 *
 * 两层执行口径（都要有，缺一个就有绕法）：
 * - **可见性**：`tools/registry.ts` 的 `getAllToolSpecs(agentId)` 直接不把这些工具交给其他 agent 的模型
 * - **执行**：每个工具自己再校验一次 `ctx.agentId`（cron/loop 的**声明式步骤**按名字直接调 `executeTool`，
 *   绕过可见性过滤，因此执行层必须自己兜住）
 */

import { loadConfig } from "../config/loader.js";

/**
 * 默认只绑定给 `default` 的自我管理工具
 *
 * 口径：**会改运行配置的**才绑 —— `config_*` 与写 `mcp.toml` 的那几个。
 * 纯开关类 MCP 工具（`mcp_list_servers` / `mcp_enable_server` / `mcp_disable_server`）不绑：
 * 它们只是"在自己的权限范围内开关 MCP 能力"，且仍受 per-agent `mcp.toml` 白名单约束。
 */
export const DEFAULT_AGENT_ONLY_TOOLS: ReadonlySet<string> = new Set([
  // config.toml 本身
  "config_validate",
  "config_reload",
  "config_set",
  // 写 mcp.toml（改配置 + 让它生效）
  "mcp_server_add",
  "mcp_server_remove",
  "mcp_server_set_enabled",
  "mcp_reload",
]);

/** 默认被授权的 agentId 列表（schema 默认值；改 schema 时同步改这里） */
export const DEFAULT_SELF_MANAGEMENT_AGENTS: readonly string[] = ["default"];

/**
 * 该 agent 是否被允许使用自我管理工具。
 *
 * @param agentId 上下文里的 agentId；**undefined = 没有 agent 上下文**（CLI / cron 无绑定场景）→ 放行，
 *                否则 CLI 与定时任务会被误伤
 * @param agents  授权列表；默认从 `config.toml` 的 `[tools.selfManagement].agents` 读（读不到就用默认值）
 */
export function isSelfManagementAllowed(agentId?: string, agents?: readonly string[]): boolean {
  if (agentId === undefined || agentId === "") return true;
  const list = agents ?? loadSelfManagementAgents();
  if (list.includes("*")) return true;
  return list.includes(agentId);
}

/** 读 `[tools.selfManagement].agents`（配置不可用时回退到默认值，绝不抛错） */
export function loadSelfManagementAgents(): readonly string[] {
  try {
    const cfg = loadConfig();
    const list = (cfg.tools as { selfManagement?: { agents?: string[] } }).selfManagement?.agents;
    return Array.isArray(list) ? list : DEFAULT_SELF_MANAGEMENT_AGENTS;
  } catch {
    return DEFAULT_SELF_MANAGEMENT_AGENTS;
  }
}

/**
 * 工具执行层的统一守卫。
 *
 * @returns 拒绝文案（`已拒绝：…`）；允许时返回 null
 */
export function guardSelfManagement(
  toolName: string,
  agentId?: string,
  agents?: readonly string[]
): string | null {
  if (isSelfManagementAllowed(agentId, agents)) return null;
  const list = (agents ?? loadSelfManagementAgents()).join(", ") || "（空）";
  return (
    `已拒绝：工具 ${toolName} 默认只绑定给 default agent，当前 agent "${agentId}" 未被授权。` +
    `如需放开，请在 ~/.tinyclaw/config.toml 写入 [tools.selfManagement] agents = ["default", "${agentId}"]` +
    `（当前授权列表：${list}）`
  );
}
