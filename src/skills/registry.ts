/**
 * SkillRegistry — Skill 子系统核心缓存
 *
 * 进程级单例，负责：
 * 1. 按 agentId 缓存解析好的 SkillEntry 列表和渲染好的 prompt 片段
 * 2. 文件变更时失效缓存（由 watcher.ts 触发 refresh）
 * 3. 提供版本号（version），供 runAgent 判断 prompt 是否需要重建
 *
 * 不依赖 chokidar，watcher 在单独的 skills/watcher.ts 中实现，
 * 这样 cron worker 可以只 import registry 而不引入文件监听。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const AGENTS_ROOT = path.join(os.homedir(), ".tinyclaw", "agents");

// ── 类型 ──────────────────────────────────────────────────────────────────────

export interface SkillEntry {
  name: string;
  description: string;
  docPath: string;
}

interface AgentSkillCache {
  entries: SkillEntry[];
  /** 已渲染好的 prompt 目录片段（null = 无 skill） */
  snapshot: string | null;
  /** 基于文件 mtime 的版本戳，0 = 文件不存在 */
  version: number;
}

// ── SkillRegistry ─────────────────────────────────────────────────────────────

class SkillRegistry {
  private readonly cache = new Map<string, AgentSkillCache>();

  // ── 公共读取接口 ────────────────────────────────────────────────────────────

  /** 获取某 agent 的 skill 条目列表（缓存命中直接返回，否则触发加载） */
  getEntries(agentId: string): SkillEntry[] {
    return this._getOrLoad(agentId).entries;
  }

  /**
   * 获取已渲染好的 skill reminder prompt 片段。
   * 格式：`[可用技能]\n- name: desc\n...\n\n匹配时使用 skill_run...`
   * 无 skill 时返回 undefined。
   */
  getPromptSnapshot(agentId: string): string | undefined {
    return this._getOrLoad(agentId).snapshot ?? undefined;
  }

  /** 获取当前版本号（基于 SKILLS.md 的 mtime，0 = 不存在） */
  getVersion(agentId: string): number {
    return this._getOrLoad(agentId).version;
  }

  // ── 缓存失效 ────────────────────────────────────────────────────────────────

  /**
   * 强制刷新指定 agent 的 skill 缓存（文件变更时由 watcher 调用）。
   * 也可以在 IPC 收到 skills_changed 时调用。
   */
  refresh(agentId: string): void {
    this.cache.delete(agentId);
    // 预热：立即重新加载
    this._getOrLoad(agentId);
    console.log(`[skills] registry refreshed for agent="${agentId}" entries=${this.cache.get(agentId)?.entries.length ?? 0}`);
  }

  /** 失效所有 agent 的缓存（全局重载，一般不需要） */
  refreshAll(): void {
    const ids = Array.from(this.cache.keys());
    this.cache.clear();
    for (const id of ids) this._getOrLoad(id);
  }

  // ── 内部 ────────────────────────────────────────────────────────────────────

  private _getOrLoad(agentId: string): AgentSkillCache {
    const cached = this.cache.get(agentId);
    if (cached) return cached;

    const skillsPath = path.join(AGENTS_ROOT, agentId, "SKILLS.md");
    let version = 0;
    let entries: SkillEntry[] = [];

    if (fs.existsSync(skillsPath)) {
      try {
        version = fs.statSync(skillsPath).mtimeMs;
        entries = this._parse(agentId, skillsPath);
      } catch {
        // 读取失败时返回空
      }
    }

    const snapshot = entries.length > 0 ? this._buildSnapshot(entries) : null;
    const item: AgentSkillCache = { entries, snapshot, version };
    this.cache.set(agentId, item);
    return item;
  }

  /** 解析 SKILLS.md，提取所有 skill 条目（与原 parseSkillsIndex 逻辑相同） */
  private _parse(agentId: string, skillsPath: string): SkillEntry[] {
    const content = fs.readFileSync(skillsPath, "utf-8");
    const agentDir = path.join(AGENTS_ROOT, agentId);
    const entries: SkillEntry[] = [];

    // 按 ## 分块
    const blocks = content.split(/^## /m).slice(1);
    for (const block of blocks) {
      const lines = block.split("\n");
      const headerLine = lines[0] ?? "";

      // 提取 skill name：优先从反引号提取，fallback 用标题
      const nameMatch = headerLine.match(/`([^`]+)`/);
      const name = nameMatch
        ? nameMatch[1]!
        : headerLine.trim().toLowerCase().replace(/\s+/g, "-");
      if (!name) continue;

      // 提取文档路径
      let docPath = "";
      for (const line of lines) {
        const docMatch = line.match(/[-*]\s*(?:介绍\/文档|文档|doc(?:ument)?|path):\s*(.+)/i);
        if (docMatch) {
          const raw = docMatch[1]!.trim();
          docPath = path.isAbsolute(raw) ? raw : path.join(agentDir, raw);
          break;
        }
      }
      if (!docPath) continue;

      // 提取描述
      let description = "";
      for (const line of lines) {
        const sceneMatch = line.match(/[-*]\s*(?:使用场景|场景|描述|description|when.to.use):\s*(.+)/i);
        if (sceneMatch) {
          description = sceneMatch[1]!.trim();
          break;
        }
      }
      if (!description) description = headerLine.replace(/`[^`]+`/, "").trim();

      entries.push({ name, description, docPath });
    }
    return entries;
  }

  /** 构建 skill reminder prompt 片段 */
  private _buildSnapshot(entries: SkillEntry[]): string {
    const lines = entries.map((e) => `- ${e.name}: ${e.description}`).join("\n");
    return `[可用技能]\n${lines}\n\n匹配用户需求时，使用 skill_run 工具执行对应技能，而不是自行尝试。`;
  }
}

// ── 进程级单例 ────────────────────────────────────────────────────────────────

export const skillRegistry = new SkillRegistry();
