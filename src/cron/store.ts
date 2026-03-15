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
const JOBS_DIR = path.join(CRON_DIR, "jobs");              // 每个 job 独立文件
const JOBS_FILE_LEGACY = path.join(CRON_DIR, "jobs.json"); // 旧格式，仅用于迁移
const LOGS_DIR = path.join(CRON_DIR, "logs");

function ensureDirs(): void {
  fs.mkdirSync(JOBS_DIR, { recursive: true });
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

function jobFilePath(id: string): string {
  return path.join(JOBS_DIR, `${id}.json`);
}

/** 迁移旧 jobs.json → jobs/<id>.json，完成后删除旧文件 */
function migrateIfNeeded(): void {
  if (!fs.existsSync(JOBS_FILE_LEGACY)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(JOBS_FILE_LEGACY, "utf-8")) as unknown;
    const parsed = CronJobsFileSchema.safeParse(raw);
    if (parsed.success) {
      fs.mkdirSync(JOBS_DIR, { recursive: true });
      for (const job of parsed.data.jobs) {
        const dest = jobFilePath(job.id);
        if (!fs.existsSync(dest)) {
          fs.writeFileSync(dest, JSON.stringify(job, null, 2), "utf-8");
        }
      }
      console.log(`[cron] 已迁移 ${parsed.data.jobs.length} 个 job 到 jobs/ 目录`);
    }
    fs.unlinkSync(JOBS_FILE_LEGACY);
  } catch (err) {
    console.error("[cron] jobs.json 迁移失败:", err);
  }
}

// ── 每 job 独立文件 CRUD ──────────────────────────────────────────────────────

/** 读取所有 job（自动完成旧 jobs.json 迁移） */
export function loadJobs(): CronJob[] {
  migrateIfNeeded();
  ensureDirs();
  const files = fs.readdirSync(JOBS_DIR).filter((f) => f.endsWith(".json"));
  const jobs: CronJob[] = [];
  for (const f of files) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(JOBS_DIR, f), "utf-8")) as unknown;
      const parsed = CronJobSchema.safeParse(raw);
      if (parsed.success) jobs.push(parsed.data);
      else console.error(`[cron] jobs/${f} 格式异常，跳过:`, parsed.error.message);
    } catch (err) {
      console.error(`[cron] jobs/${f} 读取失败:`, err);
    }
  }
  return jobs;
}

/** 添加新 job，返回添加后的 job（经 schema 校验） */
export function addJob(job: Omit<CronJob, "createdAt"> & { createdAt?: string }): CronJob {
  const validated = CronJobSchema.parse({
    ...job,
    createdAt: job.createdAt ?? new Date().toISOString(),
  });
  ensureDirs();
  fs.writeFileSync(jobFilePath(validated.id), JSON.stringify(validated, null, 2), "utf-8");
  return validated;
}

/** 删除指定 id 的 job，返回是否成功 */
export function removeJob(id: string): boolean {
  migrateIfNeeded();
  const fp = jobFilePath(id);
  if (!fs.existsSync(fp)) return false;
  try { fs.unlinkSync(fp); return true; } catch { return false; }
}

/** 更新 job 的部分字段 */
export function updateJob(id: string, patch: Partial<CronJob>): boolean {
  migrateIfNeeded();
  const fp = jobFilePath(id);
  if (!fs.existsSync(fp)) return false;
  try {
    const raw = JSON.parse(fs.readFileSync(fp, "utf-8")) as unknown;
    const existing = CronJobSchema.safeParse(raw);
    if (!existing.success) return false;
    const updated = CronJobSchema.parse({ ...existing.data, ...patch });
    fs.writeFileSync(fp, JSON.stringify(updated, null, 2), "utf-8");
    return true;
  } catch { return false; }
}

/** 获取单个 job（直接读取对应文件，无需加载全部） */
export function getJob(id: string): CronJob | undefined {
  migrateIfNeeded();
  const fp = jobFilePath(id);
  if (!fs.existsSync(fp)) return undefined;
  try {
    const raw = JSON.parse(fs.readFileSync(fp, "utf-8")) as unknown;
    const parsed = CronJobSchema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  } catch { return undefined; }
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
