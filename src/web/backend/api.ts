/**
 * Dashboard API 路由
 *
 * GET /api/stats   — 实时系统状态（CPU/内存/磁盘，不过 DB）+ Cron 活跃数
 * GET /api/metrics — 历史时序数据（?category=&key=&days=）
 * GET /api/metric-keys — 所有可用的 category/key 列表
 * GET /api/cron    — Cron job 列表 + 最近 5 条日志
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import * as fs from "node:fs";
import * as nodePath from "node:path";
import * as os from "node:os";
import { execSync } from "node:child_process";
import { sampleStats } from "./collector.js";
import { queryMetrics, querySnapshots, listMetricKeys } from "./db.js";
import { loadJobs, readLogs } from "../../cron/store.js";

// ── Notes 工具 ────────────────────────────────────────────────────────────────
const NOTES_ROOT = nodePath.join(os.homedir(), ".tinyclaw", "notes");

interface TreeNode {
  name: string;
  path: string;     // 相对于 NOTES_ROOT 的路径
  type: "dir" | "file";
  ext?: string;
  count?: number;   // 目录：含子目录的总文件数
  children?: TreeNode[];
}

function buildTree(absDir: string, relBase: string): TreeNode[] {
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(absDir, { withFileTypes: true }); }
  catch { return []; }
  const result: TreeNode[] = [];
  for (const e of entries) {
    // 跳过隐藏目录/文件（如 .obsidian、.git）
    if (e.name.startsWith(".")) continue;
    const relPath = relBase ? `${relBase}/${e.name}` : e.name;
    const resolvedIsDir = e.isDirectory() || (e.isSymbolicLink() && (() => { try { return fs.statSync(nodePath.join(absDir, e.name)).isDirectory(); } catch { return false; } })());
    if (resolvedIsDir) {
      const children = buildTree(nodePath.join(absDir, e.name), relPath);
      const count = countFiles(children);
      result.push({ name: e.name, path: relPath, type: "dir", count, children });
    } else if (e.isFile() || e.isSymbolicLink()) {
      const ext = nodePath.extname(e.name).toLowerCase();
      if ([".md", ".pdf", ".txt"].includes(ext)) {
        result.push({ name: e.name, path: relPath, type: "file", ext });
      }
    }
  }
  // 目录在前，文件在后，各自按名字排序
  result.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    if (a.type === "file") {
      // 文件名以 YYYY-MM-DD 开头时降序(最新在前),否则升序
      const dateRe = /^\d{4}-\d{2}-\d{2}/;
      const aHasDate = dateRe.test(a.name), bHasDate = dateRe.test(b.name);
      if (aHasDate && bHasDate) return b.name.localeCompare(a.name, "zh");
      return a.name.localeCompare(b.name, "zh");
    }
    return a.name.localeCompare(b.name, "zh");
  });
  return result;
}

function countFiles(nodes: TreeNode[]): number {
  let n = 0;
  for (const node of nodes) {
    if (node.type === "file") n++;
    else if (node.children) n += countFiles(node.children);
  }
  return n;
}

function json(res: ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-cache",
  });
  res.end(body);
}

function err(res: ServerResponse, msg: string, status = 400): void {
  json(res, { error: msg }, status);
}

export async function handleApi(
  req: IncomingMessage,
  res: ServerResponse
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname;

  if (!pathname.startsWith("/api/")) return false;

  try {
    // GET /api/stats
    if (pathname === "/api/stats") {
      const [stats, jobs] = await Promise.all([
        sampleStats(),
        Promise.resolve(loadJobs()),
      ]);
      const activeJobs = jobs.filter((j) => j.enabled).length;
      json(res, {
        cpu_percent: stats.cpu_percent,
        mem_used_mb: stats.mem_used_mb,
        mem_total_mb: stats.mem_total_mb,
        disk_used_gb: stats.disk_used_gb,
        disk_total_gb: stats.disk_total_gb,
        cron_active: activeJobs,
        cron_total: jobs.length,
        ts: Math.floor(Date.now() / 1000),
      });
      return true;
    }

    // GET /api/metrics?category=&key=&days=
    if (pathname === "/api/metrics") {
      const category = url.searchParams.get("category") ?? "";
      const key = url.searchParams.get("key") ?? "";
      const days = parseInt(url.searchParams.get("days") ?? "30", 10);

      // 特殊处理：system 系统快照
      if (category === "system") {
        const hours = Math.min(days * 24, 168); // 最多 7 天
        const sinceParam2 = url.searchParams.get("since");
        const sinceTs = sinceParam2 ? parseInt(sinceParam2, 10) : undefined;
        const rows = querySnapshots(hours, sinceTs);
        json(res, { category, key, rows });
        return true;
      }

      if (!category || !key) {
        err(res, "缺少 category 或 key 参数");
        return true;
      }
      const sinceParam = url.searchParams.get("since");
      const sinceOpts = sinceParam ? { since: parseInt(sinceParam, 10) } : {};
      const rows = queryMetrics({ category, key, days, ...sinceOpts });
      json(res, { category, key, rows });
      return true;
    }

    // GET /api/metric-keys
    if (pathname === "/api/metric-keys") {
      const keys = listMetricKeys();
      json(res, { keys });
      return true;
    }

    // GET /api/cron
    if (pathname === "/api/cron") {
      const jobs = loadJobs();
      const result = jobs.map((job) => {
        const logs = readLogs(job.id, 5);
        return {
          id: job.id,
          message: job.message,
          type: job.type,
          enabled: job.enabled,
          agentId: job.agentId,
          runAt: job.runAt,
          intervalSecs: job.intervalSecs,
          timeOfDay: job.timeOfDay,
          lastRunAt: job.lastRunAt,
          lastRunStatus: job.lastRunStatus,
          recentLogs: logs.map((l) => ({
            ts: l.ts,
            status: l.status,
            result: l.result.slice(0, 200), // 截断避免过大
          })),
        };
      });
      json(res, { jobs: result });
      return true;
    }


    // ── GET /api/notes/tree ───────────────────────────────────────────────────
    if (pathname === "/api/notes/tree") {
      const tree = buildTree(NOTES_ROOT, "");
      json(res, { tree });
      return true;
    }

    // ── GET /api/notes/file?path=xxx ─────────────────────────────────────────
    if (pathname === "/api/notes/file") {
      const relPath = url.searchParams.get("path") ?? "";
      if (!relPath) { err(res, "缺少 path 参数"); return true; }
      // 防路径穿越
      const abs = nodePath.resolve(NOTES_ROOT, relPath);
      if (!abs.startsWith(NOTES_ROOT + nodePath.sep) && abs !== NOTES_ROOT) {
        err(res, "非法路径", 403); return true;
      }
      if (!fs.existsSync(abs)) { err(res, "文件不存在", 404); return true; }
      const ext = nodePath.extname(abs).toLowerCase();
      if (ext === ".pdf") {
        const stat = fs.statSync(abs);
        const total = stat.size;
        const rangeHeader = req.headers.range;
        const fname = encodeURIComponent(nodePath.basename(abs));
        if (rangeHeader) {
          const m = String(rangeHeader).match(/bytes=(\d*)-(\d*)/);
          const start = (m && m[1]) ? parseInt(m[1], 10) : 0;
          const end = (m && m[2]) ? parseInt(m[2], 10) : total - 1;
          const chunkLen = end - start + 1;
          res.writeHead(206, {
            "Content-Type": "application/pdf",
            "Content-Range": `bytes ${start}-${end}/${total}`,
            "Accept-Ranges": "bytes",
            "Content-Length": String(chunkLen),
            "Content-Disposition": `inline; filename="${fname}"`,
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-store",
          });
          fs.createReadStream(abs, { start, end }).pipe(res);
        } else {
          res.writeHead(200, {
            "Content-Type": "application/pdf",
            "Content-Disposition": `inline; filename="${fname}"`,
            "Content-Length": String(total),
            "Accept-Ranges": "bytes",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-store",
          });
          fs.createReadStream(abs).pipe(res);
        }
      } else {
        const content = fs.readFileSync(abs, "utf-8");
        json(res, { path: relPath, content });
      }
      return true;
    }

    // ── GET /api/notes/search?q=xxx ──────────────────────────────────────────
    if (pathname === "/api/notes/search") {
      const q = (url.searchParams.get("q") ?? "").trim();
      if (!q) { json(res, { results: [] }); return true; }
      const safeQ = q.replace(/"/g, '').replace(/'/g, '');
      let results: Array<{ path: string; name: string; ext: string; type: string }> = [];
      try {
        // 搜文件夹名
        let dirPaths: string[] = [];
        try {
          const dirOut = execSync(
            `find "${NOTES_ROOT}" -mindepth 1 -maxdepth 6 -type d -not -name ".*" -iname "*${safeQ}*" | head -20`,
            { encoding: "utf-8", timeout: 5000 }
          ).trim();
          dirPaths = dirOut ? dirOut.split("\n") : [];
        } catch { /* 无匹配 */ }
        // 搜文件名
        let nameOut = "";
        try {
          nameOut = execSync(
            `find "${NOTES_ROOT}" -not -name '.*' -type f \( -name "*.md" -o -name "*.pdf" \) | grep -i "${safeQ}" | head -30`,
            { encoding: "utf-8", timeout: 5000 }
          ).trim();
        } catch { /* 无匹配 */ }
        const namePaths = nameOut ? nameOut.split("\n") : [];
        // grep 内容(仅 md)
        let contentPaths: string[] = [];
        try {
          const grepOut = execSync(
            `grep -r -l -i --include="*.md" "${safeQ}" "${NOTES_ROOT}" 2>/dev/null | head -20`,
            { encoding: "utf-8", timeout: 5000 }
          ).trim();
          contentPaths = grepOut ? grepOut.split("\n") : [];
        } catch { /* 无匹配 */ }
        // 文件夹结果
        const dirResults = [...new Set(dirPaths)].filter(Boolean).map(a => ({
          path: nodePath.relative(NOTES_ROOT, a),
          name: nodePath.basename(a),
          ext: '',
          type: 'dir' as const,
        }));
        // 文件结果
        const fileResults = [...new Set([...namePaths, ...contentPaths])].filter(Boolean).map(a => ({
          path: nodePath.relative(NOTES_ROOT, a),
          name: nodePath.basename(a),
          ext: nodePath.extname(a).toLowerCase(),
          type: 'file' as const,
        }));
        results = [...dirResults, ...fileResults];
      } catch { /* 失败 */ }
      json(res, { results });
      return true;
    }

    err(res, "未知 API 路径", 404);
    return true;
  } catch (e) {
    console.error("[dashboard api] 错误:", e);
    err(res, "服务器内部错误", 500);
    return true;
  }
}

