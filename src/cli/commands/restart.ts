/**
 * CLI 命令：restart
 *
 * 向正在运行的 tinyclaw 主进程发送 SIGTERM 信号，触发优雅退出。
 * 主进程 PID 由 src/main.ts 启动时写入 ~/.tinyclaw/.service_pid。
 *
 * 若使用 `bun dev`（--watch 模式），Bun 会在进程退出后自动重启。
 * 若使用 `bun start`，SIGTERM 后需要手动重新启动。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { bold, green, red, yellow, dim } from "../ui.js";

const SERVICE_PID_FILE = path.join(os.homedir(), ".tinyclaw", ".service_pid");

export const description = "重启 tinyclaw 主服务（发送 SIGTERM）";
export const usage = "restart";

export async function run(_args: string[]): Promise<void> {
  if (!fs.existsSync(SERVICE_PID_FILE)) {
    console.log(yellow("找不到 PID 文件，tinyclaw 可能未在运行。"));
    console.log(dim(`PID 文件路径：${SERVICE_PID_FILE}`));
    console.log(dim("请确认已通过 `bun start` 或 `bun dev` 启动 tinyclaw。"));
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
  try {
    process.kill(pid, 0);
  } catch {
    console.log(yellow(`PID ${pid} 的进程不存在，tinyclaw 可能已停止。`));
    fs.unlinkSync(SERVICE_PID_FILE);
    return;
  }

  // 发送 SIGTERM
  try {
    process.kill(pid, "SIGTERM");
    console.log(`${green("✓")} 已向进程 ${bold(String(pid))} 发送 SIGTERM`);
    console.log(dim("  · 使用 bun dev 启动时：Bun 会自动以新配置重启"));
    console.log(dim("  · 使用 bun start 启动时：请手动重新运行 `bun start`"));
  } catch (e) {
    console.error(red(`发送信号失败：${e}`));
  }
}
