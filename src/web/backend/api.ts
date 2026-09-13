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
import * as zlib from "node:zlib";
import { execSync } from "node:child_process";
import { sampleStats } from "./collector.js";
import {
  queryMetrics,
  querySnapshots,
  listMetricKeys,
  queryTokenBreakdown,
  latestTokenBreakdown,
  type TokenBreakdownRow,
} from "./db.js";
import { loadJobs, readLogs } from "../../cron/store.js";

// ── Notes 工具 ────────────────────────────────────────────────────────────────
const NOTES_ROOT = nodePath.join(os.homedir(), ".tinyclaw", "notes");

interface TreeNode {
  name: string;
  path: string; // 相对于 NOTES_ROOT 的路径
  type: "dir" | "file";
  ext?: string;
  count?: number; // 目录：含子目录的总文件数
  children?: TreeNode[];
}

function buildTree(absDir: string, relBase: string): TreeNode[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const result: TreeNode[] = [];
  for (const e of entries) {
    // 跳过隐藏目录/文件（如 .obsidian、.git）
    if (e.name.startsWith(".")) continue;
    const relPath = relBase ? `${relBase}/${e.name}` : e.name;
    const resolvedIsDir =
      e.isDirectory() ||
      (e.isSymbolicLink() &&
        (() => {
          try {
            return fs.statSync(nodePath.join(absDir, e.name)).isDirectory();
          } catch {
            return false;
          }
        })());
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
      const aHasDate = dateRe.test(a.name),
        bHasDate = dateRe.test(b.name);
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

// ── Token 构成聚合（/api/token-breakdown）──────────────────────────────────────

interface TokenCategoryStatJson {
  category: string;
  label: string;
  tokens: number;
  chars: number;
  count: number;
}
interface TokenToolStatJson {
  name: string;
  tokens: number;
  calls: number;
}

/** 宽松解析 JSON 列（历史行可能缺字段；坏数据不能让整个接口 500） */
function parseJsonArray<T>(raw: string | null): T[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

/** 本地时区的 YYYY-MM-DD（按天聚合用；不能用 toISOString，那会串到 UTC 日期） */
function localDay(tsSec: number): string {
  const d = new Date(tsSec * 1000);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export interface TokenBreakdownPayload {
  rows: Array<{
    ts: number;
    sessionId: string;
    source: string;
    agentId: string | null;
    model: string | null;
    round: number;
    prompt: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    estTotal: number;
    messageTokens: number;
    contextWindow: number | null;
    sessionTokens: number | null;
    items: TokenCategoryStatJson[];
    top: Array<{
      category: string;
      label: string;
      role: string;
      tool?: string;
      preview: string;
      tokens: number;
    }>;
    tools: TokenToolStatJson[];
  }>;
  latest: TokenBreakdownPayload["rows"][number] | null;
  byDay: Array<{
    day: string;
    rounds: number;
    prompt: number;
    output: number;
    cacheRead: number;
    /** 分类名 → token 数（缺失分类按 0 处理） */
    categories: Record<string, number>;
  }>;
  byTool: Array<{ name: string; tokens: number; calls: number; pct: number }>;
  bySession: Array<{
    sessionId: string;
    source: string;
    agentId: string | null;
    model: string | null;
    rounds: number;
    prompt: number;
    output: number;
    cacheRead: number;
    estTotal: number;
    lastTs: number;
    contextWindow: number | null;
    sessionTokens: number | null;
  }>;
  totals: {
    rounds: number;
    prompt: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    estTotal: number;
  };
}

/** 把 token_breakdown 行折叠成前端需要的形状（按天/按工具/按会话 + 总量） */
export function buildTokenBreakdownPayload(
  rawRows: TokenBreakdownRow[],
  latest: TokenBreakdownRow | null
): TokenBreakdownPayload {
  const rows: TokenBreakdownPayload["rows"] = rawRows.map((r) => ({
    ts: r.ts,
    sessionId: r.session_id,
    source: r.source,
    agentId: r.agent_id,
    model: r.model,
    round: r.round,
    prompt: r.actual_prompt ?? 0,
    output: r.actual_output ?? 0,
    cacheRead: r.cache_read ?? 0,
    cacheWrite: r.cache_write ?? 0,
    estTotal: r.est_total ?? 0,
    messageTokens: r.message_tokens ?? 0,
    contextWindow: r.context_window,
    sessionTokens: r.session_tokens,
    items: parseJsonArray<TokenCategoryStatJson>(r.items),
    top: parseJsonArray<TokenBreakdownPayload["rows"][number]["top"][number]>(r.top),
    tools: parseJsonArray<TokenToolStatJson>(r.tools),
  }));

  const latestRow = latest
    ? (rows.find((r) => r.ts === latest.ts) ?? {
        ts: latest.ts,
        sessionId: latest.session_id,
        source: latest.source,
        agentId: latest.agent_id,
        model: latest.model,
        round: latest.round,
        prompt: latest.actual_prompt ?? 0,
        output: latest.actual_output ?? 0,
        cacheRead: latest.cache_read ?? 0,
        cacheWrite: latest.cache_write ?? 0,
        estTotal: latest.est_total ?? 0,
        messageTokens: latest.message_tokens ?? 0,
        contextWindow: latest.context_window,
        sessionTokens: latest.session_tokens,
        items: parseJsonArray<TokenCategoryStatJson>(latest.items),
        top: parseJsonArray<TokenBreakdownPayload["rows"][number]["top"][number]>(latest.top),
        tools: parseJsonArray<TokenToolStatJson>(latest.tools),
      })
    : null;

  // 按天聚合（分类用最新口径的 label 映射，缺失分类按 0）
  const dayMap = new Map<string, TokenBreakdownPayload["byDay"][number]>();
  for (const r of rows) {
    const day = localDay(r.ts);
    const cur = dayMap.get(day) ?? {
      day,
      rounds: 0,
      prompt: 0,
      output: 0,
      cacheRead: 0,
      categories: {},
    };
    cur.rounds += 1;
    cur.prompt += r.prompt;
    cur.output += r.output;
    cur.cacheRead += r.cacheRead;
    for (const it of r.items) {
      cur.categories[it.category] = (cur.categories[it.category] ?? 0) + it.tokens;
    }
    dayMap.set(day, cur);
  }
  const byDay = [...dayMap.values()].sort((a, b) => a.day.localeCompare(b.day));

  // 按工具排行（跨请求累计，热度用该类 token 占构成合计的比例表达）
  const toolMap = new Map<string, TokenToolStatJson>();
  let toolTotal = 0;
  for (const r of rows) {
    for (const t of r.tools) {
      const cur = toolMap.get(t.name) ?? { name: t.name, tokens: 0, calls: 0 };
      cur.tokens += t.tokens;
      cur.calls += t.calls;
      toolMap.set(t.name, cur);
      toolTotal += t.tokens;
    }
  }
  const byTool = [...toolMap.values()]
    .sort((a, b) => b.tokens - a.tokens)
    .map((t) => ({ ...t, pct: toolTotal > 0 ? t.tokens / toolTotal : 0 }));

  // 按会话/来源排行
  const sessMap = new Map<string, TokenBreakdownPayload["bySession"][number]>();
  for (const r of rows) {
    const cur = sessMap.get(r.sessionId) ?? {
      sessionId: r.sessionId,
      source: r.source,
      agentId: r.agentId,
      model: r.model,
      rounds: 0,
      prompt: 0,
      output: 0,
      cacheRead: 0,
      estTotal: 0,
      lastTs: 0,
      contextWindow: r.contextWindow,
      sessionTokens: r.sessionTokens,
    };
    cur.rounds += 1;
    cur.prompt += r.prompt;
    cur.output += r.output;
    cur.cacheRead += r.cacheRead;
    cur.estTotal += r.estTotal;
    if (r.ts >= cur.lastTs) {
      cur.lastTs = r.ts;
      cur.contextWindow = r.contextWindow;
      cur.sessionTokens = r.sessionTokens;
    }
    sessMap.set(r.sessionId, cur);
  }
  const bySession = [...sessMap.values()].sort((a, b) => b.prompt + b.output - (a.prompt + a.output));

  const totals = rows.reduce(
    (acc, r) => ({
      rounds: acc.rounds + 1,
      prompt: acc.prompt + r.prompt,
      output: acc.output + r.output,
      cacheRead: acc.cacheRead + r.cacheRead,
      cacheWrite: acc.cacheWrite + r.cacheWrite,
      estTotal: acc.estTotal + r.estTotal,
    }),
    { rounds: 0, prompt: 0, output: 0, cacheRead: 0, cacheWrite: 0, estTotal: 0 }
  );

  return { rows, latest: latestRow, byDay, byTool, bySession, totals };
}

// 当前请求引用(用于 json() 判断客户端是否支持 gzip)
let _curReq: IncomingMessage | null = null;

function json(res: ServerResponse, data: unknown, status = 200): void {
  const body = JSON.stringify(data);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-cache",
  };
  // 响应体较大且客户端支持时 gzip(小响应压缩收益低,跳过)
  const ae = _curReq?.headers["accept-encoding"];
  const gzipOk = typeof ae === "string" && ae.includes("gzip");
  if (gzipOk && Buffer.byteLength(body) > 1024) {
    const gz = zlib.gzipSync(body);
    headers["Content-Encoding"] = "gzip";
    headers["Vary"] = "Accept-Encoding";
    res.writeHead(status, headers);
    res.end(gz);
    return;
  }
  res.writeHead(status, headers);
  res.end(body);
}

function err(res: ServerResponse, msg: string, status = 400): void {
  json(res, { error: msg }, status);
}

export async function handleApi(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const pathname = url.pathname;

  if (!pathname.startsWith("/api/")) return false;

  _curReq = req;

  try {
    // GET /api/stats
    if (pathname === "/api/stats") {
      const [stats, jobs] = await Promise.all([sampleStats(), Promise.resolve(loadJobs())]);
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
      // today=1 时使用当日自然日(本地 0:00)而非"过去24小时",避免把昨天数据计入今日
      const todayOnly = url.searchParams.get("today") === "1";
      const rows = queryMetrics({
        category,
        key,
        days,
        ...sinceOpts,
        ...(todayOnly ? { todayOnly: true } : {}),
      });
      json(res, { category, key, rows });
      return true;
    }

    // GET /api/metric-keys
    if (pathname === "/api/metric-keys") {
      const keys = listMetricKeys();
      json(res, { keys });
      return true;
    }

    // GET /api/token-breakdown?days=7&limit=400&session=<id>
    // Prompt 构成细分（每次 LLM 请求一行）+ 按天/按工具/按会话聚合
    if (pathname === "/api/token-breakdown") {
      const days = Math.min(Math.max(1, parseInt(url.searchParams.get("days") ?? "7", 10) || 7), 90);
      const limit = Math.min(
        Math.max(1, parseInt(url.searchParams.get("limit") ?? "400", 10) || 400),
        5000
      );
      const sessionId = url.searchParams.get("session") ?? undefined;
      const rows = queryTokenBreakdown({
        days,
        limit,
        ...(sessionId ? { sessionId } : {}),
      });
      // latest 取**全局最近一次请求**（不受 days/session 过滤影响）：用于"当前上下文窗口占用"
      const payload = buildTokenBreakdownPayload(rows, latestTokenBreakdown());
      json(res, { days, ...payload });
      return true;
    }

    // GET /api/cron
    if (pathname === "/api/cron") {
      const jobs = loadJobs();
      const result = jobs.map((job) => {
        const logs = readLogs(job.id, 5);
        return {
          id: job.id,
          name: job.name ?? null,
          message: job.message,
          type: job.type,
          enabled: job.enabled,
          agentId: job.agentId,
          model: job.model ?? null,
          runAt: job.runAt,
          intervalSecs: job.intervalSecs,
          timeOfDay: job.timeOfDay,
          lastRunAt: job.lastRunAt,
          lastRunStatus: job.lastRunStatus,
          recentLogs: logs.map((l) => ({
            ts: l.ts,
            status: l.status,
            result: l.result.slice(0, 200), // 截断避免过大
            durationMs: l.durationMs,
            trigger: l.trigger,
            model: l.model,
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
      if (!relPath) {
        err(res, "缺少 path 参数");
        return true;
      }
      // 防路径穿越
      const abs = nodePath.resolve(NOTES_ROOT, relPath);
      if (!abs.startsWith(NOTES_ROOT + nodePath.sep) && abs !== NOTES_ROOT) {
        err(res, "非法路径", 403);
        return true;
      }
      if (!fs.existsSync(abs)) {
        err(res, "文件不存在", 404);
        return true;
      }
      const ext = nodePath.extname(abs).toLowerCase();
      if (ext === ".pdf") {
        const stat = fs.statSync(abs);
        const total = stat.size;
        const rangeHeader = req.headers.range;
        const fname = encodeURIComponent(nodePath.basename(abs));
        if (rangeHeader) {
          const m = String(rangeHeader).match(/bytes=(\d*)-(\d*)/);
          const start = m && m[1] ? parseInt(m[1], 10) : 0;
          const end = m && m[2] ? parseInt(m[2], 10) : total - 1;
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
      if (!q) {
        json(res, { results: [] });
        return true;
      }
      const safeQ = q.replace(/"/g, "").replace(/'/g, "");
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
        } catch {
          /* 无匹配 */
        }
        // 搜文件名
        let nameOut = "";
        try {
          nameOut = execSync(
            `find "${NOTES_ROOT}" -not -name '.*' -type f \( -name "*.md" -o -name "*.pdf" \) | grep -i "${safeQ}" | head -30`,
            { encoding: "utf-8", timeout: 5000 }
          ).trim();
        } catch {
          /* 无匹配 */
        }
        const namePaths = nameOut ? nameOut.split("\n") : [];
        // grep 内容(仅 md)
        let contentPaths: string[] = [];
        try {
          const grepOut = execSync(
            `grep -r -l -i --include="*.md" "${safeQ}" "${NOTES_ROOT}" 2>/dev/null | head -20`,
            { encoding: "utf-8", timeout: 5000 }
          ).trim();
          contentPaths = grepOut ? grepOut.split("\n") : [];
        } catch {
          /* 无匹配 */
        }
        // 文件夹结果
        const dirResults = [...new Set(dirPaths)].filter(Boolean).map((a) => ({
          path: nodePath.relative(NOTES_ROOT, a),
          name: nodePath.basename(a),
          ext: "",
          type: "dir" as const,
        }));
        // 文件结果
        const fileResults = [...new Set([...namePaths, ...contentPaths])]
          .filter(Boolean)
          .map((a) => ({
            path: nodePath.relative(NOTES_ROOT, a),
            name: nodePath.basename(a),
            ext: nodePath.extname(a).toLowerCase(),
            type: "file" as const,
          }));
        results = [...dirResults, ...fileResults];
      } catch {
        /* 失败 */
      }
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
