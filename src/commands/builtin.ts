/**
 * 内置斜杠命令
 *
 * 副作用 import：import "./builtin.js" 即完成注册。
 * 在 main.ts 和 ipc/server.ts 中各 import 一次（幂等：重复注册会抛出，
 * 但因模块缓存只执行一次，不会重复注册）。
 */

import { registerCommand, listCommands, getCommand } from "./registry.js";
import { slaveManager } from "../core/slave-manager.js";
import { llmRegistry } from "../llm/registry.js";

// ── /help ─────────────────────────────────────────────────────────────────────

registerCommand({
  name: "help",
  description: "显示可用命令列表，或查看某个命令的详细说明",
  usage: "/help [command]",
  execute({ args }) {
    if (args.length > 0) {
      const name = args[0]!.replace(/^\//, "").toLowerCase();
      const cmd = getCommand(name);
      if (!cmd) return `❌ 未知命令 \`/${name}\`，发送 \`/help\` 查看全部命令。`;
      const lines = [
        `**/${cmd.name}** — ${cmd.description}`,
      ];
      if (cmd.usage) lines.push(`用法：\`${cmd.usage}\``);
      return lines.join("\n");
    }

    const cmds = listCommands();
    const lines = ["**可用命令**（发送 `/help <命令名>` 查看详细用法）\n"];
    for (const c of cmds) {
      lines.push(`• \`/${c.name}\` — ${c.description}`);
    }
    return lines.join("\n");
  },
});

// ── /status ───────────────────────────────────────────────────────────────────

registerCommand({
  name: "status",
  description: "查看当前会话状态（消息数、token 用量、agent、运行状态）",
  usage: "/status",
  execute({ session }) {
    const messages = session.getMessages();
    const msgCount = messages.length;
    const isRunning = session.running;
    const contextWindow = llmRegistry.getContextWindow("daily");

    // 优先显示上次 LLM 响应的实际 prompt token；若从未发送请求则显示估算
    let tokenLine: string;
    if (session.lastPromptTokens > 0) {
      const pct = Math.round((session.lastPromptTokens / contextWindow) * 100);
      tokenLine = `Token 用量：${session.lastPromptTokens.toLocaleString()} / ${contextWindow.toLocaleString()} (${pct}%)`;
    } else {
      const est = session.estimatedTokens();
      const pct = Math.round((est / contextWindow) * 100);
      tokenLine = `Token 估算：~${est.toLocaleString()} / ${contextWindow.toLocaleString()} (${pct}%)`;
    }

    const lines = [
      "**会话状态**\n",
      `会话 ID：\`${session.sessionId}\``,
      `绑定 Agent：\`${session.agentId}\``,
      `消息数：${msgCount} 条`,
      tokenLine,
      `当前状态：${isRunning ? "⏳ 运行中" : "✅ 空闲"}`,
    ];

    // 后台任务概览
    const slaves = slaveManager.listAll();
    if (slaves.length > 0) {
      const running = slaves.filter((s) => s.status === "running").length;
      lines.push(`后台任务：${slaves.length} 个（${running} 个运行中）`);
    }

    return lines.join("\n");
  },
});

// ── /abort ────────────────────────────────────────────────────────────────────

registerCommand({
  name: "abort",
  description: "软中断当前正在运行的 agent（不影响后台 Slave 任务）",
  usage: "/abort",
  execute({ session }) {
    if (!session.running) {
      return "ℹ️ 当前没有正在运行的任务，无需中断。";
    }
    session.abortRequested = true;
    session.llmAbortController?.abort();
    session.abortPendingApproval?.();
    return "⛔ 已发送中断信号，当前任务将在本轮 LLM 调用结束后停止。";
  },
});

// ── /save ─────────────────────────────────────────────────────────────────────

registerCommand({
  name: "save",
  description: "立即整理当前 session 的记忆（压缩 → 持久化 → 向量化）",
  usage: "/save",
  async execute({ session }) {
    if (session.running) {
      return "⚠️ 当前有任务正在运行，请等待完成后再整理记忆。";
    }
    try {
      const summary = await session.compress();
      return `✅ 记忆已整理完成\n\n${summary}`;
    } catch (err) {
      return `❌ 记忆整理失败：${err instanceof Error ? err.message : String(err)}`;
    }
  },
});



registerCommand({
  name: "slaves",
  description: "列出后台 Slave 任务，可按状态过滤",
  usage: "/slaves [running|done|error|aborted]",
  execute({ args }) {
    const validFilters = ["running", "done", "error", "aborted"] as const;
    type Filter = (typeof validFilters)[number];

    const filterArg = args[0]?.toLowerCase();
    const filter = validFilters.includes(filterArg as Filter)
      ? (filterArg as Filter)
      : undefined;

    let all = slaveManager.listAll();
    if (filter) {
      all = all.filter((s) => s.status === filter);
    }

    if (all.length === 0) {
      return filter
        ? `当前没有状态为 \`${filter}\` 的 Slave 任务。`
        : "当前没有任何后台 Slave 任务。";
    }

    // running 排最前
    const sorted = [
      ...all.filter((s) => s.status === "running"),
      ...all.filter((s) => s.status !== "running"),
    ];

    const runningCount = sorted.filter((s) => s.status === "running").length;
    const header = `**后台 Slave 任务**（共 ${sorted.length} 个，${runningCount} 个运行中）\n`;

    const items = sorted.map((s) => {
      const icon =
        s.status === "running" ? "⏳" :
        s.status === "done"    ? "✅" :
        s.status === "error"   ? "❌" : "⛔";
      const elapsed = s.finishedAt
        ? `${Math.round((new Date(s.finishedAt).getTime() - new Date(s.startedAt).getTime()) / 1000)}s`
        : `运行中 ${Math.round((Date.now() - new Date(s.startedAt).getTime()) / 1000)}s`;
      return `${icon} \`${s.slaveId}\` ${s.status} (${elapsed})\n   任务：${s.task.slice(0, 60)}${s.task.length > 60 ? "…" : ""}`;
    });

    return header + items.join("\n");
  },
});

// ── /ping ─────────────────────────────────────────────────────────────────────

registerCommand({
  name: "ping",
  description: "测试 LLM 服务连通性（流式请求，报告首 token 延迟 TTFT）",
  usage: "/ping",
  async execute() {
    const client = llmRegistry.get("daily");
    const model = client.model;
    const ac = new AbortController();
    let ttft: number | null = null;
    const start = Date.now();

    try {
      await client.streamChat(
        [{ role: "user", content: "Hi" }],
        (_delta) => {
          if (ttft === null) {
            ttft = Date.now() - start;
            ac.abort(); // 收到首个 token 后立即中断流
          }
        },
        { signal: ac.signal, tool_choice: "none" }
      );
    } catch (err) {
      // ac.abort() 会触发 AbortError — 这是预期的成功路径
      if (!ac.signal.aborted) {
        const latencyMs = Date.now() - start;
        const msg = err instanceof Error ? err.message : String(err);
        return `❌ **LLM 连通性测试失败**（${latencyMs} ms）\n模型：\`${model}\`\n错误：${msg}`;
      }
    }

    const totalMs = Date.now() - start;
    if (ttft !== null) {
      return `🏓 **pong** — LLM 服务正常\n模型：\`${model}\`\nTTFT：${ttft} ms（首 token）\n总耗时：${totalMs} ms`;
    }
    // 流正常结束但没有 token（空响应）
    return `🏓 **pong** — 连接成功，但未收到 token\n模型：\`${model}\`\n总耗时：${totalMs} ms`;
  },
});
