/**
 * ProjectMemory — 项目记忆管理
 *
 * 管理 projects/<slug>/ 目录下的记忆文件:
 *   metadata.json   — 结构化元数据(程序自动维护)
 *   MEMORY.md       — 记忆索引(始终加载,≤200 行)
 *   constraints.md  — 不可违反的约束
 *   architecture.md — 模块架构理解
 *   progress.md     — 进度/里程碑
 *   bugs.md         — 已知问题与根因
 *   decisions.md    — 重要设计决策
 *   ...             — AI 自行创建的其他 topic 文件
 *
 * 从 agent-manager.ts 移出，独立维护。
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ── 类型 ────────────────────────────────────────────────────────────────────

export interface TopicInfo {
  name: string;      // 文件名(不含 .md),如 "constraints"
  path: string;      // 绝对路径
  mtime: Date;       // 最后修改时间
  daysAgo: number;   // 距今天数
  lineCount: number; // 行数
}

export interface IndexMeta {
  path: string;
  mtime: string;     // ISO 8601
  lineCount: number;
  maxLines: number;
  sections: string[];
}

export interface ProjectMeta {
  version: number;
  project: {
    slug: string;
    workdir?: string;
    type: "local" | "ssh";
    createdAt: string;   // ISO 8601
    lastActive: string;  // ISO 8601
  };
  index: IndexMeta;
  topics: Record<string, TopicInfo & { createdAt: string }>;
}

// ── 常量 ────────────────────────────────────────────────────────────────────

const AGENTS_ROOT = path.join(
  process.env.HOME ?? "/home/lyy",
  ".tinyclaw",
  "agents",
);

const MEMORY_INDEX_SKELETON = `# Project Memory Index

> 始终加载;每条一行摘要 + 指向 topic 文件。详细内容读取对应 topic 文件。

## ⛔ 约束
<!-- → [constraints.md](constraints.md) -->

## 🧠 架构
<!-- → [architecture.md](architecture.md) -->

## 📊 进度
<!-- → [progress.md](progress.md) -->

## 🐛 问题
<!-- → [bugs.md](bugs.md) -->

## 📝 决策
<!-- → [decisions.md](decisions.md) -->
`;

// ── 路径方法 ────────────────────────────────────────────────────────────────

/** 项目记忆根目录: agents/<id>/code/projects */
export function projectsDir(agentId: string): string {
  return path.join(AGENTS_ROOT, agentId, "code", "projects");
}

/** 项目目录: projects/<slug>/ */
export function projectDir(agentId: string, project: string): string {
  return path.join(projectsDir(agentId), project);
}

/** MEMORY.md 路径 */
export function memoryIndexPath(agentId: string, project: string): string {
  return path.join(projectDir(agentId, project), "MEMORY.md");
}

/** metadata.json 路径 */
export function metadataPath(agentId: string, project: string): string {
  return path.join(projectDir(agentId, project), "metadata.json");
}

/** topic 文件路径: projects/<slug>/<topic>.md */
export function topicPath(agentId: string, project: string, topic: string): string {
  return path.join(projectDir(agentId, project), `${topic}.md`);
}

/** NOTES.md 路径（蒸馏/笔记的非结构化文件） */
export function notesPath(agentId: string, project: string): string {
  return path.join(projectDir(agentId, project), "NOTES.md");
}

/** project-aliases.json 路径 */
export function aliasesPath(agentId: string): string {
  return path.join(AGENTS_ROOT, agentId, "code", "project-aliases.json");
}

/** 列出指定项目下所有 .md 文件(按文件名排序),filter 掉 MEMORY.md */
export function topicFilesList(agentId: string, project: string): string[] {
  const dir = projectDir(agentId, project);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /\.md$/.test(f) && f !== "MEMORY.md")
    .sort()
    .map((f) => path.join(dir, f));
}

/** 列出所有有 MEMORY.md 的项目 slug */
export function listProjects(agentId: string): string[] {
  const dir = projectsDir(agentId);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(dir, d.name, "MEMORY.md")))
    .map((d) => d.name);
}

// ── 元数据读写 ──────────────────────────────────────────────────────────────

function readMetadata(agentId: string, project: string): ProjectMeta | null {
  const p = metadataPath(agentId, project);
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as ProjectMeta;
  } catch {
    return null;
  }
}

function writeMetadata(agentId: string, project: string, meta: ProjectMeta): void {
  fs.mkdirSync(path.dirname(metadataPath(agentId, project)), { recursive: true });
  fs.writeFileSync(metadataPath(agentId, project), JSON.stringify(meta, null, 2), "utf-8");
}

function scanTopicStats(agentId: string, project: string): Record<string, TopicInfo & { createdAt: string }> {
  const files = topicFilesList(agentId, project);
  const result: Record<string, TopicInfo & { createdAt: string }> = {};
  const now = Date.now();
  for (const filePath of files) {
    const name = path.basename(filePath, ".md");
    try {
      const stat = fs.statSync(filePath);
      const daysAgo = Math.floor((now - stat.mtimeMs) / (1000 * 60 * 60 * 24));
      const content = fs.readFileSync(filePath, "utf-8");
      const lineCount = content.split("\n").length;
      result[name] = {
        name,
        path: filePath,
        mtime: stat.mtime,
        daysAgo,
        lineCount,
        createdAt: stat.birthtime.toISOString(),
      };
    } catch {
      // skip files that can't be read
    }
  }
  return result;
}

function scanIndexStats(agentId: string, project: string): Omit<IndexMeta, "maxLines" | "sections"> | null {
  const p = memoryIndexPath(agentId, project);
  if (!fs.existsSync(p)) return null;
  try {
    const stat = fs.statSync(p);
    const content = fs.readFileSync(p, "utf-8");
    const lineCount = content.split("\n").length;
    return {
      path: p,
      mtime: stat.mtime.toISOString(),
      lineCount,
    };
  } catch {
    return null;
  }
}

function scanIndexSections(agentId: string, project: string): string[] {
  const p = memoryIndexPath(agentId, project);
  if (!fs.existsSync(p)) return [];
  try {
    const content = fs.readFileSync(p, "utf-8");
    const sections: string[] = [];
    for (const line of content.split("\n")) {
      const m = line.match(/^##\s+(.+)$/);
      if (m && m[1]) sections.push(m[1].trim());
    }
    return sections;
  } catch {
    return [];
  }
}

// ── 判断接口 ────────────────────────────────────────────────────────────────

/** 检查项目记忆是否已初始化（metadata.json 存在且 version >= 1） */
export function hasProjectMemory(agentId: string, project: string): boolean {
  const meta = readMetadata(agentId, project);
  return meta !== null && meta.version >= 1;
}

/** 获取完整项目元数据 */
export function getProjectMeta(agentId: string, project: string): ProjectMeta | null {
  return readMetadata(agentId, project);
}

/** 列出所有 topic 文件信息（含年龄） */
export function getProjectTopics(agentId: string, project: string): TopicInfo[] {
  const meta = readMetadata(agentId, project);
  if (!meta) return [];

  // 基于当前时间刷新 daysAgo
  const now = Date.now();
  const topics: TopicInfo[] = [];
  for (const [, t] of Object.entries(meta.topics)) {
    const daysAgo = Math.floor((now - new Date(t.mtime).getTime()) / (1000 * 60 * 60 * 24));
    topics.push({ ...t, daysAgo });
  }

  // 同时扫描文件系统，确保 metadata 与实际文件一致
  const scanned = scanTopicStats(agentId, project);
  for (const [name, t] of Object.entries(scanned)) {
    if (!meta.topics[name]) {
      topics.push(t);
    }
  }

  return topics;
}

/** 获取单个 topic 文件的年龄信息 */
export function getTopicAge(agentId: string, project: string, topic: string): TopicInfo | null {
  const meta = readMetadata(agentId, project);
  const now = Date.now();

  // 先从 metadata 读
  if (meta?.topics[topic]) {
    const t = meta.topics[topic];
    const daysAgo = Math.floor((now - new Date(t.mtime).getTime()) / (1000 * 60 * 60 * 24));
    return { ...t, daysAgo };
  }

  // 回退: 直接 stat 文件
  const p = topicPath(agentId, project, topic);
  if (!fs.existsSync(p)) return null;

  try {
    const stat = fs.statSync(p);
    const content = fs.readFileSync(p, "utf-8");
    const daysAgo = Math.floor((now - stat.mtimeMs) / (1000 * 60 * 60 * 24));
    return {
      name: topic,
      path: p,
      mtime: stat.mtime,
      daysAgo,
      lineCount: content.split("\n").length,
    };
  } catch {
    return null;
  }
}

// ── 初始化接口 ──────────────────────────────────────────────────────────────

export interface InitProjectMemoryOptions {
  workdir?: string;
  type?: "local" | "ssh";
}

/** 确保项目记忆结构存在 */
export function ensureProjectMemory(
  agentId: string,
  project: string,
  opts: InitProjectMemoryOptions = {},
): void {
  const dir = projectDir(agentId, project);
  fs.mkdirSync(dir, { recursive: true });

  const now = new Date().toISOString();

  // 创建 metadata.json（若不存在）
  if (!fs.existsSync(metadataPath(agentId, project))) {
    const topics = scanTopicStats(agentId, project);
    const indexStats = scanIndexStats(agentId, project);
    const meta: ProjectMeta = {
      version: 1,
      project: {
        slug: project,
        type: opts.type ?? "local",
        createdAt: now,
        lastActive: now,
      },
      index: {
        path: memoryIndexPath(agentId, project),
        mtime: now,
        lineCount: MEMORY_INDEX_SKELETON.split("\n").length,
        maxLines: 200,
        sections: ["⛔ 约束", "🧠 架构", "📊 进度", "🐛 问题", "📝 决策"],
      },
      topics: {},
    };

    if (opts.workdir !== undefined) {
      meta.project.workdir = opts.workdir;
    }

    writeMetadata(agentId, project, meta);
  }

  // 创建 MEMORY.md 骨架（若不存在）
  if (!fs.existsSync(memoryIndexPath(agentId, project))) {
    fs.writeFileSync(memoryIndexPath(agentId, project), MEMORY_INDEX_SKELETON, "utf-8");
    // 更新 metadata 中的 index 统计
    refreshIndexMeta(agentId, project);
  }
}

// ── 元数据更新 ──────────────────────────────────────────────────────────────

/** 刷新 MEMORY.md 索引的元数据（lineCount / mtime / sections） */
export function refreshIndexMeta(agentId: string, project: string): void {
  const meta = readMetadata(agentId, project);
  if (!meta) return;

  const stats = scanIndexStats(agentId, project);
  const sections = scanIndexSections(agentId, project);

  if (stats) {
    meta.index.mtime = stats.mtime;
    meta.index.lineCount = stats.lineCount;
  }
  meta.index.sections = sections;
  meta.project.lastActive = new Date().toISOString();

  writeMetadata(agentId, project, meta);
}

/** 刷新 topic 文件的元数据 */
export function refreshTopicMeta(agentId: string, project: string, topic: string): void {
  const meta = readMetadata(agentId, project);
  if (!meta) return;

  const p = topicPath(agentId, project, topic);
  if (!fs.existsSync(p)) {
    delete meta.topics[topic];
  } else {
    const stat = fs.statSync(p);
    const content = fs.readFileSync(p, "utf-8");
    const now = Date.now();
    const daysAgo = Math.floor((now - stat.mtimeMs) / (1000 * 60 * 60 * 24));
    meta.topics[topic] = {
      name: topic,
      path: p,
      mtime: stat.mtime,
      daysAgo,
      lineCount: content.split("\n").length,
      createdAt: meta.topics[topic]?.createdAt ?? stat.birthtime.toISOString(),
    };
  }
  meta.project.lastActive = new Date().toISOString();

  writeMetadata(agentId, project, meta);
}

/** 刷新所有元数据（全量扫描） */
export function refreshAllMeta(agentId: string, project: string): void {
  const meta = readMetadata(agentId, project);
  if (!meta) return;

  meta.topics = scanTopicStats(agentId, project);

  const stats = scanIndexStats(agentId, project);
  if (stats) {
    meta.index.mtime = stats.mtime;
    meta.index.lineCount = stats.lineCount;
  }
  meta.index.sections = scanIndexSections(agentId, project);
  meta.project.lastActive = new Date().toISOString();

  writeMetadata(agentId, project, meta);
}
