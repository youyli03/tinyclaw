/**
 * Cron job 持久化存储
 * - jobs:  ~/.tinyclaw/cron/jobs.json
 * - logs:  ~/.tinyclaw/cron/logs/<jobId>.jsonl
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { CronJobSchema, CronJobsFileSchema, type CronJob } from "./schema.js";

// ── 路径工具 ──────────────────────────────────────────────────────────────────

const CRON_DIR = path.join(os.homedir(), ".tinyclaw", "cron");
const JOBS_FILE = path.join(CRON_DIR, "jobs.json");
const LOGS_DIR = path.join(CRON_DIR, "logs");

function ensureDirs(): void {
  fs.mkdirSync(CRON_DIR, { recursive: true });
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

// ── jobs.json CRUD ────────────────────────────────────────────────────────────

/** 读取所有 job（文件不存在时返回空数组） */
export function loadJobs(): CronJob[] {
  if (!fs.existsSync(JOBS_FILE)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(JOBS_FILE, "utf-8")) as unknown;
    const parsed = CronJobsFileSchema.safeParse(raw);
    if (!parsed.success) {
      console.error("[cron] jobs.json 格式异常，跳过加载:", parsed.error.message);
      return [];
    }
    return parsed.data.jobs;
  } catch (err) {
    console.error("[cron] jobs.json 读取失败:", err);
    return [];
  }
}

/** 保存 jobs 列表到 jobs.json */
export function saveJobs(jobs: CronJob[]): void {
  ensureDirs();
  fs.writeFileSync(JOBS_FILE, JSON.stringify({ version: 1, jobs }, null, 2), "utf-8");
}

/** 添加新 job，返回添加后的 job（经 schema 校验） */
export function addJob(job: Omit<CronJob, "createdAt"> & { createdAt?: string }): CronJob {
  const validated = CronJobSchema.parse({
    ...job,
    createdAt: job.createdAt ?? new Date().toISOString(),
  });
  const jobs = loadJobs();
  jobs.push(validated);
  saveJobs(jobs);
  return validated;
}

/** 删除指定 id 的 job，返回是否成功 */
export function removeJob(id: string): boolean {
  const jobs = loadJobs();
  const idx = jobs.findIndex((j) => j.id === id);
  if (idx === -1) return false;
  jobs.splice(idx, 1);
  saveJobs(jobs);
  return true;
}

/** 更新 job 的部分字段 */
export function updateJob(id: string, patch: Partial<CronJob>): boolean {
  const jobs = loadJobs();
  const idx = jobs.findIndex((j) => j.id === id);
  if (idx === -1) return false;
  jobs[idx] = CronJobSchema.parse({ ...jobs[idx], ...patch });
  saveJobs(jobs);
  return true;
}

/** 获取单个 job */
export function getJob(id: string): CronJob | undefined {
  return loadJobs().find((j) => j.id === id);
}

// ── 日志 CRUD ─────────────────────────────────────────────────────────────────

export interface CronLogEntry {
  ts: string;
  status: "success" | "error";
  result: string;
  jobId: string;
}

/** 追加一条运行日志到 ~/.tinyclaw/cron/logs/<jobId>.jsonl */
export function appendLog(entry: CronLogEntry): void {
  ensureDirs();
  const file = path.join(LOGS_DIR, `${entry.jobId}.jsonl`);
  fs.appendFileSync(file, JSON.stringify(entry) + "\n", "utf-8");
}

/** 读取最近 n 条日志（默认 20） */
export function readLogs(jobId: string, n = 20): CronLogEntry[] {
  const file = path.join(LOGS_DIR, `${jobId}.jsonl`);
  if (!fs.existsSync(file)) return [];
  try {
    const lines = fs.readFileSync(file, "utf-8").split("\n").filter(Boolean);
    const entries = lines
      .map((l) => {
        try { return JSON.parse(l) as CronLogEntry; } catch { return null; }
      })
      .filter((e): e is CronLogEntry => e !== null);
    return entries.slice(-n);
  } catch {
    return [];
  }
}
