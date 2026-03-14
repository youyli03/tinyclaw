/**
 * CLI 命令：logs
 *
 * 查看 tinyclaw 主服务的运行日志（~/.tinyclaw/service.log）。
 *
 * 用法：
 *   tinyclaw logs            显示最近 100 行
 *   tinyclaw logs -n 200     显示最近 N 行
 *   tinyclaw logs -f         持续追踪日志（Ctrl+C 退出）
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { bold, yellow, dim } from "../ui.js";
import { SERVICE_LOG_FILE } from "./start.js";

export const description = "查看 tinyclaw 主服务运行日志";
export const usage = "logs [-f] [-n <lines>]";

function printHelp(): void {
  console.log(`
${bold("用法：")}
  logs              显示最近 100 行日志
  logs -n <N>       显示最近 N 行日志
  logs -f           持续追踪日志（Ctrl+C 退出）
  logs -f -n <N>    追踪并显示最近 N 行历史

${bold("日志文件：")}
  ${SERVICE_LOG_FILE}
`);
}

export async function run(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h") || args.includes("help")) {
    printHelp();
    return;
  }

  if (!fs.existsSync(SERVICE_LOG_FILE)) {
    console.log(yellow("日志文件不存在，请先通过 tinyclaw start 启动服务。"));
    console.log(dim(`期望路径：${SERVICE_LOG_FILE}`));
    return;
  }

  const follow = args.includes("-f") || args.includes("--follow");

  // 解析 -n <N>
  let lines = 100;
  const nIdx = args.findIndex((a) => a === "-n");
  if (nIdx !== -1) {
    const n = parseInt(args[nIdx + 1] ?? "", 10);
    if (!isNaN(n) && n > 0) lines = n;
  }

  const tailArgs = follow
    ? ["-f", "-n", String(lines), SERVICE_LOG_FILE]
    : ["-n", String(lines), SERVICE_LOG_FILE];

  const child = spawn("tail", tailArgs, {
    stdio: ["ignore", "inherit", "inherit"],
  });

  await new Promise<void>((resolve) => {
    child.on("exit", () => resolve());
    // Ctrl+C 时优雅结束 tail 子进程
    process.once("SIGINT", () => {
      child.kill("SIGTERM");
      resolve();
    });
  });
}
