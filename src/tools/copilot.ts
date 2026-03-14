import { spawn } from "node:child_process";
import { registerTool } from "./registry.js";

const COPILOT_TIMEOUT_MS = 2 * 60 * 1000; // 2 分钟

async function runCopilot(args: Record<string, unknown>): Promise<string> {
  const task = String(args["task"] ?? "");
  const target = String(args["target"] ?? "shell"); // "shell" | "git" | "gh"
  if (!task) return "错误：缺少 task 参数";

  const validTargets = ["shell", "git", "gh"];
  const safeTarget = validTargets.includes(target) ? target : "shell";

  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    // gh copilot suggest -t shell "..."
    const child = spawn("gh", ["copilot", "suggest", "-t", safeTarget, task], {
      timeout: COPILOT_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.stderr.on("data", (d: Buffer) => errChunks.push(d));

    child.on("close", (code) => {
      const stdout = Buffer.concat(chunks).toString("utf-8").trim();
      const stderr = Buffer.concat(errChunks).toString("utf-8").trim();
      if (code === 0) {
        resolve(stdout || "(copilot 执行完成，无输出)");
      } else {
        resolve(`gh copilot 退出码 ${code}\nstderr: ${stderr}\nstdout: ${stdout}`);
      }
    });

    child.on("error", (err) => {
      resolve(`gh copilot 启动失败：${err.message}（请确认已安装 gh CLI 并登录）`);
    });
  });
}

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "copilot",
      description:
        "将任务委派给 GitHub Copilot CLI 处理。适合生成 shell 命令、git 操作、gh CLI 操作等。返回建议结果，不消耗主 Agent 上下文。",
      parameters: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description: "要执行的任务描述",
          },
          target: {
            type: "string",
            enum: ["shell", "git", "gh"],
            description: "目标命令类型，默认 shell",
          },
        },
        required: ["task"],
      },
    },
  },
  execute: runCopilot,
});
