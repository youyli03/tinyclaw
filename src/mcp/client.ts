/**
 * MCP Client Manager（懒加载版）
 *
 * 设计：启动时只读取配置、不连接任何 server，也不注册任何 MCP 工具。
 * Agent 通过 mcp_list_servers / mcp_enable_server / mcp_disable_server 三个
 * meta-tool 按需连接 server，并控制 MCP 工具的 LLM 可见性。
 *
 * 工具命名规范：mcp_{serverName}_{toolName}（sanitize 后最长 64 字符）
 * 工具注册后始终存在于 registry，通过 hidden 字段控制 LLM 是否能看到。
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { registerTool, setToolVisibility, setMcpAgentFilter } from "../tools/registry.js";
import { loadMcpConfig, loadConfig } from "../config/loader.js";
import type { MCPConfig, MCPServerConfig } from "../config/schema.js";

/** 单个 server 的运行时状态 */
interface MCPRuntime {
  /** 已连接的 MCP 客户端（未连接时为 undefined） */
  client?: Client;
  /** 已注册的工具名列表（注册一次后保持） */
  toolNames: string[];
  /** 当前是否已连接（tools 已注册且 visible） */
  connected: boolean;
  /** 最近一次连接失败的错误信息 */
  error?: string;
}

/** 供外部（mcp-manager.ts）使用的轻量状态对象 */
export interface MCPServerStatus {
  name: string;
  description?: string;
  /** mcp.toml 中 enabled 字段 */
  enabled: boolean;
  /** 当前是否已连接（agent 主动 enable 后） */
  connected: boolean;
  /** 已注册的工具数量（连接后才有值，否则为 0） */
  toolCount: number;
  /** 最近的连接错误（若有） */
  error?: string;
  /**
   * Agent 白名单（来自 mcp.toml agents 字段）。
   * undefined / 空数组 = 所有 agent 可用。
   */
  agents?: string[];
}

/** Sanitize server/tool name: 只保留字母数字下划线，截断到 32 字符 */
function sanitizeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 32);
}

/** 构造 MCP 工具的注册名 */
function mcpToolName(serverName: string, toolName: string): string {
  return `mcp_${sanitizeName(serverName)}_${sanitizeName(toolName)}`.slice(0, 64);
}

class MCPClientManager {
  private loadedConfig: MCPConfig = { servers: {} };
  private runtimes: Map<string, MCPRuntime> = new Map();

  /**
   * 初始化：只加载配置，不连接任何 server。
   * 若 mcp.toml 不存在则静默跳过。
   * 同时向 registry 注册 MCP 工具的 agent 过滤回调（解决循环依赖）。
   */
  async init(): Promise<void> {
    this.loadedConfig = loadMcpConfig();
    const entries = Object.entries(this.loadedConfig.servers);
    for (const [name] of entries) {
      this.runtimes.set(name, { toolNames: [], connected: false });
    }
    if (entries.length > 0) {
      console.log(`[mcp] loaded config: ${entries.length} server(s) (lazy mode, none connected)`);
    }
    // 向 registry 注册过滤回调，供 getAllToolSpecs(agentId) 调用
    setMcpAgentFilter((toolName: string, agentId: string) => this.isToolAllowedForAgent(toolName, agentId));
  }

  /**
   * 判断某个 MCP server 是否对指定 agent 可见。
   * - server 未配置 agents 白名单（或为空）→ 所有 agent 可用
   * - server 配置了白名单 → 只有白名单内的 agentId 可用
   * - agentId 为 undefined → 不限制（CLI / cron 无 agent 上下文场景）
   */
  isAllowedForAgent(serverName: string, agentId?: string): boolean {
    if (!agentId) return true;
    const cfg = this.loadedConfig.servers[serverName];
    if (!cfg) return false;
    const agents = cfg.agents;
    if (!agents || agents.length === 0) return true;
    return agents.includes(agentId);
  }

  /**
   * 判断某个已注册的 MCP 工具名是否对指定 agent 可见。
   * 从工具名反推 server 名（mcp_<server>_<tool>），再调用 isAllowedForAgent。
   * 供 registry 的 getAllToolSpecs 过滤回调使用。
   */
  isToolAllowedForAgent(toolName: string, agentId: string): boolean {
    // 工具名格式：mcp_<sanitizedServerName>_<sanitizedToolName>
    // sanitizeName 将非字母数字下划线替换为 _，无法精确反推原始 server 名，
    // 改为遍历所有已知 server，检查该工具是否属于该 server 且该 server 允许此 agent
    for (const [serverName, rt] of this.runtimes) {
      if (rt.toolNames.includes(toolName)) {
        return this.isAllowedForAgent(serverName, agentId);
      }
    }
    // 工具尚未注册（server 未连接），尝试从工具名前缀匹配 server
    // mcp_<sanitizedServerName>_ 前缀匹配
    for (const serverName of Object.keys(this.loadedConfig.servers)) {
      const prefix = `mcp_${sanitizeName(serverName)}_`;
      if (toolName.startsWith(prefix)) {
        return this.isAllowedForAgent(serverName, agentId);
      }
    }
    // 未知工具，允许通过（不影响非 MCP 工具）
    return true;
  }

  /**
   * 列出已配置的 MCP server（轻量，无 tool schema）。
   * 若传入 agentId，只返回该 agent 有权访问的 server。
   * 供 mcp_list_servers meta-tool 使用。
   */
  listServers(agentId?: string): MCPServerStatus[] {
    return Object.entries(this.loadedConfig.servers)
      .filter(([name]) => this.isAllowedForAgent(name, agentId))
      .map(([name, cfg]) => {
        const rt = this.runtimes.get(name) ?? { toolNames: [], connected: false };
        const status: MCPServerStatus = {
          name,
          enabled: cfg.enabled !== false,
          connected: rt.connected,
          toolCount: rt.toolNames.length,
        };
        if (cfg.description !== undefined) status.description = cfg.description;
        if (rt.error !== undefined) status.error = rt.error;
        if (cfg.agents && cfg.agents.length > 0) status.agents = cfg.agents;
        return status;
      });
  }

  /**
   * 启用指定 server：懒连接（若尚未连接）→ 将工具设为 visible → 返回格式化工具文档。
   * 若传入 agentId 且该 agent 不在白名单中，返回权限错误。
   * 供 mcp_enable_server meta-tool 使用。
   */
  async enableServer(name: string, agentId?: string): Promise<string> {
    const cfg = this.loadedConfig.servers[name];
    if (!cfg) {
      return `错误：未找到 MCP server "${name}"，请先用 mcp_list_servers 查看可用列表。`;
    }
    if (cfg.enabled === false) {
      return `错误：server "${name}" 在 mcp.toml 中已被禁用（enabled = false），无法启用。`;
    }
    if (!this.isAllowedForAgent(name, agentId)) {
      return `错误：agent "${agentId}" 无权访问 MCP server "${name}"。`;
    }

    const rt = this.runtimes.get(name)!;

    // 懒连接：若尚未连接则建立连接并注册工具（hidden: true）
    if (!rt.client) {
      try {
        await this.connectServer(name, cfg, rt);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        rt.error = msg;
        return `错误：连接 MCP server "${name}" 失败：${msg}`;
      }
    }

    // 将该 server 的所有工具设为 visible
    for (const toolName of rt.toolNames) {
      setToolVisibility(toolName, false);
    }
    rt.connected = true;
    delete rt.error;

    // 构造工具文档（类似 Skill 文件内容）返回给 Agent
    return this.buildToolDocs(name, cfg, rt);
  }

  /**
   * 禁用指定 server：将工具设为 hidden（保持连接，避免重连延迟）。
   * 若传入 agentId 且该 agent 不在白名单中，返回权限错误。
   * 供 mcp_disable_server meta-tool 使用。
   */
  disableServer(name: string, agentId?: string): string {
    const cfg = this.loadedConfig.servers[name];
    if (!cfg) {
      return `错误：未找到 MCP server "${name}"。`;
    }
    if (!this.isAllowedForAgent(name, agentId)) {
      return `错误：agent "${agentId}" 无权访问 MCP server "${name}"。`;
    }
    const rt = this.runtimes.get(name);
    if (!rt || !rt.connected) {
      return `server "${name}" 当前未启用，无需禁用。`;
    }
    for (const toolName of rt.toolNames) {
      setToolVisibility(toolName, true);
    }
    rt.connected = false;
    return `已禁用 server "${name}" 的 ${rt.toolNames.length} 个工具（连接保持，再次 enable 无需重连）。`;
  }

  /** 关闭所有 MCP 连接（进程退出时调用） */
  async close(): Promise<void> {
    for (const [name, rt] of this.runtimes) {
      if (rt.client) {
        try {
          await rt.client.close();
        } catch (err) {
          console.warn(`[mcp] error closing server '${name}':`, err instanceof Error ? err.message : err);
        }
      }
    }
    this.runtimes.clear();
  }

  // ── 私有辅助方法 ──────────────────────────────────────────────────────────

  /**
   * 建立连接，注册工具到 registry（hidden: true），更新 rt。
   * 工具一旦注册就不再重复注册（rt.toolNames 非空则跳过）。
   */
  private async connectServer(name: string, cfg: MCPServerConfig, rt: MCPRuntime): Promise<void> {
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
    rt.client = client;

    if (rt.toolNames.length > 0) {
      // 已注册过，只更新 client 引用（不重复注册）
      return;
    }

    // 查询哪些工具名需要 MFA（从主配置 auth.mfa.tools 列表）
    let mfaTools: Set<string>;
    try {
      mfaTools = new Set(loadConfig().auth.mfa?.tools ?? []);
    } catch {
      mfaTools = new Set();
    }

    for (const tool of tools) {
      const registeredName = mcpToolName(name, tool.name);
      const requiresMFA = mfaTools.has(registeredName);

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
        hidden: true, // 注册时默认隐藏，enableServer 后才可见
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

      rt.toolNames.push(registeredName);
    }

    console.log(`[mcp] server '${name}' connected (lazy), ${rt.toolNames.length} tool(s) registered (hidden)`);
  }

  /**
   * 构造 Markdown 格式工具文档，enableServer 时返回给 Agent。
   * 类似 Agent 读取 Skill 文件的效果——让 Agent 在同一轮就了解如何使用这些工具。
   */
  private buildToolDocs(name: string, cfg: MCPServerConfig, rt: MCPRuntime): string {
    const lines: string[] = [`## MCP Server: ${name}`];
    if (cfg.description) {
      lines.push(`\n${cfg.description}`);
    }
    lines.push(`\n以下 ${rt.toolNames.length} 个工具现已可用，你可在接下来的对话中直接调用：\n`);
    for (const toolName of rt.toolNames) {
      lines.push(`- \`${toolName}\``);
    }
    lines.push(`\n> 若要取消所有这些工具，调用 \`mcp_disable_server\`，参数 name="${name}"。`);
    return lines.join("\n");
  }
}

export const mcpManager = new MCPClientManager();
