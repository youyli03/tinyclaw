/**
 * 内置每日记忆维护调度器(MemoryMaintenanceScheduler)
 *
 * 进程启动时自动启动,每天指定时间(默认 04:00)对**所有 Agent** 分别串行执行:
 *   1. QMD 向量索引全量重建 —— 补全 exec_shell/write_file 直写文件未触发索引的盲区
 *   2. diary → MEM.md 增量知识提炼 —— 直接用 fs 读文件 + summarizer LLM,不经 exec_shell
 *   3. diary → ACTIVE.md 近期活跃上下文提炼 —— 兼顾生活场景与项目场景
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

// ── MEM.md 固定章节定义 ───────────────────────────────────────────────────────
//
// 这些章节是 MEM.md 的骨架,distillMem() 按章节 upsert 更新,不整体覆写。
// 章节顺序即文件顺序,名称必须与 MEM.md 中的 `## ` 标题完全一致。

const MEM_SECTION_KEYS = [
  "👤 用户偏好",       // 长期稳定:回复风格、操作习惯、禁忌
  "🎯 当前任务",       // 常更新:正在做什么、下一步是什么
  "🗂️ 常用技能与任务", // 中等稳定:已建立的 skill/cron,路径+用途
  "🐛 踩坑记录",       // 只增不删:错误原因+修复方法,避免重蹈
  "✅ 已完成大事",      // 里程碑级别的成果
  "📝 近期变更",       // Worklog:最近若干条,按日期,1行/条
] as const;

const ACTIVE_SECTION_KEYS = [
  "最近活跃话题",
  "当前未完成事项",
  "最近明确要求",
  "近期生活上下文",
  "近期项目上下文",
] as const;

const WORKLOG_MAX_LINES = 20; // 近期变更最多保留条数,超出时删除最旧的

// ── 提炼 Prompt ───────────────────────────────────────────────────────────────

const DISTILL_MEM_SYSTEM = `你是一个记忆提炼助手。
你的任务是从近期的对话摘要日记(diary)中,将尚未记录在 MEM.md 中的有价值信息提炼出来,
并以"章节补丁"格式输出,方便程序按章节精确更新 MEM.md。

MEM.md 有以下固定章节(不得新增其他章节):
- ## 👤 用户偏好       ← 长期稳定:回复风格、操作习惯、禁忌
- ## 🎯 当前任务       ← 常更新:正在做什么、下一步,必须反映最新状态
- ## 🗂️ 常用技能与任务 ← 已建立的 skill/cron/脚本,路径+一句话说明
- ## 🐛 踩坑记录       ← 错误原因+修复方法,避免重蹈覆辙
- ## ✅ 已完成大事      ← 里程碑级成果(不写日常琐事)
- ## 📝 近期变更       ← Worklog,格式:- YYYY-MM-DD: 事件摘要

输出规则:
1. 输出格式为"章节补丁":每个需要更新的章节输出一个块,格式如下:
   ## 章节名
   - 新条目1
   - 新条目2
2. 每个块只输出该章节中**需要新增**的条目,已有内容不重复输出
3. 若某章节无需更新,不输出该章节块
4. 若所有章节均无需更新,只输出 "无新增" 三个字
5. 只记录稳定知识:用户长期偏好、重要结论、已完成大事、常用工具路径
6. 不记录临时信息:一次性调试输出、临时文件路径、天气/股价等实时数据
7. 🎯 当前任务章节必须反映日记中最新的任务状态,若有变化务必更新
8. 📝 近期变更每条必须带 YYYY-MM-DD 日期前缀
9. MEM.md 属于 chat 模式通用长期记忆,不仅服务工程项目,也要覆盖日常对话中的长期偏好、习惯、关系和稳定事实

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
1. 输出格式为章节补丁,每个章节块格式如下:
   ## 章节名
   - 条目1
   - 条目2
2. 只保留最近 7~14 天仍然活跃的信息,不要写长期稳定偏好(那些应进入 MEM.md)
3. 必须同时考虑生活场景和项目场景,不要把 ACTIVE.md 写成纯任务面板
4. 若所有章节均无需更新,只输出 "无新增"
5. 条目应简洁、具体、可续接,避免泛泛总结

直接输出补丁内容,不要输出任何前缀或说明文字。`;

// ── 时间工具 ──────────────────────────────────────────────────────────────────

/** 计算距今天(或明天)"HH:MM" 的 ms 数 */
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

// ── 调度器 ────────────────────────────────────────────────────────────────────

class MemoryMaintenanceScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;

  /**
   * 启动调度器:
   * 1. 自动禁用旧版 mem-distill cron job(若存在且启用)
   * 2. 若 dailyMaintenanceEnabled = true,计算距下次触发时间并注册 setTimeout
   */
  start(): void {
    const cfg = loadConfig();

    // ── 自动禁用旧版 mem-distill ────────────────────────────────────────────
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

  /** 停止调度器 */
  stop(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /** 立即手动触发一次(供 CLI memory maintain 调用) */
  async runNow(targetAgentId?: string): Promise<void> {
    if (targetAgentId) {
      await this.runOne(targetAgentId);
    } else {
      await this.runAll();
    }
  }

  // ── private ─────────────────────────────────────────────────────────────────

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
    // re-arm 明天同一时间
    this.arm(timeOfDay);
  }

  /** 对所有 agent 串行执行记忆维护 */
  private async runAll(): Promise<void> {
    const agents = agentManager.loadAll();
    console.log(`[memory-maintenance] Processing ${agents.length} agent(s): ${agents.map((a) => a.id).join(", ")}`);
    for (const agent of agents) {
      await this.runOne(agent.id);
    }
  }

  /** 对单个 agent 执行:Step1 全量索引重建 + Step2 diary→MEM.md + Step3 diary→ACTIVE.md */
  async runOne(agentId: string): Promise<void> {
    console.log(`[memory-maintenance] [${agentId}] Step 1: rebuilding memory index...`);
    try {
      const cfg = loadConfig();
      if (cfg.memory.enabled) {
        const result = await rebuildMemoryIndex(agentId);
        if (result) {
          console.log(
            `[memory-maintenance] [${agentId}] Index rebuilt: ` +
            `files=${result.update.indexed} chunks=${result.embed.chunksEmbedded}`
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
  }

  /**
   * 读取最近 diary 文件 + 当前 MEM.md,
   * 调用 summarizer LLM 提炼章节补丁,按章节 upsert 写入 MEM.md,
   * 再触发一次增量索引更新。
   */
  private async distillMem(agentId: string): Promise<string> {
    const memDir = path.join(os.homedir(), ".tinyclaw", "agents", agentId, "memory");
    const memPath = agentManager.memPath(agentId);

    const diaryContent = this.readRecentDiary(memDir, 2, 7);
    if (!diaryContent) {
      return "无近期日记,跳过提炼";
    }

    const currentMem = fs.existsSync(memPath)
      ? fs.readFileSync(memPath, "utf-8")
      : this.buildInitialDocument("持久记忆", MEM_SECTION_KEYS);

    const client = llmRegistry.get("summarizer");
    const userMessage =
      `## 近期日记内容\n\n${diaryContent.slice(0, 6000)}\n\n` +
      `## 当前 MEM.md 内容\n\n${currentMem.slice(0, 3000)}`;

    const result = await client.chat([
      { role: "system", content: DISTILL_MEM_SYSTEM },
      { role: "user", content: userMessage },
    ]);

    const patch = result.content.trim();
    if (!patch || patch === "无新增") {
      return "无新增";
    }

    const sectionPatches = this.parseSectionPatch(patch);
    if (sectionPatches.size === 0) {
      return "无新增";
    }

    let updatedMem = currentMem;
    let updatedCount = 0;
    for (const [sectionTitle, newLines] of sectionPatches) {
      if (!(MEM_SECTION_KEYS as readonly string[]).includes(sectionTitle)) {
        console.log(`[memory-maintenance] [${agentId}] 忽略非法 MEM 章节: ${sectionTitle}`);
        continue;
      }
      const nextMem = this.upsertSection(updatedMem, sectionTitle, newLines);
      if (nextMem !== updatedMem) updatedCount++;
      updatedMem = nextMem;
    }

    if (updatedCount === 0) {
      return "无新增";
    }

    fs.writeFileSync(memPath, updatedMem, "utf-8");

    const cfg = loadConfig();
    if (cfg.memory.enabled) {
      updateMemoryIndex(agentId).catch((err) => {
        console.error(`[memory-maintenance] [${agentId}] post-distill index update error:`, err);
      });
    }

    return `已更新 ${updatedCount} 个章节到 MEM.md`;
  }

  /**
   * 读取最近 diary 文件 + 当前 ACTIVE.md,
   * 调用 summarizer LLM 提炼章节补丁,按章节 upsert 写入 ACTIVE.md,
   * 再触发 active collection 索引更新。
   */
  private async distillActive(agentId: string): Promise<string> {
    const memDir = path.join(os.homedir(), ".tinyclaw", "agents", agentId, "memory");
    const activePath = agentManager.activePath(agentId);

    const diaryContent = this.readRecentDiary(memDir, 3, 14);
    if (!diaryContent) {
      return "无近期日记,跳过提炼";
    }

    const currentActive = fs.existsSync(activePath)
      ? fs.readFileSync(activePath, "utf-8")
      : this.buildInitialDocument("活跃上下文", ACTIVE_SECTION_KEYS);

    const client = llmRegistry.get("summarizer");
    const userMessage =
      `## 近期日记内容\n\n${diaryContent.slice(0, 7000)}\n\n` +
      `## 当前 ACTIVE.md 内容\n\n${currentActive.slice(0, 3000)}`;

    const result = await client.chat([
      { role: "system", content: DISTILL_ACTIVE_SYSTEM },
      { role: "user", content: userMessage },
    ]);

    const patch = result.content.trim();
    if (!patch || patch === "无新增") {
      return "无新增";
    }

    const sectionPatches = this.parseSectionPatch(patch);
    if (sectionPatches.size === 0) {
      return "无新增";
    }

    let updatedActive = currentActive;
    let updatedCount = 0;
    for (const [sectionTitle, newLines] of sectionPatches) {
      if (!(ACTIVE_SECTION_KEYS as readonly string[]).includes(sectionTitle)) {
        console.log(`[memory-maintenance] [${agentId}] 忽略非法 ACTIVE 章节: ${sectionTitle}`);
        continue;
      }
      const nextActive = this.replaceSection(updatedActive, sectionTitle, newLines);
      if (nextActive !== updatedActive) updatedCount++;
      updatedActive = nextActive;
    }

    if (updatedCount === 0) {
      return "无新增";
    }

    fs.writeFileSync(activePath, updatedActive, "utf-8");

    const cfg = loadConfig();
    if (cfg.memory.enabled) {
      updateStore("active", agentId).catch((err) => {
        console.error(`[memory-maintenance] [${agentId}] post-active index update error:`, err);
      });
    }

    return `已更新 ${updatedCount} 个章节到 ACTIVE.md`;
  }

  /**
   * 解析 LLM 输出的章节补丁文本,返回 Map<章节标题, 新条目行数组>。
   */
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

  /**
   * 在文档内容中找到指定章节,将 newLines 中不重复的条目追加到章节末尾。
   * 若章节不存在则在文件末尾新建该章节。
   * 若章节是 "📝 近期变更",超出 WORKLOG_MAX_LINES 时删除最旧的条目。
   */
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

    if (dedupedNewLines.length === 0) {
      return docContent;
    }

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

  /**
   * 用新条目替换章节内容,更适合 ACTIVE.md 这类短期动态上下文。
   */
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

  /**
   * 限制 "📝 近期变更" 章节的条目数,超出 WORKLOG_MAX_LINES 时删除最旧的条目。
   */
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
      if (lines[i]!.trim().startsWith("- ")) {
        bulletIndices.push(i);
      }
    }

    if (bulletIndices.length <= WORKLOG_MAX_LINES) {
      return memContent;
    }

    const toRemove = bulletIndices.length - WORKLOG_MAX_LINES;
    const removeSet = new Set(bulletIndices.slice(0, toRemove));
    return lines.filter((_, idx) => !removeSet.has(idx)).join("\n");
  }

  /**
   * 构建初始文档骨架(当文件不存在时使用)
   */
  private buildInitialDocument(title: string, sectionKeys: readonly string[]): string {
    const sections = sectionKeys
      .map((key) => `## ${key}\n`)
      .join("\n");
    return `# ${title}\n\n${sections}`;
  }

  /**
   * 读取最近 `daysToRead` 天(含今天)的 diary 文件内容,合并返回。
   * 若对应文件不存在则往前搜索,最多搜索 `maxLookback` 天。
   */
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

export const memoryMaintenance = new MemoryMaintenanceScheduler();
