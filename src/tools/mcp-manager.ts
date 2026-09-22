/**
 * MCP 管理工具（meta-tools）
 *
 * 注册三个 Agent 可调用的管理工具，实现 Skills 风格的 MCP 懒加载：
 * 1. mcp_list_servers  — 列出所有已配置的 server（轻量目录，无 tool schema）
 * 2. mcp_enable_server — 懒连接 server 并返回工具文档（类似 Agent 读 Skill 文件）
 * 3. mcp_disable_server — 隐藏 server 的工具（保持连接）
 */

import { registerTool } from "./registry.js";
import { mcpManager } from "../mcp/client.js";
import { formatDiagnostics } from "../mcp/load-report.js";

registerTool({
  spec: {
    type: "function",
    function: {
      name: "mcp_list_servers",
      description:
        "List all configured MCP servers (name, description, enabled state, connection " +
        "state, tool count) together with the mcp.toml load report: any load error (bad TOML " +
        "syntax, invalid [servers.X] entry, unreadable file) and each server's last connection " +
        "error. Returns a lightweight catalog without per-tool schemas. " +
        "To use a server's tools, call this tool first to see the available servers, then " +
        "call mcp_enable_server to enable one.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  requiresMFA: false,
  execute: async (args, ctx) => {
    const servers = mcpManager.listServers(ctx?.agentId);
    const report = mcpManager.getLoadReport();
    const diagLines = formatDiagnostics(report.diagnostics, "all");
    const footNote =
      `> 配置载入：${report.loadedAt ?? "尚未载入"}（trigger=${report.trigger}，` +
      `${report.fileExists ? "~/.tinyclaw/mcp.toml 存在" : "未配置 mcp.toml"}）`;

    if (servers.length === 0) {
      const head = report.fileExists
        ? "当前没有你可访问的 MCP server（可能被 agent 白名单排除，或配置全部载入失败）。"
        : "当前没有你可访问的 MCP server：~/.tinyclaw/mcp.toml 不存在（未配置 MCP）。";
      return [head, ...(diagLines.length > 0 ? ["", ...diagLines] : []), "", footNote].join("\n");
    }
    const lines = ["## MCP Servers\n"];
    for (const s of servers) {
      const status = s.connected
        ? `已连接（${s.toolCount} 个工具可用）`
        : s.error
          ? `连接失败${s.lastErrorAt !== undefined ? `（${s.lastErrorAt}）` : ""}：${s.error}`
          : s.enabled
            ? "未连接（可 enable）"
            : "已禁用（mcp.toml enabled=false）";
      lines.push(`### ${s.name}`);
      if (s.description) lines.push(s.description);
      lines.push(`状态：${status}`);
      lines.push("");
    }
    if (diagLines.length > 0) lines.push(...diagLines, "");
    lines.push(footNote, "");
    lines.push(
      "> 使用 `mcp_enable_server` 启用某个 server 以获取其工具文档并注册工具。\n" +
        "> 使用 `mcp_disable_server` 禁用已启用的 server（释放 token 空间，连接保持）。"
    );
    return lines.join("\n");
  },
});

registerTool({
  spec: {
    type: "function",
    function: {
      name: "mcp_enable_server",
      description:
        "Enable the given MCP server: connects on first use and registers its tools in the " +
        "LLM context. Returns the server's full tool docs (tool names and descriptions); " +
        "these tools can be called directly in the next turn.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Name of the MCP server to enable (must match the key in mcp.toml)",
          },
        },
        required: ["name"],
      },
    },
  },
  requiresMFA: false,
  execute: async (args, ctx) => {
    const name = String(args["name"] ?? "");
    if (!name) return "错误：缺少 name 参数。";
    return mcpManager.enableServer(
      name,
      ctx?.agentId,
      ctx?.sessionId,
      ctx?.mode as "chat" | "code" | undefined
    );
  },
});

registerTool({
  spec: {
    type: "function",
    function: {
      name: "mcp_disable_server",
      description:
        "Disable the given MCP server's tools (hide them from the LLM context). The " +
        "underlying connection stays alive, so enabling it again needs no reconnect. " +
        "Use it when a server's tools are not needed for now, to save tokens.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Name of the MCP server to disable",
          },
        },
        required: ["name"],
      },
    },
  },
  requiresMFA: false,
  execute: async (args, ctx) => {
    const name = String(args["name"] ?? "");
    if (!name) return "错误：缺少 name 参数。";
    return mcpManager.disableServer(
      name,
      ctx?.agentId,
      ctx?.sessionId,
      ctx?.mode as "chat" | "code" | undefined
    );
  },
});
