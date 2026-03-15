import { spawn } from "node:child_process";
import { registerTool } from "./registry.js";
import { loadConfig } from "../config/loader.js";
import { llmRegistry } from "../llm/registry.js";

/**
 * 统一代码辅助工具。
 *
 * 底层实现由 config.tools.code_assist.backend 决定：
 *   "copilot" — `copilot -p <task> --allow-all -s [--model <model>]`
 *   "codex"   — `codex --quiet [--model <model>] <task>`
 *   "api"     — daily LLM 一次无历史调用（忽略 model 字段）
 *
 * Daily agent 只看到 code_assist(task)，底层实现对 LLM 完全透明。
 */
async function runCodeAssist(args: Record<string, unknown>): Promise<string> {
  const task = String(args["task"] ?? "").trim();
  if (!task) return "错误：缺少 task 参数";

  const cfg = loadConfig().tools.code_assist;
  const { backend, model } = cfg;

  if (backend === "copilot") {
    return runCli(
      "copilot",
      [
        "-p", task,
        "--allow-all",
        "-s",
        ...(model ? ["--model", model] : []),
      ],
      "copilot"
    );
  }

  if (backend === "codex") {
    return runCli(
      "codex",
      [
        "--quiet",
        ...(model ? ["--model", model] : []),
        task,
      ],
      "codex"
    );
  }

  // backend === "api"
  return runApi(task);
}

/** 子进程 CLI 调用（等待进程自然结束，无超时） */
function runCli(bin: string, argv: string[], label: string): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    const child = spawn(bin, argv, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.stderr.on("data", (d: Buffer) => errChunks.push(d));

    child.on("close", (code) => {
      const stdout = Buffer.concat(chunks).toString("utf-8").trim();
      const stderr = Buffer.concat(errChunks).toString("utf-8").trim();
      if (code === 0) {
        resolve(stdout || `(${label} 执行完成，无输出)`);
      } else {
        resolve(`${label} 退出码 ${code}\nstdout: ${stdout}\nstderr: ${stderr}`);
      }
    });

    child.on("error", (err) => {
      resolve(`${label} 启动失败：${err.message}（请确认已安装 ${bin} 并在 PATH 中）`);
    });
  });
}

/** 直接用 daily LLM 做一次无历史调用 */
async function runApi(task: string): Promise<string> {
  try {
    const client = llmRegistry.get("daily");
    const result = await client.chat([
      {
        role: "system",
        content:
          "你是一个代码专家助手。请认真完成用户的代码任务，给出完整、可直接使用的代码结果。",
      },
      { role: "user", content: task },
    ]);
    return result.content;
  } catch (err) {
    return `code_assist(api) 调用失败：${err instanceof Error ? err.message : String(err)}`;
  }
}

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "code_assist",
      description:
        "将代码任务委派给独立 AI 助手执行。适合编写/修改/调试/重构代码等需要大量上下文的操作。" +
        "注意：code_assist 没有对话历史，每次调用是独立会话，task 必须包含完整背景信息。" +
        "返回执行结果，不消耗主 Agent 上下文窗口。",
      parameters: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description:
              "完整自包含的任务描述，需包含：相关文件路径、现有代码片段（如有）、明确目标。" +
              "不要只写'修改上面的代码'——code_assist 看不到对话历史。",
          },
        },
        required: ["task"],
      },
    },
  },
  execute: runCodeAssist,
});
