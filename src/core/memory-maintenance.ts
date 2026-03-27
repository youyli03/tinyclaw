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

// ── 提炼 Prompt ───────────────────────────────────────────────────────────────

const DISTILL_SYSTEM = `你是一个记忆提炼助手。
你的任务是从近期的对话摘要日记（diary）中，将尚未记录在 MEM.md 中的有价值信息提炼出来。

提炼规则：
1. 只追加增量：已在 MEM.md 中记录的信息不重复提炼
2. 只记录稳定知识：用户的长期偏好、重要结论、已完成的重大任务、常用工具/技能路径
3. 不记录临时信息：一次性调试输出、临时文件路径、当天的天气/股价等实时数据
4. 格式：简洁的 Markdown 列表项（以 "- " 开头），每条不超过 2 行
5. 若日记中没有值得提炼的新信息，只输出 "无新增" 这三个字，不输出任何其他内容

直接输出提炼结果，不要输出"以下是提炼内容："等前缀。`;

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
   * 调用 summarizer LLM 提炼增量知识，追加写入 MEM.md，
   * 再触发一次增量索引更新。
   * @returns 提炼结果摘要（"无新增" 或 "已追加 N 条"）
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
      : "（MEM.md 尚不存在）";

    // ── 调用 summarizer LLM ───────────────────────────────────────────────
    const client = llmRegistry.get("summarizer");
    const userMessage =
      `## 近期日记内容\n\n${diaryContent.slice(0, 6000)}\n\n` +
      `## 当前 MEM.md 内容\n\n${currentMem.slice(0, 3000)}`;

    const result = await client.chat([
      { role: "system", content: DISTILL_SYSTEM },
      { role: "user", content: userMessage },
    ]);

    const extracted = result.content.trim();

    if (!extracted || extracted === "无新增") {
      return "无新增";
    }

    // ── 追加写入 MEM.md ───────────────────────────────────────────────────
    // MEM.md 超过 80 行时，先删除 3 个月前的旧条目
    const existingLines = currentMem.split("\n");
    let memToWrite = currentMem;
    if (existingLines.length > 80) {
      memToWrite = this.pruneOldEntries(currentMem);
    }

    const today = new Date().toISOString().slice(0, 10);
    const appendChunk = `\n\n<!-- ${today} 自动提炼 -->\n${extracted}\n`;

    if (fs.existsSync(memPath)) {
      fs.appendFileSync(memPath, appendChunk, "utf-8");
    } else {
      fs.writeFileSync(memPath, `# 持久记忆\n${appendChunk}`, "utf-8");
    }
    void memToWrite; // pruneOldEntries 结果仅在内容变化时使用（简化：仅追加）

    // ── 追加后触发增量索引更新 ────────────────────────────────────────────
    const cfg = loadConfig();
    if (cfg.memory.enabled) {
      updateMemoryIndex(agentId).catch((err) => {
        console.error(`[memory-maintenance] [${agentId}] post-distill index update error:`, err);
      });
    }

    const newLines = extracted.split("\n").filter((l) => l.startsWith("- ")).length;
    return `已追加 ${newLines > 0 ? newLines : "若干"} 条新知识到 MEM.md`;
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

  /**
   * 删除 MEM.md 中 3 个月前（90 天）的旧条目（以 "<!-- YYYY-MM-DD" 注释为分隔标记）。
   * 若无法识别日期标记，返回原内容不变。
   */
  private pruneOldEntries(content: string): string {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 90);
    const cutoffStr = cutoff.toISOString().slice(0, 10);

    // 按 <!-- YYYY-MM-DD 注释行分段，删除过期段落
    const lines = content.split("\n");
    const result: string[] = [];
    let skipSection = false;

    for (const line of lines) {
      const dateMatch = line.match(/<!--\s*(\d{4}-\d{2}-\d{2})/);
      if (dateMatch) {
        skipSection = dateMatch[1]! < cutoffStr;
      }
      if (!skipSection) result.push(line);
    }

    return result.join("\n");
  }
}

export const memoryMaintenance = new MemoryMaintenanceScheduler();
