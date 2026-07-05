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
import { summarizeMemSections, summarizeActiveSections } from "../memory/summarizer.js";

const MEM_SECTION_KEYS = [
  "👤 用户偏好",
  "🎯 当前任务",
  "🗂️ 常用技能与任务",
  "🐛 踩坑记录",
  "✅ 已完成大事",
  "📝 近期变更",
] as const;

const ACTIVE_SECTION_KEYS = [
  "最近活跃话题",
  "当前未完成事项",
  "最近明确要求",
  "近期生活上下文",
  "近期项目上下文",
] as const;

const WORKLOG_MAX_LINES = 20;

const DISTILL_MEM_SYSTEM = `你是一个记忆提炼助手。
你的任务是从近期的对话摘要日记(diary)中,将尚未记录在 MEM.md 中的有价值信息提炼出来,
并以"章节补丁"格式输出,方便程序按章节精确更新 MEM.md。

MEM.md 有以下固定章节(不得新增其他章节):
- ## 👤 用户偏好       ← 长期稳定:回复风格、操作习惯、禁忌
- ## 🎯 当前任务       ← 常更新:正在做什么、下一步,必须反映最新状态（⚠️ 整体替换原章节，只保留最近仍在进行的任务，≤8条，删除已完成/过时条目）
- ## 🗂️ 常用技能与任务 ← 已建立的 skill/cron/脚本,路径+一句话说明
- ## 🐛 踩坑记录       ← 错误原因+修复方法,避免重蹈覆辙
- ## ✅ 已完成大事      ← 里程碑级成果(不写日常琐事)
- ## 📝 近期变更       ← Worklog,格式:- YYYY-MM-DD: 事件摘要

输出规则:
1. 输出格式为"章节补丁":每个需要更新的章节输出一个块
2. 只记录长期稳定信息,不要把短期活跃事项写进 MEM.md
3. MEM.md 属于 chat 模式通用长期记忆,不仅服务工程项目,也要覆盖日常对话中的长期偏好、习惯、关系和稳定事实
4. 若所有章节均无需更新,只输出 "无新增"

直接输出补丁内容,不要输出任何前缀或说明文字。`;

const DISTILL_ACTIVE_SYSTEM = `你是一个活跃上下文提炼助手。
你的任务是从近期对话摘要日记(diary)中,提炼出仍然活跃、短期内大概率会继续被提起的上下文,
并以"章节补丁"格式输出,方便程序按章节精确更新 ACTIVE.md。

ACTIVE.md 有以下固定章节(不得新增其他章节):
- ## 最近活跃话题
- ## 当前未完成事项
- ## 最近明确要求
- ## 近期生活上下文
- ## 近期项目上下文

输出规则:
1. 只保留最近 7~14 天仍然活跃的信息
2. 必须同时考虑生活场景和项目场景,不要把 ACTIVE.md 写成纯任务面板
3. 若所有章节均无需更新,只输出 "无新增"

直接输出补丁内容,不要输出任何前缀或说明文字。`;

const DISTILL_CARDS_SYSTEM = `你是一个结构化记忆卡片提炼助手。
请从近期 diary 中提炼高价值、可长期复用或需要持续跟踪的信息,输出 JSON 数组。

允许的 type 只有（严格遵守，不得使用其他类型）:
- preference    ← 用户明确表达的偏好/习惯/禁忌，AI 回复时需直接遵守
- constraint    ← 用户明确禁止或要求的约束，AI 必须遵守，最高优先级
- relationship  ← 重要关系事实（人物/组织/账号等）
- routine       ← 用户的固定流程/习惯（如每天的固定操作）
- open_loop     ← 未闭环的待办/问题（用户说"以后"/"下次"/"待做"的事）
- life_event    ← 值得记录的重大生活事件
- decision      ← 用户做出的重要决策（投资/架构/工具选型等）
- task_state    ← 正在进行的任务的当前状态（有明确截止/里程碑）
- project_fact  ← 项目相关的客观事实（路径/端口/密钥规则等）

⛔ 禁止使用的类型（因为没有行动价值）:
- profile   ← 禁止！用户特征描述，AI 无法从中获得行动指导
- pattern   ← 禁止！行为模式观察，只是描述而非约束，不要生成

每张卡片字段:
- type: 上述允许类型之一
- scope: 如 personal / family / workflow / project:tinyclaw
- facet: 简短主题,如 communication / memory / reminder / architecture
- status: active / obsolete / resolved
- importance: 0~1 数值
- ts: ISO 时间字符串
- title: 简短标题（能直接告诉 AI"要怎么做"，而不是"用户是什么人"）
- summary: 1~4 句中文摘要（内容必须能直接指导 AI 行为或作为事实参考）
- tags: 字符串数组(可选)
- supersedes: 字符串数组(可选)

规则:
1. 优先生成 constraint 和 preference：这两类直接约束 AI 行为，价值最高
2. 合格的 card 标题应能回答"AI 在这件事上应该怎么做？"，而非"用户是什么样的人？"
   ❌ 坏例：用户具备批判性思维 → 这是特征描述，不是约束
   ✅ 好例：股票分析只输出结论，不给操作建议 → AI 直接遵守
3. 同时覆盖生活和项目,不能只围绕工程任务
4. 不要输出低价值流水账，不要重复 MEM.md 里已有的条目
5. 若没有合适卡片,只输出 []
6. 只输出合法 JSON,不要 markdown 代码块
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
          `## 近期日记内容\n\n${diaryContent.slice(0, 6000)}\n\n` +
          `## 当前 MEM.md 概况\n\n${summarizeMemSections(agentId)}`,
      },
    ]);

    const patch = result.content.trim();
    if (!patch || patch === "无新增") return "无新增";

    const sectionPatches = this.parseSectionPatch(patch);
    if (sectionPatches.size === 0) return "无新增";

    let updatedMem = currentMem;
    let updatedCount = 0;

    // Embedding 去重: 对追加式章节的新条目做余弦相似度检查
    const dedupedPatches = await embedDedupPatches(currentMem, sectionPatches, agentId);

    for (const [sectionTitle, newLines] of dedupedPatches) {
      if (!(MEM_SECTION_KEYS as readonly string[]).includes(sectionTitle)) continue;
      // 🎯 当前任务 章节使用"完全替换"策略，避免无限追加历史任务
      const nextMem =
        sectionTitle === "🎯 当前任务"
          ? this.replaceSection(updatedMem, sectionTitle, newLines)
          : this.upsertSection(updatedMem, sectionTitle, newLines);
      if (nextMem !== updatedMem) updatedCount++;
      updatedMem = nextMem;
    }

    if (updatedCount === 0) return "无新增";
    fs.writeFileSync(memPath, updatedMem, "utf-8");

    const cfg = loadConfig();
    if (cfg.memory.enabled) {
      updateMemoryIndex(agentId).catch((err) => {
        console.error(`[memory-maintenance] [${agentId}] post-distill index update error:`, err);
      });
    }

    // LLM 定期合并: 👤 用户偏好 > 50 条时触发
    await maybeConsolidatePreferences(agentId, updatedMem, memPath);

    return `已更新 ${updatedCount} 个章节到 MEM.md`;
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
          `## 近期日记内容\n\n${diaryContent.slice(0, 7000)}\n\n` +
          `## 当前 ACTIVE.md 概况\n\n${summarizeActiveSections(agentId)}`,
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

    const diaryContent = this.readRecentDiary(memDir, 4, 14);
    if (!diaryContent) return "无近期日记,跳过提炼";

    const client = llmRegistry.get("summarizer");
    const result = await client.chat([
      { role: "system", content: DISTILL_CARDS_SYSTEM },
      {
        role: "user",
        content: `## 近期日记内容\n\n${diaryContent.slice(0, 9000)}`,
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

  private upsertSection(docContent: string, sectionTitle: string, newLines: string[]): string {
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

    const existingContent = lines.slice(startIdx + 1, endIdx).join("\n");
    const dedupedNewLines = newLines.filter((nl) => {
      const normalized = nl.replace(/^-\s+/, "").trim().toLowerCase();
      return !existingContent.toLowerCase().includes(normalized);
    });

    if (dedupedNewLines.length === 0) return docContent;

    let insertIdx = endIdx;
    for (let i = endIdx - 1; i > startIdx; i--) {
      if (lines[i]!.trim() !== "") {
        insertIdx = i + 1;
        break;
      }
    }

    const newContentLines = [...lines];
    newContentLines.splice(insertIdx, 0, ...dedupedNewLines);

    if (sectionTitle === "📝 近期变更") {
      return this.trimWorklogSection(newContentLines.join("\n"), headerPattern);
    }

    return newContentLines.join("\n");
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

  private trimWorklogSection(memContent: string, headerPattern: string): string {
    const lines = memContent.split("\n");
    const startIdx = lines.findIndex((l) => l.trim() === headerPattern);
    if (startIdx === -1) return memContent;

    let endIdx = lines.length;
    for (let i = startIdx + 1; i < lines.length; i++) {
      if (lines[i]!.startsWith("## ")) {
        endIdx = i;
        break;
      }
    }

    const bulletIndices: number[] = [];
    for (let i = startIdx + 1; i < endIdx; i++) {
      if (lines[i]!.trim().startsWith("- ")) bulletIndices.push(i);
    }

    if (bulletIndices.length <= WORKLOG_MAX_LINES) return memContent;

    const toRemove = bulletIndices.length - WORKLOG_MAX_LINES;
    const removeSet = new Set(bulletIndices.slice(0, toRemove));
    return lines.filter((_, idx) => !removeSet.has(idx)).join("\n");
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
}

// ================= Embedding 去重 & LLM 合并辅助函数 =================

/** 计算两个向量的余弦相似度 */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na > 0 && nb > 0 ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/** 调用本机 RKLLM embedding 服务,批量获取向量 */
async function batchEmbed(texts: string[]): Promise<number[][]> {
  const EMBED_URL = "http://127.0.0.1:11434/embed";
  const maxRetries = 2;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // 逐条调用 (API 只接受单条 text)
      const embeddings: number[][] = [];
      for (const text of texts) {
        const resp = await fetch(EMBED_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
          signal: AbortSignal.timeout(10000),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = (await resp.json()) as { embedding?: number[] };
        if (!data.embedding || !Array.isArray(data.embedding)) {
          throw new Error("Invalid embedding response");
        }
        embeddings.push(data.embedding);
      }
      return embeddings;
    } catch (e) {
      if (attempt === maxRetries) {
        console.warn(
          `[memory-maintenance] Embedding 服务不可用 (${maxRetries + 1} 次重试均失败),跳过去重:`,
          e
        );
        return [];
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
  return [];
}

/**
 * 对 distillMem 产生的追加式章节 patches 做 embedding 去重。
 * 只过滤掉余弦相似度 > 0.92 的新候选条目。
 */
async function embedDedupPatches(
  currentMem: string,
  sectionPatches: Map<string, string[]>,
  agentId: string
): Promise<Map<string, string[]>> {
  const deduped = new Map<string, string[]>();

  // 收集需要去重的章节 (非替换式)
  const appendSections: Array<{ title: string; newLines: string[] }> = [];
  for (const [title, newLines] of sectionPatches) {
    if (title === "🎯 当前任务" || title === "📝 近期变更") {
      // 替换式章节不去重,直接保留
      deduped.set(title, newLines);
    } else if (newLines.length > 0) {
      appendSections.push({ title, newLines });
    }
  }

  if (appendSections.length === 0) return deduped;

  // 提取各章节已有条目
  const existingBySection = extractSectionItems(currentMem);

  // 收集所有新候选 + 已有条目,批量 embed
  const allTexts: string[] = [];
  const textMeta: Array<{ sectionIdx: number; isNew: boolean }> = [];
  for (let si = 0; si < appendSections.length; si++) {
    const section = appendSections[si]!;
    const existing = existingBySection.get(section.title) || [];
    for (const t of existing) {
      allTexts.push(t);
      textMeta.push({ sectionIdx: si, isNew: false });
    }
    for (const t of section.newLines) {
      allTexts.push(t);
      textMeta.push({ sectionIdx: si, isNew: true });
    }
  }

  if (allTexts.length === 0) return deduped;

  const embs = await batchEmbed(allTexts);
  if (embs.length === 0) {
    // embedding 服务不可用,全部放行
    console.warn(`[memory-maintenance] [${agentId}] Embedding 去重跳过: 服务不可用`);
    for (const s of appendSections) deduped.set(s.title, s.newLines);
    return deduped;
  }

  // 按 section 分组已有和新候选的 embedding
  const results = new Map<
    number,
    { existing: number[][]; candidates: { text: string; emb: number[] }[] }
  >();
  for (let i = 0; i < textMeta.length; i++) {
    const meta = textMeta[i]!;
    const emb = embs[i]!;
    let group = results.get(meta.sectionIdx);
    if (!group) {
      group = { existing: [], candidates: [] };
      results.set(meta.sectionIdx, group);
    }
    if (meta.isNew) {
      group.candidates.push({ text: allTexts[i]!, emb });
    } else {
      group.existing.push(emb);
    }
  }

  // 对每个 section 做去重
  for (let si = 0; si < appendSections.length; si++) {
    const section = appendSections[si]!;
    const group = results.get(si);
    if (!group || group.candidates.length === 0) {
      deduped.set(section.title, section.newLines);
      continue;
    }

    const filtered: string[] = [];
    for (const cand of group.candidates) {
      let isDup = false;
      for (const exEmb of group.existing) {
        if (cosineSimilarity(cand.emb, exEmb) > 0.92) {
          isDup = true;
          break;
        }
      }
      if (!isDup) filtered.push(cand.text);
    }

    if (filtered.length < section.newLines.length) {
      const skipped = section.newLines.length - filtered.length;
      console.log(
        `[memory-maintenance] [${agentId}] Embedding 去重: ${section.title} 跳过 ${skipped} 条重复`
      );
    }
    deduped.set(section.title, filtered);
  }

  return deduped;
}

/** 从 MEM.md 文本中提取各章节的条目列表 */
function extractSectionItems(memContent: string): Map<string, string[]> {
  const result = new Map<string, string[]>();
  const lines = memContent.split("\n");
  let currentHeading = "";
  for (const line of lines) {
    if (line.startsWith("## ")) {
      currentHeading = line.slice(3).trim();
      result.set(currentHeading, []);
    } else if (line.startsWith("- ") && currentHeading) {
      const text = line.slice(2).trim();
      if (text && !text.startsWith("[")) {
        result.get(currentHeading)!.push(text);
      }
    }
  }
  return result;
}

/**
 * LLM 定期合并:当 👤 用户偏好 条目数 > 50 时,调用 LLM 合并语义完全相同的条目。
 * embedding 抓逐字重复,LLM 处理语义相近但措辞不同的边界 case。
 */
async function maybeConsolidatePreferences(
  agentId: string,
  updatedMem: string,
  memPath: string
): Promise<void> {
  try {
    const sectionItems = extractSectionItems(updatedMem);
    const prefs = sectionItems.get("👤 用户偏好") || [];
    if (prefs.length <= 50) return;

    console.log(`[memory-maintenance] [${agentId}] 👤 用户偏好 ${prefs.length} 条,触发 LLM 合并`);

    const client = llmRegistry.get("summarizer");
    const prefText = prefs.map((p, i) => `${i + 1}. ${p}`).join("\n");

    const result = await client.chat(
      [
        {
          role: "system",
          content: `[⚠️BLOCKED:zh_you_are]。
你的任务是将"用户偏好"列表中语义完全相同的条目合并,保留表述最清晰的一条。
重要:不要删除任何独立的约束/偏好,只合并语义完全相同的条目。
输出格式:用 Markdown 列表(- 开头),每行一条合并后的偏好。`,
        },
        {
          role: "user",
          content: `以下是当前"用户偏好"列表(${prefs.length} 条),请合并语义完全相同的条目:\n\n${prefText}`,
        },
      ],
      { isUserInitiated: false }
    );

    const consolidated = result.content.trim();
    if (!consolidated) return;

    // 解析合并后的列表
    const newLines = consolidated
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("- "))
      .map((l) => l.replace(/^-\s*/, "").trim());

    if (newLines.length === 0 || newLines.length >= prefs.length) return;

    // 用 replaceSection 替换整个章节
    const merged = replaceSectionStatic(updatedMem, "👤 用户偏好", newLines);
    fs.writeFileSync(memPath, merged, "utf-8");
    console.log(
      `[memory-maintenance] [${agentId}] 👤 用户偏好合并完成: ${prefs.length} → ${newLines.length} 条`
    );
  } catch (e) {
    console.warn(`[memory-maintenance] [${agentId}] 偏好合并失败:`, e);
  }
}

/** 静态版本的 replaceSection,供 maybeConsolidatePreferences 使用 */
function replaceSectionStatic(content: string, sectionTitle: string, newLines: string[]): string {
  const lines = content.split("\n");
  const headingLine = `## ${sectionTitle}`;
  let sectionStart = -1;
  let sectionEnd = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line === headingLine) {
      sectionStart = i;
    } else if (sectionStart >= 0 && line.startsWith("## ")) {
      sectionEnd = i;
      break;
    }
  }
  if (sectionEnd < 0) sectionEnd = lines.length;

  const before = lines.slice(0, sectionStart + 1);
  const after = lines.slice(sectionEnd);
  const body = newLines.length > 0 ? newLines.map((l) => `- ${l}`) : ["(待记录)"];

  return [...before, ...body, ...after].join("\n");
}

export const memoryMaintenance = new MemoryMaintenanceScheduler();
