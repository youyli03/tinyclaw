/**
 * CLI 命令：restart
 *
 * 向正在运行的 tinyclaw 主进程发送 SIGTERM，等待其退出后自动重新启动。
 * 若服务未在运行，则直接启动。
 * 主进程 PID 由 src/main.ts 启动时写入 ~/.tinyclaw/.service_pid。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { bold, green, red, yellow, dim } from "../ui.js";
import { run as startRun } from "./start.js";

const SERVICE_PID_FILE = path.join(os.homedir(), ".tinyclaw", ".service_pid");

/** systemd user unit 名称(与 ~/.config/systemd/user/tinyclaw.service 对应) */
const SYSTEMD_UNIT = "tinyclaw.service";

export const description = "重启 tinyclaw 主服务(停止旧进程并重新启动)";
export const usage = "restart";

export async function run(_args: string[]): Promise<void> {
  // ── systemd 托管检测 ──────────────────────────────────────────────────────
  // 若服务由 systemd user unit 管理,直接交回 systemd 重启:
  // CLI 旧逻辑(detached spawn)拉起的进程不在 systemd 守护范围内,
  // supervisor crash 后无人拉起(2026-08-09 曾因此产生孤儿进程)。
  try {
    const state = execSync(`systemctl --user is-active ${SYSTEMD_UNIT}`, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    })
      .trim()
      .toLowerCase();
    if (state === "active" || state === "activating" || state === "reloading") {
      execSync(`systemctl --user restart ${SYSTEMD_UNIT}`, {
        stdio: "inherit",
        timeout: 30_000,
      });
      console.log(`${green("✓")} 已通过 systemd 重启 ${SYSTEMD_UNIT}(crash 后由 systemd 自动拉起)`);
      return;
    }
  } catch {
    /* systemd 不可用或 unit 不存在 → 走下方旧逻辑 */
  }

  // ── 停止旧进程 ──────────────────────────────────────────────────────────────
  if (!fs.existsSync(SERVICE_PID_FILE)) {
    console.log(yellow("找不到 PID 文件，服务未在运行，直接启动..."));
    await startRun([]);
    return;
  }

  let pid: number;
  try {
    pid = parseInt(fs.readFileSync(SERVICE_PID_FILE, "utf-8").trim(), 10);
  } catch (e) {
    console.error(red(`读取 PID 文件失败：${e}`));
    return;
  }

  if (!pid || isNaN(pid)) {
    console.error(red("PID 文件内容无效"));
    return;
  }

  // 检查进程是否存在
  let running = true;
  try {
    process.kill(pid, 0);
  } catch {
    running = false;
    console.log(yellow(`PID ${pid} 的进程不存在，直接启动新实例...`));
    try {
      fs.unlinkSync(SERVICE_PID_FILE);
    } catch {
      /* ignore */
    }
  }

  if (running) {
    try {
      process.kill(pid, "SIGTERM");
      console.log(`${green("✓")} 已向进程 ${bold(String(pid))} 发送 SIGTERM，等待退出...`);
    } catch (e) {
      console.error(red(`发送信号失败：${e}`));
      return;
    }

    // 等待旧进程退出（最多 5s，每 200ms 轮询一次）
    let exited = false;
    for (let i = 0; i < 25; i++) {
      await new Promise<void>((r) => setTimeout(r, 200));
      try {
        process.kill(pid, 0);
      } catch {
        exited = true;
        break;
      }
    }

    if (!exited) {
      console.log(yellow("旧进程未在 5s 内退出，强制终止..."));
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
      await new Promise<void>((r) => setTimeout(r, 300));
    }

    // 清理残留 PID 文件（main.ts 退出时会自己删，但防竞争再删一次）
    try {
      fs.unlinkSync(SERVICE_PID_FILE);
    } catch {
      /* ignore */
    }
  }

  // ── 启动新进程 ──────────────────────────────────────────────────────────────
  await startRun([]);
}
