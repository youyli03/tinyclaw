/**
 * Dashboard HTTP Server
 * 端口: 4096(可通过 config [web] port 覆盖)
 *
 * 路由:
 *   GET  /__login  → 登录表单(已登录则 302 到 /)
 *   POST /__login  → 提交 token(表单字段 token / Authorization: Bearer / X-Auth-Token)
 *   GET  /__logout → 退出确认页(不产生副作用)
 *   POST /__logout → 退出登录(清 cookie + 删会话)
 *   /api/*         → api.ts 处理(需鉴权)
 *   /*             → 静态文件服务(src/web/frontend/)(需鉴权)
 *
 * 鉴权(2026-09 加固):
 *   - token 只从 **POST 表单体** 或 **Authorization: Bearer / X-Auth-Token 头**读取,
 *     不再从 URL query 读取 —— URL 会进 Cloudflare/反代访问日志、浏览器历史与 Referer
 *   - 登录成功种 `dash_token` cookie,值是**随机 256bit 会话 id**(不是 token 本身),
 *     服务端内存 Map 保存「会话 id → 过期时间」;有活动即续期;进程重启全部会话失效
 *   - token 比较先各自 sha256 再 timingSafeEqual(常量时间,不泄漏长度与前缀)
 *   - 登录失败按来源限速(单来源 8 次/10min、全局 32 次 → 锁 15min);
 *     **正确 token 一律放行**,所以攻击者无法用错误 token 把真实用户锁在门外
 *   - 除 /__login、/__logout 外**所有路径**都鉴权(含静态资源):
 *     登录页是自包含 HTML,不需要任何外部静态资源,无需按扩展名放行
 *   - 统一安全响应头: nosniff / Referrer-Policy: no-referrer / X-Frame-Options: SAMEORIGIN
 */

import * as http from "node:http";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import * as path from "node:path";
import * as url from "node:url";
import * as zlib from "node:zlib";
import { handleApi } from "./api.js";
import {
  DOWNLOAD_PATH,
  handleDownloadRoute,
  handleDownloadsApi,
  resetDownloadTokens,
  type DownloadsConfig,
} from "./downloads.js";
import { createLogger } from "../../utils/logger.js";

const log = createLogger("dashboard");

// 可压缩的文本类 MIME(前缀匹配)
const COMPRESSIBLE = [
  "text/",
  "application/javascript",
  "application/json",
  "image/svg+xml",
  "application/manifest+json",
];
function isCompressible(contentType: string): boolean {
  return COMPRESSIBLE.some((p) => contentType.startsWith(p));
}
function acceptsGzip(req: http.IncomingMessage): boolean {
  const ae = req.headers["accept-encoding"];
  return typeof ae === "string" && ae.includes("gzip");
}
// 内存缓存:对不变的 vendor / 版本化资源,压缩一次后复用 buffer,避免每次请求重复 gzip
const gzipCache = new Map<string, Buffer>();

// index.html 的"渲染后 HTML + gzip"缓存（按内容 sha1 失效，见 serveIndexHtml）
let _indexCache: { digest: string; html: string; gzip: Buffer } | null = null;

const FRONTEND_DIR = path.join(
  path.dirname(url.fileURLToPath(import.meta.url)),
  "../../web/frontend"
);

/**
 * 构建版本号 = 前端内容（index.html / main.js / style.css）的 sha1 前 12 位。
 *
 * 刻意**不用** `Date.now()`：那样每次重启版本号都变，浏览器里 `max-age=1年` 的
 * vendor JS（vue/chart/adapter/main ≈ 500KB）会被全部重下 —— 在慢速公网链路上首屏要多等好几秒。
 * 用内容哈希后，前端没改的重启不刷任何缓存；前端一改版本号自动变。
 * 启动时算一次（不是每请求算）：静态资源的 gzip 结果本身也是按路径缓存在进程里的。
 */
const BUILD_VERSION = computeBuildVersion();

function computeBuildVersion(): string {
  const h = crypto.createHash("sha1");
  // 顺序固定；缺文件也要产出确定值，不能因为前端文件缺失让服务起不来
  for (const f of ["index.html", "main.js", "style.css"]) {
    try {
      h.update(fs.readFileSync(path.join(FRONTEND_DIR, f)));
    } catch {
      h.update(`missing:${f}`);
    }
  }
  return h.digest("hex").slice(0, 12);
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".mjs": "application/javascript; charset=utf-8",
};

// ── cookie 解析 ───────────────────────────────────────────────────────────────

function parseCookies(req: http.IncomingMessage): Record<string, string> {
  const raw = req.headers["cookie"] ?? "";
  const result: Record<string, string> = {};
  for (const part of raw.split(";")) {
    const [k, ...vs] = part.trim().split("=");
    if (k) result[k.trim()] = decodeURIComponent(vs.join("=").trim());
  }
  return result;
}

// ── 鉴权:常量与状态 ───────────────────────────────────────────────────────────

const COOKIE_NAME = "dash_token";
/** 会话有效期(活动即续期) */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 天
const LOGIN_PATH = "/__login";
const LOGOUT_PATH = "/__logout";
/** 登录请求体上限(表单字段足够) */
const LOGIN_BODY_LIMIT = 4 * 1024;
/** 失败阈值:单来源 / 全局 */
const MAX_FAILURES_PER_CLIENT = 8;
const MAX_FAILURES_GLOBAL = 32;
/** 失败统计窗口 / 锁定时长 */
const FAILURE_WINDOW_MS = 10 * 60 * 1000;
const LOCKOUT_MS = 15 * 60 * 1000;
/** failures 表上限(防内存增长) */
const MAX_TRACKED_CLIENTS = 512;

interface Session {
  expiresAt: number;
}
interface FailureState {
  count: number;
  windowStart: number;
  lockedUntil: number;
}

/** 会话 id → 过期时间(仅内存;进程重启即全部失效) */
const sessions = new Map<string, Session>();
/** 来源 → 失败状态 */
const failures = new Map<string, FailureState>();
let globalFailures: FailureState = { count: 0, windowStart: 0, lockedUntil: 0 };

// ── 鉴权:工具 ─────────────────────────────────────────────────────────────────

/**
 * 统一安全响应头。
 * 用 setHeader 而不是 writeHead:后续 api/静态资源分支自己 writeHead 时会合并这些头。
 * X-Frame-Options 用 SAMEORIGIN 而不是 DENY —— 笔记页的 PDF 走同源 <iframe> 预览。
 */
function applySecurityHeaders(res: http.ServerResponse): void {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "SAMEORIGIN");
}

/**
 * 常量时间比较。
 * 先各自 sha256 再 timingSafeEqual:两侧长度恒定,既不泄漏长度也不会因长度不等抛异常。
 */
function secretEquals(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a, "utf8").digest();
  const hb = crypto.createHash("sha256").update(b, "utf8").digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * 限速 / 审计用的来源标识。
 * 直连(局域网)时只用 socket 地址 —— CF-Connecting-IP 在直连链路上是客户端可伪造的;
 * 只有请求来自本机回环(cloudflared 跑在本机)时才信任该头。
 */
function clientKey(req: http.IncomingMessage): string {
  const sock = req.socket.remoteAddress ?? "unknown";
  const loopback = sock === "127.0.0.1" || sock === "::1" || sock === "::ffff:127.0.0.1";
  if (loopback) {
    const cf = req.headers["cf-connecting-ip"];
    if (typeof cf === "string" && cf.trim()) return `cf:${cf.trim()}`;
  }
  return `sock:${sock}`;
}

/** 从 Authorization: Bearer / X-Auth-Token 头取 token(脚本与 curl 的无状态入口) */
function headerToken(req: http.IncomingMessage): string | null {
  const auth = req.headers.authorization;
  if (typeof auth === "string") {
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (m && m[1]) return m[1].trim();
  }
  const x = req.headers["x-auth-token"];
  if (typeof x === "string" && x.trim()) return x.trim();
  return null;
}

/** 请求是否经反代以 HTTPS 到达(cloudflared 会带 X-Forwarded-Proto) */
function isHttpsRequest(req: http.IncomingMessage): boolean {
  const proto = req.headers["x-forwarded-proto"];
  if (typeof proto !== "string") return false;
  return proto.split(",")[0]?.trim().toLowerCase() === "https";
}

function sessionCookie(id: string, req: http.IncomingMessage): string {
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  // Secure 只在反代确认是 HTTPS 时加:明文局域网直连时加了会导致登录态无法保存
  const secure = isHttpsRequest(req) ? "; Secure" : "";
  return `${COOKIE_NAME}=${id}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`;
}

function clearCookie(): string {
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax`;
}

function pruneSessions(now: number): void {
  for (const [id, s] of sessions) if (s.expiresAt <= now) sessions.delete(id);
}

function createSession(now: number): string {
  pruneSessions(now);
  const id = crypto.randomBytes(32).toString("base64url");
  sessions.set(id, { expiresAt: now + SESSION_TTL_MS });
  return id;
}

/** 校验会话并滑动续期 */
function sessionValid(id: string | undefined, now: number): boolean {
  if (!id) return false;
  const s = sessions.get(id);
  if (!s) return false;
  if (s.expiresAt <= now) {
    sessions.delete(id);
    return false;
  }
  s.expiresAt = now + SESSION_TTL_MS;
  return true;
}

function isLocked(st: FailureState, now: number): boolean {
  return st.lockedUntil > now;
}

function addFailure(st: FailureState, max: number, now: number): FailureState {
  const base =
    now - st.windowStart > FAILURE_WINDOW_MS
      ? { count: 0, windowStart: now, lockedUntil: 0 }
      : { count: st.count, windowStart: st.windowStart, lockedUntil: st.lockedUntil };
  const next: FailureState = { ...base, count: base.count + 1 };
  if (next.count >= max) next.lockedUntil = now + LOCKOUT_MS;
  return next;
}

function noteClientFailure(key: string, now: number): void {
  if (failures.size > MAX_TRACKED_CLIENTS) {
    for (const [k, v] of failures) {
      if (v.lockedUntil <= now && now - v.windowStart > FAILURE_WINDOW_MS) failures.delete(k);
    }
    if (failures.size > MAX_TRACKED_CLIENTS) failures.clear();
  }
  const cur = failures.get(key) ?? { count: 0, windowStart: now, lockedUntil: 0 };
  failures.set(key, addFailure(cur, MAX_FAILURES_PER_CLIENT, now));
}

function replyJson(res: http.ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
}

/** 读请求体(超限则丢弃后续字节但仍读完,避免连接挂住) */
function readBody(req: http.IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        tooLarge = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) reject(new Error("请求体过大"));
      else resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
  });
}

/**
 * 非安全方法的跨站校验(未来新增写接口时的 CSRF 兜底)。
 *
 * 用 `Sec-Fetch-Site`,**不要**用 Origin/Host 比对:本机链路上 cloudflared 会把 Host 改写成
 * 回源地址(127.0.0.1:4096),Origin 与 Host 永远对不上 → 真实用户登录 POST 直接被 403(踩过)。
 * Sec-Fetch-Site 由浏览器给出,与代理改写无关:
 *   - `cross-site` → 判为跨站
 *   - 其他值 / 缺失(curl、服务端调用、老浏览器) → 放行
 * 主防线仍是会话 cookie 的 `SameSite=Lax`:跨站请求根本不带 cookie。
 */
function crossSiteRequest(req: http.IncomingMessage): boolean {
  const method = (req.method ?? "GET").toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false;
  const site = req.headers["sec-fetch-site"];
  return typeof site === "string" && site.trim().toLowerCase() === "cross-site";
}

// ── 登录页 ────────────────────────────────────────────────────────────────────

function sendLoginPage(res: http.ServerResponse, status: number, errText: string | null): void {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(`<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1">
<title>需要认证 — tinyclaw dashboard</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC",sans-serif;
       background:#F5F7FF;display:flex;align-items:center;justify-content:center;min-height:100vh}
  .box{background:#fff;border:1px solid #E8EEFF;border-radius:12px;padding:40px 36px;
       max-width:360px;width:90%;text-align:center;box-shadow:0 4px 24px rgba(79,126,248,0.10)}
  .logo{font-size:20px;font-weight:700;color:#4F7EF8;margin-bottom:4px}
  .sub{font-size:12px;color:#B0B8D4;margin-bottom:28px}
  input{width:100%;padding:10px 14px;border:1px solid #E8EEFF;border-radius:8px;
        font-size:14px;outline:none;margin-bottom:12px;background:#F5F7FF}
  input:focus{border-color:#4F7EF8;background:#fff}
  button{width:100%;padding:11px;background:#4F7EF8;color:#fff;border:none;
         border-radius:8px;font-size:14px;font-weight:600;cursor:pointer;transition:opacity .15s}
  button:hover{opacity:.88}
  .err{font-size:12px;color:#FF6961;margin-top:10px;display:${errText ? "block" : "none"}}
  .tip{font-size:11px;color:#B0B8D4;margin-top:14px;line-height:1.6}
</style>
</head>
<body>
<form class="box" method="post" action="${LOGIN_PATH}">
  <div class="logo">tinyclaw</div>
  <div class="sub">dashboard</div>
  <input type="password" name="token" placeholder="访问令牌" autocomplete="current-password" autofocus>
  <button type="submit">进入</button>
  <div class="err">${errText ?? ""}</div>
  <div class="tip">令牌见 ~/.tinyclaw/config.toml 的 [web] token</div>
</form>
</body></html>`);
}

function sendLogoutPage(res: http.ServerResponse): void {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(`<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>退出登录 — tinyclaw dashboard</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;background:#F5F7FF;
             display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0">
<form method="post" action="${LOGOUT_PATH}" style="background:#fff;border:1px solid #E8EEFF;border-radius:12px;
      padding:32px;text-align:center">
  <div style="font-size:16px;font-weight:600;color:#4F7EF8;margin-bottom:16px">退出登录</div>
  <button type="submit" style="padding:10px 20px;background:#4F7EF8;color:#fff;border:none;
          border-radius:8px;font-size:14px;font-weight:600;cursor:pointer">确认退出</button>
</form>
</body></html>`);
}

// ── 登录 / 退出 ───────────────────────────────────────────────────────────────

async function handleLoginRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  configToken: string
): Promise<void> {
  const method = (req.method ?? "GET").toUpperCase();
  const parsedUrl = new URL(req.url ?? "/", "http://localhost");
  const now = Date.now();

  if (method === "GET") {
    if (sessionValid(parseCookies(req)[COOKIE_NAME], now)) {
      res.writeHead(302, { Location: "/", "Cache-Control": "no-store" });
      res.end();
      return;
    }
    const e = parsedUrl.searchParams.get("e");
    const errText = e === "1" ? "令牌错误，请重试" : e === "2" ? "尝试过于频繁，请稍后再试" : null;
    sendLoginPage(res, 200, errText);
    return;
  }

  if (method !== "POST") {
    res.writeHead(405, { Allow: "GET, POST", "Cache-Control": "no-store" });
    res.end();
    return;
  }

  const key = clientKey(req);

  let submitted = headerToken(req) ?? "";
  if (!submitted) {
    try {
      const body = await readBody(req, LOGIN_BODY_LIMIT);
      submitted = (new URLSearchParams(body).get("token") ?? "").trim();
    } catch {
      replyJson(res, 413, { error: "请求体过大" });
      return;
    }
  }

  // 正确 token 一律放行(即使此刻处于锁定窗口):攻击者无法用错误 token 把真实用户锁在门外
  if (submitted && secretEquals(submitted, configToken)) {
    failures.delete(key);
    globalFailures = { count: 0, windowStart: now, lockedUntil: 0 };
    const id = createSession(now);
    log.info(`登录成功（${key}，会话数 ${sessions.size}）`);
    res.writeHead(303, {
      "Set-Cookie": sessionCookie(id, req),
      Location: "/",
      "Cache-Control": "no-store",
    });
    res.end();
    return;
  }

  // 限速只约束**失败**的请求:阈值内 401,超阈值 429
  const st = failures.get(key) ?? { count: 0, windowStart: now, lockedUntil: 0 };
  if (isLocked(st, now) || isLocked(globalFailures, now)) {
    const until = Math.max(st.lockedUntil, globalFailures.lockedUntil);
    res.setHeader("Retry-After", String(Math.max(1, Math.ceil((until - now) / 1000))));
    log.warn(`登录被限速拒绝（${key}）`);
    if ((req.headers.accept ?? "").includes("text/html")) {
      res.writeHead(303, { Location: `${LOGIN_PATH}?e=2`, "Cache-Control": "no-store" });
      res.end();
      return;
    }
    replyJson(res, 429, { error: "登录尝试过于频繁，请稍后再试" });
    return;
  }

  noteClientFailure(key, now);
  globalFailures = addFailure(globalFailures, MAX_FAILURES_GLOBAL, now);
  const count = failures.get(key)?.count ?? 1;
  log.warn(`登录失败（${key}，本来源 ${count}/${MAX_FAILURES_PER_CLIENT}）`);
  const wantsHtml = (req.headers.accept ?? "").includes("text/html");
  if (wantsHtml) {
    res.writeHead(303, { Location: `${LOGIN_PATH}?e=1`, "Cache-Control": "no-store" });
    res.end();
    return;
  }
  replyJson(res, 401, { error: "令牌错误" });
}

function handleLogoutRoute(req: http.IncomingMessage, res: http.ServerResponse): void {
  const method = (req.method ?? "GET").toUpperCase();

  if (method === "POST") {
    const sid = parseCookies(req)[COOKIE_NAME];
    if (sid) sessions.delete(sid);
    log.info(`退出登录（${clientKey(req)}，剩余会话 ${sessions.size}）`);
    res.writeHead(303, {
      "Set-Cookie": clearCookie(),
      Location: LOGIN_PATH,
      "Cache-Control": "no-store",
    });
    res.end();
    return;
  }

  if (method === "GET") {
    // GET 不产生副作用(避免被跨站 img/link 触发登出),只给一个确认按钮
    sendLogoutPage(res);
    return;
  }

  res.writeHead(405, { Allow: "GET, POST", "Cache-Control": "no-store" });
  res.end();
}

// ── 鉴权入口 ──────────────────────────────────────────────────────────────────

/**
 * 检查请求是否已通过认证。
 *
 * 返回 true 表示已处理(拦截),false 表示放行继续处理。
 * token 未配置时直接放行(启动时已打告警)。
 */
async function handleAuth(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  configToken: string | undefined
): Promise<boolean> {
  applySecurityHeaders(res);

  if (!configToken) return false;

  if (crossSiteRequest(req)) {
    const origin = req.headers.origin ?? "-";
    const host = req.headers.host ?? "-";
    const xfh = req.headers["x-forwarded-host"] ?? "-";
    log.warn(
      `拒绝:跨站请求（${clientKey(req)} ${req.method} origin=${origin} host=${host} xfh=${xfh}）`
    );
    replyJson(res, 403, { error: "跨站请求被拒绝" });
    return true;
  }

  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  const now = Date.now();

  if (pathname === LOGIN_PATH) {
    await handleLoginRoute(req, res, configToken);
    return true;
  }
  if (pathname === LOGOUT_PATH) {
    handleLogoutRoute(req, res);
    return true;
  }

  // 1) 无状态入口:Authorization: Bearer / X-Auth-Token(给 curl 与脚本用,不进 URL)
  const viaHeader = headerToken(req);
  if (viaHeader) {
    if (secretEquals(viaHeader, configToken)) return false;
    log.warn(`拒绝:请求头中的令牌错误（${clientKey(req)} ${req.method} ${pathname}）`);
    replyJson(res, 401, { error: "未认证" });
    return true;
  }

  // 2) 会话 cookie
  if (sessionValid(parseCookies(req)[COOKIE_NAME], now)) return false;

  // 3) 未认证
  log.warn(`拒绝:未认证访问（${clientKey(req)} ${req.method} ${pathname}）`);
  res.setHeader("WWW-Authenticate", 'Bearer realm="tinyclaw-dashboard"');
  if (pathname === "/api" || pathname.startsWith("/api/")) {
    replyJson(res, 401, {
      error: "未认证:请先 POST /__login 登录,或带 Authorization: Bearer <token>",
    });
    return true;
  }
  sendLoginPage(res, 401, null);
  return true;
}

// ── 静态文件服务 ──────────────────────────────────────────────────────────────

function serveIndexHtml(res: http.ServerResponse, req?: http.IncomingMessage): void {
  const indexPath = path.join(FRONTEND_DIR, "index.html");
  const raw = fs.readFileSync(indexPath, "utf-8");

  // 渲染 + gzip 结果缓存：index.html 是 `no-store`（每次都要判版本），
  // 但内容本身只在改前端时变。原来每个请求都做一遍 readFile + 3 次 replace + gzip，
  // 现在只按内容 sha1 判断是否需要重算（读 27KB + 哈希 ≈ 0.1ms，gzip ≈ 2ms）。
  const digest = crypto.createHash("sha1").update(raw).digest("hex");
  if (!_indexCache || _indexCache.digest !== digest) {
    // 注入版本号，强制浏览器获取最新 JS/CSS
    // 版本号是**前端内容的哈希、不是启动时间戳**：重启但前端没改 → 版本号不变 → 缓存继续有效
    // 同时把构建号写到 <html data-build>：界面右下角显示后 6 位，用来判断"手机上跑的是不是新版本"
    const html = raw
      .replace(/<html([^>]*)>/, `<html$1 data-build="${BUILD_VERSION}">`)
      .replace(/\/main\.js"/g, `/main.js?v=${BUILD_VERSION}"`)
      .replace(/\/style\.css"/g, `/style.css?v=${BUILD_VERSION}"`);
    _indexCache = { digest, html, gzip: zlib.gzipSync(html) };
  }

  const headers: Record<string, string> = {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  };
  if (req && acceptsGzip(req)) {
    headers["Content-Encoding"] = "gzip";
    headers["Vary"] = "Accept-Encoding";
    res.writeHead(200, headers);
    res.end(_indexCache.gzip);
  } else {
    res.writeHead(200, headers);
    res.end(_indexCache.html);
  }
}

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): void {
  const parsedUrl = new URL(req.url ?? "/", "http://localhost");
  let filePath = parsedUrl.pathname;

  if (filePath === "/" || !path.extname(filePath)) {
    filePath = "/index.html";
  }

  const fullPath = path.join(FRONTEND_DIR, filePath);

  if (!fullPath.startsWith(FRONTEND_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  if (!fs.existsSync(fullPath)) {
    const indexPath = path.join(FRONTEND_DIR, "index.html");
    if (fs.existsSync(indexPath)) {
      serveIndexHtml(res, req);
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
    return;
  }

  const ext = path.extname(fullPath);
  // index.html 动态注入版本号（强制不缓存 + 给 JS/CSS 加 ?v= 查询参数）
  if (fullPath.endsWith("index.html")) {
    serveIndexHtml(res, req);
    return;
  }
  const contentType = MIME[ext] ?? "application/octet-stream";
  // main.js / style.css 已通过 ?v=<前端内容哈希> 实现版本化，可以长期缓存
  // 第三方 vendor 库（chart.umd、vue.global、marked、chartjs-adapter）同样不变，1 年缓存
  // 其余资源（图片等）走默认缓存
  // ⚠️ 必须用 private：用 public 会被 Cloudflare 边缘缓存，之后**不带任何凭证也能取到**
  // （实测未登录 GET /main.js → 200 + cf-cache-status: HIT）。private 只禁共享缓存，
  // 浏览器自身的缓存行为不变。
  const fileName = path.basename(fullPath);
  const hasVersion = parsedUrl.searchParams.has("v");
  const isVersioned = hasVersion || fileName.includes(".min.") || fileName.includes("vue.global");
  const cacheControl = isVersioned
    ? "private, max-age=31536000, immutable" // 1 年，不变
    : "private, max-age=3600"; // 其他资源 1 小时
  const headers: Record<string, string> = {
    "Content-Type": contentType,
    "Cache-Control": cacheControl,
  };

  // gzip 压缩:仅对文本类资源 + 客户端支持时启用
  if (acceptsGzip(req) && isCompressible(contentType)) {
    headers["Content-Encoding"] = "gzip";
    headers["Vary"] = "Accept-Encoding";
    if (isVersioned) {
      let buf = gzipCache.get(fullPath);
      if (!buf) {
        buf = zlib.gzipSync(fs.readFileSync(fullPath));
        gzipCache.set(fullPath, buf);
      }
      res.writeHead(200, headers);
      res.end(buf);
    } else {
      const buf = zlib.gzipSync(fs.readFileSync(fullPath));
      res.writeHead(200, headers);
      res.end(buf);
    }
    return;
  }

  res.writeHead(200, headers);
  fs.createReadStream(fullPath).pipe(res);
}

// ── 服务入口 ──────────────────────────────────────────────────────────────────

let _server: http.Server | null = null;

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  token: string | undefined,
  downloads: DownloadsConfig | undefined
): Promise<void> {
  if (req.method === "OPTIONS") {
    // 不再返回 Access-Control-Allow-Origin：Dashboard 是同源应用，不需要 CORS，
    // 而通配 CORS 会让任意网站在浏览器里直接读走数据接口
    res.writeHead(204);
    res.end();
    return;
  }

  // /dl 免会话：它只认一次性下载令牌（downloads 模块内部 fail-closed）。
  // 这是唯一绕过会话鉴权的路径，所以必须**精确匹配**，且只交给 downloads 模块处理。
  if (new URL(req.url ?? "/", "http://localhost").pathname === DOWNLOAD_PATH) {
    applySecurityHeaders(res);
    if (!downloads?.enabled) {
      replyJson(res, 404, { error: "下载功能未启用" });
      return;
    }
    await handleDownloadRoute(req, res, downloads);
    return;
  }

  if (await handleAuth(req, res, token)) return;

  if (downloads && (await handleDownloadsApi(req, res, downloads))) return;

  const handled = await handleApi(req, res);
  if (handled) return;

  serveStatic(req, res);
}

export function startDashboard(port = 4096, token?: string, downloads?: DownloadsConfig): void {
  if (_server) return;

  const server = http.createServer((req, res) => {
    void handleRequest(req, res, token, downloads).catch((e: unknown) => {
      log.error(`请求处理失败: ${String(e)}`);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify({ error: "服务器内部错误" }));
      } else {
        res.end();
      }
    });
  });

  server.listen(port, "0.0.0.0", () => {
    log.info(`HTTP server started on http://0.0.0.0:${port}${token ? " (auth enabled)" : ""}`);
    if (!token) {
      log.warn("未配置 [web].token：Dashboard 无鉴权，任何能访问该端口的客户端都能读取全部数据");
    }
    if (downloads?.enabled) {
      log.info(
        `下载页已启用（令牌 ${downloads.linkTtlSecs}s / 最多 ${downloads.maxUses} 次 / 单文件 ${downloads.maxFileMb}MB）`
      );
    }
  });

  server.on("error", (err) => {
    log.error(`Server error: ${String(err)}`);
  });

  _server = server;
}

export function stopDashboard(): void {
  sessions.clear();
  failures.clear();

  resetDownloadTokens();
  _server?.close();
  _server = null;
}
