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
          context_rounds: {
            type: "number",
            description:
              "继承 Master 最近多少轮对话作为背景（一轮 = 一条用户消息起算，含该轮内全部工具调用与结果）；默认 10，最大 30",
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

    const contextRounds = Math.min(Math.max(1, Number(args["context_rounds"] ?? 10)), 30);

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
      `继承上下文：Master 最近 ${contextRounds} 轮对话（含工具调用与结果）\n` +
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
        "检索已归档的 Slave 执行轨迹（子 agent 的完整过程留档）。\n" +
        "不传 slave_id：列出最近归档的轨迹（含任务、状态、工具、归档目录）。\n" +
        "传 slave_id：返回该 Slave 的最终结果全文 + 轨迹文件路径（轨迹 JSONL 含每轮工具调用与结果）。\n" +
        "归档目录形如 ~/.tinyclaw/slaves/YYYY-MM/YYYY-MM-DD-<slaveId>/。",
      parameters: {
        type: "object",
        properties: {
          slave_id: {
            type: "string",
            description: "要检索的 Slave ID（也接受归档目录名，如 2026-09-10-a1b2c3d4）",
          },
          limit: {
            type: "number",
            description: "不传 slave_id 时，列出最近多少条（默认 20）",
          },
          full: {
            type: "boolean",
            description:
              "传 slave_id 时是否一并返回轨迹 JSONL 全文（默认 false，只返回路径；轨迹可能很长）",
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
    lines.push(
      `继承上下文：${state.context.inheritedRounds} 轮 / ${state.context.inheritedMessages} 条` +
        `（约 ${state.context.inheritedChars} 字符）` +
        `${state.context.summaryInjected ? " + Master 摘要" : ""}` +
        `${state.context.droppedRounds > 0 ? `；因预算上限丢弃了最旧 ${state.context.droppedRounds} 轮` : ""}`
    );
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
