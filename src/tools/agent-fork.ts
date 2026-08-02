/**
 * agent-fork 工具集 — Master-Slave Agent Fork
 *
 * 提供三个工具：
 * - agent_fork   在后台 fork 一个 Slave agent，继承 Master 上下文
 * - agent_status 查询 Slave 运行进度
 * - agent_abort  软中断 Slave
 */

import { registerTool, type ToolContext } from "./registry.js";
import { slaveManager } from "../core/slave-manager.js";

// ── agent_fork ────────────────────────────────────────────────────────────────

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "agent_fork",
      description:
        "后台 fork 一个 Slave agent 异步执行任务(继承 Master 最近上下文),立即返回 slave_id 不阻塞。\n" +
        "result_mode: inject(默认,完成后自动注入 Master 并通知用户)/ wait(静默,需 agent_wait 取结果)。" +
        "详细编排说明见 skill agent-orchestration",
      parameters: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description: "Slave 需要完成的具体任务描述（清晰、可独立执行）",
          },
          context_window: {
            type: "number",
            description: "从 Master 历史中截取的消息条数作为背景上下文（默认 10，最大 30）",
          },
          progress_interval_secs: {
            type: "number",
            description:
              "进度汇报间隔(秒,30~3600);不设置则仅完成时通知",
          },
          result_mode: {
            type: "string",
            enum: ["inject", "wait"],
            description:
              "inject(默认):完成自动注入 Master;wait:静默,用 agent_wait 取结果",
          },
        },
        required: ["task"],
      },
    },
  },
  execute: async (args: Record<string, unknown>, ctx?: ToolContext): Promise<string> => {
    const task = String(args["task"] ?? "").trim();
    if (!task) return "错误：缺少 task 参数";

    if (!ctx?.masterSession) {
      return "错误：agent_fork 需要在交互式 Agent 会话中调用（masterSession 未提供）";
    }
    if (!ctx.slaveRunFn) {
      return "⚠️ 当前 Slave 不允许嵌套 fork（已达最大嵌套深度 1）。请在 Master 会话中调用 agent_fork。";
    }

    const contextWindow = Math.min(Math.max(1, Number(args["context_window"] ?? 10)), 30);

    // 定期进度汇报间隔：限制在 30s - 3600s 之间
    const rawInterval = args["progress_interval_secs"];
    const reportIntervalSecs =
      rawInterval !== undefined ? Math.min(3600, Math.max(30, Number(rawInterval))) : undefined;

    // 结果交付模式
    const resultMode: "inject" | "wait" = args["result_mode"] === "wait" ? "wait" : "inject";

    const slaveId = slaveManager.fork(
      task,
      ctx.masterSession,
      contextWindow,
      ctx.slaveRunFn,
      ctx.onSlaveComplete,
      reportIntervalSecs,
      ctx.onProgressNotify,
      resultMode
    );

    const progressNote =
      reportIntervalSecs !== undefined
        ? `\n进度汇报：每 ${reportIntervalSecs} 秒推送一次进度快照`
        : resultMode === "inject"
          ? "\n进度汇报：仅在任务完成时自动通知"
          : "\n进度汇报：wait 模式下不自动通知，请调用 agent_wait(slave_id) 主动获取结果";

    const modeNote =
      resultMode === "inject"
        ? "完成后将自动注入 Master 并通知用户。"
        : `完成后静默等待，请调用 \`agent_wait(slave_id="${slaveId}")\` 获取结果。`;

    return (
      `✅ Slave \`${slaveId}\` 已在后台启动\n` +
      `任务：${task.slice(0, 100)}${task.length > 100 ? "…" : ""}\n` +
      `上下文窗口：最近 ${contextWindow} 条消息\n` +
      `交付模式：${resultMode}` +
      progressNote +
      `\n\n` +
      modeNote +
      `\n` +
      `用 \`agent_status(slave_id="${slaveId}")\` 查询进度。`
    );
  },
});

// ── agent_status ──────────────────────────────────────────────────────────────

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "agent_status",
      description:
        "查询后台 Slave 运行状态/进度;不传 slave_id 列出全部(status_filter 过滤),运行中排最前",
      parameters: {
        type: "object",
        properties: {
          slave_id: {
            type: "string",
            description: "要查询的 Slave ID（agent_fork 返回的 slave_id）",
          },
          status_filter: {
            type: "string",
            enum: ["running", "done", "error", "aborted"],
            description: "只显示指定状态的 Slave（不传则显示全部）",
          },
        },
      },
    },
  },
  execute: async (args: Record<string, unknown>): Promise<string> => {
    const slaveId = args["slave_id"] ? String(args["slave_id"]) : undefined;
    const statusFilter = args["status_filter"] ? String(args["status_filter"]) : undefined;

    if (slaveId) {
      const state = slaveManager.status(slaveId);
      if (!state) return `Slave "${slaveId}" 不存在`;
      return formatSlaveState(state);
    }

    // 列出全部（按状态排序：running 优先）
    let all = slaveManager.listAll();
    if (statusFilter) {
      all = all.filter((s) => s.status === statusFilter);
    }
    if (all.length === 0) {
      return statusFilter
        ? `当前没有状态为 "${statusFilter}" 的 Slave 任务`
        : "当前没有任何 Slave 任务";
    }

    // running 排最前
    const sorted = [
      ...all.filter((s) => s.status === "running"),
      ...all.filter((s) => s.status !== "running"),
    ];

    const runningCount = sorted.filter((s) => s.status === "running").length;
    const header = `共 ${sorted.length} 个 Slave 任务（${runningCount} 个运行中）`;
    return header + "\n\n" + sorted.map(formatSlaveState).join("\n---\n");
  },
});

// ── agent_wait ────────────────────────────────────────────────────────────────

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "agent_wait",
      description:
        "等待后台 Slave 完成并返回结果。传 slave_id 等单个;不传等当前会话全部。\n" +
        "timeout_secs 默认 300,超时标记 error。inject 模式已完成则立即返回。详细见 skill agent-orchestration",
      parameters: {
        type: "object",
        properties: {
          slave_id: {
            type: "string",
            description:
              "要等待的单个 Slave ID（agent_fork 返回的 slave_id）。不传则等待当前会话的所有 Slave。",
          },
          timeout_secs: {
            type: "number",
            description:
              "等待超时秒数（默认 300 秒）。超时后将未完成的 Slave 标记为 error 并返回。",
          },
        },
      },
    },
  },
  execute: async (args: Record<string, unknown>, ctx?: ToolContext): Promise<string> => {
    if (!ctx?.masterSession) {
      return "错误：agent_wait 需要在交互式 Agent 会话中调用（masterSession 未提供）";
    }

    const timeoutSecs = Math.min(3600, Math.max(1, Number(args["timeout_secs"] ?? 300)));

    const slaveId = args["slave_id"] ? String(args["slave_id"]).trim() : undefined;

    // ── 等待单个指定 Slave ────────────────────────────────────────────────────
    if (slaveId) {
      const state = await slaveManager.waitForById(slaveId, timeoutSecs * 1000);
      if (!state) return `Slave "${slaveId}" 不存在（可能 ID 有误或已被 GC 清理）`;

      const MAX_RESULT_CHARS = 10000;
      const statusIcon =
        state.status === "done"
          ? "✅"
          : state.status === "error"
            ? "❌"
            : state.status === "aborted"
              ? "⛔"
              : "❓";
      const duration = state.finishedAt
        ? Math.round(
            (new Date(state.finishedAt).getTime() - new Date(state.startedAt).getTime()) / 1000
          )
        : null;
      const durationStr = duration !== null ? ` (耗时 ${duration}s)` : "";

      const lines: string[] = [
        `${statusIcon} Slave \`${slaveId}\`${durationStr}`,
        `**任务**：${state.task.slice(0, 120)}${state.task.length > 120 ? "…" : ""}`,
        `**状态**：${state.status}`,
      ];
      const result = state.result ?? "";
      if (result) {
        const truncated = result.slice(0, MAX_RESULT_CHARS);
        const isTruncated = result.length > MAX_RESULT_CHARS;
        lines.push(
          `**结果**：\n${truncated}${isTruncated ? `\n…（已截断，原长 ${result.length} 字）` : ""}`
        );
      } else {
        lines.push("**结果**：（无输出）");
      }
      return lines.join("\n");
    }

    // ── 等待当前会话所有 Slave ─────────────────────────────────────────────────
    const states = await slaveManager.waitForByMaster(
      ctx.masterSession.sessionId,
      timeoutSecs * 1000
    );

    if (states.size === 0) {
      return "当前会话没有任何 Slave 任务（可能尚未调用 agent_fork，或已被 GC 清理）。";
    }

    const MAX_RESULT_CHARS = 10000;
    const lines: string[] = [`共 ${states.size} 个 Slave 任务完成，结果如下：\n`];

    for (const [sid, state] of states) {
      const statusIcon =
        state.status === "done"
          ? "✅"
          : state.status === "error"
            ? "❌"
            : state.status === "aborted"
              ? "⛔"
              : "❓";
      const duration = state.finishedAt
        ? Math.round(
            (new Date(state.finishedAt).getTime() - new Date(state.startedAt).getTime()) / 1000
          )
        : null;
      const durationStr = duration !== null ? ` (耗时 ${duration}s)` : "";

      lines.push(`### ${statusIcon} Slave \`${sid}\`${durationStr}`);
      lines.push(`**任务**：${state.task.slice(0, 120)}${state.task.length > 120 ? "…" : ""}`);
      lines.push(`**状态**：${state.status}`);

      const result = state.result ?? "";
      if (result) {
        const truncated = result.slice(0, MAX_RESULT_CHARS);
        const isTruncated = result.length > MAX_RESULT_CHARS;
        lines.push(
          `**结果**：\n${truncated}${isTruncated ? `\n…（已截断，原长 ${result.length} 字）` : ""}`
        );
      } else {
        lines.push("**结果**：（无输出）");
      }
      lines.push("");
    }

    return lines.join("\n");
  },
});

// ── agent_abort ───────────────────────────────────────────────────────────────

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "agent_abort",
      description: "软中断一个正在运行的 Slave agent。",
      parameters: {
        type: "object",
        properties: {
          slave_id: {
            type: "string",
            description: "要中断的 Slave ID",
          },
        },
        required: ["slave_id"],
      },
    },
  },
  execute: async (args: Record<string, unknown>): Promise<string> => {
    const slaveId = String(args["slave_id"] ?? "").trim();
    if (!slaveId) return "错误：缺少 slave_id 参数";
    return slaveManager.abort(slaveId);
  },
});

// ── 工具函数 ──────────────────────────────────────────────────────────────────

function formatSlaveState(state: ReturnType<typeof slaveManager.status> & object): string {
  const statusIcon =
    state.status === "running"
      ? "⏳"
      : state.status === "done"
        ? "✅"
        : state.status === "error"
          ? "❌"
          : "⛔";

  const lines = [
    `${statusIcon} Slave \`${state.slaveId}\` — ${state.status}`,
    `任务：${state.task.slice(0, 80)}${state.task.length > 80 ? "…" : ""}`,
    `启动：${state.startedAt}`,
  ];

  if (state.finishedAt) lines.push(`完成：${state.finishedAt}`);
  if (state.progress.toolsUsed.length > 0) {
    lines.push(`已用工具：${state.progress.toolsUsed.join(", ")}`);
  }
  if (state.status === "running" && state.progress.partialOutput) {
    lines.push(`最新输出：…${state.progress.partialOutput.slice(-200)}`);
  }
  if (state.result && state.status !== "running") {
    lines.push(`结果：${state.result.slice(0, 300)}${state.result.length > 300 ? "…" : ""}`);
  }

  return lines.join("\n");
}
