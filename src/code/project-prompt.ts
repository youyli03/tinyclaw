/**
 * Project Session System Prompt 构建器。
 *
 * 当 session 已通过 .code.project 跳板文件绑定到特定项目时使用。
 * 与 code prompt (buildCodeSystemPrompt) 的区别：
 *   - MEMORY.md + topic 表直接注入上下文，无需 AI 自己读
 *   - 记忆指令精简（已知 slug，无需初始化引导）
 *   - workdir 来自 metadata.json
 *   - Plan 两阶段 / 工具 / 图表 / ENV / feedback 等共享段复用 code prompt
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  memoryIndexPath,
  getProjectMeta,
  getProjectTopics,
  type TopicInfo,
} from "../core/project-memory.js";
import {
  renderSharedHeader,
  renderSharedWorkPrinciples,
  renderSharedToolUsage,
  renderSharedCodeTaskSpecs,
  renderSharedDiagramsAndMedia,
} from "./system-prompt.js";
import { agentManager } from "../core/agent-manager.js";
import { readFeedback } from "../core/feedback-writer.js";
import { loadConfig } from "../config/loader.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface TopicSummary {
  name: string;
  daysAgo: number;
  lineCount: number;
  stale: boolean; // daysAgo > 7
}

export interface ProjectContext {
  slug: string;
  workdir: string;
  type: "local" | "ssh";
  memoryContent: string;
  topics: TopicSummary[];
}

// ── Load ─────────────────────────────────────────────────────────────────────

/** 读取项目上下文：metadata.json + MEMORY.md + topic 列表 */
export function loadProjectContext(agentId: string, slug: string): ProjectContext {
  const meta = getProjectMeta(agentId, slug);
  const workdir = meta?.project?.workdir ?? slugToWorkdirFallback(slug);
  const type = meta?.project?.type ?? "local";

  // 读 MEMORY.md 全文
  let memoryContent = "";
  try {
    const mp = memoryIndexPath(agentId, slug);
    if (existsSync(mp)) {
      memoryContent = readFileSync(mp, "utf-8");
    }
  } catch { /* ignore */ }

  // 读 topic 列表
  const rawTopics = getProjectTopics(agentId, slug);
  const topics: TopicSummary[] = rawTopics.map((t: TopicInfo) => ({
    name: t.name,
    daysAgo: t.daysAgo,
    lineCount: t.lineCount,
    stale: t.daysAgo > 7,
  }));

  return { slug, workdir, type, memoryContent, topics };
}

// ── Render ───────────────────────────────────────────────────────────────────

/** 渲染「当前项目」block：workdir + MEMORY.md 全文 + topic 表 */
export function renderProjectContext(ctx: ProjectContext): string {
  let out = `## 当前项目\n\n`;
  out += `项目: \`${ctx.slug}\`\n`;
  out += `工作目录: \`${ctx.workdir}\`\n`;
  out += `类型: ${ctx.type === "ssh" ? "远程(SSH)" : "本地"}\n`;

  // MEMORY.md 全文
  if (ctx.memoryContent) {
    out += `\n### 项目记忆 (MEMORY.md)\n\n${ctx.memoryContent}\n`;
  }

  // Topic 表
  if (ctx.topics.length > 0) {
    out += `\n### 专题文件\n\n`;
    out += `| 文件 | 更新 | 行数 |\n`;
    out += `|------|------|------|\n`;
    for (const t of ctx.topics) {
      const stale = t.stale ? " ⚠️" : "";
      const days = t.daysAgo === 0 ? "今天" : `${t.daysAgo}天前`;
      out += `| ${t.name} | ${days}${stale} | ${t.lineCount} |\n`;
    }
  }

  return out;
}

/** 渲染「项目记忆系统」指令（精简版：不含切换、不含 slug 约束） */
export function renderProjectMemoryInstructions(slug: string): string {
  return `## 项目记忆系统

你已在项目 \`${slug}\` 的上下文中，项目记忆已注入，无需初始化。

- 写入: \`code_note({project:"${slug}", content:"..."})\` → MEMORY.md
- 搜索: \`code_note_search({query:"..."})\` 语义搜索
- 读专题: \`code_note_read({topic:"xxx", project:"${slug}"})\`

MEMORY.md 超过约 200 行时，自行将旧条目详情移到对应 topic 文件，索引中只留摘要行。

**执行完毕前**: code_note 更新进度 → git commit → 告知用户。
**发现约束/根因**: 立即调 code_note，不等任务完成。`;
}

// ── Build Full Prompt ────────────────────────────────────────────────────────

export interface BuildProjectPromptOptions {
  supportsVision?: boolean;
  sessionId?: string;
  currentProvider?: string;
}

/**
 * 构建项目 session 的完整 system prompt。
 *
 * 共享段（与 code prompt 相同）：
 *   - Plan 两阶段 / 重要约束
 *   - 工具使用规范
 *   - 代码任务规范
 *   - 图表与可视化 / 富媒体
 *   - 行为约束 (feedback.md)
 *   - 本机环境上下文 (ENV.md)
 *
 * 项目独有段：
 *   - 当前项目 (renderProjectContext)
 *   - 项目记忆系统 (renderProjectMemoryInstructions)
 */
export function buildProjectSystemPrompt(
  agentId: string,
  ctx: ProjectContext,
  options: BuildProjectPromptOptions = {},
): string {
  const sessionId = options.sessionId ?? "";
  const agentDir = agentManager.agentDir(agentId);
  const workspaceDir = agentManager.workspaceDir(agentId);

  // PLAN.md 按 session 隔离
  const planPath = sessionId
    ? agentManager.codePlanPath(agentId, sessionId)
    : agentManager.planPath(agentId);

  // feedback
  const feedbackContent = readFeedback(agentId, "code");

  // ENV.md
  let envContent: string | undefined;
  try {
    const envPath = join(agentDir, "code", "ENV.md");
    if (existsSync(envPath)) {
      const ec = readFileSync(envPath, "utf-8").trim();
      if (ec.length > 0) envContent = ec;
    }
  } catch { /* ignore */ }

  // vision
  const visionSection = options.supportsVision
    ? `\n\n## 视觉能力\n\n当前模型支持直接读取图片，收到含图片的消息时，直接观察并回答。`
    : "";

  // 组装
  const parts: string[] = [];

  // 1. Header（含 project slug）
  parts.push(renderSharedHeader(ctx.slug));

  // 2. Plan 两阶段 + 重要约束
  parts.push(renderSharedWorkPrinciples(planPath));

  // 3. 工具使用
  parts.push(renderSharedToolUsage());

  // 4. 工作区（项目版）
  parts.push(renderProjectWorkspace(ctx.workdir, agentDir, workspaceDir, planPath, agentDir));

  // 5. 项目上下文（MEMORY.md + topic 表）
  parts.push(renderProjectContext(ctx));

  // 6. 项目记忆指令（精简版）
  parts.push(renderProjectMemoryInstructions(ctx.slug));

  // 7. 代码任务规范
  parts.push(renderSharedCodeTaskSpecs());

  // 8. 图表 + 富媒体
  parts.push(renderSharedDiagramsAndMedia(ctx.workdir));

  // 9. ENV
  if (envContent) {
    parts.push(`\n\n## 本机环境上下文（ENV.md）\n\n${envContent}`);
  }

  // 10. vision
  if (visionSection) parts.push(visionSection);

  // 11. feedback
  if (feedbackContent) {
    parts.push(`\n\n## 行为约束（来自历史反馈）\n\n以下是用户过去纠正过的行为，请严格遵守：\n\n${feedbackContent}`);
  }

  // 12. code hook
  if (options.currentProvider) {
    const hookText = loadConfig().agent.responseHooks?.[options.currentProvider];
    if (hookText) {
      parts.push(`\n\n## 行为钩子（来自 provider 配置）\n\n${hookText}`);
    }
  }

  return parts.join("\n\n");
}

// ── Internal helpers ─────────────────────────────────────────────────────────

function slugToWorkdirFallback(slug: string): string {
  // 简单反解：_home_lyy_tinyclaw → /home/lyy/tinyclaw
  if (slug.startsWith("_")) {
    return "/" + slug.slice(1).replace(/_/g, "/");
  }
  return `/${slug}`;
}

function renderProjectWorkspace(
  workdir: string,
  agentDir: string,
  workspaceDir: string,
  planPath: string,
  _agentDir: string, // same as agentDir, kept for symmetry
): string {
  return `## 工作区

三个核心目录，用途完全不同：

| 用途 | 路径 |
|------|------|
| 项目代码（exec_shell 默认 cwd，git 操作） | ${workdir} |
| Agent 配置（ENV.md / PLAN.md / feedback.md 均在 code/ 子目录） | ${agentDir} |
| 文件输出（tmp/ output/ 子目录） | ${workspaceDir} |

- PLAN.md（本 session 计划文件）：\`${planPath}\`，不存在时用 \`write_file\` 创建，已存在时只能用 \`edit_file\` 局部更新
- 当用户明确纠正你的行为（"不要…"/"以后…"/"每次都要…"），用 \`edit_file\` 追加到 \`${agentDir}/code/feedback.md\`，格式：\`- [YYYY-MM-DD] 纠正内容\`
> **所有 Agent 管理文件（ENV.md、PLAN.md、feedback.md）都在 Agent 配置目录的 code/ 下，不在项目目录。**`;
}
