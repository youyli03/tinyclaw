import { spawn } from "node:child_process";
import { registerTool, getTool, type ToolContext } from "./registry.js";
import { loadConfig } from "../config/loader.js";
import { Session } from "../core/session.js";
import { runAgent } from "../core/agent.js";
import { slaveManager } from "../core/slave-manager.js";
import type { SlaveRunFn } from "../core/slave-manager.js";
import { createAskMasterCallback } from "./ask-master.js";
import type { ChatCompletionTool } from "openai/resources/chat/completions";

// ── Daily subagent 系统提示后缀 ───────────────────────────────────────────────

const DAILY_SUBAGENT_SYSTEM = `## ⚠️ 你正在以【Daily Coordinator / 协调子 Agent】身份运行

### 职责
你是一个代码任务协调者。你的职责是：
1. **理解任务**：分析用户需求，探索代码库，制定执行计划
2. **指挥执行**：通过 \`run_code_subagent\` 工具将具体代码任务委派给代码执行子 Agent
3. **验证结果**：检查执行结果，必要时给出修正指令继续执行
4. **汇报完成**：简洁总结完成情况

### 关键规范
- **分步执行**：先探索代码库了解现状，再制定计划，然后分步骤调用 \`run_code_subagent\`
- **不要直接写代码**：所有文件修改、代码执行均通过 \`run_code_subagent\` 完成；可用 \`exec_shell\` 进行只读探索
- **遇到不确定时必须问**：不要假设用户技术水平、偏好、或任何未明确说明的技术选型；调用 \`ask_master\` 向用户确认
- **ask_master 使用场景**：架构决策、技术选型、需求模糊、有多种合理方案时
- **传递计划文件**：若已生成 plan.md，在调用 \`ask_master\` 时通过 \`plan_path\` 参数传入，用户会收到可视化计划图
- **无用户在线**：除 ask_master 外，所有决策均自主完成，不依赖人工介入
- **禁止**：agent_fork、code_assist（不得嵌套）`;

// ── Code subagent 系统提示后缀 ────────────────────────────────────────────────

const CODE_SUBAGENT_SYSTEM = `## ⚠️ 你正在以【Code Executor / 代码执行子 Agent】身份运行

### 职责
你是一个代码执行者，由协调子 Agent 指挥。每次调用你时，你会收到一个具体的代码任务。

### 关键规范
- **直接执行**：收到任务后立即执行，不要询问，不要重复已完成的工作
- **简洁输出**：仅报告关键结果（修改了哪些文件、执行了什么命令、遇到了什么问题）
- **无人值守**：没有用户在线，所有决策须自主完成
- **禁止**：ask_master、agent_fork、code_assist、run_code_subagent（不得嵌套）`;

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

  // api/internal backend：双子 Agent 协作模式
  return runInternal(task, ctx);
}

async function runInternal(task: string, ctx?: ToolContext): Promise<string> {
  if (!ctx?.masterSession) {
    return "错误：code_assist 需要在交互式 Agent 会话中调用（masterSession 未提供）";
  }
  if (!ctx.slaveRunFn) {
    return "⚠️ 当前 Slave 不允许嵌套 code_assist（已达最大嵌套深度）";
  }

  const masterSession = ctx.masterSession;
  const agentId = ctx.agentId ?? "default";

  // ── MFA 一次性预授权（如配置了 MFA） ─────────────────────────────────────
  const mfaCfg = loadConfig().auth.mfa;
  if (mfaCfg && ctx.onMFARequest) {
    let mfaPassed = false;
    try {
      mfaPassed = await ctx.onMFARequest(
        "⚠️ code_assist 将在后台启动两个子 Agent 执行代码操作（exec_shell / write_file 等）。\n" +
        "请完成一次授权，两个子 Agent 将在整个任务期间免再次验证。"
      );
    } catch {
      mfaPassed = false;
    }
    if (!mfaPassed) {
      return "操作已取消：MFA 未通过，code_assist 子 Agent 未启动";
    }
  }

  // ── 创建两个 Session ────────────────────────────────────────────────────
  const codeSessionId = `code-assist-code:${globalThis.crypto.randomUUID().slice(0, 8)}`;
  const dailySessionId = `code-assist-daily:${globalThis.crypto.randomUUID().slice(0, 8)}`;

  const codeSession = new Session(codeSessionId, { agentId });
  codeSession.mode = "code";
  codeSession.codeSubMode = "auto";
  if (ctx.cwd) codeSession.codeWorkdir = ctx.cwd;

  const dailySession = new Session(dailySessionId, { agentId });
  // dailySession 保持 chat 模式（使用 daily 模型）

  // MFA 预授权标记两个子 Session
  if (mfaCfg && ctx.onMFARequest) {
    codeSession.mfaPreApproved = true;
    dailySession.mfaPreApproved = true;
  }

  // ── Bind 父子关系 ─────────────────────────────────────────────────────
  dailySession.bindParent(masterSession);
  codeSession.bindParent(dailySession);

  // ── 构建 codeRunFn 闭包（daily → code 的同步调用） ───────────────────
  const codeRunFn = async (instruction: string): Promise<string> => {
    const result = await runAgent(codeSession, instruction, {
      slaveDepth: 2,  // code subagent 是深度 2，彻底禁止再 fork
      systemPromptSuffix: CODE_SUBAGENT_SYSTEM,
      ...(ctx.onNotify ? { onNotify: ctx.onNotify } : {}),
    });
    return result.content;
  };

  // ── 构建 onAskMaster 回调 ────────────────────────────────────────────
  const onAskMaster = createAskMasterCallback(masterSession, ctx.onNotify ?? (async () => {}), agentId);

  // ── 获取 hidden 工具的 spec（注入给 daily subagent） ────────────────
  const customTools: ChatCompletionTool[] = [
    getTool("ask_master")?.spec,
    getTool("run_code_subagent")?.spec,
  ].filter((s): s is ChatCompletionTool => s !== undefined);

  // ── 构建 daily subagent 的 runFn 闭包 ────────────────────────────────
  // opts 来自 slaveManager._run，含 systemPromptSuffix: SLAVE_SYSTEM_PROMPT
  // 我们覆盖为 DAILY_SUBAGENT_SYSTEM（协调者专属规则）
  const dailyRunFn: SlaveRunFn = async (session, content, opts) => {
    return runAgent(session, content, {
      ...opts,
      systemPromptSuffix: DAILY_SUBAGENT_SYSTEM,  // 覆盖 slaveManager 传入的默认 suffix
      slaveDepth: 1,
      customTools,
      onAskMaster,
      codeRunFn,
      ...(ctx.onNotify ? { onNotify: ctx.onNotify } : {}),
      ...(ctx.onSlaveComplete ? { onSlaveComplete: ctx.onSlaveComplete } : {}),
      ...(ctx.onProgressNotify ? { onProgressNotify: ctx.onProgressNotify } : {}),
    });
  };

  // ── 后台启动 daily subagent（slaveManager.fork） ─────────────────────
  const slaveId = slaveManager.fork(
    task,
    masterSession,
    10,
    dailyRunFn,
    ctx.onSlaveComplete,
    undefined,
    ctx.onProgressNotify,
  );

  console.log(`[code_assist] daily slave:${slaveId} started for task="${task.slice(0, 60)}"`);

  return (
    `🚀 **已启动双子 Agent 代码协作**\n\n` +
    `任务：${task.slice(0, 100)}${task.length > 100 ? "…" : ""}\n\n` +
    `- **Daily 协调 Agent**：\`${slaveId}\`（daily 模型，负责规划和指挥）\n` +
    `- **Code 执行 Agent**：绑定在协调 Agent 下（code 模型，负责代码执行）\n\n` +
    `任务完成后将自动通知你。可用 \`agent_status(slave_id="${slaveId}")\` 查询进度。`
  );
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
        "将代码任务委派给双子 Agent 协作系统（Daily 协调 + Code 执行）。\n" +
        "适合编写/修改/调试/重构代码等需要大量上下文的操作。\n\n" +
        "**双子 Agent 工作流**（api/internal backend）：\n" +
        "1. 调用此工具 → 后台启动两个子 Agent：\n" +
        "   - Daily Agent（daily 模型）：探索代码库、制定计划、指挥执行、遇到不确定时主动向你提问\n" +
        "   - Code Agent（code 模型）：在 Daily Agent 指挥下执行具体代码操作\n" +
        "2. 立即返回，任务在后台异步执行，完成后自动通知你\n" +
        "3. Daily Agent 若有疑问会主动推送问题给你，回复后它会继续执行\n\n" +
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
