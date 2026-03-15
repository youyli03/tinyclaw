/**
 * Cron 调度器
 *
 * 负责在进程启动时加载所有 enabled jobs，注册对应 timer，
 * 并在 stop() 时清理所有 timer。
 *
 * 调度策略：
 *   once  — setTimeout(msUntilRunAt)；触发后自动从 jobs.json 删除
 *   every — setInterval(intervalSecs * 1000)；启动时若上次运行已过期则立即补跑一次
 *   daily — setTimeout(msUntilNextHH:MM) + 触发后重新 arm 明日同一时间
 */

import { loadJobs, removeJob } from "./store.js";
import { runJob } from "./runner.js";
import type { CronJob } from "./schema.js";
import type { Connector } from "../connectors/base.js";

// ── 时间工具 ──────────────────────────────────────────────────────────────────

/** 距今 ms 数（负数=已过期） */
function msUntil(iso: string): number {
  return new Date(iso).getTime() - Date.now();
}

/** 计算今天（或明天）"HH:MM" 的下次触发时间距今 ms */
function msUntilTimeOfDay(timeOfDay: string): number {
  const [hh, mm] = timeOfDay.split(":").map(Number);
  const now = new Date();
  const next = new Date(now);
  next.setHours(hh!, mm!, 0, 0);
  if (next.getTime() <= now.getTime()) {
    // 已过，定到明天
    next.setDate(next.getDate() + 1);
  }
  return next.getTime() - now.getTime();
}

// ── 调度器 ────────────────────────────────────────────────────────────────────

class CronScheduler {
  private connector: Connector | null = null;
  /** jobId → timer handle */
  private timers = new Map<string, ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>>();

  async start(connector: Connector): Promise<void> {
    this.connector = connector;
    const jobs = loadJobs();
    for (const job of jobs) {
      if (job.enabled) this.scheduleJob(job);
    }
    console.log(`[cron] Scheduler started (${jobs.filter((j) => j.enabled).length} active jobs)`);
  }

  stop(): void {
    for (const handle of this.timers.values()) {
      clearTimeout(handle as ReturnType<typeof setTimeout>);
      clearInterval(handle as ReturnType<typeof setInterval>);
    }
    this.timers.clear();
    console.log("[cron] Scheduler stopped");
  }

  /** 取消并重新调度单个 job（add/enable/remove 后调用） */
  reschedule(jobId: string): void {
    // 先取消旧 timer
    const old = this.timers.get(jobId);
    if (old !== undefined) {
      clearTimeout(old as ReturnType<typeof setTimeout>);
      clearInterval(old as ReturnType<typeof setInterval>);
      this.timers.delete(jobId);
    }
    // 重新从 store 读取（可能已更新或删除）
    const jobs = loadJobs();
    const job = jobs.find((j) => j.id === jobId);
    if (job?.enabled) this.scheduleJob(job);
  }

  // ── 内部调度逻辑 ──────────────────────────────────────────────────────────

  private scheduleJob(job: CronJob): void {
    switch (job.type) {
      case "once":  return this.scheduleOnce(job);
      case "every": return this.scheduleEvery(job);
      case "daily": return this.scheduleDaily(job);
    }
  }

  private scheduleOnce(job: CronJob): void {
    if (!job.runAt) return;
    const ms = msUntil(job.runAt);
    if (ms < 0) {
      // 已过期，静默忽略（重启时不补跑 once）
      return;
    }
    const handle = setTimeout(() => {
      this.timers.delete(job.id);
      void this.fire(job).then(() => removeJob(job.id));
    }, ms);
    this.timers.set(job.id, handle);
  }

  private scheduleEvery(job: CronJob): void {
    if (!job.intervalSecs) return;
    const intervalMs = job.intervalSecs * 1000;

    // 补跑检查：若 lastRunAt + interval < now，立即运行一次
    if (job.lastRunAt) {
      const elapsed = Date.now() - new Date(job.lastRunAt).getTime();
      if (elapsed >= intervalMs) {
        void this.fire(job);
      }
    }

    const handle = setInterval(() => void this.fire(job), intervalMs);
    this.timers.set(job.id, handle);
  }

  private scheduleDaily(job: CronJob): void {
    if (!job.timeOfDay) return;
    const ms = msUntilTimeOfDay(job.timeOfDay);
    const arm = () => {
      void this.fire(job).then(() => {
        // 触发后 arm 明日
        const handle = setTimeout(() => arm(), msUntilTimeOfDay(job.timeOfDay!));
        this.timers.set(job.id, handle);
      });
    };
    const handle = setTimeout(arm, ms);
    this.timers.set(job.id, handle);
  }

  private async fire(job: CronJob): Promise<void> {
    const ts = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    console.log(`[${ts}] [cron] Firing job: ${job.id} (${job.type}) — "${job.message.slice(0, 40)}"`);
    try {
      await runJob(job, this.connector);
    } catch (err) {
      console.error(`[cron] Job ${job.id} failed:`, err);
    }
  }
}

/** 全局调度器单例 */
export const cronScheduler = new CronScheduler();
