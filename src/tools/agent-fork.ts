/**
 * agent-fork 工具集 — Master-Slave Agent Fork
 *
 * 提供五个工具：
 * - agent_fork   在后台 fork 一个 Slave agent，按轮数继承 Master 上下文
 * - agent_status 查询 Slave 运行进度（含当前阶段 / 已用工具 / 实时输出）
 * - agent_wait   等待完成并取回结果全文
 * - agent_trace  检索已归档的 Slave 执行轨迹（子 agent 的完整留档）
 * - agent_abort  软中断 Slave
 */

import { registerTool, type ToolContext } from "./registry.js";
import { slaveManager, type SlaveState } from "../core/slave-manager.js";
import {
  listSlaveTrajectories,
  readSlaveTrajectory,
  slaveTrajectoryRoot,
} from "../core/slave-trajectory.js";

// ── agent_fork ────────────────────────────────────────────────────────────────

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "agent_fork",
      description:
        "Fork a Slave agent in the background to run a task asynchronously (inheriting " +
        "the Master's recent context); returns slave_id immediately without blocking.\n" +
        "Prefer this over doing the work inline whenever a task takes more than a few " +
        "seconds or splits into independent pieces — for independent parts fork one " +
        "Slave per part with result_mode=wait and combine them with agent_wait.\n" +
        "result_mode: inject (default: auto-inject into the Master on completion and " +
        "notify the user) / wait (silent, fetch the result via agent_wait). " +
        "See skill agent-orchestration for full orchestration details",
      parameters: {
        type: "object",
        properties: {
          task: {
            type: "string",
            description:
              "Concrete task for the Slave to complete (clear and independently " +
              "executable)",
          },
          context_rounds: {
            type: "number",
            description:
              "**Upper bound** on inherited rounds (the stricter of this and context_mode). " +
              "Default 10, max 30. When the budget is short, fewer rounds are given " +
              "automatically; do not expect raising it to fit the whole history",
          },
          context_mode: {
            type: "string",
            enum: ["task-only", "minimal", "standard", "full"],
            description:
              "Inheritance mode (defaults to memory.slaveContextMode from config): " +
              "task-only = inherit nothing (cheapest; MEM.md in the system prompt stays); " +
              "minimal = Master summary + at most the 6 most recent rounds; " +
              "standard = summary + as many recent rounds as the budget allows; " +
              "full = same as standard but with no round cap (still limited by the budget). " +
              "Note: inheritance covers recency (what was just discussed); long-term " +
              "context comes from MEM.md / ACTIVE.md / semantic retrieval; put background " +
              "needs in task",
          },
          progress_interval_secs: {
            type: "number",
            description:
              "Progress reporting interval in seconds (30-3600); " +
              "if not set, notify only when the task completes",
          },
          result_mode: {
            type: "string",
            enum: ["inject", "wait"],
            description:
              "inject (default): auto-inject into the Master on completion; " +
              "wait: silent, fetch the result with agent_wait",
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

    const contextRounds = Math.min(Math.max(1, Number(args["context_rounds"] ?? 10)), 30);
    const rawMode = args["context_mode"] ? String(args["context_mode"]) : undefined;
    const contextMode =
      rawMode === "task-only" || rawMode === "minimal" || rawMode === "standard" || rawMode === "full"
        ? rawMode
        : undefined;

    // 定期进度汇报间隔：限制在 30s - 3600s 之间
    const rawInterval = args["progress_interval_secs"];
    const reportIntervalSecs =
      rawInterval !== undefined ? Math.min(3600, Math.max(30, Number(rawInterval))) : undefined;

    // 结果交付模式
    const resultMode: "inject" | "wait" = args["result_mode"] === "wait" ? "wait" : "inject";

    const slaveId = slaveManager.fork(
      task,
      ctx.masterSession,
      contextRounds,
      ctx.slaveRunFn,
      ctx.onSlaveComplete,
      reportIntervalSecs,
      ctx.onProgressNotify,
      resultMode,
      undefined,
      contextMode
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
      `继承模式：${contextMode ?? "config 默认"}（轮数上限 ${contextRounds}，实际受 token 预算约束）\n` +
      `交付模式：${resultMode}` +
      progressNote +
      `\n\n` +
      modeNote +
      `\n` +
      `用 \`agent_status(slave_id="${slaveId}")\` 查询进度。\n` +
      `完成后轨迹会全文归档，可用 \`agent_trace(slave_id="${slaveId}")\` 复查。`
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
        "Query the status/progress of background Slaves; omit slave_id to list all " +
        "(filtered by status_filter), with running ones first",
      parameters: {
        type: "object",
        properties: {
          slave_id: {
            type: "string",
            description: "Slave ID to query (the slave_id returned by agent_fork)",
          },
          status_filter: {
            type: "string",
            enum: ["running", "done", "error", "aborted"],
            description: "Only show Slaves with this status (omit to show all)",
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
        "Wait for background Slaves to finish and return results. Pass slave_id to wait " +
        "for one; omit it to wait for all Slaves in the current session.\n" +
        "timeout_secs defaults to 300; on timeout the Slave is marked error. In inject " +
        "mode an already-finished Slave returns immediately. See skill agent-orchestration",
      parameters: {
        type: "object",
        properties: {
          slave_id: {
            type: "string",
            description:
              "Single Slave ID to wait for (the slave_id returned by agent_fork). " +
              "Omit to wait for all Slaves in the current session.",
          },
          timeout_secs: {
            type: "number",
            description:
              "Wait timeout in seconds (default 300). On timeout, unfinished Slaves " +
              "are marked error and returned.",
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
      const res = await slaveManager.waitForById(slaveId, timeoutSecs * 1000);
      if (!res) return `Slave "${slaveId}" 不存在（可能 ID 有误或已被 GC 清理）`;
      return formatSlaveBlock(res.state, { timedOut: res.timedOut, timeoutSecs });
    }

    // ── 等待当前会话所有 Slave ─────────────────────────────────────────────────
    const res = await slaveManager.waitForByMaster(
      ctx.masterSession.sessionId,
      timeoutSecs * 1000
    );

    if (res.states.size === 0) {
      return "当前会话没有任何 Slave 任务（可能尚未调用 agent_fork，或已被 GC 清理）。";
    }

    const lines: string[] = [];
    if (res.timedOut) {
      lines.push(
        `⏱️ 等待超时（>${timeoutSecs}s）。以下 Slave **仍在运行**，其状态未被改写：` +
          res.stillRunningIds.map((i) => `\`${i}\``).join("、") +
          `\n继续用 \`agent_status(slave_id=…)\` 查询，或用 \`agent_abort(slave_id=…)\` 中止。\n`
      );
    } else {
      lines.push(`共 ${res.states.size} 个 Slave 任务已结束，结果如下：\n`);
    }

    for (const [sid, state] of res.states) {
      lines.push(
        formatSlaveBlock(state, { timedOut: res.timedOut && state.status === "running", timeoutSecs })
      );
      lines.push("");
    }

    return lines.join("\n");
  },
});

// ── agent_trace ───────────────────────────────────────────────────────────────

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "agent_trace",
      description:
        "Search archived Slave execution traces (the full record of a sub-agent's run).\n" +
        "Without slave_id: list recent archived traces (task, status, tools, directory).\n" +
        "With slave_id: returns the full final result plus the trace file path " +
        "(the trace JSONL contains every round's tool calls and results).\n" +
        "Archive directories look like ~/.tinyclaw/slaves/YYYY-MM/YYYY-MM-DD-<slaveId>/.",
      parameters: {
        type: "object",
        properties: {
          slave_id: {
            type: "string",
            description:
              "Slave ID to search (also accepts an archive directory name, " +
              "e.g. 2026-09-10-a1b2c3d4)",
          },
          limit: {
            type: "number",
            description: "When slave_id is omitted, how many recent entries to list (default 20)",
          },
          full: {
            type: "boolean",
            description:
              "With slave_id, whether to also return the full trace JSONL " +
              "(default false: only the path; traces may be long)",
          },
        },
      },
    },
  },
  execute: async (args: Record<string, unknown>): Promise<string> => {
    const slaveId = args["slave_id"] ? String(args["slave_id"]).trim() : "";
    const limit = Math.min(200, Math.max(1, Number(args["limit"] ?? 20)));
    const full = Boolean(args["full"]);

    if (!slaveId) {
      const list = listSlaveTrajectories(limit);
      if (list.length === 0) return `暂无归档轨迹（目录：${slaveTrajectoryRoot()}）`;
      const lines = [`最近 ${list.length} 条归档轨迹（根目录：\`${slaveTrajectoryRoot()}\`）：\n`];
      for (const item of list) {
        const m = item.meta;
        const statusIcon =
          m?.status === "done" ? "✅" : m?.status === "error" ? "❌" : m?.status === "aborted" ? "⛔" : "❓";
        const task = m?.task ?? "(meta 缺失)";
        lines.push(
          `${statusIcon} \`${item.slaveId}\` — ${item.date}\n` +
            `  任务：${task.slice(0, 100)}${task.length > 100 ? "…" : ""}\n` +
            `  工具：${m && m.toolsUsed.length > 0 ? m.toolsUsed.join(", ") : "（无）"}\n` +
            `  目录：\`${item.dir}\``
        );
      }
      return lines.join("\n\n");
    }

    const trace = readSlaveTrajectory(slaveId, { includeResult: true });
    if (!trace) {
      return (
        `未找到 Slave \`${slaveId}\` 的归档轨迹。\n` +
        `可能原因：该 Slave 尚未结束（轨迹在结束时归档）、进程重启前未正常收尾且 gc 未跑到，或 ID 有误。\n` +
        `用 \`agent_trace()\`（不传参）列出全部已归档轨迹；运行中的 Slave 用 \`agent_status\` 查询。`
      );
    }

    const lines = [
      `✅ Slave \`${slaveId}\` 的归档轨迹`,
      `目录：\`${trace.dir}\``,
      `轨迹文件：\`${trace.dir}/trajectory.jsonl\`（每行一条消息，含工具调用与结果全文）`,
      ``,
      `**最终结果全文**：`,
      trace.result || "（无结果文件）",
    ];
    if (full) {
      lines.push("", "**轨迹 JSONL 全文**：", "```jsonl", trace.trajectory, "```");
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
      description: "Soft-abort a running Slave agent.",
      parameters: {
        type: "object",
        properties: {
          slave_id: {
            type: "string",
            description: "Slave ID to abort",
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

/** 状态图标（全文件唯一实现，避免多处重复） */
function statusIcon(status: SlaveState["status"]): string {
  switch (status) {
    case "running":
      return "⏳";
    case "done":
      return "✅";
    case "error":
      return "❌";
    case "aborted":
      return "⛔";
  }
}

function durationStr(state: SlaveState): string {
  if (!state.finishedAt) return "";
  const secs = Math.round(
    (new Date(state.finishedAt).getTime() - new Date(state.startedAt).getTime()) / 1000
  );
  return ` (耗时 ${secs}s)`;
}

/** agent_status 的单行/多行状态描述（不返回结果全文，避免刷屏） */
function formatSlaveState(state: SlaveState): string {
  const lines = [
    `${statusIcon(state.status)} Slave \`${state.slaveId}\` — ${state.status}`,
    `任务：${state.task.slice(0, 80)}${state.task.length > 80 ? "…" : ""}`,
    `启动：${state.startedAt}`,
  ];

  if (state.finishedAt) lines.push(`完成：${state.finishedAt}`);
  if (state.context) {
    const c = state.context;
    lines.push(
      `继承上下文：mode=${c.mode}，${c.inheritedRounds} 轮 / ${c.inheritedMessages} 条` +
        `（约 ${c.usedTokens}/${c.budgetTokens} tokens）` +
        `${c.summaryInjected ? " + Master 摘要" : ""}` +
        `${c.droppedRounds > 0 ? `；未纳入 ${c.droppedRounds} 轮（mode 或预算所限）` : ""}`
    );
    if (c.recall) {
      lines.push(
        `召回层：ACTIVE.md=${c.recall.activeMd ? "已注入" : "无"}，` +
          `语义检索=${c.recall.memoryChars} 字符`
      );
    }
  }
  if (state.progress.phase) lines.push(`当前阶段：${state.progress.phase}`);
  if (state.progress.toolsUsed.length > 0) {
    const n = state.progress.toolCallCount ?? state.progress.toolsUsed.length;
    lines.push(`已用工具（共 ${n} 次调用）：${state.progress.toolsUsed.join(", ")}`);
  }
  if (state.status === "running" && state.progress.partialOutput) {
    lines.push(`最新输出：…${state.progress.partialOutput.slice(-200)}`);
  }
  if (state.result && state.status !== "running") {
    lines.push(`结果：${state.result.slice(0, 300)}${state.result.length > 300 ? "…" : ""}`);
  }
  if (state.tracePath) {
    lines.push(`轨迹：\`${state.tracePath}\`（可用 agent_trace 检索全文）`);
  }

  return lines.join("\n");
}

/**
 * agent_wait 的完整结果块：**结果全文不截断**（B4）。
 * 超长结果由 registry 的 sanitizeToolResult 统一收口，工具内不再自行截断。
 */
function formatSlaveBlock(
  state: SlaveState,
  opts: { timedOut: boolean; timeoutSecs: number }
): string {
  const lines = [
    `${statusIcon(state.status)} Slave \`${state.slaveId}\`${durationStr(state)}`,
    `**任务**：${state.task.slice(0, 120)}${state.task.length > 120 ? "…" : ""}`,
  ];

  if (opts.timedOut) {
    lines.push(
      `**状态**：仍在运行（本次等待超过 ${opts.timeoutSecs}s，**未改写其状态**）`,
      `**下一步**：用 \`agent_status(slave_id="${state.slaveId}")\` 继续查询进度`
    );
  } else {
    lines.push(`**状态**：${state.status}`);
  }

  if (state.progress.phase && state.status === "running") {
    lines.push(`**当前阶段**：${state.progress.phase}`);
  }

  lines.push(`**结果**：\n${state.result || "（无输出）"}`);

  if (state.tracePath) {
    lines.push(`**轨迹**：\`${state.tracePath}\`（\`agent_trace(slave_id="${state.slaveId}")\` 可取全文）`);
  }

  return lines.join("\n");
}
