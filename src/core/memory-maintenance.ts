/**
 * 内置每日记忆维护调度器(MemoryMaintenanceScheduler)
 *
 * 进程启动时自动启动,每天指定时间(默认 04:00)对**所有 Agent** 分别串行执行:
 *   1. QMD 向量索引全量重建 —— 补全 exec_shell/write_file 直写文件未触发索引的盲区
 *   2. diary → MEM.md 增量知识提炼 —— 直接用 fs 读文件 + summarizer LLM,不经 exec_shell
 *   3. diary → ACTIVE.md 近期活跃上下文提炼 —— 兼顾生活场景与项目场景
 *   4. diary → cards/ 结构化记忆卡片提炼 —— 覆盖偏好/约束/关系/决策/open loop 等
 *
 * 每个 Agent 的索引完全隔离(各自独立 index.sqlite + QMDStore 实例),不会混串。
 *
 * 启动时若检测到旧版 mem-distill cron job 存在且启用,自动将其禁用(不删除文件)。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { loadConfig } from "../config/loader.js";
import { agentManager } from "./agent-manager.js";
import { rebuildMemoryIndex, updateMemoryIndex, updateStore } from "../memory/qmd.js";
import { llmRegistry } from "../llm/registry.js";
import { updateJob, getJob } from "../cron/store.js";
import { cronScheduler } from "../cron/scheduler.js";
import { parseCardJson, saveCards, ageOpenLoopCards } from "../memory/cards.js";
import { summarizeActiveSections } from "../memory/summarizer.js";
import { compactFeedback } from "./feedback-writer.js";
// 章节名是数据键（MEM.md 的固定小节），单一真相放在 mem-budget.ts —— 注入侧按同一份清单排优先级
import { MEM_SECTION_KEYS } from "../memory/mem-budget.js";

const ACTIVE_SECTION_KEYS = [
  "最近活跃话题",
  "当前未完成事项",
  "最近明确要求",
  "近期生活上下文",
  "近期项目上下文",
] as const;

/** MEM.md 备份保留份数 */
const MEM_BACKUP_KEEP = 10;

const DISTILL_MEM_SYSTEM = `You are a memory distillation assistant.
Your task is to fully rebuild MEM.md based on the recent conversation-summary diary: merge entries with
the same meaning, drop finished/outdated content, and keep long-term memories that are still valuable.

MEM.md has the following fixed sections (do not add any other section):
- ## 👤 用户偏好       ← Long-term stable: reply style, working habits, taboos. Merge entries with the same meaning
- ## 🎯 当前任务       ← Frequently updated: what is being worked on and the next step; must reflect the latest state (⚠️ replace the whole section, keep only tasks still in progress, ≤8 items, drop finished/outdated entries)
- ## 🗂️ 常用技能与任务 ← Established skills/cron/scripts, path + one-line description
- ## 🐛 踩坑记录       ← Root cause + fix, so the same mistake is not repeated. Merge entries with the same root cause
- ## ✅ 已完成大事      ← Milestone-level results (no daily trivia)
- ## 📝 近期变更       ← Worklog, format: - YYYY-MM-DD: event summary (keep at most 20 entries)

The section headings above are written in Chinese. Copy them **verbatim** into the output file; never
translate, reword or reorder them.

Goals:
1. Merge the current MEM.md with the new information in the diary and output the full de-duplicated MEM.md
2. Merge entries that mean exactly the same thing into one (judge the substance, not just the wording)
3. MEM.md is a general long-term memory for chat mode: it serves not only engineering projects but also
   long-term preferences, habits, relationships and stable facts from everyday conversation
4. Add newly appearing long-term stable information from the diary to the matching section
5. Do not create sections that MEM.md does not already have
6. Retrospective rule (this is how preferences get learned): when the diary shows that the user corrected
   you, rejected your approach, or had to re-explain something, record the **durable lesson** in the
   matching section — a preference or working habit goes to ## 👤 用户偏好, a root cause + fix goes to
   ## 🐛 踩坑记录. Record the rule, not the incident: "prefer X over Y" is useful, "on 2026-09-01 the user
   asked for Y" is not. Skip one-off noise; only promote something that is likely to recur.

Output the full de-duplicated MEM.md directly (including the # 持久记忆 heading and all ## sections).
Do not output any prefix or explanatory text. Refer to the memory content itself in the user's own language.`;

const DISTILL_ACTIVE_SYSTEM = `You are an active-context distillation assistant.
Your task is to extract, from the recent conversation-summary diary, the context that is still active and
likely to come up again in the short term, and to output it as a "section patch" so the program can update
ACTIVE.md section by section.

ACTIVE.md has the following fixed sections (do not add any other section):
- ## 最近活跃话题
- ## 当前未完成事项
- ## 最近明确要求
- ## 近期生活上下文
- ## 近期项目上下文

The section headings above are written in Chinese. Copy them **verbatim** as the \`##\` heading of each patch
section; never translate, reword or reorder them.

Output rules:
1. Keep only information that is still active within the last 7~14 days
2. Consider both everyday-life scenarios and project scenarios; do not turn ACTIVE.md into a pure task board
3. If no section needs an update, output only "无新增"

Output the patch content directly under those verbatim Chinese \`##\` headings, with each entry on its own
line starting with "- ". Do not output any prefix or explanatory text. Write entry content in the user's own
language.`;

const DISTILL_CARDS_SYSTEM = `You are a structured memory-card distillation assistant.
Extract from the recent diary the information that is high-value, reusable long term, or needs continued
tracking, and output a JSON array.

The only allowed type values are (follow strictly, never use any other type):
- preference    ← a preference/habit/taboo the user stated explicitly; the AI must follow it directly in replies
- constraint    ← a constraint the user explicitly forbids or requires; the AI must obey it, highest priority
- relationship  ← important relationship facts (people/organizations/accounts, etc.)
- routine       ← a fixed process/habit of the user (such as a fixed daily operation)
- open_loop     ← an unfinished task/question (something the user said "later"/"next time"/"to do")
- life_event    ← a significant life event worth recording
- decision      ← an important decision the user made (investment/architecture/tooling choice, etc.)
- task_state    ← the current state of an ongoing task (with a clear deadline/milestone)
- project_fact  ← objective project-related facts (paths/ports/secret rules, etc.)

⛔ Forbidden types (because they carry no action value):
- profile   ← FORBIDDEN! A description of the user's traits; the AI cannot derive any action guidance from it
- pattern   ← FORBIDDEN! An observation of behavior patterns; it only describes, it does not constrain — do not generate

Fields of each card:
- type: one of the allowed types above
- scope: e.g. personal / family / workflow / project:tinyclaw
- facet: a short topic, e.g. communication / memory / reminder / architecture
- status: active / obsolete / resolved
- importance: a number 0~1
- ts: ISO time string
- title: a short title (it must tell the AI "what to do", not "what kind of person the user is")
- summary: 1~4 sentences (write them in the user's own language; the content must directly guide AI behavior or serve as a factual reference)
- quote: a **verbatim excerpt** supporting the card (copy it **as-is** from the source text below, ≤120 characters, no rewriting/polishing)
- source: the file path the excerpt came from (for example memory/transcript/2026-09-09.md, taken from the source section heading)
- tags: array of strings (optional)
- supersedes: array of strings (optional)

Rules:
1. Prefer generating constraint and preference: these two directly constrain AI behavior and carry the most value
2. A qualified card title should answer "what should the AI do about this?", not "what kind of person is the user?"
   ❌ Bad: the user is critical in thinking → that is a trait description, not a constraint
   ✅ Good: stock analysis outputs conclusions only, no trading advice → the AI can follow it directly
3. Cover both life and projects; do not focus solely on engineering tasks
4. Do not output low-value running logs, and do not repeat entries already present in MEM.md
5. **quote must be verbatim from the provided source text** (details are easily lost in summaries; quoting the original is what prevents that loss); if no suitable excerpt exists, omit quote/source
6. If there is no suitable card, output only []
7. Output valid JSON only; do not use markdown code fences
`;

function msUntilTimeOfDay(timeOfDay: string): number {
  const [hh, mm] = timeOfDay.split(":").map(Number);
  const now = new Date();
  const next = new Date(now);
  next.setHours(hh!, mm!, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return next.getTime() - now.getTime();
}

class MemoryMaintenanceScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;

  start(): void {
    const cfg = loadConfig();

    const existingJob = getJob("mem-distill");
    if (existingJob && existingJob.enabled) {
      const disabled = updateJob("mem-distill", { enabled: false });
      if (disabled) {
        cronScheduler.reschedule("mem-distill");
        console.log(
          "[memory-maintenance] 已自动禁用旧版 mem-distill cron job(由内置调度器接管)\n" +
            "[memory-maintenance] 如需恢复旧 job,可手动修改 ~/.tinyclaw/cron/jobs/mem-distill.json"
        );
      }
    }

    if (!cfg.memory.dailyMaintenanceEnabled) {
      console.log("[memory-maintenance] disabled(config.memory.dailyMaintenanceEnabled = false)");
      return;
    }

    this.arm(cfg.memory.dailyMaintenanceTime);
  }

  stop(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  async runNow(targetAgentId?: string): Promise<void> {
    if (targetAgentId) {
      await this.runOne(targetAgentId);
    } else {
      await this.runAll();
    }
  }

  private arm(timeOfDay: string): void {
    const ms = msUntilTimeOfDay(timeOfDay);
    const nextRun = new Date(Date.now() + ms);
    console.log(
      `[memory-maintenance] Scheduler started, next run at ${nextRun.toLocaleString()} ` +
        `(in ${Math.round(ms / 60000)} min)`
    );
    this.timer = setTimeout(() => {
      void this.fire(timeOfDay);
    }, ms);
  }

  private async fire(timeOfDay: string): Promise<void> {
    console.log("[memory-maintenance] Daily maintenance started");
    try {
      await this.runAll();
      console.log("[memory-maintenance] Daily maintenance completed");
    } catch (err) {
      console.error("[memory-maintenance] Daily maintenance error:", err);
    }
    this.arm(timeOfDay);
  }

  private async runAll(): Promise<void> {
    const agents = agentManager.loadAll();
    console.log(
      `[memory-maintenance] Processing ${agents.length} agent(s): ${agents.map((a) => a.id).join(", ")}`
    );
    for (const agent of agents) {
      await this.runOne(agent.id);
    }
  }

  async runOne(agentId: string): Promise<void> {
    console.log(`[memory-maintenance] [${agentId}] Step 1: rebuilding memory index...`);
    try {
      const cfg = loadConfig();
      if (cfg.memory.enabled) {
        const result = await rebuildMemoryIndex(agentId);
        if (result) {
          console.log(
            `[memory-maintenance] [${agentId}] Index rebuilt: files=${result.update.indexed} chunks=${result.embed.chunksEmbedded}`
          );
        }
      } else {
        console.log(`[memory-maintenance] [${agentId}] memory not enabled, skipping index rebuild`);
      }
    } catch (err) {
      console.error(`[memory-maintenance] [${agentId}] Index rebuild error:`, err);
    }

    console.log(`[memory-maintenance] [${agentId}] Step 2: distilling diary → MEM.md...`);
    try {
      const result = await this.distillMem(agentId);
      console.log(`[memory-maintenance] [${agentId}] MEM distill result: ${result}`);
    } catch (err) {
      console.error(`[memory-maintenance] [${agentId}] MEM distill error:`, err);
    }

    console.log(`[memory-maintenance] [${agentId}] Step 3: distilling diary → ACTIVE.md...`);
    try {
      const result = await this.distillActive(agentId);
      console.log(`[memory-maintenance] [${agentId}] ACTIVE distill result: ${result}`);
    } catch (err) {
      console.error(`[memory-maintenance] [${agentId}] ACTIVE distill error:`, err);
    }

    console.log(`[memory-maintenance] [${agentId}] Step 4: distilling diary → cards/...`);
    try {
      const result = await this.distillCards(agentId);
      console.log(`[memory-maintenance] [${agentId}] cards distill result: ${result}`);
    } catch (err) {
      console.error(`[memory-maintenance] [${agentId}] cards distill error:`, err);
    }

    console.log(`[memory-maintenance] [${agentId}] Step 5: aging stale open_loop cards...`);
    try {
      const result = ageOpenLoopCards(agentId, 30);
      console.log(
        `[memory-maintenance] [${agentId}] aged ${result.aged} open_loop cards → obsolete`
      );
    } catch (err) {
      console.error(`[memory-maintenance] [${agentId}] age open_loop error:`, err);
    }

    console.log(`[memory-maintenance] [${agentId}] Step 6: compacting feedback.md...`);
    for (const mode of ["chat", "code"] as const) {
      try {
        const r = compactFeedback(agentId, mode);
        if (r.before > 0) {
          console.log(
            `[memory-maintenance] [${agentId}] feedback(${mode}) ${r.before} → ${r.after} 字符`
          );
        }
      } catch (err) {
        console.error(`[memory-maintenance] [${agentId}] feedback(${mode}) compact error:`, err);
      }
    }
  }

  private async distillMem(agentId: string): Promise<string> {
    const memDir = path.join(os.homedir(), ".tinyclaw", "agents", agentId, "memory");
    const memPath = agentManager.memPath(agentId);

    const diaryContent = this.readRecentDiary(memDir, 2, 7);
    if (!diaryContent) return "无近期日记,跳过提炼";

    const currentMem = fs.existsSync(memPath)
      ? fs.readFileSync(memPath, "utf-8")
      : this.buildInitialDocument("持久记忆", MEM_SECTION_KEYS);

    const client = llmRegistry.get("summarizer");
    const result = await client.chat([
      { role: "system", content: DISTILL_MEM_SYSTEM },
      {
        role: "user",
        content:
          `## Recent diary entries\n\n${diaryContent.slice(0, 6000)}\n\n` +
          `## Full current MEM.md content\n\n${currentMem.slice(0, 20000)}`,
      },
    ]);

    const fullMem = result.content.trim();
    if (!fullMem) return "LLM 返回为空,跳过";

    // 结构校验：必需章节必须齐全，否则拒绝写入——防止 LLM 幻觉把 MEM.md 改坏
    const missingSections = MEM_SECTION_KEYS.filter((k) => !fullMem.includes(`## ${k}`));
    if (!fullMem.includes("## ") || missingSections.length > 0) {
      console.warn(
        `[memory-maintenance] [${agentId}] LLM 输出缺少章节「${missingSections.join("、") || "全部"}」，已拒绝写入`
      );
      return `输出缺少必需章节(${missingSections.join("、") || "全部"})，已拒绝写入`;
    }

    // 写入前备份（保留最近 10 份，供人工回滚）
    this.backupMem(agentId, currentMem);

    // 直接写入 LLM 输出的全量 MEM.md
    const originalSize = currentMem.length;
    fs.writeFileSync(memPath, fullMem + "\n", "utf-8");
    const newSize = fullMem.length;

    const cfg = loadConfig();
    if (cfg.memory.enabled) {
      updateMemoryIndex(agentId).catch((err) => {
        console.error(`[memory-maintenance] [${agentId}] post-distill index update error:`, err);
      });
    }

    const pct = originalSize > 0 ? Math.round((1 - newSize / originalSize) * 100) : 0;
    return `已重写 MEM.md (${originalSize} → ${newSize} 字符, 缩减 ${pct}%)`;
  }

  /**
   * MEM.md 写入前备份到 `memory/mem-backup/<时间戳>.md`，只保留最近 MEM_BACKUP_KEEP 份。
   * MEM.md 每日被 LLM 全量重写，一次幻觉就会覆盖旧内容；备份提供人工回滚点。
   */
  private backupMem(agentId: string, content: string): void {
    if (!content.trim()) return;
    try {
      const dir = path.join(os.homedir(), ".tinyclaw", "agents", agentId, "memory", "mem-backup");
      fs.mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23);
      fs.writeFileSync(path.join(dir, `${stamp}.md`), content, "utf-8");
      const files = fs
        .readdirSync(dir)
        .filter((f) => f.endsWith(".md"))
        .sort();
      while (files.length > MEM_BACKUP_KEEP) {
        const oldest = files.shift();
        if (oldest) fs.unlinkSync(path.join(dir, oldest));
      }
    } catch (err) {
      console.warn(
        `[memory-maintenance] [${agentId}] MEM.md 备份失败:`,
        err instanceof Error ? err.message : err
      );
    }
  }

  private async distillActive(agentId: string): Promise<string> {
    const memDir = path.join(os.homedir(), ".tinyclaw", "agents", agentId, "memory");
    const activePath = agentManager.activePath(agentId);

    const diaryContent = this.readRecentDiary(memDir, 3, 14);
    if (!diaryContent) return "无近期日记,跳过提炼";

    const currentActive = fs.existsSync(activePath)
      ? fs.readFileSync(activePath, "utf-8")
      : this.buildInitialDocument("活跃上下文", ACTIVE_SECTION_KEYS);

    const client = llmRegistry.get("summarizer");
    const result = await client.chat([
      { role: "system", content: DISTILL_ACTIVE_SYSTEM },
      {
        role: "user",
        content:
          `## Recent diary entries\n\n${diaryContent.slice(0, 7000)}\n\n` +
          `## Current ACTIVE.md overview\n\n${summarizeActiveSections(agentId)}`,
      },
    ]);

    const patch = result.content.trim();
    if (!patch || patch === "无新增") return "无新增";

    const sectionPatches = this.parseSectionPatch(patch);
    if (sectionPatches.size === 0) return "无新增";

    let updatedActive = currentActive;
    let updatedCount = 0;
    for (const [sectionTitle, newLines] of sectionPatches) {
      if (!(ACTIVE_SECTION_KEYS as readonly string[]).includes(sectionTitle)) continue;
      const nextActive = this.replaceSection(updatedActive, sectionTitle, newLines);
      if (nextActive !== updatedActive) updatedCount++;
      updatedActive = nextActive;
    }

    if (updatedCount === 0) return "无新增";
    fs.writeFileSync(activePath, updatedActive, "utf-8");

    const cfg = loadConfig();
    if (cfg.memory.enabled) {
      updateStore("active", agentId).catch((err) => {
        console.error(`[memory-maintenance] [${agentId}] post-active index update error:`, err);
      });
    }

    return `已更新 ${updatedCount} 个章节到 ACTIVE.md`;
  }

  private async distillCards(agentId: string): Promise<string> {
    const memDir = path.join(os.homedir(), ".tinyclaw", "agents", agentId, "memory");
    const cardsDir = agentManager.cardsDir(agentId);
    fs.mkdirSync(cardsDir, { recursive: true });

    // 优先用逐字层 transcript（含原文，便于生成 quote）；没有则回退到 diary 摘要
    const sourceText =
      this.readRecentTranscripts(agentId, 4, 14) ?? this.readRecentDiary(memDir, 4, 14);
    if (!sourceText) return "无近期原文/日记,跳过提炼";

    const client = llmRegistry.get("summarizer");
    const result = await client.chat([
      { role: "system", content: DISTILL_CARDS_SYSTEM },
      {
        role: "user",
        content: `## Recent conversation source text\n\n${sourceText.slice(0, 12000)}`,
      },
    ]);

    const cards = parseCardJson(result.content);
    if (cards.length === 0) return "无新增";

    const saveResult = saveCards(cards, agentId);

    const cfg = loadConfig();
    if (cfg.memory.enabled) {
      updateStore("cards", agentId).catch((err) => {
        console.error(`[memory-maintenance] [${agentId}] post-cards index update error:`, err);
      });
    }

    return `已写入 ${saveResult.saved} 张卡片,标记 ${saveResult.obsoleted} 张旧卡失效`;
  }

  private parseSectionPatch(patch: string): Map<string, string[]> {
    const result = new Map<string, string[]>();
    let currentSection: string | null = null;
    let currentLines: string[] = [];

    const flush = (): void => {
      if (currentSection !== null && currentLines.length > 0) {
        result.set(currentSection, [...currentLines]);
      }
    };

    for (const line of patch.split("\n")) {
      const sectionMatch = line.match(/^##\s+(.+)$/);
      if (sectionMatch) {
        flush();
        currentSection = sectionMatch[1]!.trim();
        currentLines = [];
      } else if (currentSection !== null && line.trim().startsWith("- ")) {
        currentLines.push(line.trim());
      }
    }
    flush();

    return result;
  }


  private replaceSection(docContent: string, sectionTitle: string, newLines: string[]): string {
    const lines = docContent.split("\n");
    const headerPattern = `## ${sectionTitle}`;

    const startIdx = lines.findIndex((l) => l.trim() === headerPattern);
    if (startIdx === -1) {
      const tail = docContent.endsWith("\n") ? "" : "\n";
      return docContent + `${tail}\n${headerPattern}\n${newLines.join("\n")}\n`;
    }

    let endIdx = lines.length;
    for (let i = startIdx + 1; i < lines.length; i++) {
      if (lines[i]!.startsWith("## ")) {
        endIdx = i;
        break;
      }
    }

    const nextLines = [...lines.slice(0, startIdx + 1), ...newLines, "", ...lines.slice(endIdx)];
    while (nextLines.length > 0 && nextLines[nextLines.length - 1] === "") {
      nextLines.pop();
    }
    return nextLines.join("\n") + "\n";
  }


  private buildInitialDocument(title: string, sectionKeys: readonly string[]): string {
    const sections = sectionKeys.map((key) => `## ${key}\n`).join("\n");
    return `# ${title}\n\n${sections}`;
  }

  private readRecentDiary(memDir: string, daysToRead: number, maxLookback: number): string | null {
    if (!fs.existsSync(memDir)) return null;

    const now = new Date();
    const contents: string[] = [];
    let found = 0;
    let offset = 0;

    while (found < daysToRead && offset < maxLookback) {
      const d = new Date(now);
      d.setDate(d.getDate() - offset);
      const month = d.toISOString().slice(0, 7);
      const date = d.toISOString().slice(0, 10);
      const filePath = path.join(memDir, month, `${date}.md`);
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, "utf-8").trim();
        if (content) {
          contents.push(`### ${date}\n\n${content}`);
          found++;
        }
      }
      offset++;
    }

    return contents.length > 0 ? contents.join("\n\n---\n\n") : null;
  }

  /**
   * 读取最近几天的逐字层 transcript（`memory/transcript/YYYY-MM-DD.md`）。
   * 每个文件前标注相对路径，供 LLM 在卡片的 `source` 字段里引用。
   */
  private readRecentTranscripts(
    agentId: string,
    daysToRead: number,
    maxLookback: number
  ): string | null {
    const dir = path.join(
      os.homedir(),
      ".tinyclaw",
      "agents",
      agentId,
      "memory",
      "transcript"
    );
    if (!fs.existsSync(dir)) return null;

    const now = new Date();
    const blocks: string[] = [];
    let found = 0;
    for (let offset = 0; found < daysToRead && offset < maxLookback; offset++) {
      const d = new Date(now);
      d.setDate(d.getDate() - offset);
      const day = d.toISOString().slice(0, 10);
      const filePath = path.join(dir, `${day}.md`);
      if (!fs.existsSync(filePath)) continue;
      const content = fs.readFileSync(filePath, "utf-8").trim();
      if (!content) continue;
      blocks.push(`### 原文（memory/transcript/${day}.md）\n\n${content}`);
      found++;
    }
    return blocks.length > 0 ? blocks.join("\n\n---\n\n") : null;
  }
}


export const memoryMaintenance = new MemoryMaintenanceScheduler();
