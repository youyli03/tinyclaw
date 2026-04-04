/**
 * Dashboard HTTP Server
 * 端口: 4096（可通过 config [web] port 覆盖）
 *
 * 路由:
 *   /api/*  → api.ts 处理
 *   /*      → 静态文件服务（src/web/frontend/）
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
};

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): void {
  const parsedUrl = new URL(req.url ?? "/", "http://localhost");
  let filePath = parsedUrl.pathname;

  // SPA fallback：所有非文件路径都返回 index.html
  if (filePath === "/" || !path.extname(filePath)) {
    filePath = "/index.html";
  }

  const fullPath = path.join(FRONTEND_DIR, filePath);

  // 安全：防止路径穿越
  if (!fullPath.startsWith(FRONTEND_DIR)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  if (!fs.existsSync(fullPath)) {
    // 文件不存在也返回 index.html（SPA 路由）
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

export function startDashboard(port = 4096): void {
  if (_server) return;

  const server = http.createServer(async (req, res) => {
    // OPTIONS 预检
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "Access-Control-Allow-Origin": "*" });
      res.end();
      return;
    }

    // API 路由
    const handled = await handleApi(req, res);
    if (handled) return;

    // 静态文件
    serveStatic(req, res);
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`[dashboard] HTTP server started on http://0.0.0.0:${port}`);
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
