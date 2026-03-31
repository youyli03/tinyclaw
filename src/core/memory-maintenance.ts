/**
 * 内置每日记忆维护调度器（MemoryMaintenanceScheduler）
 *
 * 进程启动时自动启动，每天指定时间（默认 04:00）对**所有 Agent** 分别串行执行：
 *   1. QMD 向量索引全量重建 —— 补全 exec_shell/write_file 直写文件未触发索引的盲区
 *   2. diary → MEM.md 增量知识提炼 —— 直接用 fs 读文件 + summarizer LLM，不经 exec_shell
 *
 * 每个 Agent 的索引完全隔离（各自独立 index.sqlite + QMDStore 实例），不会混串。
 *
 * 启动时若检测到旧版 mem-distill cron job 存在且启用，自动将其禁用（不删除文件）。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { loadConfig } from "../config/loader.js";
import { agentManager } from "./agent-manager.js";
import { rebuildMemoryIndex, updateMemoryIndex } from "../memory/qmd.js";
import { llmRegistry } from "../llm/registry.js";
import { updateJob, getJob } from "../cron/store.js";
import { cronScheduler } from "../cron/scheduler.js";

// ── MEM.md 固定章节定义 ───────────────────────────────────────────────────────
//
// 这些章节是 MEM.md 的骨架，distillMemory() 按章节 upsert 更新，不整体覆写。
// 章节顺序即文件顺序，名称必须与 MEM.md 中的 `## ` 标题完全一致。

const SECTION_KEYS = [
  "👤 用户偏好",       // 长期稳定：回复风格、操作习惯、禁忌
  "🎯 当前任务",       // 常更新：正在做什么、下一步是什么
  "🗂️ 常用技能与任务", // 中等稳定：已建立的 skill/cron，路径+用途
  "🐛 踩坑记录",       // 只增不删：错误原因+修复方法，避免重蹈
  "✅ 已完成大事",      // 里程碑级别的成果
  "📝 近期变更",       // Worklog：最近若干条，按日期，1行/条
] as const;

const WORKLOG_MAX_LINES = 20; // 近期变更最多保留条数，超出时删除最旧的

// ── 提炼 Prompt ───────────────────────────────────────────────────────────────

const DISTILL_SYSTEM = `你是一个记忆提炼助手。
你的任务是从近期的对话摘要日记（diary）中，将尚未记录在 MEM.md 中的有价值信息提炼出来，
并以"章节补丁"格式输出，方便程序按章节精确更新 MEM.md。

MEM.md 有以下固定章节（不得新增其他章节）：
- ## 👤 用户偏好       ← 长期稳定：回复风格、操作习惯
- ## 🎯 当前任务       ← 常更新：正在做什么、下一步，必须反映最新状态
- ## 🗂️ 常用技能与任务 ← 已建立的 skill/cron/脚本，路径+一句话说明
- ## 🐛 踩坑记录       ← 错误原因+修复方法，避免重蹈覆辙
- ## ✅ 已完成大事      ← 里程碑级成果（不写日常琐事）
- ## 📝 近期变更       ← Worklog，格式：- YYYY-MM-DD: 事件摘要

输出规则：
1. 输出格式为"章节补丁"：每个需要更新的章节输出一个块，格式如下：
   ## 章节名
   - 新条目1
   - 新条目2
2. 每个块只输出该章节中**需要新增**的条目，已有内容不重复输出
3. 若某章节无需更新，不输出该章节块
4. 若所有章节均无需更新，只输出 "无新增" 三个字
5. 只记录稳定知识：用户长期偏好、重要结论、已完成大事、常用工具路径
6. 不记录临时信息：一次性调试输出、临时文件路径、天气/股价等实时数据
7. 🎯 当前任务章节必须反映日记中最新的任务状态，若有变化务必更新
8. 📝 近期变更每条必须带 YYYY-MM-DD 日期前缀

直接输出补丁内容，不要输出任何前缀或说明文字。`;

// ── 时间工具 ──────────────────────────────────────────────────────────────────

/** 计算距今天（或明天）"HH:MM" 的 ms 数 */
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
   * 启动调度器：
   * 1. 自动禁用旧版 mem-distill cron job（若存在且启用）
   * 2. 若 dailyMaintenanceEnabled = true，计算距下次触发时间并注册 setTimeout
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
          "[memory-maintenance] 已自动禁用旧版 mem-distill cron job（由内置调度器接管）\n" +
          "[memory-maintenance] 如需恢复旧 job，可手动修改 ~/.tinyclaw/cron/jobs/mem-distill.json"
        );
      }
    }

    if (!cfg.memory.dailyMaintenanceEnabled) {
      console.log("[memory-maintenance] disabled（config.memory.dailyMaintenanceEnabled = false）");
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

  /** 立即手动触发一次（供 CLI memory maintain 调用） */
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

  /** 对单个 agent 执行：Step1 全量索引重建 + Step2 diary→MEM.md 提炼 */
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
      const result = await this.distillMemory(agentId);
      console.log(`[memory-maintenance] [${agentId}] Distill result: ${result}`);
    } catch (err) {
      console.error(`[memory-maintenance] [${agentId}] Distill error:`, err);
    }
  }

  /**
   * 读取最近 1-2 天的 diary 文件 + 当前 MEM.md，
   * 调用 summarizer LLM 提炼章节补丁，按章节 upsert 写入 MEM.md，
   * 再触发一次增量索引更新。
   * @returns 提炼结果摘要（"无新增" 或 "已更新 N 个章节"）
   */
  private async distillMemory(agentId: string): Promise<string> {
    const memDir = path.join(os.homedir(), ".tinyclaw", "agents", agentId, "memory");
    const memPath = path.join(os.homedir(), ".tinyclaw", "agents", agentId, "MEM.md");

    // ── 读取最近 diary 文件（最近 2 天，往前最多找 7 天） ─────────────────
    const diaryContent = this.readRecentDiary(memDir, 2, 7);
    if (!diaryContent) {
      return "无近期日记，跳过提炼";
    }

    // ── 读取当前 MEM.md ───────────────────────────────────────────────────
    const currentMem = fs.existsSync(memPath)
      ? fs.readFileSync(memPath, "utf-8")
      : this.buildInitialMem();

    // ── 调用 summarizer LLM ───────────────────────────────────────────────
    const client = llmRegistry.get("summarizer");
    const userMessage =
      `## 近期日记内容\n\n${diaryContent.slice(0, 6000)}\n\n` +
      `## 当前 MEM.md 内容\n\n${currentMem.slice(0, 3000)}`;

    const result = await client.chat([
      { role: "system", content: DISTILL_SYSTEM },
      { role: "user", content: userMessage },
    ]);

    const patch = result.content.trim();

    if (!patch || patch === "无新增") {
      return "无新增";
    }

    // ── 解析章节补丁并 upsert ──────────────────────────────────────────────
    const sectionPatches = this.parseSectionPatch(patch);
    if (sectionPatches.size === 0) {
      return "无新增";
    }

    let updatedMem = currentMem;
    let updatedCount = 0;
    for (const [sectionTitle, newLines] of sectionPatches) {
      // 只处理在 SECTION_KEYS 中的合法章节（安全过滤）
      if (!(SECTION_KEYS as readonly string[]).includes(sectionTitle)) {
        console.log(`[memory-maintenance] [${agentId}] 忽略非法章节: ${sectionTitle}`);
        continue;
      }
      updatedMem = this.upsertSection(updatedMem, sectionTitle, newLines);
      updatedCount++;
    }

    if (updatedCount === 0) {
      return "无新增";
    }

    // ── 写回 MEM.md ────────────────────────────────────────────────────────
    fs.writeFileSync(memPath, updatedMem, "utf-8");

    // ── 写入后触发增量索引更新 ────────────────────────────────────────────
    const cfg = loadConfig();
    if (cfg.memory.enabled) {
      updateMemoryIndex(agentId).catch((err) => {
        console.error(`[memory-maintenance] [${agentId}] post-distill index update error:`, err);
      });
    }

    return `已更新 ${updatedCount} 个章节到 MEM.md`;
  }

  /**
   * 解析 LLM 输出的章节补丁文本，返回 Map<章节标题, 新条目行数组>。
   *
   * 期望格式（可包含多个章节块）：
   * ```
   * ## 章节名A
   * - 条目1
   * - 条目2
   *
   * ## 章节名B
   * - 条目3
   * ```
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
   * 在 MEM.md 内容中找到指定章节，将 newLines 中不重复的条目追加到章节末尾。
   * 若章节不存在则在文件末尾新建该章节。
   * 若章节是 "📝 近期变更"，超出 WORKLOG_MAX_LINES 时删除最旧的条目。
   *
   * @returns 更新后的完整 MEM.md 内容
   */
  private upsertSection(memContent: string, sectionTitle: string, newLines: string[]): string {
    const lines = memContent.split("\n");
    const headerPattern = `## ${sectionTitle}`;

    // 找章节起始行
    const startIdx = lines.findIndex((l) => l.trim() === headerPattern);

    if (startIdx === -1) {
      // 章节不存在，追加到文件末尾
      const tail = memContent.endsWith("\n") ? "" : "\n";
      return memContent + `${tail}\n${headerPattern}\n${newLines.join("\n")}\n`;
    }

    // 找章节结束行（下一个 ## 标题的前一行，或文件末尾）
    let endIdx = lines.length;
    for (let i = startIdx + 1; i < lines.length; i++) {
      if (lines[i]!.startsWith("## ")) {
        endIdx = i;
        break;
      }
    }

    // 提取该章节已有的条目（去重用）
    const existingContent = lines.slice(startIdx + 1, endIdx).join("\n");

    // 过滤掉已存在的条目（简单字符串包含匹配）
    const dedupedNewLines = newLines.filter((nl) => {
      const normalized = nl.replace(/^-\s+/, "").trim().toLowerCase();
      return !existingContent.toLowerCase().includes(normalized);
    });

    if (dedupedNewLines.length === 0) {
      return memContent; // 无新内容，不修改
    }

    // 找章节内最后一个非空行的位置（在空行和下一章节之间插入）
    let insertIdx = endIdx;
    for (let i = endIdx - 1; i > startIdx; i--) {
      if (lines[i]!.trim() !== "") {
        insertIdx = i + 1;
        break;
      }
    }

    // 插入新条目
    const newContentLines = [...lines];
    newContentLines.splice(insertIdx, 0, ...dedupedNewLines);

    // 若是 Worklog 章节，限制最大行数
    if (sectionTitle === "📝 近期变更") {
      return this.trimWorklogSection(newContentLines.join("\n"), headerPattern);
    }

    return newContentLines.join("\n");
  }

  /**
   * 限制 "📝 近期变更" 章节的条目数，超出 WORKLOG_MAX_LINES 时删除最旧的条目。
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

    // 找出章节内的所有条目行
    const bulletIndices: number[] = [];
    for (let i = startIdx + 1; i < endIdx; i++) {
      if (lines[i]!.trim().startsWith("- ")) {
        bulletIndices.push(i);
      }
    }

    if (bulletIndices.length <= WORKLOG_MAX_LINES) {
      return memContent;
    }

    // 删除最旧的（最前面的）超出部分
    const toRemove = bulletIndices.length - WORKLOG_MAX_LINES;
    const removeSet = new Set(bulletIndices.slice(0, toRemove));
    return lines.filter((_, idx) => !removeSet.has(idx)).join("\n");
  }

  /**
   * 构建初始 MEM.md 骨架（当文件不存在时使用）
   */
  private buildInitialMem(): string {
    const sections = (SECTION_KEYS as readonly string[])
      .map((key) => `## ${key}\n`)
      .join("\n");
    return `# 持久记忆\n\n${sections}`;
  }

  /**
   * 读取最近 `daysToRead` 天（含今天）的 diary 文件内容，合并返回。
   * 若对应文件不存在则往前搜索，最多搜索 `maxLookback` 天。
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
