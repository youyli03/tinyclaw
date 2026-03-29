/**
 * LoopRunner — Loop Session 持续执行引擎
 *
 * Loop session 本质上是一个普通 session，tick 时把 TASK.md 的内容当作一条
 * 用户消息，通过 loopTick 回调（main.ts 提供）走完整的 runAgent 路径。
 *
 * 间隔语义：上次 runAgent **结束后**等待 tickSeconds，再开始下一次（串行 delay）。
 * 与 setInterval 不同，不会因执行时间过长而叠加触发。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { agentManager } from "./agent-manager.js";
import type { LoopSessionConfig } from "./agent-manager.js";

/** main.ts 提供的 tick 回调：将 taskContent 作为用户消息注入指定 session */
export type LoopTickFn = (sessionId: string, content: string) => Promise<void>;

// ── LoopRunner ────────────────────────────────────────────────────────────────

class LoopRunner {
  private loopTick: LoopTickFn | null = null;
  /** sessionId → abort flag（stop() 时设为 true，让循环退出） */
  private stopped = new Set<string>();
  /** 正在执行 tick 的 sessionId 集合（并发保护：triggerNow 时如已在跑则跳过） */
  private running = new Set<string>();

  async start(loopTick: LoopTickFn): Promise<void> {
    this.loopTick = loopTick;
    this.stopped.clear();
    const loops = agentManager.listSessionLoops();
    let count = 0;
    for (const { sessionId, cfg } of loops) {
      this.scheduleSession(sessionId, cfg);
      count++;
    }
    console.log(`[loop] LoopRunner started (${count} active loop sessions)`);
  }

  stop(): void {
    // 标记所有 session 停止，下次循环自然退出
    const loops = agentManager.listSessionLoops();
    for (const { sessionId } of loops) {
      this.stopped.add(sessionId);
    }
    this.loopTick = null;
    console.log("[loop] LoopRunner stopped");
  }

  /** 重新调度单个 session 的 loop（改配置后调用） */
  restartSession(sessionId: string): void {
    // 停掉旧循环
    this.stopped.add(sessionId);

    const cfg = agentManager.readSessionLoop(sessionId);
    if (cfg && this.loopTick) {
      // 移除停止标记，启动新循环
      this.stopped.delete(sessionId);
      this.scheduleSession(sessionId, cfg);
      console.log(`[loop] session=${sessionId} 已重新调度（tickSeconds=${cfg.tickSeconds}）`);
    } else {
      console.log(`[loop] session=${sessionId} loop 已停用或配置不存在`);
    }
  }

  /** 立即触发一次 tick（不影响定时计划；若已在运行则跳过） */
  triggerNow(sessionId: string): boolean {
    const cfg = agentManager.readSessionLoop(sessionId);
    if (!cfg || !this.loopTick) return false;
    if (this.running.has(sessionId)) {
      console.log(`[loop] session=${sessionId} triggerNow 跳过（当前 tick 仍在执行）`);
      return true; // 配置存在，只是跳过本次
    }
    void this.tick(sessionId, cfg);
    return true;
  }

  private scheduleSession(sessionId: string, cfg: LoopSessionConfig): void {
    console.log(`[loop] session=${sessionId} 已启动（每 ${cfg.tickSeconds}s tick）`);
    // 启动串行循环（不立即执行第一次，等待第一个 delay 后再触发）
    void this.loop(sessionId, cfg);
  }

  /** 串行循环：执行一次 tick → 等待 delay → 再执行，直到 stopped */
  private async loop(sessionId: string, cfg: LoopSessionConfig): Promise<void> {
    while (!this.stopped.has(sessionId) && this.loopTick) {
      // 等待间隔（首次也等，避免服务启动时立即全部触发）
      await delay(cfg.tickSeconds * 1000);

      if (this.stopped.has(sessionId) || !this.loopTick) break;

      // 重新读取配置（支持动态修改 tickSeconds/taskFile）
      const latestCfg = agentManager.readSessionLoop(sessionId);
      if (!latestCfg) {
        console.log(`[loop] session=${sessionId} loop 配置已移除，退出循环`);
        break;
      }

      await this.tick(sessionId, latestCfg);
    }
  }

  private async tick(sessionId: string, cfg: LoopSessionConfig): Promise<void> {
    if (this.running.has(sessionId)) {
      console.log(`[loop] session=${sessionId} tick 跳过（上次仍在执行）`);
      return;
    }
    if (!this.loopTick) return;

    // 读取任务文件（绝对路径，或相对于 agentDir 的路径）
    const taskFilePath = path.isAbsolute(cfg.taskFile)
      ? cfg.taskFile
      : path.join(agentManager.agentDir(cfg.agentId), cfg.taskFile);

    if (!fs.existsSync(taskFilePath)) {
      console.warn(`[loop] session=${sessionId} 任务文件不存在：${taskFilePath}，跳过本次 tick`);
      return;
    }
    let taskContent: string;
    try {
      taskContent = fs.readFileSync(taskFilePath, "utf-8").trim();
    } catch (err) {
      console.error(`[loop] session=${sessionId} 读取任务文件失败：`, err);
      return;
    }
    if (!taskContent) {
      console.warn(`[loop] session=${sessionId} 任务文件为空，跳过本次 tick`);
      return;
    }

    this.running.add(sessionId);
    try {
      await this.loopTick(sessionId, taskContent);
    } catch (err) {
      console.error(`[loop] session=${sessionId} tick 执行失败：`, err);
    } finally {
      this.running.delete(sessionId);
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const loopRunner = new LoopRunner();
