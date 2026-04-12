/**
 * SkillRegistry — Skill 子系统核心缓存
 *
 * 进程级单例,负责:
 * 1. 按 agentId 缓存解析好的 SkillEntry 列表和渲染好的 prompt 片段
 * 2. 文件变更时失效缓存(由 watcher.ts 触发 refresh)
 * 3. 提供版本号(version),供 runAgent 判断 prompt 是否需要重建
 *
 * Skill 文档(SKILL.md / README.md)支持 YAML frontmatter,可声明：
 *   name: skill-name
 *   description: 一句话说明
 *   trigger-phrases: [精确触发短语1, 短语2]
 *   disable-model-invocation: true   # 仅 /skill:name 命令显式调用,AI 不得主动触发
 *   requires: [exec_shell, mcp_browser]
 *
 * 不依赖 chokidar,watcher 在单独的 skills/watcher.ts 中实现,
 * 这样 cron worker 可以只 import registry 而不引入文件监听。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const AGENTS_ROOT = path.join(os.homedir(), ".tinyclaw", "agents");

/** snapshot 最多包含的 skill 数量 */
const MAX_SKILLS_COUNT = 10;
/** snapshot 字符上限(超出时截断末尾 skill) */
const MAX_SKILLS_PROMPT_CHARS = 3000;

// ── 类型 ──────────────────────────────────────────────────────────────────────

export interface SkillEntry {
  name: string;
  description: string;
  /** SKILL.md / README.md 的绝对路径 */
  docPath: string;
  /** true = 禁止 AI 主动触发,仅可通过 /skill:name 命令显式调用 */
  disableModelInvocation: boolean;
  /** 前置条件工具/依赖列表 */
  requires?: string[];
  /** 精确触发短语列表,AI 仅在用户使用这些短语时才触发该 skill */
  triggerPhrases?: string[];
}

interface AgentSkillCache {
  entries: SkillEntry[];
  /** 已渲染好的 prompt 目录片段(null = 无 skill) */
  snapshot: string | null;
  /** 基于目录 mtime 的版本戳 */
  version: number;
}

// ── SkillRegistry ─────────────────────────────────────────────────────────────

class SkillRegistry {
  private readonly cache = new Map<string, AgentSkillCache>();

  // ── 公共读取接口 ────────────────────────────────────────────────────────────

  /** 获取某 agent 的 skill 条目列表(缓存命中直接返回,否则触发加载) */
  getEntries(agentId: string): SkillEntry[] {
    return this._getOrLoad(agentId).entries;
  }

  /**
   * 获取已渲染好的 skill reminder prompt 片段(XML + doc_path 格式)。
   * 无 skill 时返回 undefined。
   */
  getPromptSnapshot(agentId: string): string | undefined {
    return this._getOrLoad(agentId).snapshot ?? undefined;
  }

  /** 获取当前版本号 */
  getVersion(agentId: string): number {
    return this._getOrLoad(agentId).version;
  }

  // ── 缓存失效 ────────────────────────────────────────────────────────────────

  /**
   * 强制刷新指定 agent 的 skill 缓存(文件变更时由 watcher 调用)。
   */
  refresh(agentId: string): void {
    this.cache.delete(agentId);
    this._getOrLoad(agentId);
    console.log(`[skills] registry refreshed for agent="${agentId}" entries=${this.cache.get(agentId)?.entries.length ?? 0}`);
  }

  /** 失效所有 agent 的缓存 */
  refreshAll(): void {
    const ids = Array.from(this.cache.keys());
    this.cache.clear();
    for (const id of ids) this._getOrLoad(id);
  }

  // ── 内部 ────────────────────────────────────────────────────────────────────

  private _getOrLoad(agentId: string): AgentSkillCache {
    const cached = this.cache.get(agentId);
    if (cached) return cached;

    const skillsDir = path.join(AGENTS_ROOT, agentId, "skills");
    let version = 0;
    let entries: SkillEntry[] = [];

    if (fs.existsSync(skillsDir)) {
      try {
        version = fs.statSync(skillsDir).mtimeMs;
        entries = this._scanSkillsDir(agentId, skillsDir);
      } catch {
        // 读取失败时返回空
      }
    }

    // 兼容旧版 SKILLS.md 索引文件(若 skills/ 目录不存在时 fallback)
    if (entries.length === 0) {
      const skillsPath = path.join(AGENTS_ROOT, agentId, "SKILLS.md");
      if (fs.existsSync(skillsPath)) {
        try {
          version = fs.statSync(skillsPath).mtimeMs;
          entries = this._parseLegacySkillsIndex(agentId, skillsPath);
        } catch {
          // ignore
        }
      }
    }

    // 过滤掉 disable-model-invocation=true 的 skill(不出现在 AI 可见列表中)
    const visibleEntries = entries.filter((e) => !e.disableModelInvocation);

    const snapshot = visibleEntries.length > 0 ? this._buildSnapshot(visibleEntries) : null;
    const item: AgentSkillCache = { entries, snapshot, version };
    this.cache.set(agentId, item);
    return item;
  }

  /**
   * 扫描 skills/ 目录,每个子目录寻找 SKILL.md 或 README.md,解析 frontmatter。
   */
  private _scanSkillsDir(agentId: string, skillsDir: string): SkillEntry[] {
    const agentDir = path.join(AGENTS_ROOT, agentId);
    const entries: SkillEntry[] = [];

    let subdirs: string[];
    try {
      subdirs = fs.readdirSync(skillsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      return entries;
    }

    for (const subdir of subdirs) {
      const skillDir = path.join(skillsDir, subdir);
      // 优先 SKILL.md,其次 README.md
      const candidates = ["SKILL.md", "README.md"];
      for (const candidate of candidates) {
        const docPath = path.join(skillDir, candidate);
        if (!fs.existsSync(docPath)) continue;

        try {
          const content = fs.readFileSync(docPath, "utf-8");
          const fm = this._parseFrontmatter(content);

          // name:优先 frontmatter,fallback 目录名
          const name = fm.name || subdir;
          // description:优先 frontmatter
          const description = fm.description || `Skill: ${name}`;

          entries.push({
            name,
            description,
            docPath,
            disableModelInvocation: fm.disableModelInvocation ?? false,
            ...(fm.requires !== undefined ? { requires: fm.requires } : {}),
            ...(fm.triggerPhrases !== undefined ? { triggerPhrases: fm.triggerPhrases } : {}),
          });
        } catch {
          // 单个 skill 解析失败不影响其他
        }
        break; // 找到文档后跳出 candidate 循环
      }
    }

    return entries;
  }

  /**
   * 解析 SKILL.md / README.md 文件头的 YAML frontmatter。
   * 仅支持简单 key: value 和 key: [list] 格式,不引入外部 yaml 库。
   */
  private _parseFrontmatter(content: string): {
    name?: string;
    description?: string;
    disableModelInvocation?: boolean;
    requires?: string[];
    triggerPhrases?: string[];
  } {
    const result: ReturnType<SkillRegistry["_parseFrontmatter"]> = {};

    // frontmatter 必须在文件头部,以 --- 开头和结尾
    const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) return result;

    const yamlBlock = match[1]!;
    const lines = yamlBlock.split(/\r?\n/);

    let i = 0;
    while (i < lines.length) {
      const line = lines[i]!;
      i++;

      // 跳过空行和注释
      if (!line.trim() || line.trim().startsWith("#")) continue;

      // key: value 或 key: [inline, list]
      const kvMatch = line.match(/^([a-zA-Z0-9_-]+):\s*(.*)/);
      if (!kvMatch) continue;

      const key = kvMatch[1]!.toLowerCase();
      const rawVal = kvMatch[2]!.trim();

      switch (key) {
        case "name":
          result.name = rawVal;
          break;
        case "description":
          result.description = rawVal;
          break;
        case "disable-model-invocation":
          result.disableModelInvocation = rawVal === "true";
          break;
        case "requires": {
          if (rawVal.startsWith("[")) {
            result.requires = this._parseInlineList(rawVal);
          } else if (!rawVal) {
            // block list
            const items: string[] = [];
            while (i < lines.length && lines[i]!.match(/^\s+-\s+/)) {
              items.push(lines[i]!.replace(/^\s+-\s+/, "").trim());
              i++;
            }
            result.requires = items;
          }
          break;
        }
        case "trigger-phrases": {
          if (rawVal.startsWith("[")) {
            result.triggerPhrases = this._parseInlineList(rawVal);
          } else if (!rawVal) {
            // block list
            const items: string[] = [];
            while (i < lines.length && lines[i]!.match(/^\s+-\s+/)) {
              items.push(lines[i]!.replace(/^\s+-\s+/, "").trim());
              i++;
            }
            result.triggerPhrases = items;
          }
          break;
        }
      }
    }

    return result;
  }

  /** 解析 YAML 内联列表,如 `["a", "b", c]` → ["a", "b", "c"] */
  private _parseInlineList(raw: string): string[] {
    const inner = raw.replace(/^\[/, "").replace(/\]$/, "");
    return inner
      .split(",")
      .map((s) => s.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
  }

  /**
   * 兼容旧版 SKILLS.md 索引格式(按 ## 分块解析)。
   * 仅在 skills/ 目录不存在时作为 fallback 使用。
   */
  private _parseLegacySkillsIndex(agentId: string, skillsPath: string): SkillEntry[] {
    const content = fs.readFileSync(skillsPath, "utf-8");
    const agentDir = path.join(AGENTS_ROOT, agentId);
    const entries: SkillEntry[] = [];

    const blocks = content.split(/^## /m).slice(1);
    for (const block of blocks) {
      const lines = block.split("\n");
      const headerLine = lines[0] ?? "";

      const nameMatch = headerLine.match(/`([^`]+)`/);
      const name = nameMatch
        ? nameMatch[1]!
        : headerLine.trim().toLowerCase().replace(/\s+/g, "-");
      if (!name) continue;

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

      let description = "";
      for (const line of lines) {
        const sceneMatch = line.match(/[-*]\s*(?:使用场景|场景|描述|description|when.to.use):\s*(.+)/i);
        if (sceneMatch) {
          description = sceneMatch[1]!.trim();
          break;
        }
      }
      if (!description) description = headerLine.replace(/`[^`]+`/, "").trim();

      entries.push({
        name,
        description,
        docPath,
        disableModelInvocation: false,
      });
    }
    return entries;
  }

  /**
   * 构建 skill reminder prompt 片段(XML + 精确 doc_path 格式)。
   * 超出 MAX_SKILLS_COUNT 或 MAX_SKILLS_PROMPT_CHARS 时截断。
   */
  private _buildSnapshot(entries: SkillEntry[]): string {
    const limited = entries.slice(0, MAX_SKILLS_COUNT);

    const skillBlocks = limited.map((e) => {
      const lines = [
        `  <skill>`,
        `    <name>${e.name}</name>`,
        `    <description>${e.description}</description>`,
        `    <doc_path>${e.docPath}</doc_path>`,
      ];
      if (e.triggerPhrases && e.triggerPhrases.length > 0) {
        lines.push(`    <trigger_phrases>${e.triggerPhrases.join(",")}</trigger_phrases>`);
      }
      if (e.requires && e.requires.length > 0) {
        lines.push(`    <requires>${e.requires.join(",")}</requires>`);
      }
      lines.push(`  </skill>`);
      return lines.join("\n");
    });

    const rules = [
      "",
      "**[Skill 调用规则 — 严格遵守]**",
      "1. 仅当用户意图与 <description> 或 <trigger_phrases> **精确匹配**时才触发，禁止主动猜测",
      "2. 触发前必须先调用 read_file 读取 <doc_path>，再严格按文档步骤执行，禁止凭记忆执行",
      "3. 使用 skill_run 工具执行，禁止绕过 skill_run 自行实现步骤",
      "4. 未找到匹配 skill 时，告知用户并询问是否继续",
    ].join("\n");

    let snapshot =
      `<available_skills>\n${skillBlocks.join("\n")}\n</available_skills>` + rules;

    // 字符上限截断
    if (snapshot.length > MAX_SKILLS_PROMPT_CHARS) {
      // 逐步减少 skill 数量直到满足限制
      let count = limited.length;
      while (count > 1 && snapshot.length > MAX_SKILLS_PROMPT_CHARS) {
        count--;
        const trimmed = skillBlocks.slice(0, count);
        snapshot =
          `<available_skills>\n${trimmed.join("\n")}\n</available_skills>` +
          `\n  <!-- ${entries.length - count} 个 skill 因超出长度限制被截断 -->` +
          rules;
      }
    }

    return snapshot;
  }
}

// ── 进程级单例 ────────────────────────────────────────────────────────────────

export const skillRegistry = new SkillRegistry();
