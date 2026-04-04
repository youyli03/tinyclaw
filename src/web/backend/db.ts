/**
 * Dashboard SQLite 数据库
 * 路径: ~/.tinyclaw/dashboard.db
 *
 * 表:
 *   metric_keys      — 已注册的指标白名单（/metric add 命令管理）
 *   metrics          — AI 通过 db_write tool 写入的业务时序数据
 *   system_snapshots — collector.ts 每 5 分钟自动采样的系统状态
 */

import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import type { Database } from "better-sqlite3";

const _require = createRequire(import.meta.url);

const DB_PATH = path.join(os.homedir(), ".tinyclaw", "dashboard.db");

let _db: Database | null = null;

function openDB(): Database {
  if (_db) return _db;

  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

  const BetterSqlite = _require("better-sqlite3") as new (path: string) => Database;
  const db = new BetterSqlite(DB_PATH);

  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS metric_keys (
      category    TEXT NOT NULL,
      key         TEXT NOT NULL,
      description TEXT,
      created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
      PRIMARY KEY (category, key)
    );

    CREATE TABLE IF NOT EXISTS metrics (
      id       INTEGER PRIMARY KEY AUTOINCREMENT,
      ts       INTEGER NOT NULL,
      category TEXT    NOT NULL,
      key      TEXT    NOT NULL,
      value    REAL    NOT NULL,
      note     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_metrics ON metrics(category, key, ts);

    CREATE TABLE IF NOT EXISTS system_snapshots (
      ts            INTEGER PRIMARY KEY,
      cpu_percent   REAL,
      mem_used_mb   INTEGER,
      mem_total_mb  INTEGER,
      disk_used_gb  REAL,
      disk_total_gb REAL
    );
  `);

  // 写入内置指标白名单（幂等）
  const builtins: Array<[string, string, string]> = [
    ["electric", "balance",       "电费余额（元）"],
    ["copilot",  "remaining",     "高级请求剩余次数"],
    ["copilot",  "rate_limit_remaining", "接口频率限制剩余次数"],
  ];
  const upsert = db.prepare(
    "INSERT OR IGNORE INTO metric_keys (category, key, description) VALUES (?, ?, ?)"
  );
  for (const [cat, k, desc] of builtins) upsert.run(cat, k, desc);

  _db = db;
  return db;
}

// ── 对外接口 ──────────────────────────────────────────────────────────────────

export interface MetricRow {
  id: number;
  ts: number;
  category: string;
  key: string;
  value: number;
  note: string | null;
}

export interface MetricKeyRow {
  category: string;
  key: string;
  description: string | null;
  created_at: number;
}

export interface SystemSnapshotRow {
  ts: number;
  cpu_percent: number;
  mem_used_mb: number;
  mem_total_mb: number;
  disk_used_gb: number;
  disk_total_gb: number;
}

// ── 指标白名单管理 ─────────────────────────────────────────────────────────────

/** 检查 category/key 是否已注册 */
export function isMetricKeyAllowed(category: string, key: string): boolean {
  const db = openDB();
  const row = db
    .prepare("SELECT 1 FROM metric_keys WHERE category = ? AND key = ?")
    .get(category, key);
  return !!row;
}

/** 注册一个新指标（/metric add 命令调用） */
export function addMetricKey(category: string, key: string, description?: string): void {
  const db = openDB();
  db.prepare(
    "INSERT OR REPLACE INTO metric_keys (category, key, description) VALUES (?, ?, ?)"
  ).run(category, key, description ?? null);
}

/** 删除一个指标注册（同时删除历史数据） */
export function removeMetricKey(category: string, key: string): { deleted: number } {
  const db = openDB();
  db.prepare("DELETE FROM metric_keys WHERE category = ? AND key = ?").run(category, key);
  const deleted = (db.prepare(
    "DELETE FROM metrics WHERE category = ? AND key = ?"
  ).run(category, key) as { changes: number }).changes;
  return { deleted };
}

/** 列出所有已注册的指标 */
export function listRegisteredKeys(): MetricKeyRow[] {
  const db = openDB();
  return db
    .prepare("SELECT category, key, description, created_at FROM metric_keys ORDER BY category, key")
    .all() as MetricKeyRow[];
}

// ── metrics 写入 / 查询 ────────────────────────────────────────────────────────

/**
 * 写入一条业务指标（AI 通过 db_write tool 调用）
 * category/key 必须已在 metric_keys 白名单中，否则抛出错误。
 */
export function insertMetric(opts: {
  category: string;
  key: string;
  value: number;
  note?: string;
  ts?: number;
}): void {
  const db = openDB();
  if (!isMetricKeyAllowed(opts.category, opts.key)) {
    throw new Error(
      `指标 "${opts.category}/${opts.key}" 未注册，请先用 /metric add ${opts.category}/${opts.key} 注册`
    );
  }
  const ts = opts.ts ?? Math.floor(Date.now() / 1000);
  db.prepare(
    "INSERT INTO metrics (ts, category, key, value, note) VALUES (?, ?, ?, ?, ?)"
  ).run(ts, opts.category, opts.key, opts.value, opts.note ?? null);
}

/** 查询某 category/key 的历史时序数据 */
export function queryMetrics(opts: {
  category: string;
  key: string;
  days: number;
}): MetricRow[] {
  const db = openDB();
  const since = Math.floor(Date.now() / 1000) - opts.days * 86400;
  return db
    .prepare(
      "SELECT id, ts, category, key, value, note FROM metrics WHERE category = ? AND key = ? AND ts >= ? ORDER BY ts ASC"
    )
    .all(opts.category, opts.key, since) as MetricRow[];
}

/** 查询所有已注册的 category/key（从白名单读，不从 metrics 读） */
export function listMetricKeys(): Array<{ category: string; key: string }> {
  return listRegisteredKeys().map(r => ({ category: r.category, key: r.key }));
}

// ── system_snapshots ──────────────────────────────────────────────────────────

/** 写入系统快照（collector.ts 调用） */
export function insertSnapshot(row: Omit<SystemSnapshotRow, "ts"> & { ts?: number }): void {
  const db = openDB();
  const ts = row.ts ?? Math.floor(Date.now() / 1000);
  db.prepare(`
    INSERT OR REPLACE INTO system_snapshots
      (ts, cpu_percent, mem_used_mb, mem_total_mb, disk_used_gb, disk_total_gb)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(ts, row.cpu_percent, row.mem_used_mb, row.mem_total_mb, row.disk_used_gb, row.disk_total_gb);
}

/** 查询最近 N 小时的系统快照 */
export function querySnapshots(hours = 24): SystemSnapshotRow[] {
  const db = openDB();
  const since = Math.floor(Date.now() / 1000) - hours * 3600;
  return db
    .prepare("SELECT * FROM system_snapshots WHERE ts >= ? ORDER BY ts ASC")
    .all(since) as SystemSnapshotRow[];
}

/** 获取最新一条系统快照 */
export function latestSnapshot(): SystemSnapshotRow | null {
  const db = openDB();
  const row = db.prepare("SELECT * FROM system_snapshots ORDER BY ts DESC LIMIT 1").get();
  return (row as SystemSnapshotRow | undefined) ?? null;
}
