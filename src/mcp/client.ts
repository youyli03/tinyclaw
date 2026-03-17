/**
 * MCP Client Manager
 *
 * 启动时读取 ~/.tinyclaw/mcp.toml，连接所有 enabled 的 MCP server，
 * 自动发现工具并注册到 tinyclaw 的 tool registry。
 *
 * 工具命名规范：mcp_{serverName}_{toolName}
 * MFA 控制：沿用 auth.mfa.tools 列表，直接填写工具全名即可。
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { registerTool } from "../tools/registry.js";
import { loadMcpConfig, loadConfig } from "../config/loader.js";
import type { MCPConfig, MCPServerConfig } from "../config/schema.js";

/** Sanitize server/tool name: 只保留字母数字下划线，截断到 32 字符 */
function sanitizeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 32);
}

/** 构造 MCP 工具的注册名 */
function mcpToolName(serverName: string, toolName: string): string {
  return `mcp_${sanitizeName(serverName)}_${sanitizeName(toolName)}`.slice(0, 64);
}

class MCPClientManager {
  private clients: Map<string, Client> = new Map();

  /**
   * 初始化所有 enabled MCP servers，注册工具到 registry。
   * 单个 server 连接失败时 warn + skip，不影响整体启动。
   */
  async init(): Promise<void> {
    const cfg: MCPConfig = loadMcpConfig();
    const entries = Object.entries(cfg.servers);
    if (entries.length === 0) return;

    for (const [name, serverCfg] of entries) {
      if (serverCfg.enabled === false) {
        console.log(`[mcp] server '${name}' disabled, skipping`);
        continue;
      }
      try {
        await this.connectServer(name, serverCfg);
      } catch (err) {
        console.warn(`[mcp] server '${name}' failed to initialize:`, err instanceof Error ? err.message : err);
      }
    }
  }

  private async connectServer(name: string, cfg: MCPServerConfig): Promise<void> {
    const client = new Client({ name: "tinyclaw", version: "0.1.0" });

    let transport;
    if (cfg.transport === "stdio") {
      transport = new StdioClientTransport({
        command: cfg.command,
        args: cfg.args,
        ...(cfg.env !== undefined ? { env: { ...(process.env as Record<string, string>), ...cfg.env } } : {}),
      });
    } else {
      // sse
      const url = new URL(cfg.url);
      transport = new SSEClientTransport(url);
    }

    await client.connect(transport);

    const { tools } = await client.listTools();
    this.clients.set(name, client);

    // 查询哪些工具名需要 MFA（从主配置 auth.mfa.tools 列表）
    let mfaTools: Set<string>;
    try {
      mfaTools = new Set(loadConfig().auth.mfa?.tools ?? []);
    } catch {
      mfaTools = new Set();
    }

    let registeredCount = 0;
    for (const tool of tools) {
      const registeredName = mcpToolName(name, tool.name);
      const requiresMFA = mfaTools.has(registeredName);

      // 将 MCP JSON Schema 转换为 OpenAI function calling 格式
      const parameters = (tool.inputSchema && typeof tool.inputSchema === "object")
        ? tool.inputSchema
        : { type: "object", properties: {}, required: [] };

      registerTool({
        spec: {
          type: "function",
          function: {
            name: registeredName,
            description: `[MCP:${name}] ${tool.description ?? tool.name}`,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            parameters: parameters as any,
          },
        },
        requiresMFA,
        execute: async (args) => {
          try {
            const result = await client.callTool({ name: tool.name, arguments: args });
            if (result.isError) {
              const errText = Array.isArray(result.content)
                ? result.content
                    .filter((c) => c.type === "text")
                    .map((c) => (c as { type: "text"; text: string }).text)
                    .join("\n")
                : String(result.content);
              return `Error: ${errText}`;
            }
            // 合并所有文本 content
            if (Array.isArray(result.content)) {
              return result.content
                .filter((c) => c.type === "text")
                .map((c) => (c as { type: "text"; text: string }).text)
                .join("\n");
            }
            return String(result.content);
          } catch (err) {
            return `Error calling MCP tool '${tool.name}': ${err instanceof Error ? err.message : String(err)}`;
          }
        },
      });
      registeredCount++;
    }

    console.log(`[mcp] server '${name}' initialized, ${registeredCount} tool(s): ${tools.map((t) => mcpToolName(name, t.name)).join(", ")}`);
  }

  /** 关闭所有 MCP 连接（进程退出时调用） */
  async close(): Promise<void> {
    for (const [name, client] of this.clients) {
      try {
        await client.close();
      } catch (err) {
        console.warn(`[mcp] error closing server '${name}':`, err instanceof Error ? err.message : err);
      }
    }
    this.clients.clear();
  }
}

export const mcpManager = new MCPClientManager();
