/**
 * tinyclaw 进程守护（supervisor）
 *
 * 职责：
 * 1. 启动 main.ts 子进程
 * 2. 若子进程以非 0 退出码崩溃，按退避策略重启
 * 3. 收到 SIGTERM / SIGINT 时，将信号转发给子进程并随之优雅退出
 *
 * start.ts 启动的是此 supervisor，不是直接启动 main.ts。
 * PID 文件写入此 supervisor 自身的 PID，使 `tinyclaw restart` 能正确终止整个进程树。
 */

// ── 全局日志时间戳注入 ────────────────────────────────────────────────────────
{
  const _log = console.log.bind(console);
  const _err = console.error.bind(console);
  const _warn = console.warn.bind(console);
  const ts = () => new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log   = (...a) => _log(`[${ts()}]`, ...a);
  console.error = (...a) => _err(`[${ts()}]`, ...a);
  console.warn  = (...a) => _warn(`[${ts()}]`, ...a);
}

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const SERVICE_PID_FILE = path.join(os.homedir(), ".tinyclaw", ".service_pid");
const MAIN_SCRIPT = new URL("./main.ts", import.meta.url).pathname;

const RESTART_DELAYS_MS = [2_000, 5_000, 10_000, 30_000, 60_000];
const MAX_RESTARTS = 20;

let restartCount = 0;
let child: ChildProcess | null = null;
let shuttingDown = false;

// 启动前检查并清理残留的旧实例（防止多个 supervisor 并行运行）
async function killStaleInstance(): Promise<void> {
  if (!fs.existsSync(SERVICE_PID_FILE)) return;
  let stalePid: number;
  try {
    stalePid = parseInt(fs.readFileSync(SERVICE_PID_FILE, "utf-8").trim(), 10);
  } catch { return; }
  if (!stalePid || isNaN(stalePid) || stalePid === process.pid) return;
  try { process.kill(stalePid, 0); } catch { return; } // 进程不存在，无需清理

  console.log(`[supervisor] 发现残留实例（PID ${stalePid}），正在终止…`);
  try { process.kill(stalePid, "SIGTERM"); } catch { return; }

  // 等待最多 5s 让旧进程优雅退出
  for (let i = 0; i < 25; i++) {
    await new Promise<void>((r) => setTimeout(r, 200));
    try { process.kill(stalePid, 0); } catch { return; } // 已退出
  }

  // 超时：强制终止
  console.warn(`[supervisor] 旧实例未在 5s 内退出，强制终止（SIGKILL）`);
  try { process.kill(stalePid, "SIGKILL"); } catch { /* already gone */ }
  await new Promise<void>((r) => setTimeout(r, 300));
}

await killStaleInstance();

// 写入 supervisor 自身的 PID（restart 命令 kill 此 PID → supervisor 转发给 main → 优雅退出）
try {
  fs.mkdirSync(path.dirname(SERVICE_PID_FILE), { recursive: true });
  fs.writeFileSync(SERVICE_PID_FILE, String(process.pid), "utf-8");
} catch { /* ignore */ }

function startChild(): void {
  if (shuttingDown) return;

  child = spawn("node", ["--import", "tsx/esm", MAIN_SCRIPT], {
    stdio: "inherit",
    env: process.env,
  });

  child.on("exit", (code, signal) => {
    child = null;

    // 正常退出（主动 SIGTERM/SIGINT 或 exit(0)）→ supervisor 也退出
    if (shuttingDown || code === 0) {
      cleanup();
      process.exit(code ?? 0);
    }

    // 主动重启请求（exit code 75）：立即重启，不计入崩溃次数
    if (code === 75) {
      console.log("[supervisor] 收到主动重启请求，立即重启...");
      setTimeout(startChild, 100);
      return;
    }

    console.error(
      `[supervisor] main.ts 异常退出（code=${code ?? "null"}, signal=${signal ?? "null"}）`
    );

    if (restartCount >= MAX_RESTARTS) {
      console.error(`[supervisor] 已重启 ${MAX_RESTARTS} 次，放弃重启`);
      cleanup();
      process.exit(1);
    }

    const delay =
      RESTART_DELAYS_MS[Math.min(restartCount, RESTART_DELAYS_MS.length - 1)] ??
      RESTART_DELAYS_MS[RESTART_DELAYS_MS.length - 1]!;
    restartCount++;
    console.log(
      `[supervisor] ${delay / 1000}s 后重启（第 ${restartCount} 次）…`
    );
    setTimeout(startChild, delay);
  });
}

function cleanup(): void {
  try { fs.unlinkSync(SERVICE_PID_FILE); } catch { /* ignore */ }
}

function handleSignal(signal: "SIGTERM" | "SIGINT"): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[supervisor] 收到 ${signal}，转发给子进程…`);
  if (child) {
    child.kill(signal);
    // 若子进程 5s 内未退出，强制终止
    setTimeout(() => {
      if (child) {
        console.warn("[supervisor] 子进程超时未退出，强制终止");
        child.kill("SIGKILL");
      }
    }, 5_000).unref();
  } else {
    cleanup();
    process.exit(0);
  }
}

process.on("SIGTERM", () => handleSignal("SIGTERM"));
process.on("SIGINT",  () => handleSignal("SIGINT"));

startChild();
