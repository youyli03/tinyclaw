/**
 * CLI 命令：start
 *
 * 将 tinyclaw 主服务作为后台守护进程启动。
 * stdout / stderr 全部重定向到 ~/.tinyclaw/service.log。
 * PID 由 main.ts 启动后自行写入 ~/.tinyclaw/.service_pid。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { bold, green, red, yellow, dim } from "../ui.js";

const TINYCLAW_DIR    = path.join(os.homedir(), ".tinyclaw");
const SERVICE_PID_FILE = path.join(TINYCLAW_DIR, ".service_pid");
export const SERVICE_LOG_FILE = path.join(TINYCLAW_DIR, "service.log");

// src/cli/commands/start.ts  →  ../../main.ts  →  src/main.ts
const MAIN_SCRIPT = new URL("../../main.ts", import.meta.url).pathname;

export const description = "在后台启动 tinyclaw 主服务";
export const usage = "start";

export async function run(_args: string[]): Promise<void> {
  // 检查是否已在运行
  if (fs.existsSync(SERVICE_PID_FILE)) {
    const pidRaw = fs.readFileSync(SERVICE_PID_FILE, "utf-8").trim();
    const pid = parseInt(pidRaw, 10);
    if (!isNaN(pid)) {
      try {
        process.kill(pid, 0); // signal 0：仅检查进程是否存在
        console.log(yellow(`tinyclaw 已在运行（PID ${bold(String(pid))}）`));
        console.log(dim(`日志：tinyclaw logs  或  tail -f ${SERVICE_LOG_FILE}`));
        return;
      } catch {
        // 进程不存在，清理残留 PID 文件
        try { fs.unlinkSync(SERVICE_PID_FILE); } catch { /* ignore */ }
      }
    }
  }

  // 确保目录存在
  fs.mkdirSync(TINYCLAW_DIR, { recursive: true });

  // 以追加模式打开日志文件，将 stdout/stderr 重定向进去
  const logFd = fs.openSync(SERVICE_LOG_FILE, "a");

  const child = spawn("bun", [MAIN_SCRIPT], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: process.env,
  });

  // 父进程不等待子进程
  child.unref();
  fs.closeSync(logFd);

  if (child.pid == null) {
    console.error(red("启动失败：无法获取子进程 PID"));
    process.exit(1);
  }

  // 等待 main.ts 写入 PID 文件（最多 3s，每 200ms 检查一次）
  let ready = false;
  for (let i = 0; i < 15; i++) {
    await new Promise<void>((r) => setTimeout(r, 200));
    if (fs.existsSync(SERVICE_PID_FILE)) { ready = true; break; }
  }

  const pid = ready
    ? fs.readFileSync(SERVICE_PID_FILE, "utf-8").trim()
    : String(child.pid);

  if (ready) {
    console.log(`${green("✓")} tinyclaw 已在后台启动（PID ${bold(pid)}）`);
  } else {
    console.log(`${yellow("⚠")} 进程已启动（PID ${bold(pid)}），但 PID 文件尚未写入，服务可能仍在初始化`);
  }
  console.log(dim(`日志：tinyclaw logs  或  tail -f ${SERVICE_LOG_FILE}`));
}
