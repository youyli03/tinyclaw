/**
 * Dashboard HTTP Server
 * 端口: 4096(可通过 config [web] port 覆盖)
 *
 * 路由:
 *   /api/*  → api.ts 处理
 *   /*      → 静态文件服务(src/web/frontend/)
 *
 * 鉴权:
 *   config [web] token 设置后启用。
 *   首次访问带 ?token=xxx → 验证通过后种 cookie dash_token，后续凭 cookie 访问。
 *   静态资源(.js/.css/.ico 等)不鉴权，避免认证页面加载失败。
 */

import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as url from "node:url";
import { handleApi } from "./api.js";

const FRONTEND_DIR = path.join(
  path.dirname(url.fileURLToPath(import.meta.url)),
  "../../web/frontend"
);

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".json": "application/json",
  ".png":  "image/png",
  ".ico":  "image/x-icon",
  ".svg":  "image/svg+xml",
  ".webp": "image/webp",
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

// ── 鉴权中间件 ────────────────────────────────────────────────────────────────

const COOKIE_NAME = "dash_token";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 天

/**
 * 检查请求是否已通过认证。
 * - token 未配置 → 直接放行
 * - 有合法 cookie → 放行
 * - URL 带 ?token=xxx 且匹配 → 种 cookie 并重定向到去掉 token 的 URL
 * - 否则 → 返回 401 登录页
 *
 * 返回 true 表示已处理（拦截），false 表示放行继续处理。
 */
function checkAuth(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  configToken: string | undefined
): boolean {
  if (!configToken) return false;

  const parsedUrl = new URL(req.url ?? "/", "http://localhost");
  const ext = path.extname(parsedUrl.pathname);

  // 静态资源（JS/CSS 等）不鉴权，防止登录页本身加载失败
  if (ext && ext !== ".html") return false;

  // 检查 cookie
  const cookies = parseCookies(req);
  if (cookies[COOKIE_NAME] === configToken) return false;

  // 检查 URL token
  const urlToken = parsedUrl.searchParams.get("token");
  if (urlToken === configToken) {
    parsedUrl.searchParams.delete("token");
    const cleanUrl = parsedUrl.pathname + (parsedUrl.search || "");
    res.writeHead(302, {
      "Set-Cookie": `${COOKIE_NAME}=${encodeURIComponent(configToken)}; Path=/; Max-Age=${COOKIE_MAX_AGE}; HttpOnly; SameSite=Lax`,
      "Location": cleanUrl,
    });
    res.end();
    return true;
  }

  // 未通过认证 → 返回登录页
  res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
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
  .err{font-size:12px;color:#FF6961;margin-top:10px;display:none}
</style>
</head>
<body>
<div class="box">
  <div class="logo">tinyclaw</div>
  <div class="sub">dashboard</div>
  <input type="password" id="t" placeholder="访问令牌" autofocus
         onkeydown="if(event.key==='Enter')go()">
  <button onclick="go()">进入</button>
  <div class="err" id="err">令牌错误，请重试</div>
</div>
<script>
const params = new URLSearchParams(location.search);
if (params.get("auth") === "fail") {
  document.getElementById("err").style.display = "block";
}
function go() {
  const t = document.getElementById("t").value.trim();
  if (t) location.href = location.pathname + "?token=" + encodeURIComponent(t);
}
</script>
</body></html>`);
  return true;
}

// ── 静态文件服务 ──────────────────────────────────────────────────────────────

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
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      fs.createReadStream(indexPath).pipe(res);
    } else {
      res.writeHead(404);
      res.end("Not found");
    }
    return;
  }

  const ext = path.extname(fullPath);
  const contentType = MIME[ext] ?? "application/octet-stream";
  res.writeHead(200, { "Content-Type": contentType });
  fs.createReadStream(fullPath).pipe(res);
}

let _server: http.Server | null = null;

export function startDashboard(port = 4096, token?: string): void {
  if (_server) return;

  const server = http.createServer(async (req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "Access-Control-Allow-Origin": "*" });
      res.end();
      return;
    }

    if (checkAuth(req, res, token)) return;

    const handled = await handleApi(req, res);
    if (handled) return;

    serveStatic(req, res);
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`[dashboard] HTTP server started on http://0.0.0.0:${port}${token ? " (auth enabled)" : ""}`);
  });

  server.on("error", (err) => {
    console.error("[dashboard] Server error:", err);
  });

  _server = server;
}

export function stopDashboard(): void {
  _server?.close();
  _server = null;
}
