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
import type { CronJob } from "./schema.js";
import type { Connector } from "../connectors/base.js";
import { spawn, type ChildProcess } from "node:child_process";
import type { CronWorkerResponse } from "./worker-protocol.js";

const CRON_WORKER_SCRIPT = new URL("./worker.ts", import.meta.url).pathname;

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
  /** 正在执行的 jobId 集合（并发保护：同一 job 不允许多个实例同时运行） */
  private running = new Set<string>();
  /** 长驻 cron runtime 子进程 */
  private worker: ChildProcess | null = null;
  /** worker 启动中的 Promise，避免并发重复拉起 */
  private workerReady: Promise<void> | null = null;
  private nextRequestId = 0;
  private pendingRuns = new Map<string, { resolve: () => void; reject: (err: Error) => void }>();

  async start(connector: Connector | null): Promise<void> {
    this.connector = connector;
    await this.ensureWorker();
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
    for (const { reject } of this.pendingRuns.values()) {
      reject(new Error("cron runtime stopped"));
    }
    this.pendingRuns.clear();
    if (this.worker) {
      this.worker.kill("SIGTERM");
      this.worker = null;
    }
    this.workerReady = null;
    console.log("[cron] Scheduler stopped");
  }

  /** 主动触发一次 job（fire-and-forget，不影响定时计划） */
  triggerJob(jobId: string): boolean {
    const jobs = loadJobs();
    const job = jobs.find((j) => j.id === jobId);
    if (!job) return false;
    void this.fire(job);
    return true;
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
    if (this.running.has(job.id)) {
      const ts = new Date().toLocaleTimeString("zh-CN", { hour12: false });
      console.warn(`[${ts}] [cron] Job ${job.id} skipped: previous run still in progress`);
      return;
    }
    const ts = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    console.log(`[${ts}] [cron] Firing job: ${job.id} (${job.type}) — "${job.message.slice(0, 40)}"`);
    this.running.add(job.id);
    try {
      await this.runInWorker(job.id);
    } catch (err) {
      console.error(`[cron] Job ${job.id} failed:`, err);
    } finally {
      this.running.delete(job.id);
    }
  }

  private async runInWorker(jobId: string): Promise<void> {
    await this.ensureWorker();
    const requestId = `req_${++this.nextRequestId}_${Date.now()}`;
    await new Promise<void>((resolve, reject) => {
      this.pendingRuns.set(requestId, { resolve, reject });
      if (!this.worker?.send) {
        this.pendingRuns.delete(requestId);
        reject(new Error("cron runtime IPC channel unavailable"));
        return;
      }
      this.worker.send({ type: "run", requestId, jobId }, (err) => {
        if (!err) return;
        this.pendingRuns.delete(requestId);
        reject(err);
      });
    });
  }

  private async ensureWorker(): Promise<void> {
    if (this.worker && this.worker.connected) return;
    if (this.workerReady) return this.workerReady;

    this.workerReady = new Promise<void>((resolve, reject) => {
      const child = spawn("node", ["--import", "tsx/esm", CRON_WORKER_SCRIPT], {
        stdio: ["ignore", "inherit", "inherit", "ipc"],
        env: process.env,
        cwd: new URL("../../", import.meta.url).pathname,
      });
      this.worker = child;
      let ready = false;

      const failPending = (message: string) => {
        for (const [requestId, pending] of this.pendingRuns) {
          pending.reject(new Error(message));
          this.pendingRuns.delete(requestId);
        }
      };

      child.on("message", (msg: CronWorkerResponse) => {
        if (!msg || typeof msg !== "object") return;
        if (msg.type === "ready") {
          ready = true;
          console.log("[cron] Persistent runtime ready");
          resolve();
          return;
        }
        if (msg.type === "job_done") {
          const pending = this.pendingRuns.get(msg.requestId);
          if (!pending) return;
          this.pendingRuns.delete(msg.requestId);
          pending.resolve();
          return;
        }
        if (msg.type === "job_error") {
          const pending = this.pendingRuns.get(msg.requestId);
          if (!pending) return;
          this.pendingRuns.delete(msg.requestId);
          pending.reject(new Error(msg.message));
        }
      });

      child.on("error", (err) => {
        this.worker = null;
        this.workerReady = null;
        failPending(`cron runtime error: ${err.message}`);
        if (!ready) reject(err);
      });

      child.on("exit", (code, signal) => {
        this.worker = null;
        this.workerReady = null;
        failPending(`cron runtime exited (code=${code ?? "null"}, signal=${signal ?? "null"})`);
        if (!ready) {
          reject(new Error(`cron runtime exited before ready (code=${code ?? "null"}, signal=${signal ?? "null"})`));
        }
      });
    });

    return this.workerReady;
  }
}

/** 全局调度器单例 */
export const cronScheduler = new CronScheduler();
