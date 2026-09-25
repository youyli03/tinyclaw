/**
 * `wake` 工具 —— 把一个进程/事件的产出变成"叫醒 LLM 去做判断与汇报"。
 *
 * 场景：后台 job（`job_start`，跑进程）或外部脚本干完活，想让 agent 看一眼结果再决定做什么 ——
 * 进程不能直接调 LLM，但可以（a）自己调 `tinyclaw wake ...` / IPC `wake` 请求，
 * 或者（b）在一个交互会话里让 agent 用本工具唤醒**另一个**会话。
 *
 * 语义与 IPC `wake` 完全一致（同一个实现，`main.ts` 经 `setWakeFn` 注入）：
 * - 注入的文本会带 `[wake ...]` 前缀，让模型知道这不是用户在说话；
 * - 被唤醒那一轮的**权限跟着目标会话走**：目标会话能把审批送到人（如 qqbot 会话）时，按该会话的
 *   普通对话权限跑（全量工具，需要 MFA 时发到该通道等确认）；目标没有交互路径（`cli:` / 无常驻
 *   连接）时退回无人值守规则（工具走白名单、MFA 一律拒绝）；
 *   agent 的最终回复由框架推给该会话绑定的通道（QQ / CLI）。
 *
 * ⚠️ 因此本工具被列入 `HARD_DENY_REACT_UNATTENDED`：无人值守的 ReAct 循环里**模型不能**
 * 用它自我唤醒（那等于自我复制执行）。需要"任务完成→叫醒 agent"，请让脚本/job 调 CLI 或 IPC。
 */

import { registerTool, getWakeFn } from "./registry.js";

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "wake",
      description:
        "Wake up the agent of another (or the same agent's) session: inject a message and start a new " +
        "agent turn for it. Use it to hand a finished background job, an external event, or a finding " +
        "over to another conversation so that agent can act on it. That turn runs with the TARGET " +
        "session's permissions: if the session has a reachable channel (e.g. a QQ chat) it gets the full " +
        "tool set and approval prompts are sent there, otherwise it falls back to the unattended " +
        "whitelist. The target agent's final reply is delivered to its own channel — this call itself " +
        "returns as soon as the wake is accepted. " +
        "For a plain single LLM call without tools/history use the `send` CLI instead.",
      parameters: {
        type: "object",
        properties: {
          message: {
            type: "string",
            description: "What to tell the woken agent. Be explicit about what to check and what to do.",
          },
          session_id: {
            type: "string",
            description: "Target session id. Omit when passing agent_id.",
          },
          agent_id: {
            type: "string",
            description:
              "Target agent id: reuses that agent's most recent session, creating one if none exists.",
          },
          source: {
            type: "string",
            description: "Short label recorded in logs/audit (e.g. job id or script name).",
          },
        },
        required: ["message"],
      },
    },
  },
  execute: async (args: Record<string, unknown>): Promise<string> => {
    const message = typeof args["message"] === "string" ? args["message"].trim() : "";
    if (!message) return "错误：message 不能为空";
    const sessionId = typeof args["session_id"] === "string" ? args["session_id"].trim() : undefined;
    const agentId = typeof args["agent_id"] === "string" ? args["agent_id"].trim() : undefined;
    if (!sessionId && !agentId) return "错误：session_id 与 agent_id 至少要给一个";

    const wakeFn = getWakeFn();
    if (!wakeFn) {
      return "错误：唤醒能力未注入（服务未完成启动？）。脚本侧也可用 `tinyclaw wake` 或 IPC wake 请求。";
    }
    try {
      const result = await wakeFn({
        ...(sessionId ? { sessionId } : {}),
        ...(agentId ? { agentId } : {}),
        message,
        source: typeof args["source"] === "string" ? args["source"] : "agent-tool",
      });
      return `已唤醒 session "${result.sessionId}"。${result.note}`;
    } catch (err) {
      return `错误：唤醒失败 — ${err instanceof Error ? err.message : String(err)}`;
    }
  },
});
