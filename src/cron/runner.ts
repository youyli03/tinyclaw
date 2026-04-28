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
import type { InboundMessage } from "../connectors/base.js";
import { updateJob, appendLog } from "./store.js";
import type { CronJob } from "./schema.js";
import { parseModelSymbol, isPremiumModel, buildFallbackClient } from "../llm/registry.js";
import { buildCopilotClient } from "../llm/copilot.js";
import { LLMClient } from "../llm/client.js";
import type { AnyLLMClient } from "../llm/registry.js";
import { loadConfig } from "../config/loader.js";
import { executeTool } from "../tools/registry.js";
import type { ToolContext } from "../tools/registry.js";

// ── Cron 专用 system prompt（约束 agent 不递归创建任务） ──────────────────────

const CRON_AGENT_SYSTEM = `## ⚠️ 你正在以【自动化 cron 任务】身份运行（非交互式）

以下规则必须严格遵守：

### 执行规范
1. **直接执行**：user 消息即为你的任务指令，立即执行，不要询问用户确认或追问细节
2. **禁止创建 cron 任务**：不得调用 cron_add 工具，当前运行的就是 cron 任务本身
3. **无人值守**：没有用户在线，所有工具调用须自主完成，不依赖人工介入
4. **简洁输出**：仅输出最终结果，不要提供操作选项、说明步骤或描述你做了什么

### 数据获取规范（强制）
5. **实时数据必须用工具获取**：天气、股价、汇率、系统状态等时效性数据，必须通过 exec_shell 执行具体命令（curl/wget/df/free 等）获取真实数据，禁止凭记忆或训练知识直接输出数值
6. **失败时明确报告**：若 exec_shell 返回错误或数据格式异常，输出"数据获取失败：<具体原因>"，不得用猜测值替代
7. **命令必须完整可执行**：exec_shell 的 command 必须是含完整参数的可执行命令，不得依赖 user message 里的隐式约定
8. **注意超时**：exec_shell 默认超时 60 秒；预计超过 60 秒的命令，必须显式传入更大的 timeout_sec，不能假设系统会无限等待

### 输出规范（关键）
9. **输出实际内容，禁止摘要**：你的最终文字回复将直接推送给用户，必须包含从工具中获取到的实际数据（如天气数值、查询结果、执行输出等），**严禁只输出"已执行"、"任务完成"、"操作成功"等摘要语句替代真实内容**`;

/**
 * 当 notify=llm 时追加到 system prompt 的通知约定说明。
 */
const CRON_LLM_NOTIFY_SUFFIX = `

### 通知规则(本任务启用 LLM 判断推送)
- 如果你判断需要通知用户,将要推送的内容用 [NOTIFY]...[/NOTIFY] 包裹
- 可以有多个 [NOTIFY] 块,每块内容将独立推送给用户
- 如果不需要通知,不输出任何 [NOTIFY] 块即可,系统将保持静默
- [NOTIFY] 块之外的内容仅写入日志,不会推送
- 示例:
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

    if (provider === "copilot") {
      const copilotCfg = cfg.providers.copilot;
      if (!copilotCfg) {
        throw new Error("job.model 使用 copilot provider,但 [providers.copilot] 未配置");
      }
      const { client } = await buildCopilotClient({
        githubToken: copilotCfg.githubToken,
        model: modelId,
        timeoutMs: copilotCfg.timeoutMs,
      });
      console.log(`[cron] job=${job.id} 使用指定模型: ${job.model}`);
      return client;
    } else if (provider === "openai") {
      const openaiCfg = cfg.providers.openai;
      if (!openaiCfg) {
        throw new Error("job.model 使用 openai provider,但 [providers.openai] 未配置");
      }
      console.log(`[cron] job=${job.id} 使用指定模型: ${job.model}`);
      return new LLMClient({
        baseUrl: openaiCfg.baseUrl,
        apiKey: openaiCfg.apiKey,
        model: modelId,
        maxTokens: openaiCfg.maxTokens,
        timeoutMs: openaiCfg.timeoutMs,
      });
    } else {
      throw new Error(`job.model 使用未知 provider "${provider}"`);
    }
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
  overrideClient: AnyLLMClient | undefined,
  systemPrompt: string,
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
        slaveDepth: 1,
        ...(notifyFn ? { onNotify: notifyFn } : {}),
      }),
    // cron pipeline 用 result_mode="wait" + agent_wait 汇总结果，inject 回调保持 no-op
    onSlaveComplete: async (_notif) => { /* no-op */ },
    // 透传推送回调，SubAgent 内部调用 notify_user 时可正常推送
    ...(notifyFn ? { onNotify: notifyFn } : {}),
  };

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const stepLabel = `[pipeline step ${i + 1}/${steps.length}:${step.type}]`;

    if (step.type === "tool") {
      console.log(`[cron] job=${job.id} ${stepLabel} 执行工具: ${step.name}`);
      const toolResult = await executeTool(step.name, step.args as Record<string, unknown>, toolCtx);
      lastResult = toolResult;

      // 将工具输出以合成 tool call 对注入 session：
      // assistant(tool_calls) + tool(result)，使后续 LLM 步骤以原生工具结果格式感知数据
      const syntheticCallId = `pipeline_step${i + 1}_${step.name}_${Date.now()}`;
      session.addAssistantWithToolCalls("", [{
        callId: syntheticCallId,
        name: step.name,
        args: step.args as Record<string, unknown>,
      }]);
      session.addToolResultMessage(syntheticCallId, toolResult);
      console.log(`[cron] job=${job.id} ${stepLabel} 完成，输出长度: ${toolResult.length}`);

    } else {
      // msg step：触发 LLM
      console.log(`[cron] job=${job.id} ${stepLabel} 触发 LLM，msg: "${step.content.slice(0, 60)}"`);
      const result = await runAgent(session, step.content, {
        onMFARequest,
        systemPrompt: systemPrompt,
        ...(notifyFn ? { onNotify: notifyFn } : {}),
        ...(overrideClient ? { overrideClient } : {}),
        // slaveDepth: 1 禁止 msg step 里的 LLM 调用 agent_fork，防止 Cron Pipeline 无限递归
        // Pipeline 中需要 fork 请改用 type:"tool", name:"agent_fork" 的 tool step 显式触发
        slaveDepth: 1,
        // cron 场景下 inject 模式的 slave 完成不额外推送用户（wait 模式 slave 本就不触发此回调）
        onSlaveComplete: async (_notif) => { /* no-op for cron pipeline: use result_mode="wait" + agent_wait instead */ },
      });
      lastResult = result.content;
      console.log(`[cron] job=${job.id} ${stepLabel} 完成，输出长度: ${result.content.length}`);
    }
  }

  return lastResult;
}

// ── 执行单个 Job ──────────────────────────────────────────────────────────────

export async function runJob(job: CronJob, bridge: CronRuntimeBridge | null): Promise<void> {
  const now = new Date().toISOString();

  // Pipeline 模式强制使用 stateful session（步骤间需共享上下文）
  const isPipeline = Array.isArray(job.steps) && job.steps.length > 0;
  const sessionId = (job.stateful || isPipeline)
    ? `cron:${job.id}`
    : `cron:${job.id}:${Date.now()}`;

  // Pipeline 模式：若 clearSessionOnRun !== false（默认 true）且非 stateful，运行前清空 session JSONL，
  // 防止历史消息（含旧行情数据）跨 run 污染当次上下文。必须在 new Session() 之前执行，
  // 否则 Session 构造函数会先从 JSONL 加载旧历史
  if (isPipeline && !job.stateful && job.clearSessionOnRun !== false) {
    const sanitized = sessionId.replace(/[:/\\]/g, "_");
    const jsonlPath = path.join(os.homedir(), ".tinyclaw", "sessions", `${sanitized}.jsonl`);
    try { fs.unlinkSync(jsonlPath); } catch { /* 文件不存在时忽略 */ }
  }

  const session = new Session(sessionId, { agentId: job.agentId });

  // MFA 处理：exempt = 自动通过，否则透传给 connector（如无 connector 则自动通过）
  const onMFARequest = job.mfaExempt
    ? async () => true
    : bridge && job.output.peerId && bridge.requestUserInput
      ? async (warningMsg: string, verifyCode?: (code: string) => boolean) => {
          const answer = await bridge.requestUserInput!(
            job.output.peerId!,
            job.output.msgType,
            warningMsg,
            60_000,
          );
          if (verifyCode) {
            const digits = answer.replace(/\s/g, "");
            return /^\d{6}$/.test(digits) && verifyCode(digits);
          }
          return /^确认$|^y$|^yes$/i.test(answer.trim());
        }
      : async () => true;

  let status: "success" | "error" = "success";
  let resultText = "";

  const overrideClient = await buildOverrideClient(job);

  const notifyFn = bridge && job.output.peerId
    ? async (message: string) => {
        const prefixed = message.startsWith("<img") ? message : `📅 [定时]
${message}`;
        await bridge.send(job.output.peerId!, job.output.msgType, prefixed);
      }
    : undefined;

  // notify=llm 时在 system prompt 追加 [NOTIFY] 约定说明
  const systemPrompt = job.output.notify === "llm"
    ? CRON_AGENT_SYSTEM + CRON_LLM_NOTIFY_SUFFIX
    : CRON_AGENT_SYSTEM;

  try {
    if (isPipeline) {
      // ── Pipeline 模式 ──────────────────────────────────────────────────────
      console.log(`[cron] job=${job.id} 以 Pipeline 模式运行（${job.steps!.length} 步）`);
      resultText = await runPipelineJob(job, session, onMFARequest, notifyFn, overrideClient, systemPrompt);
    } else {
      // ── 单步模式（向后兼容）────────────────────────────────────────────────
      const result = await runAgent(session, job.message, {
        onMFARequest,
        systemPrompt: systemPrompt,
        ...(notifyFn ? { onNotify: notifyFn } : {}),
        ...(overrideClient ? { overrideClient } : {}),
      });
      resultText = result.content;
    }
  } catch (err) {
    status = "error";
    resultText = `执行失败：${err instanceof Error ? err.message : String(err)}`;
  }

  // ── 写日志 ────────────────────────────────────────────────────────────────
  appendLog({ ts: now, status, result: resultText, jobId: job.id });

  // ── 通知策略 ──────────────────────────────────────────────────────────────
  const shouldNotify = ((): boolean => {
    switch (job.output.notify) {
      case "always":    return true;
      case "on_error":  return status === "error";
      case "on_change": return resultText !== (job.lastRunResult ?? "");
      case "never":     return false;
      case "llm":       return false; // llm 模式：由下方单独处理
    }
  })();

  // ── llm 模式：提取 [NOTIFY] 块并推送 ──────────────────────────────────
  if (job.output.notify === "llm" && bridge && job.output.peerId) {
    const blocks = extractNotifyBlocks(resultText);
    for (const block of blocks) {
      try {
        const prefixed = block.startsWith("<img") ? block : `📅 [定时]
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
      const prefixed = resultText.startsWith("<img") ? resultText : `📅 [定时]
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
    try { fs.unlinkSync(jsonlPath); } catch { /* 文件可能不存在,忽略 */ }
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
