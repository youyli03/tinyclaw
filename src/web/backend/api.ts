/**
 * Dashboard API 路由
 *
 * GET /api/stats   — 实时系统状态（CPU/内存/磁盘，不过 DB）+ Cron 活跃数
 * GET /api/metrics — 历史时序数据（?category=&key=&days=）
 * GET /api/metric-keys — 所有可用的 category/key 列表
 * GET /api/cron    — Cron job 列表 + 最近 5 条日志
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { sampleStats } from "./collector.js";
import { queryMetrics, querySnapshots, listMetricKeys } from "./db.js";
import { loadJobs, readLogs } from "../../cron/store.js";
import { listReportTypes, listReportDates, readReport } from "./reports.js";

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
        const rows = querySnapshots(hours);
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


    // GET /api/reports          — 列出所有类型及各类型最新日期
    // GET /api/reports?type=    — 列出某类型所有日期
    // GET /api/reports?type=&date= — 读取具体一篇日报内容
    if (pathname === "/api/reports") {
      const type = url.searchParams.get("type") ?? "";
      const date = url.searchParams.get("date") ?? "";

      if (!type) {
        // 列出所有类型 + 每个类型最新日期
        const types = listReportTypes();
        const result = types.map(t => {
          const dates = listReportDates(t);
          return { type: t, count: dates.length, latest: dates[0] ?? null };
        });
        json(res, { types: result });
        return true;
      }

      if (type && !date) {
        // 列出某类型所有日期
        const dates = listReportDates(type);
        json(res, { type, dates });
        return true;
      }

      if (type && date) {
        // 读取具体日报内容
        const content = readReport(type, date);
        if (content === null) {
          err(res, `日报不存在: ${type}/${date}`, 404);
        } else {
          json(res, { type, date, content });
        }
        return true;
      }
    }

    err(res, "未知 API 路径", 404);
    return true;
  } catch (e) {
    console.error("[dashboard api] 错误:", e);
    err(res, "服务器内部错误", 500);
    return true;
  }
}

