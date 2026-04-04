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

// ── 磁盘（读 /proc/mounts + statvfs 替代：用 df 输出）────────────────────────

interface DiskInfo {
  used_gb: number;
  total_gb: number;
}

function getDiskInfo(): DiskInfo {
  try {
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    const out = execSync("df -k /", { encoding: "utf-8", timeout: 3000 });
    // Filesystem  1K-blocks  Used  Available  Use%  Mounted
    const line = out.split("\n")[1] ?? "";
    const parts = line.trim().split(/\s+/);
    const total = parseInt(parts[1] ?? "0", 10);
    const used = parseInt(parts[2] ?? "0", 10);
    return {
      used_gb: Math.round((used / 1024 / 1024) * 10) / 10,
      total_gb: Math.round((total / 1024 / 1024) * 10) / 10,
    };
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

export async function sampleStats(): Promise<SystemStats> {
  const [cpu, mem, disk] = await Promise.all([
    getCpuPercent(),
    Promise.resolve(getMemInfo()),
    Promise.resolve(getDiskInfo()),
  ]);
  return {
    cpu_percent: cpu,
    mem_used_mb: mem.used_mb,
    mem_total_mb: mem.total_mb,
    disk_used_gb: disk.used_gb,
    disk_total_gb: disk.total_gb,
  };
}

// ── 定时采样器（每 5 分钟写 DB）──────────────────────────────────────────────

let _timer: NodeJS.Timeout | null = null;

export function startCollector(): void {
  if (_timer) return;

  async function run() {
    try {
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
