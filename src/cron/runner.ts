/**
 * Cron job 执行器
 *
 * 对每个 job 触发一次 runAgent()，结合 job.output.notify 策略决定是否推送结果，
 * 并将运行记录追加到日志文件。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Session } from "../core/session.js";
import { runAgent } from "../core/agent.js";
import type { Connector } from "../connectors/base.js";
import { updateJob, appendLog } from "./store.js";
import type { CronJob } from "./schema.js";

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
7. **命令必须完整可执行**：exec_shell 的 command 必须是含完整参数的可执行命令，不得依赖 user message 里的隐式约定`;

// ── 执行单个 Job ──────────────────────────────────────────────────────────────

export async function runJob(job: CronJob, connector: Connector | null): Promise<void> {
  const now = new Date().toISOString();
  const sessionId = job.stateful
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

  try {
    const result = await runAgent(session, job.message, { onMFARequest, systemPrompt: CRON_AGENT_SYSTEM });
    resultText = result.content;
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
  if (!job.stateful) {
    const sanitized = sessionId.replace(/[:/\\]/g, "_");
    const jsonlPath = path.join(os.homedir(), ".tinyclaw", "sessions", `${sanitized}.jsonl`);
    try { fs.unlinkSync(jsonlPath); } catch { /* 文件可能不存在，忽略 */ }
  }
}
