/**
 * Dashboard 下载页后端：释放目录 + 一次性下载令牌
 *
 * - 释放目录：`[web.downloads].dir`，缺省 `~/.tinyclaw/downloads/`（agent 用 `release_file` 投放）
 * - 列表 / 签发 / 删除：`/api/downloads*`，走 server.ts 的常规会话鉴权
 * - 下载：`GET /dl`，**只认一次性令牌**（`X-Download-Token` / `Authorization: Bearer <otp>` / `?t=<otp>`），
 *   不需要会话 —— 这是唯一免会话路径，所以本文件里的校验必须 fail-closed
 *
 * 安全约定（改之前先读）：
 *   1. 请求里**只传文件名，绝不接受路径**；解析后 realpath 必须仍落在释放目录内，且拒绝符号链接
 *   2. 令牌 256bit 随机、只在内存、**绑定文件指纹**（size+mtimeMs）、带 TTL 与最大次数，
 *      文件被替换/截断 → 旧令牌立即作废；进程重启 → 全部失效
 *   3. 下载响应必须 `Cache-Control: private, no-store` —— 用 public 会被 Cloudflare 边缘缓存后
 *      **不带凭证也能取到**（静态资源上已经实测踩过一次：CF 的缓存键不看 cookie）
 *   4. 令牌只能下它绑定的那一个文件，不存在"通用下载令牌"
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { getDataPath } from "../../config/loader.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("downloads");

/** 免会话下载端点（server.ts 只对这个精确路径放行） */
export const DOWNLOAD_PATH = "/dl";
/** 管理 API 前缀（需会话） */
export const DOWNLOADS_API_PREFIX = "/api/downloads";

export interface DownloadsConfig {
  enabled: boolean;
  /** 临时区（一次释放、按 ttlDays 清理）；缺省 = ~/.tinyclaw/downloads */
  dir?: string | undefined;
  /** 常驻区（按目录归类、永不自动清理）；缺省 = ~/.tinyclaw/keep */
  keepDir?: string | undefined;
  linkTtlSecs: number;
  maxUses: number;
  maxFileMb: number;
  maxTotalMb: number;
  /** 常驻区总占用上限(MB) */
  keepMaxTotalMb: number;
  ttlDays: number;
}

export interface DownloadEntry {
  name: string;
  size: number;
  mtimeMs: number;
}

/** 下载区：`temp` = 临时（flat、按天清理），`keep` = 常驻（可嵌套归类、不清理） */
export type DownloadZone = "temp" | "keep";

/** 常驻区目录树节点（与 notes 的 `buildTree` 同形，前端复用 notes-tree-node 组件） */
export interface KeepTreeNode {
  name: string;
  /** 相对常驻区根目录的路径 */
  path: string;
  type: "dir" | "file";
  size?: number;
  mtimeMs?: number;
  count?: number;
  children?: KeepTreeNode[];
}

interface DownloadToken {
  abs: string;
  name: string;
  size: number;
  mtimeMs: number;
  expiresAt: number;
  maxUses: number;
  uses: number;
}

/** 一次性令牌表（内存；进程重启即全部失效，与会话口径一致） */
const tokens = new Map<string, DownloadToken>();

/** `/dl` 的失败计数（全局粗粒度限速；先验令牌、再判限速，所以有效令牌永远不会被锁） */
const FAILURE_WINDOW_MS = 5 * 60 * 1000;
const MAX_FAILURES = 20;
const LOCKOUT_MS = 5 * 60 * 1000;
let failures = { count: 0, windowStart: 0, lockedUntil: 0 };

// ── 目录与文件解析 ────────────────────────────────────────────────────────────

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** 释放目录（绝对路径；不存在则创建） */
export function downloadDir(cfg: DownloadsConfig): string {
  const raw = cfg.dir && cfg.dir.trim() ? expandHome(cfg.dir.trim()) : getDataPath("downloads");
  fs.mkdirSync(raw, { recursive: true });
  return fs.realpathSync(raw);
}

/**
 * 把请求里的"文件名"解析成目录内的真实文件。
 * 非法（空 / 含路径分隔符 / 隐藏名 / 控制字符 / 目录 / 符号链接 / realpath 越界）一律返回 null。
 */
function resolveEntry(
  cfg: DownloadsConfig,
  rawName: string
): { name: string; abs: string; size: number; mtimeMs: number } | null {
  const name = String(rawName ?? "").trim();
  if (!name || name.length > 200) return null;
  if (name !== path.basename(name)) return null;
  if (name.startsWith(".")) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f]/.test(name)) return null;

  const dir = downloadDir(cfg);
  const candidate = path.join(dir, name);
  let real: string;
  try {
    if (fs.lstatSync(candidate).isSymbolicLink()) return null;
    real = fs.realpathSync(candidate);
  } catch {
    return null;
  }
  if (real !== path.join(dir, name)) return null;
  let st: fs.Stats;
  try {
    st = fs.statSync(real);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  return { name, abs: real, size: st.size, mtimeMs: Math.floor(st.mtimeMs) };
}

/** 目录内文件列表（跳过隐藏文件 / 目录 / 符号链接），按修改时间倒序 */
export function listDownloads(cfg: DownloadsConfig): DownloadEntry[] {
  let names: string[];
  try {
    names = fs.readdirSync(downloadDir(cfg));
  } catch {
    return [];
  }
  const out: DownloadEntry[] = [];
  for (const name of names) {
    if (name.startsWith(".")) continue;
    const e = resolveEntry(cfg, name);
    if (e) out.push({ name: e.name, size: e.size, mtimeMs: e.mtimeMs });
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** 目录总占用（字节） */
export function downloadsTotalBytes(cfg: DownloadsConfig): number {
  return listDownloads(cfg).reduce((n, f) => n + f.size, 0);
}

// ── 常驻区（按目录归类，永不自动清理）──────────────────────────────────────────

/** 常驻区根目录（绝对路径；不存在则创建） */
export function keepDir(cfg: DownloadsConfig): string {
  const raw =
    cfg.keepDir && cfg.keepDir.trim() ? expandHome(cfg.keepDir.trim()) : getDataPath("keep");
  fs.mkdirSync(raw, { recursive: true });
  return fs.realpathSync(raw);
}

/**
 * 常驻区允许**相对路径**（用 `/` 分层归类），所以每一段都要单独校验：
 * 拒绝绝对路径、`.` / `..`、隐藏段、控制字符；段数与段长都有上限。
 * `release_file` 工具也 import 这个函数，保证"投放"与"下载"两侧口径完全一致。
 */
export function normalizeKeepRel(raw: string): string | null {
  const s = String(raw ?? "")
    .trim()
    .replace(/\\/g, "/");
  // 显式拒绝绝对路径 / 盘符 / ~ 开头：否则会被"无害化"成 keep 根下的相对路径（容易误解）
  const raw0 = String(raw ?? "").trim();
  if (/^[/\\]/.test(raw0) || /^[A-Za-z]:[\\/]/.test(raw0) || raw0.startsWith("~")) return null;
  if (!s || s.length > 400) return null;
  const segs = s.split("/").filter((x) => x.length > 0);
  if (!segs.length || segs.length > 8) return null;
  for (const seg of segs) {
    if (seg === "." || seg === "..") return null;
    if (seg.startsWith(".")) return null;
    if (seg.length > 100) return null;
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f]/.test(seg)) return null;
  }
  return segs.join("/");
}

/** 常驻区：把相对路径解析成真实文件；拒绝符号链接（含中间目录）与越界 */
function resolveKeepEntry(
  cfg: DownloadsConfig,
  rawRel: string
): { name: string; abs: string; size: number; mtimeMs: number } | null {
  const rel = normalizeKeepRel(rawRel);
  if (!rel) return null;
  const root = keepDir(cfg);
  let cur = root;
  for (const seg of rel.split("/")) {
    cur = path.join(cur, seg);
    try {
      if (fs.lstatSync(cur).isSymbolicLink()) return null;
    } catch {
      return null;
    }
  }
  let real: string;
  try {
    real = fs.realpathSync(cur);
  } catch {
    return null;
  }
  if (real !== path.join(root, rel)) return null;
  let st: fs.Stats;
  try {
    st = fs.statSync(real);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  return { name: rel, abs: real, size: st.size, mtimeMs: Math.floor(st.mtimeMs) };
}

const KEEP_MAX_DEPTH = 6;
const KEEP_MAX_ENTRIES = 2000;

function countTreeFiles(nodes: KeepTreeNode[]): number {
  let n = 0;
  for (const node of nodes) {
    if (node.type === "file") n++;
    else if (node.children) n += countTreeFiles(node.children);
  }
  return n;
}

function walkKeep(
  dirAbs: string,
  relBase: string,
  depth: number,
  budget: { left: number }
): KeepTreeNode[] {
  if (depth > KEEP_MAX_DEPTH || budget.left <= 0) return [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirAbs, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: KeepTreeNode[] = [];
  for (const e of entries) {
    if (budget.left <= 0) break;
    if (e.name.startsWith(".")) continue;
    // 符号链接既不展示也不跟随（否则树里会出现指向目录外的节点）
    if (e.isSymbolicLink()) continue;
    const rel = relBase ? `${relBase}/${e.name}` : e.name;
    const abs = path.join(dirAbs, e.name);
    if (e.isDirectory()) {
      budget.left--;
      const children = walkKeep(abs, rel, depth + 1, budget);
      out.push({ name: e.name, path: rel, type: "dir", count: countTreeFiles(children), children });
    } else if (e.isFile()) {
      budget.left--;
      let size = 0;
      let mtimeMs = 0;
      try {
        const st = fs.statSync(abs);
        size = st.size;
        mtimeMs = Math.floor(st.mtimeMs);
      } catch {
        /* 读不到属性就给 0，不影响展示 */
      }
      out.push({ name: e.name, path: rel, type: "file", size, mtimeMs });
    }
  }
  // 目录在前、文件在后，各自按名字排（与 notes 的树一致）
  out.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name, "zh");
  });
  return out;
}

/** 常驻区目录树 + 合计（一次遍历，供列表接口用） */
export function listKeepTree(cfg: DownloadsConfig): {
  tree: KeepTreeNode[];
  totalBytes: number;
  fileCount: number;
} {
  const tree = walkKeep(keepDir(cfg), "", 1, { left: KEEP_MAX_ENTRIES });
  let totalBytes = 0;
  let fileCount = 0;
  const sum = (nodes: KeepTreeNode[]): void => {
    for (const n of nodes) {
      if (n.type === "file") {
        totalBytes += n.size ?? 0;
        fileCount++;
      } else if (n.children) {
        sum(n.children);
      }
    }
  };
  sum(tree);
  return { tree, totalBytes, fileCount };
}

/** 常驻区总占用（字节；不带展示用的条目上限，用于投放时判配额） */
export function keepTotalBytes(cfg: DownloadsConfig): number {
  const walk = (dirAbs: string, depth: number): number => {
    if (depth > KEEP_MAX_DEPTH) return 0;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dirAbs, { withFileTypes: true });
    } catch {
      return 0;
    }
    let total = 0;
    for (const e of entries) {
      if (e.name.startsWith(".") || e.isSymbolicLink()) continue;
      const abs = path.join(dirAbs, e.name);
      if (e.isDirectory()) total += walk(abs, depth + 1);
      else if (e.isFile()) {
        try {
          total += fs.statSync(abs).size;
        } catch {
          /* ignore */
        }
      }
    }
    return total;
  };
  return walk(keepDir(cfg), 1);
}

/** 删除超过 `ttlDays` 的文件（0 = 不清理）；返回删除条数 */
export function pruneDownloads(cfg: DownloadsConfig): number {
  if (cfg.ttlDays <= 0) return 0;
  const cutoff = Date.now() - cfg.ttlDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const f of listDownloads(cfg)) {
    if (f.mtimeMs >= cutoff) continue;
    const entry = resolveEntry(cfg, f.name);
    if (!entry) continue;
    try {
      fs.unlinkSync(entry.abs);
      revokeTokensFor(entry.abs);
      removed++;
    } catch (e) {
      log.warn(`清理失败 ${f.name}: ${String(e)}`);
    }
  }
  if (removed) log.info(`清理过期下载文件 ${removed} 个（保留 ${cfg.ttlDays} 天）`);
  return removed;
}

// ── 令牌 ──────────────────────────────────────────────────────────────────────

function revokeTokensFor(abs: string): void {
  for (const [k, v] of tokens) if (v.abs === abs) tokens.delete(k);
}

function pruneTokens(now: number): void {
  for (const [k, v] of tokens) if (v.expiresAt <= now) tokens.delete(k);
}

export interface IssuedLink {
  token: string;
  expiresAt: number;
  maxUses: number;
}

/** 签发一次性下载令牌（绑定文件指纹；zone 决定在临时区还是常驻区解析） */
export function issueDownloadLink(
  cfg: DownloadsConfig,
  rawName: string,
  zone: DownloadZone = "temp"
):
  | { ok: true; name: string; size: number; link: IssuedLink }
  | { ok: false; status: number; error: string } {
  if (!cfg.enabled) return { ok: false, status: 403, error: "下载功能未启用" };
  const entry = zone === "keep" ? resolveKeepEntry(cfg, rawName) : resolveEntry(cfg, rawName);
  if (!entry) return { ok: false, status: 404, error: "文件不存在或名称非法" };
  if (entry.size > cfg.maxFileMb * 1024 * 1024) {
    return { ok: false, status: 413, error: `文件超过单文件上限（${cfg.maxFileMb} MB）` };
  }

  const now = Date.now();
  pruneTokens(now);
  const token = crypto.randomBytes(32).toString("base64url");
  const expiresAt = now + cfg.linkTtlSecs * 1000;
  tokens.set(token, {
    abs: entry.abs,
    name: entry.name,
    size: entry.size,
    mtimeMs: entry.mtimeMs,
    expiresAt,
    maxUses: cfg.maxUses,
    uses: 0,
  });
  log.info(
    `签发下载令牌（${entry.name}，${entry.size} 字节，${cfg.linkTtlSecs}s 内最多 ${cfg.maxUses} 次）`
  );
  return {
    ok: true,
    name: entry.name,
    size: entry.size,
    link: { token, expiresAt, maxUses: cfg.maxUses },
  };
}

/** 取出并消费一次令牌；null = 不存在 / 过期 / 超次 / 文件已变 */
function consumeToken(token: string): DownloadToken | null {
  const rec = tokens.get(token);
  if (!rec) return null;
  const now = Date.now();
  if (rec.expiresAt <= now || rec.uses >= rec.maxUses) {
    tokens.delete(token);
    return null;
  }
  let st: fs.Stats;
  try {
    st = fs.statSync(rec.abs);
  } catch {
    tokens.delete(token);
    return null;
  }
  if (!st.isFile() || st.size !== rec.size || Math.floor(st.mtimeMs) !== rec.mtimeMs) {
    tokens.delete(token);
    log.warn(`令牌作废：文件已变化（${rec.name}）`);
    return null;
  }
  rec.uses += 1;
  if (rec.uses >= rec.maxUses) tokens.delete(token);
  return rec;
}

/** 进程退出时清空令牌（server.ts 的 stopDashboard 调用） */
export function resetDownloadTokens(): void {
  tokens.clear();
  failures = { count: 0, windowStart: 0, lockedUntil: 0 };
}

// ── HTTP ──────────────────────────────────────────────────────────────────────

function replyJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "private, no-store",
  });
  res.end(JSON.stringify(data));
}

/** 从请求头/查询串里取下载令牌（头优先；master token 不在这里生效） */
function readToken(req: IncomingMessage, url: URL): string {
  const auth = req.headers.authorization;
  if (typeof auth === "string") {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m && m[1]) return m[1].trim();
  }
  const x = req.headers["x-download-token"];
  if (typeof x === "string" && x.trim()) return x.trim();
  return (url.searchParams.get("t") ?? "").trim();
}

/** RFC 5987/6266：ASCII 回退名 + UTF-8 百分号编码名（中文文件名不乱码） */
function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/** 只支持 `bytes=START-` 与 `bytes=START-END`；其它形态按完整响应处理 */
function parseRange(
  header: string | undefined,
  size: number
): { start: number; end: number } | null {
  if (typeof header !== "string") return null;
  const m = /^bytes=(\d+)-(\d*)$/.exec(header.trim());
  if (!m || !m[1]) return null;
  const start = Number(m[1]);
  const end = m[2] ? Number(m[2]) : size - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start > end || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

/** GET/HEAD /dl —— 只认一次性令牌 */
export async function handleDownloadRoute(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: DownloadsConfig
): Promise<void> {
  const method = (req.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    replyJson(res, 405, { error: "仅支持 GET/HEAD" });
    return;
  }
  if (!cfg.enabled) {
    replyJson(res, 404, { error: "下载功能未启用" });
    return;
  }

  const url = new URL(req.url ?? "/", "http://localhost");
  const raw = readToken(req, url);
  const rec = raw ? consumeToken(raw) : null;

  if (!rec) {
    const now = Date.now();
    if (now - failures.windowStart > FAILURE_WINDOW_MS) {
      failures = { count: 0, windowStart: now, lockedUntil: 0 };
    }
    failures.count += 1;
    if (failures.count >= MAX_FAILURES && failures.lockedUntil <= now) {
      failures.lockedUntil = now + LOCKOUT_MS;
      log.warn(`下载失败次数过多，限速 ${LOCKOUT_MS / 1000}s`);
    }
    if (failures.lockedUntil > now) {
      res.setHeader("Retry-After", String(Math.ceil((failures.lockedUntil - now) / 1000)));
      replyJson(res, 429, { error: "请求过于频繁，请稍后再试" });
      return;
    }
    log.warn(`拒绝下载：令牌无效（${req.socket.remoteAddress ?? "?"}）`);
    replyJson(res, 401, { error: "下载令牌无效、已过期或已用完" });
    return;
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/octet-stream",
    // 用 basename：常驻区的 name 是 `分类/文件`，下载文件名里不该出现路径分隔符
    "Content-Disposition": contentDisposition(path.basename(rec.name)),
    // 绝不能用 public：CF 边缘会把对象缓存后公开（静态资源上已实测踩过）
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Accept-Ranges": "bytes",
  };

  const range = parseRange(req.headers.range, rec.size);
  const start = range ? range.start : 0;
  const end = range ? range.end : rec.size - 1;
  const length = end - start + 1;

  if (range) headers["Content-Range"] = `bytes ${start}-${end}/${rec.size}`;
  headers["Content-Length"] = String(length);

  res.writeHead(range ? 206 : 200, headers);
  log.info(
    `下载 ${rec.name}（${length} 字节${range ? `，Range ${start}-${end}` : ""}，` +
      `令牌已用 ${rec.uses}/${rec.maxUses}）`
  );
  if (method === "HEAD") {
    res.end();
    return;
  }
  fs.createReadStream(rec.abs, { start, end }).pipe(res);
}

/** /api/downloads* —— 管理接口（调用方已确认会话鉴权通过） */
export async function handleDownloadsApi(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: DownloadsConfig
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const p = url.pathname;
  if (p !== DOWNLOADS_API_PREFIX && !p.startsWith(`${DOWNLOADS_API_PREFIX}/`)) return false;

  const method = (req.method ?? "GET").toUpperCase();
  const zone: DownloadZone = url.searchParams.get("zone") === "keep" ? "keep" : "temp";

  // GET /api/downloads —— 列表（临时区 flat + 常驻区目录树）
  if (p === DOWNLOADS_API_PREFIX && method === "GET") {
    if (!cfg.enabled) {
      replyJson(res, 200, { enabled: false, dir: "", files: [], totalBytes: 0 });
      return true;
    }
    pruneDownloads(cfg); // 只清临时区；常驻区永不自动清理
    const files = listDownloads(cfg);
    const keep = listKeepTree(cfg);
    replyJson(res, 200, {
      enabled: true,
      dir: downloadDir(cfg),
      files,
      totalBytes: files.reduce((n, f) => n + f.size, 0),
      maxFileMb: cfg.maxFileMb,
      maxTotalMb: cfg.maxTotalMb,
      ttlDays: cfg.ttlDays,
      linkTtlSecs: cfg.linkTtlSecs,
      maxUses: cfg.maxUses,
      keep: {
        dir: keepDir(cfg),
        tree: keep.tree,
        totalBytes: keep.totalBytes,
        fileCount: keep.fileCount,
        maxTotalMb: cfg.keepMaxTotalMb,
      },
    });
    return true;
  }

  // POST /api/downloads/link?name=…&zone=temp|keep —— 签发一次性令牌
  if (p === `${DOWNLOADS_API_PREFIX}/link` && method === "POST") {
    const r = issueDownloadLink(cfg, url.searchParams.get("name") ?? "", zone);
    if (!r.ok) {
      replyJson(res, r.status, { error: r.error });
      return true;
    }
    replyJson(res, 200, {
      name: r.name,
      zone,
      size: r.size,
      token: r.link.token,
      expiresAt: r.link.expiresAt,
      maxUses: r.link.maxUses,
      path: DOWNLOAD_PATH,
    });
    return true;
  }

  // POST /api/downloads/delete?name=…&zone=… —— 删除文件并作废其令牌
  if (p === `${DOWNLOADS_API_PREFIX}/delete` && method === "POST") {
    if (!cfg.enabled) {
      replyJson(res, 403, { error: "下载功能未启用" });
      return true;
    }
    const raw = url.searchParams.get("name") ?? "";
    const entry = zone === "keep" ? resolveKeepEntry(cfg, raw) : resolveEntry(cfg, raw);
    if (!entry) {
      replyJson(res, 404, { error: "文件不存在或名称非法" });
      return true;
    }
    try {
      fs.unlinkSync(entry.abs);
      revokeTokensFor(entry.abs);
      log.info(`删除${zone === "keep" ? "常驻区" : "临时区"}文件 ${entry.name}`);
      replyJson(res, 200, { success: true, name: entry.name, zone });
    } catch (e) {
      replyJson(res, 500, { error: `删除失败：${String(e)}` });
    }
    return true;
  }

  replyJson(res, 404, { error: "未知下载接口" });
  return true;
}
