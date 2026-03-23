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
import type { Connector } from "../connectors/base.js";
import { updateJob, appendLog } from "./store.js";
import type { CronJob } from "./schema.js";
import { parseModelSymbol } from "../llm/registry.js";
import { buildCopilotClient } from "../llm/copilot.js";
import { LLMClient } from "../llm/client.js";
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

### 输出规范（关键）
8. **输出实际内容，禁止摘要**：你的最终文字回复将直接推送给用户，必须包含从工具中获取到的实际数据（如天气数值、查询结果、执行输出等），**严禁只输出"已执行"、"任务完成"、"操作成功"等摘要语句替代真实内容**`;

// ── 构建 LLM override client（cron job 指定 model 时使用）──────────────────────

async function buildOverrideClient(job: CronJob): Promise<LLMClient | undefined> {
  if (!job.model) return undefined;
  try {
    const { provider, modelId } = parseModelSymbol(job.model);
    if (provider === "copilot") {
      const cfg = loadConfig();
      const copilotCfg = cfg.providers.copilot;
      if (!copilotCfg) {
        throw new Error("job.model 使用 copilot provider，但 [providers.copilot] 未配置");
      }
      const { client } = await buildCopilotClient({
        githubToken: copilotCfg.githubToken,
        model: modelId,
        timeoutMs: copilotCfg.timeoutMs,
      });
      console.log(`[cron] job=${job.id} 使用指定模型: ${job.model}`);
      return client;
    } else if (provider === "openai") {
      const cfg = loadConfig();
      const openaiCfg = cfg.providers.openai;
      if (!openaiCfg) {
        throw new Error("job.model 使用 openai provider，但 [providers.openai] 未配置");
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
    console.error(`[cron] job=${job.id} 模型初始化失败，回退到 daily：`, err);
    return undefined;
  }
}

// ── Pipeline 模式执行 ─────────────────────────────────────────────────────────

/**
 * 执行 Pipeline Job：按顺序运行 job.steps，共享同一个 stateful session。
 *
 * - `tool` step：直接调用工具，输出注入 session（作为 assistant 消息），供后续 LLM 感知
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
  overrideClient: LLMClient | undefined,
): Promise<string> {
  const steps = job.steps!;
  let lastResult = "";

  // 构建工具执行上下文（pipeline tool steps 使用）
  const toolCtx: ToolContext = {
    sessionId: session.sessionId,
    agentId: job.agentId,
    cwd: os.homedir(),
  };

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    const stepLabel = `[pipeline step ${i + 1}/${steps.length}:${step.type}]`;

    if (step.type === "tool") {
      console.log(`[cron] job=${job.id} ${stepLabel} 执行工具: ${step.name}`);
      const toolResult = await executeTool(step.name, step.args as Record<string, unknown>, toolCtx);
      lastResult = toolResult;

      // 将工具输出注入 session 上下文，以 assistant 消息形式，供后续 LLM 步骤感知
      session.addAssistantMessage(`[pipeline:tool:${step.name}]\n${toolResult}`);
      console.log(`[cron] job=${job.id} ${stepLabel} 完成，输出长度: ${toolResult.length}`);

    } else {
      // msg step：触发 LLM
      console.log(`[cron] job=${job.id} ${stepLabel} 触发 LLM，msg: "${step.content.slice(0, 60)}"`);
      const result = await runAgent(session, step.content, {
        onMFARequest,
        systemPrompt: CRON_AGENT_SYSTEM,
        ...(notifyFn ? { onNotify: notifyFn } : {}),
        ...(overrideClient ? { overrideClient } : {}),
      });
      lastResult = result.content;
      console.log(`[cron] job=${job.id} ${stepLabel} 完成，输出长度: ${result.content.length}`);
    }
  }

  return lastResult;
}

// ── 执行单个 Job ──────────────────────────────────────────────────────────────

export async function runJob(job: CronJob, connector: Connector | null): Promise<void> {
  const now = new Date().toISOString();

  // Pipeline 模式强制使用 stateful session（步骤间需共享上下文）
  const isPipeline = Array.isArray(job.steps) && job.steps.length > 0;
  const sessionId = (job.stateful || isPipeline)
    ? `cron:${job.id}`
    : `cron:${job.id}:${Date.now()}`;

  const session = new Session(sessionId, { agentId: job.agentId });

  // MFA 处理：exempt = 自动通过，否则透传给 connector（如无 connector 则自动通过）
  const onMFARequest = job.mfaExempt
    ? async () => true
    : connector && job.output.peerId
      ? async (warningMsg: string, verifyCode?: (code: string) => boolean) => {
          return (connector as import("../connectors/qqbot/index.js").QQBotConnector)
            .buildMFARequest(
              job.output.peerId!,
              job.output.msgType,
              warningMsg,
              60_000,
              verifyCode,
            );
        }
      : async () => true;

  let status: "success" | "error" = "success";
  let resultText = "";

  const overrideClient = await buildOverrideClient(job);

  const notifyFn = connector && job.output.peerId
    ? async (message: string) => {
        await connector.send(job.output.peerId!, job.output.msgType, message);
      }
    : undefined;

  try {
    if (isPipeline) {
      // ── Pipeline 模式 ──────────────────────────────────────────────────────
      console.log(`[cron] job=${job.id} 以 Pipeline 模式运行（${job.steps!.length} 步）`);
      resultText = await runPipelineJob(job, session, onMFARequest, notifyFn, overrideClient);
    } else {
      // ── 单步模式（向后兼容）────────────────────────────────────────────────
      const result = await runAgent(session, job.message, {
        onMFARequest,
        systemPrompt: CRON_AGENT_SYSTEM,
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
    }
  })();

  if (shouldNotify && connector && job.output.peerId && job.output.sessionId) {
    try {
      await connector.send(job.output.peerId, job.output.msgType, resultText);
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

  // ── 无状态模式：运行完删 JSONL ────────────────────────────────────────────
  // Pipeline 模式不删除（session 是其共享状态的载体；若需无状态可在 steps 执行完后清理）
  if (!job.stateful && !isPipeline) {
    const sanitized = sessionId.replace(/[:/\\]/g, "_");
    const jsonlPath = path.join(os.homedir(), ".tinyclaw", "sessions", `${sanitized}.jsonl`);
    try { fs.unlinkSync(jsonlPath); } catch { /* 文件可能不存在，忽略 */ }
  }
}
