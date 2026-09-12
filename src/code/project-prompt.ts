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
import { buildWorkspaceInstructionsSection } from "../instructions/workspace-prompt.js";
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
import { injectScoredEntries } from "../memory/entry-scorer.js";

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
  } catch {
    /* ignore */
  }

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
  let out = `## Current project\n\n`;
  out += `Project: \`${ctx.slug}\`\n`;
  out += `Workdir: \`${ctx.workdir}\`\n`;
  out += `Type: ${ctx.type === "ssh" ? "remote (SSH)" : "local"}\n`;

  // MEMORY.md 评分截断后注入
  if (ctx.memoryContent) {
    const cfg = loadConfig();
    const maxEntries = cfg.memory.codeInjectionMaxEntries ?? 30;
    const scored = injectScoredEntries(ctx.memoryContent, maxEntries);
    out += `\n### Project memory (MEMORY.md)\n\n${scored}\n`;
  }

  // Topic 表
  if (ctx.topics.length > 0) {
    out += `\n### Topic files\n\n`;
    out += `| File | Updated | Lines |\n`;
    out += `|------|------|------|\n`;
    for (const t of ctx.topics) {
      const stale = t.stale ? " ⚠️" : "";
      const days = t.daysAgo === 0 ? "today" : `${t.daysAgo}d ago`;
      out += `| ${t.name} | ${days}${stale} | ${t.lineCount} |\n`;
    }
  }

  return out;
}

/** 渲染「项目记忆系统」指令（精简版：不含切换、不含 slug 约束） */
/** 渲染「项目记忆系统」指令 */
export function renderProjectMemoryInstructions(slug: string): string {
  return `## Project memory system

You are already in the context of project \`${slug}\`; its memory is injected below, so no
initialization is needed.

MEMORY.md is organized by section, and inside each section the summary lines are stored by date:

| Section | topic file | Purpose |
|------|-----------|------|
| ⛔ 约束 | constraints | Constraints that must not be violated |
| 🧠 架构 | architecture | Module architecture understanding |
| 📊 进度 | progress | Milestones / current status |
| 🐛 问题 | bugs | Known issues and their root causes |
| 📝 决策 | decisions | Design decisions and their rationale |

**Reading**:
- \`code_note_read()\` - read the MEMORY.md index
- \`code_note_read({topic:"constraints"})\` - read a topic file
- \`code_note_read({section:"⛔ 约束"})\` - read the given section
- \`code_note_search({query:"..."})\` - semantic search

**Writing**:
- \`code_note_write({content:"[约束] 摘要 → constraints.md"})\` - append a summary line to MEMORY.md
- \`code_note_write({topic:"constraints", content:"详情"})\` - write a topic file
- \`code_note_write({section:"⛔ 约束", content:"..."})\` - write the given MEMORY.md section
- \`code_note_write({topic:"constraints", section:"API限制", content:"..."})\` - write a named point inside a topic file

Once MEMORY.md grows past roughly 200 lines, move the details of old entries into the matching
topic file and keep only the summary line in the index.

**Before finishing**: update progress with code_note_write → ask the user to confirm the commit (run git commit only after approval) → inform the user.
**On finding a constraint or a root cause**: call code_note_write immediately; do not wait for the task to finish.`;
}

// ── Project Switch Tools ─────────────────────────────────────────────────────

/** 渲染「项目切换」指令:教 AI 如何切换到其他项目 */
export function renderProjectSwitchTools(slug: string): string {
  return `## Project switching

You are currently bound to project \`${slug}\`. If the user wants to work on another project:

### Switching flow

1. **Find the path** - look up the target project path in the \`projects\` field of the ENV.md section above
2. **Compute the slug** - convert according to the path type:

| Type | Example path | slug |
|------|---------|------|
| Local | \`/home/lyy/tinyclaw\` | \`_home_lyy_tinyclaw\` (\`/\` → \`_\`) |
| SSH remote | \`root@m1saka.cc:/opt/app\` | \`ssh_m1saka.cc_opt_app\` (\`ssh_\` + host + path,\`.\`/\`/\` → \`_\`) |
| WinMCP | \`win:F:/Github/fpgallm\` | \`ssh_win_F_Github_fpgallm\` (\`ssh_win_\` + path,\`:\\/\` → \`_\`) |

3. **Call project_switch** - you may pass the path directly (the tool converts it to a slug internally); pass the user's task description too:
   \`project_switch({ project: "path or slug", task: "user requirement description" })\`

### Notes

- \`project_switch\` requires **MFA confirmation**; tell the user about the upcoming switch before sending it
- If the target project is held by another session, the switch fails and returns the current holder
- After the switch the system prompt is replaced with the new project context automatically and the AI keeps executing the task
- Helper tools: \`project_list\` lists all projects, \`project_status\` shows the current binding and lock`;
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
  options: BuildProjectPromptOptions = {}
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
  } catch {
    /* ignore */
  }

  // vision
  const visionSection = options.supportsVision
    ? `\n\n## Vision support\n\nThe current model can read images directly. When a message contains an image, observe it and answer directly.`
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

  // 6.5 项目切换指令
  parts.push(renderProjectSwitchTools(ctx.slug));

  // 7. 代码任务规范
  parts.push(renderSharedCodeTaskSpecs());

  // 8. 图表 + 富媒体
  parts.push(renderSharedDiagramsAndMedia(ctx.workdir));

  // 9. ENV
  if (envContent) {
    parts.push(`\n\n## Local environment context (ENV.md)\n\n${envContent}`);
  }

  // 9.5 工作区指令（AGENTS.md / CLAUDE.md 及其 local 覆盖）——项目目录就是 cwd
  const instructionsSection = buildWorkspaceInstructionsSection(ctx.workdir);
  if (instructionsSection) parts.push(instructionsSection);

  // 10. vision
  if (visionSection) parts.push(visionSection);

  // 11. feedback
  if (feedbackContent) {
    parts.push(
      `\n\n## Behavior constraints (from past feedback)\n\nBelow are behaviors the user corrected in the past; follow them strictly:\n\n${feedbackContent}`
    );
  }

  // 12. code hook
  if (options.currentProvider) {
    const hookText = loadConfig().agent.responseHooks?.[options.currentProvider];
    if (hookText) {
      parts.push(`\n\n## Behavior hook (from provider config)\n\n${hookText}`);
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
  _agentDir: string // same as agentDir, kept for symmetry
): string {
  return `## Workspace

Three core directories with completely different purposes:

| Purpose | Path |
|------|------|
| Project code (exec_shell default cwd, git operations) | ${workdir} |
| Agent config (ENV.md / PLAN.md / feedback.md all live under code/) | ${agentDir} |
| File output (tmp/ and output/ subdirectories) | ${workspaceDir} |

- PLAN.md (this session's plan file): \`${planPath}\`; create it with \`write_file\` when it does not exist, and when it already exists you may only update it locally with \`edit_file\`
- When the user explicitly corrects your behavior ("不要…" / "以后…" / "每次都要…" in their own words), call \`memory_append_feedback(content="…")\` to record it in \`${agentDir}/code/feedback.md\` (no MFA needed, deduplicated automatically)
> **All agent-managed files (ENV.md, PLAN.md, feedback.md) live under code/ in the agent config directory, not in the project directory.**`;
}
