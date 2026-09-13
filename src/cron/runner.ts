/**
 * Cron job 执行器
 *
 * 支持两种运行模式：
 * 1. 单步模式（message）：对每个 job 触发一次 runAgent()，向后兼容
 * 2. Pipeline 模式（steps）：按顺序执行多个步骤（tool / msg），共享 stateful session
 *
 * 结合 job.output.notify 策略决定是否推送结果，并将运行记录追加到日志文件。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Session } from "../core/session.js";
import { runAgent } from "../core/agent.js";
import { agentManager } from "../core/agent-manager.js";
import { auditToolCall, enforceUnattendedTool, unattendedMfaFallback } from "../auth/tool-policy.js";
import type { InboundMessage } from "../connectors/base.js";
import { updateJob, appendLog } from "./store.js";
import type { CronJob } from "./schema.js";
import {
  parseModelSymbol,
  isPremiumModel,
  buildFallbackClient,
  llmRegistry,
} from "../llm/registry.js";
import type { AnyLLMClient } from "../llm/registry.js";
import { loadConfig } from "../config/loader.js";
import { executeTool } from "../tools/registry.js";
import type { ToolContext } from "../tools/registry.js";
import { createLogger, setLogLevel, getLogLevel, type LogLevel } from "../utils/logger.js";

const log = createLogger("cron");

// ── Cron 专用 system prompt（约束 agent 不递归创建任务） ──────────────────────

const CRON_AGENT_SYSTEM = `## ⚠️ You are running as an [automated cron task] (non-interactive)

The following rules are mandatory:

### Execution rules
1. **Act immediately**: the user message IS your task instruction; execute it right away. Do not ask the user for confirmation and do not ask for details.
2. **Never create cron tasks**: do not call the cron_add tool — the current run is itself a cron task.
3. **Unattended**: no user is online. Every tool call must be completed autonomously; never depend on human intervention.
4. **Concise output**: output only the final result. Do not offer options, explain steps, or describe what you did.

### Data acquisition rules (mandatory)
5. **Always fetch live data with tools**: for time-sensitive data (weather, stock prices, FX rates, system status …) you MUST run concrete commands (curl/wget/df/free etc.) via exec_shell to obtain the real data. Never output values from memory or training knowledge.
6. **Report failures explicitly**: if exec_shell returns an error or the data format is unexpected, output "数据获取失败：<具体原因>" and never substitute a guessed value.
7. **Commands must be complete and executable**: exec_shell's command must be a fully-parameterized executable command; do not rely on implicit conventions inside the user message.
8. **Mind the timeout**: exec_shell times out after 60 seconds by default. For commands expected to run longer you MUST pass an explicit larger timeout_sec; never assume the system waits indefinitely.

### Output rules (critical)
9. **Output the actual content, never a digest**: your final text reply is pushed straight to the user, so it MUST contain the real data obtained from tools (weather values, query results, command output …). Do NOT replace it with digest phrases such as "已执行"、"任务完成"、"操作成功".`;

/**
 * 当 notify=llm 时追加到 system prompt 的通知约定说明。
 */
const CRON_LLM_NOTIFY_SUFFIX = `

### Notification rules (this task uses LLM-decided push)
- If you decide the user should be notified, wrap the content to push in [NOTIFY]...[/NOTIFY]
- Multiple [NOTIFY] blocks are allowed; each block's content is pushed to the user independently
- If no notification is needed, output no [NOTIFY] block at all and the system stays silent
- Content outside [NOTIFY] blocks is written to the log only and is never pushed
- Example (the pushed text is written in the user's own language; a Chinese sample is shown here):
  [NOTIFY]⚠️ 烽火电子已触及止损线 9.73,建议关注[/NOTIFY]`;

/** 从 LLM 输出中提取所有 [NOTIFY]...[/NOTIFY] 块的内容 */
function extractNotifyBlocks(text: string): string[] {
  const results: string[] = [];
  const re = /\[NOTIFY\]([\s\S]*?)\[\/NOTIFY\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const content = m[1]!.trim();
    if (content) results.push(content);
  }
  return results;
}

export interface CronRuntimeBridge {
  send(
    peerId: string,
    msgType: InboundMessage["type"],
    message: string,
    replyToId?: string
  ): Promise<void>;
  requestUserInput?(
    peerId: string,
    msgType: InboundMessage["type"],
    prompt: string,
    timeoutMs: number
  ): Promise<string>;
}

// ─// ── 构建 LLM override client(cron job 指定 model 时使用)──────────────────────

async function buildOverrideClient(job: CronJob): Promise<AnyLLMClient | undefined> {
  const cfg = loadConfig();

  if (!job.model) {
    // 未指定 model，走 daily backend，但仍需检查 cron 白名单
    const allowlist = cfg.llm.premiumAllowlist;
    if (allowlist.enabled) {
      const dailyModelId = cfg.llm.backends.daily.model.split("/").pop() ?? "";
      if (isPremiumModel(dailyModelId) && !allowlist.allowedCronJobs.includes(job.id)) {
        console.warn(
          `[cron][premiumGuard] job=${job.id} 不在 cron 白名单，` +
            `daily 模型 ${cfg.llm.backends.daily.model} → ${allowlist.fallbackModel}`
        );
        return buildFallbackClient();
      }
    }
    return undefined;
  }

  try {
    const { provider, modelId } = parseModelSymbol(job.model);

    // ── Premium 白名单检查（job 明确指定了模型）────────────────────────────
    const allowlist = cfg.llm.premiumAllowlist;
    if (allowlist.enabled && isPremiumModel(modelId)) {
      if (!allowlist.allowedCronJobs.includes(job.id)) {
        console.warn(
          `[cron][premiumGuard] job=${job.id} 不在 cron 白名单，` +
            `降级 ${job.model} → ${allowlist.fallbackModel}`
        );
        return buildFallbackClient();
      }
    }
    // ── END Premium 白名单检查 ─────────────────────────────────────────────

    // ── 统一委托给 registry 的通用解析 ─────────────────────────────────────
    // 这里曾硬编码 copilot / openai 两个分支，其余 provider 一律 throw 并**静默回退 daily**：
    // 结果是任何 `deepseek/…`、`mimo/…`、`google/…`、`openrouter/…` 的 job 都长期没用上指定模型，
    // 还每轮刷一条 ERROR（实测 8 个 job 受影响，7 天 3222 条错误日志）。
    // `buildClientForSymbol()` 覆盖 copilot / openai / openrouter / deepseek / mimo / google，
    // 与 `llm.backends.*.model` 走的是同一套解析，不会再漂移。
    if (provider === "copilot") {
      // 该方法的 copilot 分支返回 daily 客户端（它为 fallback 列表设计，不按 modelId 建客户端），
      // 对"指定某个 copilot 模型"的语义不完整。Copilot 已非本环境主路径，此处**显式告警**而非静默降级。
      console.warn(
        `[cron] job=${job.id} provider=copilot 已非主路径，将沿用 daily 客户端（不会按 ${modelId} 新建）`
      );
    }
    const client = llmRegistry.buildClientForSymbol(job.model);
    console.log(`[cron] job=${job.id} 使用指定模型: ${job.model}`);
    return client;
  } catch (err) {
    console.error(`[cron] job=${job.id} 模型初始化失败,回退到 daily:`, err);
    return undefined;
  }
}

// ── Pipeline 模式执行 ─────────────────────────────────────────────────────────

/**
 * 执行 Pipeline Job：按顺序运行 job.steps，共享同一个 stateful session。
 *
 * - `tool` step：直接调用工具，输出以合成 tool call 对（assistant+tool_calls + role:tool）注入 session，
 *   使后续 LLM 步骤能以原生工具结果格式感知数据，避免将工具数据误认为普通 assistant 消息而忽略
 * - `msg`  step：向 session 注入 user 消息，触发 runAgent，LLM 生成回复
 *
 * 返回最终推送给用户的文本（最后一个 msg step 的 LLM 输出；若无 msg step 则取最后 tool 输出）。
 * 任意 step 失败则抛出异常，由调用方处理 status=error。
 */
async function runPipelineJob(
  job: CronJob,
  session: Session,
  onMFARequest: (msg: string, verify?: (code: string) => boolean) => Promise<boolean>,
  notifyFn: ((message: string) => Promise<void>) | undefined,
  onAskUserFn:
    | ((
        question: string,
        options?: Array<{ label: string; description?: string; recommended?: boolean }>,
        allowFreeform?: boolean
      ) => Promise<{ answer: string; isFreeform: boolean }>)
    | undefined,
  overrideClient: AnyLLMClient | undefined,
  systemPrompt: string
): Promise<string> {
  const steps = job.steps!;
  let lastResult = "";

  // 构建工具执行上下文（pipeline tool steps 使用）
  // 必须包含 masterSession 和 slaveRunFn，否则 agent_fork / agent_wait 工具会因缺少上下文而返回错误字符串
  const toolCtx: ToolContext = {
    sessionId: session.sessionId,
    agentId: job.agentId,
    cwd: agentManager.workspaceDir(job.agentId),
    // ── agent_fork / agent_wait 所需 ──────────────────────────────────────
    masterSession: session,
    slaveRunFn: (s, c, o) =>
      runAgent(s, c, {
        ...(o as Parameters<typeof runAgent>[2]),
        // 子 agent 继承"无人值守"身份：否则 fork 出来的 slave 会被当成交互式，
        // 绕过无人值守白名单与提权禁令（2026-09-11 修复）
        origin: "cron",
        slaveDepth: 1,
        // 子 Agent 审批策略钉死为 never（对齐 DSH 委派语义）：不允许弹 MFA / 提权
        approvalPolicy: "never",
        ...(notifyFn ? { onNotify: notifyFn } : {}),
      }),
    // cron pipeline 用 result_mode="wait" + agent_wait 汇总结果，inject 回调保持 no-op
    onSlaveComplete: async (_notif) => {
      /* no-op */
    },
    // 透传推送回调，SubAgent 内部调用 notify_user 时可正常推送
    ...(notifyFn ? { onNotify: notifyFn } : {}),
    // 该 job 显式声明的沙箱可写豁免（默认空 = 只能写自己的 agent 目录）
    ...(job.writablePaths.length > 0 ? { sandboxExtraRwPaths: job.writablePaths } : {}),
    // 该 job 声明要读的密钥（方案 B：沙箱内只暴露这几把 key）
    ...(job.secrets.length > 0 ? { sandboxSecretNames: job.secrets } : {}),
  };

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const stepLabel = `[pipeline step ${i + 1}/${steps.length}:${step.type}]`;

    if (step.type === "tool") {
      console.log(`[cron] job=${job.id} ${stepLabel} 执行工具: ${step.name}`);
      // 无人值守策略：cron 的 tool 步骤过去完全绕过 MFA 与任何准入检查，
      // 现在统一走白名单裁决（拒绝时写入审计并合成一条 tool_result 让 LLM 看到原因）
      const stepPolicy = enforceUnattendedTool({
        toolName: step.name,
        origin: "cron",
        // 声明式步骤通道：这是 job 配置里写死的 tool 步骤（不是模型临场决定），
        // 因此允许 agent_fork 这类"ReAct 通道禁止"的能力
        channel: "steps",
        agentId: job.agentId,
        sessionId: session.sessionId,
      });
      if (!stepPolicy.allow) {
        auditToolCall({
          event: "policy",
          origin: "cron",
          agentId: job.agentId,
          sessionId: session.sessionId,
          tool: step.name,
          decision: "deny",
          reason: "无人值守白名单外（cron 声明式 tool 步骤）",
          args: step.args as Record<string, unknown>,
        });
        console.warn(`[cron] job=${job.id} ${stepLabel} 被策略拒绝: ${step.name}`);
        lastResult = stepPolicy.reason ?? `已拒绝：${step.name}`;
        const deniedCallId = `pipeline_step${i + 1}_${step.name}_denied`;
        session.addAssistantWithToolCalls("", [
          { callId: deniedCallId, name: step.name, args: step.args as Record<string, unknown> },
        ]);
        session.addToolResultMessage(deniedCallId, lastResult);
        continue;
      }
      const stepStartMs = Date.now();
      const toolResult = await executeTool(
        step.name,
        step.args as Record<string, unknown>,
        toolCtx
      );
      lastResult = toolResult;
      auditToolCall({
        event: "tool",
        origin: "cron",
        agentId: job.agentId,
        sessionId: session.sessionId,
        tool: step.name,
        decision: "allow",
        args: step.args as Record<string, unknown>,
        durationMs: Date.now() - stepStartMs,
      });

      // 将工具输出以合成 tool call 对注入 session：
      // assistant(tool_calls) + tool(result)，使后续 LLM 步骤以原生工具结果格式感知数据
      const syntheticCallId = `pipeline_step${i + 1}_${step.name}_${Date.now()}`;
      session.addAssistantWithToolCalls("", [
        {
          callId: syntheticCallId,
          name: step.name,
          args: step.args as Record<string, unknown>,
        },
      ]);
      session.addToolResultMessage(syntheticCallId, toolResult);
      console.log(`[cron] job=${job.id} ${stepLabel} 完成，输出长度: ${toolResult.length}`);
    } else {
      // msg step：触发 LLM
      console.log(
        `[cron] job=${job.id} ${stepLabel} 触发 LLM，msg: "${step.content.slice(0, 60)}"`
      );
      const result = await runAgent(session, step.content, {
        origin: "cron",
        onMFARequest,
        systemPrompt: systemPrompt,
        // LLM 步骤里的 exec_shell 也继承该 job 的可写豁免
        ...(job.writablePaths.length > 0 ? { sandboxExtraRwPaths: job.writablePaths } : {}),
        ...(notifyFn ? { onNotify: notifyFn } : {}),
        ...(onAskUserFn ? { onAskUser: onAskUserFn } : {}),
        ...(overrideClient ? { overrideClient } : {}),
        // slaveDepth: 1 禁止 msg step 里的 LLM 调用 agent_fork，防止 Cron Pipeline 无限递归
        // Pipeline 中需要 fork 请改用 type:"tool", name:"agent_fork" 的 tool step 显式触发
        slaveDepth: 1,
        // 无人值守场景同样钉死审批：不允许 MFA / 提权（与 slaveRunFn 一致）
        approvalPolicy: "never",
        // cron 场景下 inject 模式的 slave 完成不额外推送用户（wait 模式 slave 本就不触发此回调）
        onSlaveComplete: async (_notif) => {
          /* no-op for cron pipeline: use result_mode="wait" + agent_wait instead */
        },
      });
      lastResult = result.content;
      console.log(`[cron] job=${job.id} ${stepLabel} 完成，输出长度: ${result.content.length}`);
    }
  }

  return lastResult;
}

// ── 执行单个 Job ──────────────────────────────────────────────────────────────

export async function runJob(
  job: CronJob,
  bridge: CronRuntimeBridge | null,
  trigger: "schedule" | "manual" = "schedule"
): Promise<void> {
  const now = new Date().toISOString();

  // ── 按 job.logLevel 控制日志输出量 ────────────────────────────────────
  const prevLevel = getLogLevel();
  const jobLevel = job.logLevel ?? "normal";
  if (jobLevel === "silent") {
    setLogLevel("error"); // 仅 error 可见
  } else if (jobLevel === "quiet") {
    setLogLevel("warn"); // 仅 warn + error 可见
  }
  // normal: 保持当前 level 不变

  try {
    await _runJob(job, bridge, now, trigger);
  } finally {
    // 恢复日志级别(即使 job 抛异常也要恢复)
    setLogLevel(prevLevel);
  }
}

async function _runJob(
  job: CronJob,
  bridge: CronRuntimeBridge | null,
  now: string,
  trigger: "schedule" | "manual"
): Promise<void> {
  const startMs = Date.now();

  // Pipeline 模式强制使用 stateful session（步骤间需共享上下文）
  const isPipeline = Array.isArray(job.steps) && job.steps.length > 0;
  const sessionId = job.stateful || isPipeline ? `cron:${job.id}` : `cron:${job.id}:${Date.now()}`;

  // Pipeline 模式：若 clearSessionOnRun !== false（默认 true）且非 stateful，运行前清空 session JSONL，
  // 防止历史消息（含旧行情数据）跨 run 污染当次上下文。必须在 new Session() 之前执行，
  // 否则 Session 构造函数会先从 JSONL 加载旧历史
  if (isPipeline && !job.stateful && job.clearSessionOnRun !== false) {
    const sanitized = sessionId.replace(/[:/\\]/g, "_");
    const jsonlPath = path.join(os.homedir(), ".tinyclaw", "sessions", `${sanitized}.jsonl`);
    try {
      fs.unlinkSync(jsonlPath);
    } catch {
      /* 文件不存在时忽略 */
    }
  }

  const session = new Session(sessionId, { agentId: job.agentId });

  // MFA 处理：exempt = 自动通过；可交互时透传给 connector；
  // **既未豁免又无法送达用户时不再自动通过**（见 [sandbox.unattended].mfaFallback）
  const reachableUser = !!(bridge && job.output.peerId && bridge.requestUserInput);
  const onMFARequest = job.mfaExempt
    ? async () => true
    : reachableUser
      ? async (warningMsg: string, verifyCode?: (code: string) => boolean) => {
          const answer = await bridge!.requestUserInput!(
            job.output.peerId!,
            job.output.msgType,
            warningMsg,
            60_000
          );
          if (verifyCode) {
            const digits = answer.replace(/\s/g, "");
            return /^\d{6}$/.test(digits) && verifyCode(digits);
          }
          return /^确认$|^y$|^yes$/i.test(answer.trim());
        }
      : async () => {
          // 无法送达（未绑定输出目标 / 无 connector）→ 交由 mfaFallback 决定
          const fallback = unattendedMfaFallback({
            toolName: "(cron run)",
            origin: "cron",
            agentId: job.agentId,
            sessionId,
          });
          return fallback.allow;
        };

  let status: "success" | "error" = "success";
  let resultText = "";

  const overrideClient = await buildOverrideClient(job);

  const notifyFn =
    bridge && job.output.peerId
      ? async (message: string) => {
          const prefixed = message.startsWith("<img")
            ? message
            : `📅 [定时]
${message}`;
          await bridge.send(job.output.peerId!, job.output.msgType, prefixed);
        }
      : undefined;

  // ask_user 回调:将问题推送到 job 绑定的 connector,等待用户回复(超时 5 分钟)
  const onAskUserFn =
    bridge && job.output.peerId && bridge.requestUserInput
      ? async (
          question: string,
          options?: Array<{ label: string; description?: string; recommended?: boolean }>,
          allowFreeform?: boolean
        ): Promise<{ answer: string; isFreeform: boolean }> => {
          let prompt = `❓ ${question}`;
          if (options && options.length > 0) {
            prompt +=
              "\n" +
              options
                .map(
                  (o, i) =>
                    `${i + 1}. ${o.label}${o.description ? " — " + o.description : ""}${o.recommended ? " ✅" : ""}`
                )
                .join("\n");
          }
          const raw = await bridge.requestUserInput!(
            job.output.peerId!,
            job.output.msgType,
            prompt,
            300_000 // 5 分钟超时
          );
          const trimmed = raw.trim();
          const n = parseInt(trimmed, 10);
          if (options && options.length > 0 && !isNaN(n) && n >= 1 && n <= options.length) {
            return { answer: options[n - 1]!.label, isFreeform: false };
          }
          if (allowFreeform !== false) {
            return { answer: trimmed, isFreeform: true };
          }
          throw new Error(`INVALID_CHOICE:${trimmed}`);
        }
      : undefined;

  // notify=llm 时在 system prompt 追加 [NOTIFY] 约定说明
  const systemPrompt =
    job.output.notify === "llm" ? CRON_AGENT_SYSTEM + CRON_LLM_NOTIFY_SUFFIX : CRON_AGENT_SYSTEM;

  try {
    if (isPipeline) {
      // ── Pipeline 模式 ──────────────────────────────────────────────────────
      console.log(`[cron] job=${job.id} 以 Pipeline 模式运行（${job.steps!.length} 步）`);
      resultText = await runPipelineJob(
        job,
        session,
        onMFARequest,
        notifyFn,
        onAskUserFn,
        overrideClient,
        systemPrompt
      );
    } else {
      // ── 单步模式（向后兼容）────────────────────────────────────────────────
      const result = await runAgent(session, job.message, {
        origin: "cron",
        onMFARequest,
        systemPrompt: systemPrompt,
        ...(job.writablePaths.length > 0 ? { sandboxExtraRwPaths: job.writablePaths } : {}),
        ...(notifyFn ? { onNotify: notifyFn } : {}),
        ...(onAskUserFn ? { onAskUser: onAskUserFn } : {}),
        ...(overrideClient ? { overrideClient } : {}),
      });
      resultText = result.content;
    }
  } catch (err) {
    status = "error";
    resultText = `执行失败：${err instanceof Error ? err.message : String(err)}`;
  }

  // ── 写日志 ────────────────────────────────────────────────────────────────
  appendLog({
    ts: now,
    status,
    result: resultText,
    jobId: job.id,
    durationMs: Date.now() - startMs,
    trigger,
    model: job.model ?? loadConfig().llm.backends.daily.model,
  });

  // ── 通知策略 ──────────────────────────────────────────────────────────────
  const shouldNotify = ((): boolean => {
    switch (job.output.notify) {
      case "always":
        return true;
      case "on_error":
        return status === "error";
      case "on_change":
        return resultText !== (job.lastRunResult ?? "");
      case "never":
        return false;
      case "llm":
        return false; // llm 模式：由下方单独处理
    }
  })();

  // ── llm 模式：提取 [NOTIFY] 块并推送 ──────────────────────────────────
  if (job.output.notify === "llm" && bridge && job.output.peerId) {
    const blocks = extractNotifyBlocks(resultText);
    for (const block of blocks) {
      try {
        const prefixed = block.startsWith("<img")
          ? block
          : `📅 [定时]
${block}`;
        await bridge.send(job.output.peerId, job.output.msgType, prefixed);
      } catch (err) {
        console.error(`[cron] llm notify 推送失败 job=${job.id}:`, err);
      }
    }
    if (blocks.length > 0) {
      console.log(`[cron] job=${job.id} llm notify: 推送了 ${blocks.length} 条通知`);
    } else {
      console.log(`[cron] job=${job.id} llm notify: 无 [NOTIFY] 块，静默`);
    }
  }

  if (shouldNotify && bridge && job.output.peerId && job.output.sessionId) {
    try {
      const prefixed = resultText.startsWith("<img")
        ? resultText
        : `📅 [定时]
${resultText}`;
      await bridge.send(job.output.peerId, job.output.msgType, prefixed);
    } catch (err) {
      console.error(`[cron] 推送结果失败 job=${job.id}:`, err);
    }
  }

  // ── 更新 job 状态 ─────────────────────────────────────────────────────────
  updateJob(job.id, {
    lastRunAt: now,
    lastRunStatus: status,
    lastRunResult: resultText,
  });

  // ── 无状态模式:运行完删 JSONL ────────────────────────────────────────────
  // Pipeline 模式不删除(session 是其共享状态的载体;若需无状态可在 steps 执行完后清理)
  if (!job.stateful && !isPipeline) {
    const sanitized = sessionId.replace(/[:/\\]/g, "_");
    const jsonlPath = path.join(os.homedir(), ".tinyclaw", "sessions", `${sanitized}.jsonl`);
    try {
      fs.unlinkSync(jsonlPath);
    } catch {
      /* 文件可能不存在,忽略 */
    }
  }

  // ── 带时间戳 session 同前缀只保最新 1 个 ──────────────────────────────
  {
    const sanitized2 = sessionId.replace(/[:/\\]/g, "_");
    const tsMatch = sanitized2.match(/^(.+_)\d{13}$/);
    if (tsMatch) {
      const { Session } = await import("../core/session.js");
      Session.pruneOldByPrefix(tsMatch[1]!, 1);
    }
  }
}
