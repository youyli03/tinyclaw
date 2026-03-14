import { spawn } from "node:child_process";
import { registerTool } from "./registry.js";

const CODEX_TIMEOUT_MS = 5 * 60 * 1000; // 5 分钟

/**
 * 调用 codex CLI 子进程执行代码任务。
 * 主 Agent 只接收结果，不暴露代码执行的中间上下文。
 */
async function runCodex(args: Record<string, unknown>): Promise<string> {
  const task = String(args["task"] ?? "");
  if (!task) return "错误：缺少 task 参数";

  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    const child = spawn("codex", ["--quiet", task], {
      timeout: CODEX_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.stderr.on("data", (d: Buffer) => errChunks.push(d));

    child.on("close", (code) => {
      const stdout = Buffer.concat(chunks).toString("utf-8").trim();
      const stderr = Buffer.concat(errChunks).toString("utf-8").trim();
      if (code === 0) {
        resolve(stdout || "(codex 执行完成，无输出)");
      } else {
        resolve(`codex 退出码 ${code}\nstderr: ${stderr}\nstdout: ${stdout}`);
      }
    });

    child.on("error", (err) => {
      resolve(`codex 启动失败：${err.message}（请确认已安装 codex CLI）`);
    });
  });
}

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "codex",
      description:
        "将代码任务委派给 codex CLI 执行。适合编写/修改代码、调试、重构等需要消耗大量上下文的操作。返回执行结果，不消耗主 Agent 上下文。",
      parameters: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description: "要执行的代码任务描述，用自然语言描述需求",
          },
        },
        required: ["task"],
      },
    },
  },
  execute: runCodex,
});
