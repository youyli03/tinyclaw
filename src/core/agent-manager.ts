/**
 * AgentManager — 管理 Agent 工作区
 *
 * 每个 Agent 的文件结构：
 *   ~/.tinyclaw/agents/<id>/
 *     agent.toml    — 元数据：id、创建时间、bindings
 *     SYSTEM.md     — Agent 级系统提示（可选）
 *     MEM.md        — 跨 session 持久笔记（agent 可写，注入 system prompt）
 *     SKILLS.md     — 技能目录（agent 可写，注入 system prompt）
 *     skills/       — 技能 workflow 文件（agent 读取执行）
 *     workspace/    — exec_shell 默认工作目录
 *       tmp/        — 临时文件
 *       output/     — 输出物
 *     memory/       — QMD 向量索引
 *     mcp.toml      — MCP server 白名单（可选）
 *     tools.toml    — 内置工具黑/白名单（可选）
 */


import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { parse } from "smol-toml";

export interface AgentBinding {
  source: string;
}

export interface AgentDef {
  id: string;
  createdAt: string;
  bindings: AgentBinding[];
}

const AGENTS_ROOT = path.join(os.homedir(), ".tinyclaw", "agents");
export const DEFAULT_AGENT_ID = "default";

export class AgentManager {
  agentDir(id: string): string {
    return path.join(AGENTS_ROOT, id);
  }

  memoryDir(id: string): string {
    return path.join(AGENTS_ROOT, id, "memory");
  }

  systemPromptPath(id: string): string {
    return path.join(AGENTS_ROOT, id, "SYSTEM.md");
  }

  memPath(id: string): string {
    return path.join(AGENTS_ROOT, id, "MEM.md");
  }

  skillsPath(id: string): string {
    return path.join(AGENTS_ROOT, id, "SKILLS.md");
  }

  skillsDir(id: string): string {
    return path.join(AGENTS_ROOT, id, "skills");
  }

  workspaceDir(id: string): string {
    return path.join(AGENTS_ROOT, id, "workspace");
  }

  downloadsDir(id: string): string {
    return path.join(AGENTS_ROOT, id, "workspace", "downloads");
  }

  /** Plan 模式下 AI 输出的计划文档路径（与 MEM.md 同级） */
  planPath(id: string): string {
    return path.join(AGENTS_ROOT, id, "PLAN.md");
  }

  /**
   * Agent 级 MCP 权限配置文件路径。
   * 格式：~/.tinyclaw/agents/<id>/mcp.toml
   * 内容示例：servers = ["polymarket", "browser"]
   */
  agentMcpPath(id: string): string {
    return path.join(AGENTS_ROOT, id, "mcp.toml");
  }

  /**
   * 读取 agent 的 MCP server 白名单。
   * - 文件不存在 → 返回 null（表示无限制，全量访问）
   * - 文件存在但 servers 为空数组 → 返回 []（表示禁用所有 MCP）
   * - 文件存在且有值 → 返回 server 名称列表
   */
  readMcpServers(id: string): string[] | null {
    const p = this.agentMcpPath(id);
    if (!fs.existsSync(p)) return null;
    try {
      const content = fs.readFileSync(p, "utf-8");
      const parsed = parse(content) as Record<string, unknown>;
      const servers = parsed["servers"];
      if (!Array.isArray(servers)) return null;
      return servers.filter((s): s is string => typeof s === "string");
    } catch {
      return null;
    }
  }

  /**
   * Agent 级内置工具黑/白名单配置文件路径。
   * 格式：~/.tinyclaw/agents/<id>/tools.toml
   */
  agentToolsPath(id: string): string {
    return path.join(AGENTS_ROOT, id, "tools.toml");
  }

  /**
   * 读取 agent 的内置工具过滤配置。
   * - 文件不存在 → 返回 null（不限制，全量访问）
   * - mode = "allowlist" → 只有 tools 列出的工具对该 agent 可见
   * - mode = "denylist"  → tools 列出的工具对该 agent 不可见
   * MCP 工具（mcp_ 前缀）不受此配置影响，由 mcp.toml 单独控制。
   */
  readToolsConfig(id: string): { mode: "allowlist" | "denylist"; tools: string[] } | null {
    const p = this.agentToolsPath(id);
    if (!fs.existsSync(p)) return null;
    try {
      const content = fs.readFileSync(p, "utf-8");
      const parsed = parse(content) as Record<string, unknown>;
      const mode = parsed["mode"];
      if (mode !== "allowlist" && mode !== "denylist") return null;
      const tools = parsed["tools"];
      if (!Array.isArray(tools)) return null;
      return {
        mode,
        tools: tools.filter((t): t is string => typeof t === "string"),
      };
    } catch {
      return null;
    }
  }

  /** Code 模式持久化工作目录文件路径 */
  codeDirPath(id: string): string {
    return path.join(AGENTS_ROOT, id, "codedir");
  }

  /** Code 模式 plan/auto 子模式持久化文件路径 */
  codeSubModePath(id: string): string {
    return path.join(AGENTS_ROOT, id, "codesubmode");
  }

  private tomlPath(id: string): string {
    return path.join(AGENTS_ROOT, id, "agent.toml");
  }

  loadAll(): AgentDef[] {
    if (!fs.existsSync(AGENTS_ROOT)) return [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(AGENTS_ROOT, { withFileTypes: true });
    } catch {
      return [];
    }
    const result: AgentDef[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        result.push(this.load(entry.name));
      } catch { /* skip malformed */ }
    }
    return result;
  }

  load(id: string): AgentDef {
    const tomlPath = this.tomlPath(id);
    if (!fs.existsSync(tomlPath)) {
      throw new Error(`Agent "${id}" not found`);
    }
    const content = fs.readFileSync(tomlPath, "utf-8");
    const parsed = parse(content) as Record<string, unknown>;
    const bindings: AgentBinding[] = [];
    if (Array.isArray(parsed["bindings"])) {
      for (const b of parsed["bindings"] as Record<string, unknown>[]) {
        if (typeof b["source"] === "string") {
          bindings.push({ source: b["source"] });
        }
      }
    }
    return {
      id,
      createdAt: typeof parsed["createdAt"] === "string" ? parsed["createdAt"] : new Date().toISOString(),
      bindings,
    };
  }

  private ensureAgentDirs(id: string): void {
    const dir = this.agentDir(id);
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(this.memoryDir(id), { recursive: true });
    fs.mkdirSync(path.join(this.workspaceDir(id), "tmp"), { recursive: true });
    fs.mkdirSync(path.join(this.workspaceDir(id), "output"), { recursive: true });
    fs.mkdirSync(path.join(this.workspaceDir(id), "downloads"), { recursive: true });
    fs.mkdirSync(this.skillsDir(id), { recursive: true });
  }

  save(def: AgentDef): void {
    this.ensureAgentDirs(def.id);
    fs.writeFileSync(this.tomlPath(def.id), formatAgentToml(def), "utf-8");
  }

  delete(id: string): void {
    if (id === DEFAULT_AGENT_ID) {
      throw new Error("不能删除默认 Agent");
    }
    const dir = this.agentDir(id);
    if (!fs.existsSync(dir)) {
      throw new Error(`Agent "${id}" not found`);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }

  /**
   * 根据消息来源（sessionId 或 source 字符串）查找绑定的 agentId。
   * 扫描所有 agent.toml 中的 [[bindings]]，未绑定则返回 "default"。
   */
  resolveAgent(source: string): string {
    if (!fs.existsSync(AGENTS_ROOT)) return DEFAULT_AGENT_ID;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(AGENTS_ROOT, { withFileTypes: true });
    } catch {
      return DEFAULT_AGENT_ID;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      try {
        const def = this.load(entry.name);
        for (const b of def.bindings) {
          if (b.source === source) return def.id;
        }
      } catch { /* skip */ }
    }
    return DEFAULT_AGENT_ID;
  }

  /**
   * 将 source 绑定到指定 agent。
   * 同一 source 只能绑定到一个 agent，会自动从其他 agent 移除。
   */
  bindSession(source: string, agentId: string): void {
    // 从其他 agent 移除同一 source 的绑定
    let entries: fs.Dirent[] = [];
    if (fs.existsSync(AGENTS_ROOT)) {
      try {
        entries = fs.readdirSync(AGENTS_ROOT, { withFileTypes: true });
      } catch { /* ignore */ }
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === agentId) continue;
      try {
        const def = this.load(entry.name);
        const filtered = def.bindings.filter((b) => b.source !== source);
        if (filtered.length !== def.bindings.length) {
          def.bindings = filtered;
          this.save(def);
        }
      } catch { /* skip */ }
    }
    // 添加到目标 agent
    const target = this.load(agentId);
    if (!target.bindings.some((b) => b.source === source)) {
      target.bindings.push({ source });
      this.save(target);
    }
  }

  /** 读取 Agent 的 SYSTEM.md（不存在则返回 null） */
  readSystemPrompt(id: string): string | null {
    const p = this.systemPromptPath(id);
    if (!fs.existsSync(p)) return null;
    const content = fs.readFileSync(p, "utf-8").trim();
    return content.length > 0 ? content : null;
  }

  /** 确保 default agent 工作区存在（含新子目录） */
  ensureDefault(): void {
    if (!fs.existsSync(this.tomlPath(DEFAULT_AGENT_ID))) {
      this.save({
        id: DEFAULT_AGENT_ID,
        createdAt: new Date().toISOString(),
        bindings: [],
      });
    } else {
      // 已存在时也补全新增目录（升级兼容）
      this.ensureAgentDirs(DEFAULT_AGENT_ID);
    }
  }
}

function formatAgentToml(def: AgentDef): string {
  const lines: string[] = [
    `id = "${def.id}"`,
    `createdAt = "${def.createdAt}"`,
  ];
  for (const b of def.bindings) {
    lines.push(`\n[[bindings]]`);
    lines.push(`source = "${b.source}"`);
  }
  return lines.join("\n") + "\n";
}

export const agentManager = new AgentManager();
