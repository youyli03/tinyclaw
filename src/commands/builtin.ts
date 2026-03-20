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
import { loadConfig } from "../config/loader.js";
import { getCachedCopilotInfo, getCopilotRateLimit, lookupMultiplier } from "../llm/copilot.js";

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
  description: "查看当前会话状态（模式、消息数、token 用量、agent、Copilot 配额）",
  usage: "/status",
  async execute({ session }) {
    const messages = session.getMessages();
    const msgCount = messages.length;
    const isRunning = session.running;
    const isCodeMode = session.mode === "code";
    const backendName = isCodeMode ? "code" : "daily";
    const contextWindow = llmRegistry.getContextWindow(backendName);

    // ── 模式行 ───────────────────────────────────────────────────────────────
    let modeLine: string;
    if (isCodeMode) {
      const subModeIcon = session.codeSubMode === "plan" ? "📋 Plan" : "🚀 Auto";
      modeLine = `模式：🖥️ Code · ${subModeIcon} 子模式`;
    } else {
      modeLine = "模式：💬 Chat 模式";
    }

    // ── Token 行 ─────────────────────────────────────────────────────────────
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
      modeLine,
      `会话 ID：\`${session.sessionId}\``,
      `绑定 Agent：\`${session.agentId}\``,
      `消息数：${msgCount} 条`,
      tokenLine,
      `当前状态：${isRunning ? "⏳ 运行中" : "✅ 空闲"}`,
    ];

    // ── 后台任务概览 ─────────────────────────────────────────────────────────
    const slaves = slaveManager.listAll();
    if (slaves.length > 0) {
      const running = slaves.filter((s) => s.status === "running").length;
      lines.push(`后台任务：${slaves.length} 个（${running} 个运行中）`);
    }

    // ── Copilot 信息 ─────────────────────────────────────────────────────────
    try {
      const config = loadConfig();
      const copilotCfg = config.providers?.copilot;
      if (copilotCfg?.githubToken) {
        const modelName = llmRegistry.get(backendName).model;
        const multiplier = lookupMultiplier(modelName);

        // 格式化 multiplier
        let multiplierStr: string;
        if (multiplier === undefined) multiplierStr = "-";
        else if (multiplier === 0) multiplierStr = "免费（不计配额）";
        else multiplierStr = `${multiplier}×`;

        // 从缓存读取 Copilot token 信息（不触发新网络请求）
        const info = getCachedCopilotInfo(copilotCfg.githubToken);

        // 配额信息：优先从补全 API 响应头（付费计划），回退到 token 响应体（免费计划）
        let quotaStr = "N/A（发送消息后更新）";
        const rl = getCopilotRateLimit(copilotCfg.githubToken);
        if (rl) {
          const ageMin = Math.round((Date.now() - rl.capturedAt) / 60_000);
          const ageSuffix = ageMin < 1 ? "" : `（${ageMin} 分钟前更新）`;
          quotaStr = `${rl.remaining} / ${rl.limit}${ageSuffix}`;
        } else if (info.quotas) {
          // 免费计划：token 响应体中的 limited_user_quotas
          const chatQuota = (info.quotas["chat_completions"] ?? Object.values(info.quotas)[0]) as
            | Record<string, unknown>
            | undefined;
          if (chatQuota) {
            const remaining = chatQuota["remaining"];
            const limit = chatQuota["monthly_limit"];
            if (typeof remaining === "number" && typeof limit === "number") {
              quotaStr = `${remaining} / ${limit}`;
            } else if (typeof remaining === "number") {
              quotaStr = String(remaining);
            }
          }
        }

        const skuStr = info.sku ?? (info.tokenCached ? "（SKU 未知）" : "（未初始化）");

        // Code 模式独立模型提示
        let modelDisplayName = `\`${modelName}\``;
        if (isCodeMode && !config.llm.backends.code) {
          modelDisplayName += "（与 Chat 共用 daily 模型，可在 [llm.backends.code] 独立配置）";
        }

        lines.push(
          "",
          `Copilot：${modelDisplayName} · ${multiplierStr} premium/请求 · 剩余配额：${quotaStr} · 计划：${skuStr}`,
        );
      }
    } catch {
      // Copilot 未配置或初始化失败，忽略
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

// ── code 模式命令（/code 和 /chat）────────────────────────────────────────────
// 命令实现在 src/code/，此处触发注册
import "../code/index.js";
