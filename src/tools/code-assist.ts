import { spawn } from "node:child_process";
import { registerTool, type ToolContext } from "./registry.js";
import { loadConfig } from "../config/loader.js";
import { Session } from "../core/session.js";
import type { PlanApprovalResult } from "../core/session.js";
import { runAgent } from "../core/agent.js";

// ── 类型 ─────────────────────────────────────────────────────────────────────

interface PlanItem {
  summary: string;
  planPath?: string | undefined;
  /** 调用后解除子 Agent 的 exit_plan_mode 等待，传入审批结果 */
  pendingApproval: (r: PlanApprovalResult) => void;
}

/**
 * PlanChannel：协调子 Agent exit_plan_mode 调用与父 Agent 工具层之间的异步通信。
 *
 * - 子 Agent 通过 `onPlanRequest` 发布计划并等待批准
 * - 父 Agent 通过 `waitForPlan()` 接收计划（或 done 信号）
 *
 * 处理所有竞态：produce-before-consume 和 done-before-consume 均正确处理。
 */
interface PlanChannel {
  /** 注入 runAgent 的 onPlanRequest 回调 */
  onPlanRequest: (
    summary: string,
    actions?: string[],
    recommendedAction?: string,
    planPath?: string,
  ) => Promise<PlanApprovalResult>;
  /** 等待下一个计划到来，或等到 done 信号（runAgent 未调用 exit_plan_mode 直接完成） */
  waitForPlan(): Promise<{ type: "plan" } & PlanItem | { type: "done" }>;
  /** runAgent 完成时调用，通知正在等待的 waitForPlan */
  signalDone(): void;
}

function createPlanChannel(): PlanChannel {
  // 等待 waitForPlan() 被调用后再 resolve 的 Promise 控制柄
  let resolveWait: ((r: { type: "plan" } & PlanItem | { type: "done" }) => void) | null = null;
  // produce 比 consume 先到时的缓存
  let bufferedPlan: PlanItem | null = null;
  let doneSignaled = false;

  return {
    onPlanRequest(summary, _actions, _recommendedAction, planPath) {
      return new Promise<PlanApprovalResult>((resolveApproval) => {
        const item: PlanItem = { summary, planPath, pendingApproval: resolveApproval };
        if (resolveWait) {
          resolveWait({ type: "plan", ...item });
          resolveWait = null;
        } else {
          bufferedPlan = item;
        }
      });
    },

    waitForPlan() {
      if (doneSignaled) return Promise.resolve({ type: "done" as const });
      if (bufferedPlan) {
        const item = bufferedPlan;
        bufferedPlan = null;
        return Promise.resolve({ type: "plan" as const, ...item });
      }
      return new Promise((resolve) => {
        resolveWait = resolve;
      });
    },

    signalDone() {
      doneSignaled = true;
      if (resolveWait) {
        resolveWait({ type: "done" });
        resolveWait = null;
      }
    },
  };
}

// ── 待审批会话存储 ────────────────────────────────────────────────────────────

interface CodeAssistEntry {
  channel: PlanChannel;
  completionPromise: Promise<string>;
  /** 当前等待审批的回调（每次 exit_plan_mode 调用后刷新） */
  pendingApproval: ((r: PlanApprovalResult) => void) | null;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

/** 键：`code-assist:<8位hex>`，值：待 code_assist_run 审批的子会话 */
const sessions = new Map<string, CodeAssistEntry>();

const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

// ── 主工具：code_assist ───────────────────────────────────────────────────────

async function runCodeAssist(args: Record<string, unknown>, ctx?: ToolContext): Promise<string> {
  const task = String(args["task"] ?? "").trim();
  if (!task) return "错误：缺少 task 参数";

  const cfg = loadConfig().tools.code_assist;
  const { backend, model } = cfg;

  // CLI backends 保持不变
  if (backend === "copilot") {
    return runCli("copilot", ["-p", task, "--allow-all", "-s", ...(model ? ["--model", model] : [])], "copilot");
  }
  if (backend === "codex") {
    return runCli("codex", ["--quiet", ...(model ? ["--model", model] : []), task], "codex");
  }

  // api/internal backend：通过 runAgent plan 模式实现多步骤规划+执行
  return runInternal(task, ctx);
}

async function runInternal(task: string, ctx?: ToolContext): Promise<string> {
  const sessionId = `code-assist:${globalThis.crypto.randomUUID().slice(0, 8)}`;
  const channel = createPlanChannel();

  const subSession = new Session(sessionId, { agentId: ctx?.agentId ?? "default" });
  subSession.mode = "code";
  subSession.codeSubMode = "plan";
  // 继承父 Agent 的工作目录（如已知）
  if (ctx?.cwd) {
    subSession.codeWorkdir = ctx.cwd;
  }

  // completionPromise：等待 runAgent 完成的 Promise
  let resolveCompletion!: (result: string) => void;
  const completionPromise = new Promise<string>((resolve) => {
    resolveCompletion = resolve;
  });

  // 后台启动子 Agent（plan 模式），不 await
  runAgent(subSession, task, {
    onPlanRequest: (summary, actions, recommendedAction, planPath) =>
      channel.onPlanRequest(summary, actions, recommendedAction, planPath),
  })
    .then((result) => {
      channel.signalDone();
      resolveCompletion(result.content);
    })
    .catch((err: unknown) => {
      channel.signalDone();
      resolveCompletion(`code_assist 子 Agent 异常：${err instanceof Error ? err.message : String(err)}`);
    });

  // 等待子 Agent 的第一个计划，或直接完成
  const first = await channel.waitForPlan();

  if (first.type === "done") {
    // 子 Agent 直接完成（纯查询/无需规划的任务）
    return completionPromise;
  }

  // 有计划需要审批，存入会话表，等父 Agent 调用 code_assist_run
  const timeoutHandle = setTimeout(() => {
    const entry = sessions.get(sessionId);
    if (entry?.pendingApproval) {
      entry.pendingApproval({ approved: false, feedback: "会话超时（30 分钟无操作）" });
    }
    sessions.delete(sessionId);
  }, SESSION_TIMEOUT_MS);

  sessions.set(sessionId, {
    channel,
    completionPromise,
    pendingApproval: first.pendingApproval,
    timeoutHandle,
  });

  const planText = first.planPath
    ? `${first.summary}\n\n📄 详细计划：\`${first.planPath}\``
    : first.summary;

  return (
    `📋 **规划完成**\n\n${planText}\n\n` +
    `---\n会话 ID：\`${sessionId}\`\n\n` +
    `• 批准执行：\`code_assist_run("${sessionId}")\`\n` +
    `• 修改方案：\`code_assist_run("${sessionId}", "你的反馈意见")\``
  );
}

// ── 辅助工具：code_assist_run ─────────────────────────────────────────────────

async function runCodeAssistRun(args: Record<string, unknown>): Promise<string> {
  const sessionId = String(args["session_id"] ?? "").trim();
  const feedback = args["feedback"] ? String(args["feedback"]).trim() : undefined;

  if (!sessionId) return "错误：缺少 session_id 参数";

  const entry = sessions.get(sessionId);
  if (!entry) {
    return `错误：找不到会话 "${sessionId}"（已超时或不存在）`;
  }
  if (!entry.pendingApproval) {
    return `错误：会话 "${sessionId}" 当前没有待审批的计划`;
  }

  const { pendingApproval } = entry;
  entry.pendingApproval = null;

  if (feedback) {
    // 拒绝计划，要求子 Agent 重新规划
    pendingApproval({ approved: false, feedback });

    // 等待子 Agent 给出下一个计划
    const next = await entry.channel.waitForPlan();

    if (next.type === "done") {
      // 子 Agent 重规划后直接完成（罕见，但处理）
      clearTimeout(entry.timeoutHandle);
      sessions.delete(sessionId);
      return entry.completionPromise;
    }

    // 有新计划，刷新 pendingApproval
    entry.pendingApproval = next.pendingApproval;
    const planText = next.planPath
      ? `${next.summary}\n\n📄 详细计划：\`${next.planPath}\``
      : next.summary;

    return (
      `📋 **重新规划完成**\n\n${planText}\n\n` +
      `---\n会话 ID：\`${sessionId}\`\n\n` +
      `• 批准执行：\`code_assist_run("${sessionId}")\`\n` +
      `• 继续反馈：\`code_assist_run("${sessionId}", "你的反馈意见")\``
    );
  }

  // 批准计划，等待子 Agent 执行完成
  pendingApproval({ approved: true, selectedAction: "autopilot" });
  clearTimeout(entry.timeoutHandle);
  sessions.delete(sessionId);

  return entry.completionPromise;
}

// ── CLI 子进程辅助 ────────────────────────────────────────────────────────────

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

// ── 工具注册 ─────────────────────────────────────────────────────────────────

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "code_assist",
      description:
        "将代码任务委派给独立代码助手 Agent（具备 plan/auto 两阶段工作流）。\n" +
        "适合编写/修改/调试/重构代码等需要大量上下文的操作。\n\n" +
        "**两阶段工作流**（api/internal backend）：\n" +
        "1. 调用此工具 → 子 Agent 探索代码库并生成计划摘要\n" +
        "2. 返回计划 + sessionId → 调用 `code_assist_run(sessionId)` 批准执行，或传入 feedback 修改方案\n\n" +
        "注意：task 必须包含完整背景信息（文件路径、明确目标等），子 Agent 没有对话历史。",
      parameters: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description:
              "完整自包含的任务描述，需包含：相关文件路径、现有代码片段（如有）、明确目标。" +
              "不要只写'修改上面的代码'——子 Agent 看不到对话历史。",
          },
        },
        required: ["task"],
      },
    },
  },
  execute: runCodeAssist,
});

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "code_assist_run",
      description:
        "批准或修改 code_assist 返回的计划，然后执行。\n\n" +
        "• 不传 feedback → 批准计划，子 Agent 进入 auto 模式执行，等待结果\n" +
        "• 传入 feedback → 拒绝当前计划并附上修改意见，子 Agent 重新规划后返回新计划",
      parameters: {
        type: "object",
        properties: {
          session_id: {
            type: "string",
            description: "code_assist 返回的会话 ID（格式：`code-assist:xxxxxxxx`）",
          },
          feedback: {
            type: "string",
            description: "（可选）对当前计划的修改意见。提供时表示拒绝并要求重新规划；不提供时表示批准。",
          },
        },
        required: ["session_id"],
      },
    },
  },
  execute: runCodeAssistRun,
});
