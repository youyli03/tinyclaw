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
 *     access.toml   — 跨 session 通信权限配置（可选）
 */


import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { parse } from "smol-toml";

/**
 * 跨 session 通信权限配置（存储在 agents/<agentId>/access.toml）。
 * 双向 allow-list：发送方 can_access 包含接收方 agentId，且接收方 allow_from 包含发送方 agentId，才允许通信。
 * 文件不存在视为两个列表均为空（默认 deny）。
 */
export interface AccessConfig {
  /** 本 agent 可以向哪些 agentId 的 session 发送消息 */
  can_access: string[];
  /** 允许哪些 agentId 的 agent 向本 agent 的 session 发送消息 */
  allow_from: string[];
}

export interface AgentBinding {
  source: string;
}

export interface AgentDef {
  id: string;
  createdAt: string;
  bindings: AgentBinding[];
}

/**
 * Session 维度的 Loop 配置（存储在 sessions/<sanitized-sessionId>.toml 的 [loop] 块）。
 * sessionId 体现在文件名中，不包含在此接口里。
 */
export interface LoopSessionConfig {
  enabled: boolean;
  /** 走哪个 agent 的 MEM.md / 记忆（默认 "default"） */
  agentId: string;
  /** 上次执行结束后等待多少秒再执行下一次 */
  tickSeconds: number;
  /** 绝对路径，或相对于 agentDir 的相对路径 */
  taskFile: string;
  /**
   * 是否跨轮次保留对话历史（默认 true）。
   * 设为 false 时，每次 tick 开始前自动清空 session messages，
   * 避免长时间运行后 context 积累过长导致模型跳步骤。
   */
  stateful: boolean;
}

const AGENTS_ROOT = path.join(os.homedir(), ".tinyclaw", "agents");
const SESSIONS_DIR = path.join(os.homedir(), ".tinyclaw", "sessions");
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

  activePath(id: string): string {
    return path.join(AGENTS_ROOT, id, "ACTIVE.md");
  }

  cardsDir(id: string): string {
    return path.join(AGENTS_ROOT, id, "cards");
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

  /** 列出所有已创建的 agent id（agents/ 目录下的所有子目录名） */
  listAgentIds(): string[] {
    if (!fs.existsSync(AGENTS_ROOT)) return [];
    return fs.readdirSync(AGENTS_ROOT, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
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

  /**
   * Agent 级跨 session 通信权限配置文件路径。
   * 格式：~/.tinyclaw/agents/<id>/access.toml
   */
  accessConfigPath(id: string): string {
    return path.join(AGENTS_ROOT, id, "access.toml");
  }

  /**
   * 读取 agent 的跨 session 通信权限配置。
   * - 文件不存在 → 返回 { can_access: [], allow_from: [] }（默认 deny）
   */
  readAccessConfig(id: string): AccessConfig {
    const p = this.accessConfigPath(id);
    const empty: AccessConfig = { can_access: [], allow_from: [] };
    if (!fs.existsSync(p)) return empty;
    try {
      const content = fs.readFileSync(p, "utf-8");
      const parsed = parse(content) as Record<string, unknown>;
      const can_access = Array.isArray(parsed["can_access"])
        ? (parsed["can_access"] as unknown[]).filter((x): x is string => typeof x === "string")
        : [];
      const allow_from = Array.isArray(parsed["allow_from"])
        ? (parsed["allow_from"] as unknown[]).filter((x): x is string => typeof x === "string")
        : [];
      return { can_access, allow_from };
    } catch {
      return empty;
    }
  }

  /**
   * 返回指定 sessionId 对应的 session 配置文件路径。
   * 格式：~/.tinyclaw/sessions/<sanitized-sessionId>.toml
   * sanitized 规则与 JSONL 一致：: / \ 替换为 _
   */
  getSessionTomlPath(sessionId: string): string {
    const sanitized = sessionId.replace(/[:/\\]/g, "_");
    return path.join(SESSIONS_DIR, `${sanitized}.toml`);
  }

  /**
   * 读取指定 session 的 loop 配置（来自 sessions/<id>.toml 中的 [loop] 块）。
   * - [loop] 不存在或 enabled = false → 返回 null
   */
  readSessionLoop(sessionId: string): LoopSessionConfig | null {
    const p = this.getSessionTomlPath(sessionId);
    if (!fs.existsSync(p)) return null;
    try {
      const content = fs.readFileSync(p, "utf-8");
      const parsed = parse(content) as Record<string, unknown>;
      const loop = parsed["loop"];
      if (!loop || typeof loop !== "object") return null;
      const l = loop as Record<string, unknown>;
      if (l["enabled"] === false) return null;
      return {
        enabled: true,
        agentId: typeof l["agentId"] === "string" && l["agentId"] ? l["agentId"] : DEFAULT_AGENT_ID,
        tickSeconds: typeof l["tickSeconds"] === "number" ? l["tickSeconds"] : 60,
        taskFile: typeof l["taskFile"] === "string" ? l["taskFile"] : "TASK.md",
        stateful: l["stateful"] !== false,
      };
    } catch {
      return null;
    }
  }

  /**
   * 写入/更新指定 session 的 loop 配置到 sessions/<id>.toml 的 [loop] 块。
   * 若文件已有其他配置（非 [loop]），保留原有内容，仅更新 [loop] 部分。
   */
  writeSessionLoop(sessionId: string, cfg: LoopSessionConfig): void {
    const p = this.getSessionTomlPath(sessionId);
    fs.mkdirSync(path.dirname(p), { recursive: true });

    // 读取现有内容（若有），保留非 [loop] 部分
    let existing: Record<string, unknown> = {};
    if (fs.existsSync(p)) {
      try {
        existing = parse(fs.readFileSync(p, "utf-8")) as Record<string, unknown>;
      } catch { /* ignore parse error, overwrite */ }
    }

    // 构建 [loop] 表内容
    const loopBlock: Record<string, unknown> = {
      enabled: cfg.enabled,
      agentId: cfg.agentId,
      tickSeconds: cfg.tickSeconds,
      taskFile: cfg.taskFile,
      stateful: cfg.stateful,
    };

    existing["loop"] = loopBlock;

    // 序列化为 TOML（手动构建，不依赖 toml 序列化库）
    fs.writeFileSync(p, formatSessionToml(existing), "utf-8");
  }

  /**
   * 扫描 sessions/*.toml，返回所有有 [loop] 且 enabled=true 的 session。
   */
  listSessionLoops(): { sessionId: string; cfg: LoopSessionConfig }[] {
    if (!fs.existsSync(SESSIONS_DIR)) return [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true });
    } catch {
      return [];
    }
    const result: { sessionId: string; cfg: LoopSessionConfig }[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".toml")) continue;
      // 从文件名还原 sessionId（_ → : 不准确，保留 sanitized 形式即可；用文件名作为标识）
      // 注意：sanitized 是单向的，不能完整还原（: 和 / 都变成了 _）
      // 但实际上 loop runner 用 sanitized 形式作为 key，能正确找到对应 jsonl
      const sanitized = entry.name.slice(0, -5); // 去掉 .toml 后缀
      // 尝试还原 sessionId：约定格式为 qqbot_c2c_xxx → qqbot:c2c:xxx（仅前两个 _ 还原）
      const sessionId = sanitizedToSessionId(sanitized);
      const cfg = this.readSessionLoop(sessionId);
      if (cfg) result.push({ sessionId, cfg });
    }
    return result;
  }

  /** Code 模式持久化工作目录文件路径 */
  codeDirPath(id: string): string {
    return path.join(AGENTS_ROOT, id, "codedir");
  }

  /** Code 模式 plan/auto 子模式持久化文件路径 */
  codeSubModePath(id: string): string {
    return path.join(AGENTS_ROOT, id, "codesubmode");
  }

  /**
   * Code session 独立目录路径（按 sessionId 隔离）。
   * 格式：~/.tinyclaw/agents/<id>/code/<sanitized-sessionId>/
   */
  codeSessionDir(agentId: string, sessionId: string): string {
    const sanitized = sessionId.replace(/[:/\\]/g, "_");
    return path.join(AGENTS_ROOT, agentId, "code", sanitized);
  }

  /**
   * Code session 的 PLAN.md 路径（替代原 planPath，按 session 隔离）。
   * 格式：~/.tinyclaw/agents/<id>/code/<sanitized-sessionId>/PLAN.md
   */
  codePlanPath(agentId: string, sessionId: string): string {
    return path.join(this.codeSessionDir(agentId, sessionId), "PLAN.md");
  }

  /**
   * feedback.md 路径（chat/code 分开，跨 session 永久有效）。
   * - chat：~/.tinyclaw/agents/<id>/feedback.md
   * - code：~/.tinyclaw/agents/<id>/code/feedback.md
   */
  feedbackPath(agentId: string, mode: "chat" | "code"): string {
    if (mode === "code") {
      return path.join(AGENTS_ROOT, agentId, "code", "feedback.md");
    }
    return path.join(AGENTS_ROOT, agentId, "feedback.md");
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

/**
 * 将 session.toml 的内容序列化为 TOML 字符串。
 * 支持顶层 key-value 和 [section] 块。
 */
function formatSessionToml(data: Record<string, unknown>): string {
  const lines: string[] = [];
  // 先写非对象字段
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === "object" && v !== null && !Array.isArray(v)) continue;
    lines.push(`${k} = ${tomlValue(v)}`);
  }
  // 再写 [section] 块
  for (const [k, v] of Object.entries(data)) {
    if (typeof v !== "object" || v === null || Array.isArray(v)) continue;
    lines.push(`\n[${k}]`);
    for (const [sk, sv] of Object.entries(v as Record<string, unknown>)) {
      lines.push(`${sk} = ${tomlValue(sv)}`);
    }
  }
  return lines.join("\n") + "\n";
}

function tomlValue(v: unknown): string {
  if (typeof v === "string") return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return `[${v.map(tomlValue).join(", ")}]`;
  return `"${String(v)}"`;
}

/**
 * 尝试将 sanitized 文件名还原为 sessionId。
 * 约定：前缀 qqbot_c2c_ / qqbot_group_ / qqbot_guild_ / qqbot_dm_ → qqbot:xxx:xxx
 *        前缀 cli_ → cli:xxx
 *        loop_ / cron_ / 其他 → 直接当作 sessionId（用 _ 替换处不还原）
 * 对于 qqbot 前缀，第一个和第二个 _ 还原为 :，其余保留。
 */
function sanitizedToSessionId(sanitized: string): string {
  const qqbotPrefixes = ["qqbot_c2c_", "qqbot_group_", "qqbot_guild_", "qqbot_dm_"];
  for (const prefix of qqbotPrefixes) {
    if (sanitized.startsWith(prefix)) {
      // qqbot_c2c_OPENID → qqbot:c2c:OPENID
      const parts = sanitized.split("_");
      // parts[0]=qqbot, parts[1]=c2c|group|guild|dm, parts[2..]=openid（可能含_）
      const openid = parts.slice(2).join("_");
      return `${parts[0]}:${parts[1]}:${openid}`;
    }
  }
  if (sanitized.startsWith("cli_")) {
    return `cli:${sanitized.slice(4)}`;
  }
  // loop_xxx / cron_xxx / 其他：原样返回（sanitized 形式）
  return sanitized;
}

export const agentManager = new AgentManager();
