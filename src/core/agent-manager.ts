/**
 * AgentManager — 管理 Agent 工作区
 *
 * 每个 Agent 的文件结构：
 *   ~/.tinyclaw/agents/<id>/
 *     agent.toml    — 元数据：id、创建时间、bindings
 *     SYSTEM.md     — Agent 级系统提示（可选）
 *     memory/
 *       index.sqlite   — 向量索引
 *       YYYY-MM-DD.md  — 压缩摘要
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

  save(def: AgentDef): void {
    const dir = this.agentDir(def.id);
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(dir, "memory"), { recursive: true });
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

  /** 确保 default agent 工作区存在 */
  ensureDefault(): void {
    if (!fs.existsSync(this.tomlPath(DEFAULT_AGENT_ID))) {
      this.save({
        id: DEFAULT_AGENT_ID,
        createdAt: new Date().toISOString(),
        bindings: [],
      });
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
