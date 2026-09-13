/**
 * 系统状态采样器
 * 每 5 分钟读取 /proc，写入 system_snapshots 表
 */

import * as fs from "node:fs";
import * as os from "node:os";
import { insertSnapshot } from "./db.js";

// ── CPU 采样（两次读取差值）────────────────────────────────────────────────────

interface CpuStat {
  idle: number;
  total: number;
}

function readCpuStat(): CpuStat {
  try {
    const line = fs.readFileSync("/proc/stat", "utf-8").split("\n")[0] ?? "";
    const parts = line.split(/\s+/).slice(1).map(Number);
    // user nice system idle iowait irq softirq steal guest guest_nice
    const idle = (parts[3] ?? 0) + (parts[4] ?? 0); // idle + iowait
    const total = parts.reduce((a, b) => a + b, 0);
    return { idle, total };
  } catch {
    return { idle: 0, total: 1 };
  }
}

async function getCpuPercent(): Promise<number> {
  const a = readCpuStat();
  await new Promise((r) => setTimeout(r, 500));
  const b = readCpuStat();
  const dTotal = b.total - a.total;
  const dIdle = b.idle - a.idle;
  if (dTotal === 0) return 0;
  return Math.round(((dTotal - dIdle) / dTotal) * 1000) / 10;
}

// ── 内存（读 /proc/meminfo）───────────────────────────────────────────────────

interface MemInfo {
  used_mb: number;
  total_mb: number;
}

function getMemInfo(): MemInfo {
  try {
    const text = fs.readFileSync("/proc/meminfo", "utf-8");
    const get = (key: string): number => {
      const m = text.match(new RegExp(`^${key}:\\s+(\\d+)`, "m"));
      return m ? parseInt(m[1]!, 10) : 0;
    };
    const total = get("MemTotal");
    const free = get("MemFree");
    const buffers = get("Buffers");
    const cached = get("Cached");
    const sReclaimable = get("SReclaimable");
    const used = total - free - buffers - cached - sReclaimable;
    return {
      used_mb: Math.round(used / 1024),
      total_mb: Math.round(total / 1024),
    };
  } catch {
    // 非 Linux 降级用 os 模块
    const total = os.totalmem();
    const free = os.freemem();
    return {
      used_mb: Math.round((total - free) / 1024 / 1024),
      total_mb: Math.round(total / 1024 / 1024),
    };
  }
}

// ── 磁盘（statfs 系统调用，不再 fork `df`）──────────────────────────────────
//
// 原来是 `execSync("df -k /")`：每次 Dashboard 请求都 fork 一个进程（实测整个
// /api/stats 要 500ms+）。`fs.statfsSync` 是同步系统调用，微秒级、零进程开销。

interface DiskInfo {
  used_gb: number;
  total_gb: number;
}

function getDiskInfo(): DiskInfo {
  try {
    const st = fs.statfsSync("/");
    const totalBytes = st.blocks * st.bsize;
    // 与 `df` 的 "Used" 口径一致：总块 − 全部空闲块（bfree），不是 bavail（非 root 可用）
    const usedBytes = (st.blocks - st.bfree) * st.bsize;
    const gb = (bytes: number): number => Math.round((bytes / 1024 / 1024 / 1024) * 10) / 10;
    return { used_gb: gb(usedBytes), total_gb: gb(totalBytes) };
  } catch {
    return { used_gb: 0, total_gb: 0 };
  }
}

// ── 导出：单次采样 ─────────────────────────────────────────────────────────────

export interface SystemStats {
  cpu_percent: number;
  mem_used_mb: number;
  mem_total_mb: number;
  disk_used_gb: number;
  disk_total_gb: number;
}

/**
 * 采样缓存 TTL（毫秒）。
 * CPU% 需要两次读数取差值（默认间隔 500ms），`/api/stats` 又是被**轮询**的接口：
 * 多开几个标签页就会并发触发多次采样。缓存 + single-flight 让同一瞬间的请求共用一次采样。
 * 5s 对"实时状态"完全够用（系统快照本来就是每 5 分钟入库一次）。
 */
const STATS_TTL_MS = 5000;
let _statsCache: { at: number; stats: SystemStats } | null = null;
let _statsInflight: Promise<SystemStats> | null = null;

/** 丢弃缓存（采样器写快照前可用，保证入库的是新值） */
export function invalidateStatsCache(): void {
  _statsCache = null;
}

export async function sampleStats(): Promise<SystemStats> {
  const now = Date.now();
  if (_statsCache && now - _statsCache.at < STATS_TTL_MS) return _statsCache.stats;
  // single-flight：同一瞬间的并发请求共享同一次采样
  if (_statsInflight) return _statsInflight;

  _statsInflight = (async (): Promise<SystemStats> => {
    const [cpu, mem, disk] = await Promise.all([
      getCpuPercent(),
      Promise.resolve(getMemInfo()),
      Promise.resolve(getDiskInfo()),
    ]);
    const stats: SystemStats = {
      cpu_percent: cpu,
      mem_used_mb: mem.used_mb,
      mem_total_mb: mem.total_mb,
      disk_used_gb: disk.used_gb,
      disk_total_gb: disk.total_gb,
    };
    _statsCache = { at: Date.now(), stats };
    return stats;
  })().finally(() => {
    _statsInflight = null;
  });

  return _statsInflight;
}

// ── 定时采样器（每 5 分钟写 DB）──────────────────────────────────────────────

let _timer: NodeJS.Timeout | null = null;

export function startCollector(): void {
  if (_timer) return;

  async function run() {
    try {
      // 入库的是"当前状态快照"：绕开 /api/stats 的 5s 缓存，保证写进 DB 的是新采样
      invalidateStatsCache();
      const stats = await sampleStats();
      insertSnapshot(stats);
    } catch (err) {
      console.error("[collector] 采样失败:", err);
    }
  }

  // 立即采样一次
  void run();
  // 之后每 5 分钟
  _timer = setInterval(() => void run(), 5 * 60 * 1000);
  console.log("[collector] 系统状态采样器已启动（每5分钟）");
}

export function stopCollector(): void {
  if (_timer) {
    clearInterval(_timer);
    _timer = null;
  }
}
