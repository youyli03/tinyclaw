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
  let out = `## 当前项目\n\n`;
  out += `项目: \`${ctx.slug}\`\n`;
  out += `工作目录: \`${ctx.workdir}\`\n`;
  out += `类型: ${ctx.type === "ssh" ? "远程(SSH)" : "本地"}\n`;

  // MEMORY.md 评分截断后注入
  if (ctx.memoryContent) {
    const cfg = loadConfig();
    const maxEntries = cfg.memory.codeInjectionMaxEntries ?? 30;
    const scored = injectScoredEntries(ctx.memoryContent, maxEntries);
    out += `\n### 项目记忆 (MEMORY.md)\n\n${scored}\n`;
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
/** 渲染「项目记忆系统」指令 */
export function renderProjectMemoryInstructions(slug: string): string {
  return `## 项目记忆系统

你已在项目 \`${slug}\` 的上下文中,项目记忆已注入,无需初始化。

MEMORY.md 按分区组织,每分区下按日期存放摘要行:

| 分区 | topic 文件 | 用途 |
|------|-----------|------|
| ⛔ 约束 | constraints | 不可违反的约束 |
| 🧠 架构 | architecture | 模块架构理解 |
| 📊 进度 | progress | 里程碑/当前状态 |
| 🐛 问题 | bugs | 已知问题与根因 |
| 📝 决策 | decisions | 设计决策及理由 |

**读取**:
- \`code_note_read()\` — 读 MEMORY.md 索引
- \`code_note_read({topic:"constraints"})\` — 读 topic 文件
- \`code_note_read({section:"⛔ 约束"})\` — 读指定分区
- \`code_note_search({query:"..."})\` — 语义搜索

**写入**:
- \`code_note_write({content:"[约束] 摘要 → constraints.md"})\` — 追加摘要行到 MEMORY.md
- \`code_note_write({topic:"constraints", content:"详情"})\` — 写 topic 文件
- \`code_note_write({section:"⛔ 约束", content:"..."})\` — 写 MEMORY.md 指定分区
- \`code_note_write({topic:"constraints", section:"API限制", content:"..."})\` — 写 topic 指定分点

MEMORY.md 超过约 200 行时,将旧条目详情移到对应 topic 文件,索引中只留摘要行。

**执行完毕前**: code_note_write 更新进度 → 向用户请求提交确认(获准后才 git commit) → 告知用户。
**发现约束/根因**: 立即调 code_note_write,不等任务完成。`;
}

// ── Project Switch Tools ─────────────────────────────────────────────────────

/** 渲染「项目切换」指令:教 AI 如何切换到其他项目 */
export function renderProjectSwitchTools(slug: string): string {
  return `## 项目切换

你当前绑定在项目 \`${slug}\`。若用户想操作其他项目:

### 切换流程

1. **确定路径** — 从上方 ENV.md 的 \`projects\` 字段查找目标项目路径
2. **计算 slug** — 根据路径类型转换:

| 类型 | 路径示例 | slug |
|------|---------|------|
| 本地 | \`/home/lyy/tinyclaw\` | \`_home_lyy_tinyclaw\`（\`/\` → \`_\`） |
| SSH 远程 | \`root@m1saka.cc:/opt/app\` | \`ssh_m1saka.cc_opt_app\`（\`ssh_\` + host + path,\`.\`/\`/\` → \`_\`） |
| WinMCP | \`win:F:/Github/fpgallm\` | \`ssh_win_F_Github_fpgallm\`（\`ssh_win_\` + path,\`:\\/\` → \`_\`） |

3. **调用 project_switch** — 可直接传路径(工具内部自动转 slug),传入用户任务描述:
   \`project_switch({ project: "路径或slug", task: "用户需求描述" })\`

### 注意事项

- \`project_switch\` 需要 **MFA 确认**,发送前告知用户即将切换
- 若目标项目被其他 session 占用,切换会失败并返回占用者
- 切换后 system prompt 自动替换为新项目上下文,AI 继续执行 task
- 辅助工具:\`project_list\` 列出所有项目、\`project_status\` 查看当前绑定和锁`;
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

  // 6.5 项目切换指令
  parts.push(renderProjectSwitchTools(ctx.slug));

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
    parts.push(
      `\n\n## 行为约束（来自历史反馈）\n\n以下是用户过去纠正过的行为，请严格遵守：\n\n${feedbackContent}`
    );
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
  _agentDir: string // same as agentDir, kept for symmetry
): string {
  return `## 工作区

三个核心目录，用途完全不同：

| 用途 | 路径 |
|------|------|
| 项目代码（exec_shell 默认 cwd，git 操作） | ${workdir} |
| Agent 配置（ENV.md / PLAN.md / feedback.md 均在 code/ 子目录） | ${agentDir} |
| 文件输出（tmp/ output/ 子目录） | ${workspaceDir} |

- PLAN.md（本 session 计划文件）：\`${planPath}\`，不存在时用 \`write_file\` 创建，已存在时只能用 \`edit_file\` 局部更新
- 当用户明确纠正你的行为（"不要…"/"以后…"/"每次都要…"），调用 \`memory_append_feedback(content="…")\` 记录到 \`${agentDir}/code/feedback.md\`（无需 MFA，自动去重）
> **所有 Agent 管理文件（ENV.md、PLAN.md、feedback.md）都在 Agent 配置目录的 code/ 下，不在项目目录。**`;
}
