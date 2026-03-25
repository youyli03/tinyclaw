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

registerTool({
  spec: {
    type: "function",
    function: {
      name: "mcp_list_servers",
      description:
        "列出所有已配置的 MCP server（名称、描述、启用状态、连接状态、工具数量）。" +
        "返回轻量目录，不包含具体工具 schema。" +
        "若需使用某个 server 的工具，先调用此工具查看可用 server，再调用 mcp_enable_server 启用。",
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
    if (servers.length === 0) {
      return "当前没有你可访问的 MCP server。请联系管理员在 ~/.tinyclaw/mcp.toml 中配置，或检查 agents 白名单设置。";
    }
    const lines = ["## MCP Servers\n"];
    for (const s of servers) {
      const status = s.connected
        ? `已连接（${s.toolCount} 个工具可用）`
        : s.error
          ? `连接失败：${s.error}`
          : s.enabled
            ? "未连接（可 enable）"
            : "已禁用（mcp.toml enabled=false）";
      lines.push(`### ${s.name}`);
      if (s.description) lines.push(s.description);
      lines.push(`状态：${status}`);
      lines.push("");
    }
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
        "启用指定 MCP server：建立连接（首次时）并将其工具注册到 LLM 上下文中。" +
        "返回该 server 的完整工具文档（工具名列表及说明），下一轮对话即可直接调用这些工具。",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "要启用的 MCP server 名称（与 mcp.toml 中的键名一致）",
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
    return mcpManager.enableServer(name, ctx?.agentId);
  },
});

registerTool({
  spec: {
    type: "function",
    function: {
      name: "mcp_disable_server",
      description:
        "禁用指定 MCP server 的工具（从 LLM 上下文中隐藏）。" +
        "底层连接保持，再次 enable 时无需重连。适用于暂时不需要某个 server 的工具以节省 token。",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "要禁用的 MCP server 名称",
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
    return mcpManager.disableServer(name, ctx?.agentId);
  },
});
