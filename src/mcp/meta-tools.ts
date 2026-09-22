/**
 * MCP 框架级工具名单（meta-tools）
 *
 * 为什么需要它：agent 的 MCP 白名单（`~/.tinyclaw/agents/<id>/mcp.toml`）本来靠
 * "工具名前缀 `mcp_<server>_`" 反推 server —— 框架自己的工具（`mcp_list_servers` …）
 * 恰好也是 `mcp_` 前缀，之前是靠"前缀匹配不上任何 server → 放行"侥幸通过。
 * 有了这里显式声明的集合，per-agent 白名单不会再误伤框架工具。
 *
 * 另：`MCP_ADMIN_TOOLS` 是**会改动 mcp.toml** 的工具，它们走**内置工具**过滤口径
 * （`tools.toml` 的黑/白名单），这样管理员能按 agent 关掉"自管理 MCP"的能力；
 * 其余 meta-tool 保持历史行为（不受 `tools.toml` 影响）。
 */

/** 全部框架级 MCP 工具 */
export const MCP_META_TOOLS: ReadonlySet<string> = new Set([
  "mcp_list_servers",
  "mcp_enable_server",
  "mcp_disable_server",
  "mcp_server_add",
  "mcp_server_remove",
  "mcp_server_set_enabled",
  "mcp_reload",
]);

/** 会写 `mcp.toml`（或触发重载）的特权工具 —— 按内置工具口径过滤 + 无人值守硬拒绝 */
export const MCP_ADMIN_TOOLS: ReadonlySet<string> = new Set([
  "mcp_server_add",
  "mcp_server_remove",
  "mcp_server_set_enabled",
  "mcp_reload",
]);
