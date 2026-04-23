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
import { getCachedCopilotInfo, getCopilotRateLimit, getCopilotUserQuota, lookupMultiplier } from "../llm/copilot.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";

// ── /help ─────────────────────────────────────────────────────────────────────

registerCommand({
  name: "help",
  description: "显示可用命令列表，或查看某个命令的详细说明",
  usage: "/help [command]",
  execute({ args, session }) {
    if (args.length > 0) {
      const name = args[0]!.replace(/^\//, "").toLowerCase();
      const cmd = getCommand(name);
      if (!cmd) return `❌ 未知命令 \`/${name}\`，发送 \`/help\` 查看全部命令。`;
      const lines = [
        `• \`/${cmd.name}\` — ${cmd.description}`,
      ];
      if (cmd.usage) lines.push(`用法：\`${cmd.usage}\``);
      return lines.join("\n");
    }

    const cmds = listCommands(session.mode);
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

    const waitingStates: string[] = [];
    if (session.pendingPlanApproval) waitingStates.push("📋 等待 Plan 审批");
    if (session.pendingAskUser) waitingStates.push("🤔 等待 ask_user 回复");
    if (session.pendingApproval) waitingStates.push("🔐 等待 MFA 确认");
    if (session.pendingSlaveQuestion) waitingStates.push("🪢 等待子任务提问回复");
    if (waitingStates.length > 0) {
      lines.push(`等待态：${waitingStates.join(" / ")}`);
    }

    // ── 后台任务概览 ─────────────────────────────────────────────────────────
    const slaves = slaveManager.listAll();
    if (slaves.length > 0) {
      const running = slaves.filter((s) => s.status === "running").length;
      lines.push(`后台任务：${slaves.length} 个（${running} 个运行中）`);
    }

    // ── Loop 状态（chat 模式才显示）──────────────────────────────────────────
    if (!isCodeMode) {
      const loops = loopTriggerManager.listStatus();
      if (loops.length > 0) {
        const icons: Record<string, string> = { running: "⏳", paused: "⏸️", idle: "✅", not_found: "❓" };
        const loopStrs = loops.map((l) => `${icons[l.status] ?? "❓"} \`${l.id}\`(${l.status})`);
        lines.push(`Loop 触发器:${loopStrs.join(" / ")}`);
      }
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

        // 配额信息：
        //  1. 优先：copilot_internal/user 的 quota_snapshots（Pro/Pro+ 实时 premium 配额）
        //  2. 回退：补全 API 响应头 x-ratelimit-*（部分账户类型）
        //  3. 最后：token 响应体 limited_user_quotas（免费计划）
        let quotaStr = "N/A";
        const userQuota = await getCopilotUserQuota(copilotCfg.githubToken);
        const pi = userQuota.premium_interactions;
        if (pi) {
          if (pi.unlimited) {
            quotaStr = "无限制";
          } else {
            const resetSuffix = userQuota.quota_reset_date ? `，${userQuota.quota_reset_date} 重置` : "";
            const overageSuffix = pi.overage_permitted && pi.overage_count > 0
              ? `（超额 ${pi.overage_count}）`
              : "";
            quotaStr = `${pi.remaining} / ${pi.entitlement} premium 请求${overageSuffix}${resetSuffix}`;
          }
        } else {
          const rl = getCopilotRateLimit(copilotCfg.githubToken);
          if (rl) {
            const ageMin = Math.round((Date.now() - rl.capturedAt) / 60_000);
            const ageSuffix = ageMin < 1 ? "" : `（${ageMin} 分钟前）`;
            quotaStr = `${rl.remaining} / ${rl.limit}${ageSuffix}`;
          } else if (info.quotas) {
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
  name: "compact",
  description: "手动压缩会话上下文（code 模式：滑动窗口压缩；chat 模式：摘要压缩）",
  usage: "/compact",
  async execute({ session }) {
    if (session.running) {
      return "⚠️ 当前有任务正在运行，请等待完成后再压缩。";
    }
    try {
      if (session.mode === "code") {
        const compressed = await session.compressForCode();
        if (!compressed) return "ℹ️ 无可压缩内容（上下文已是最短状态）";
        return `✅ Code 上下文已压缩（当前 ${session.getMessages().length} 条消息）`;
      } else {
        const summary = await session.compress();
        return `✅ 上下文已压缩\n\n${summary}`;
      }
    } catch (err) {
      return `❌ 压缩失败：${err instanceof Error ? err.message : String(err)}`;
    }
  },
});



registerCommand({
  name: "slaves",
  description: "列出后台 Slave 任务，可按状态过滤",
  usage: "/slaves [running|done|error|aborted]",
  modes: ["chat"],
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
  modes: ["chat"],
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

// ── /restart ──────────────────────────────────────────────────────────────────

/** 项目根目录（src/commands/builtin.ts → ../../） */
const PROJECT_ROOT = new URL("../../", import.meta.url).pathname;

/** 运行 tsc --noEmit 检查，返回 {ok, output} */
function runTypecheck(): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const proc = spawn("bun", ["run", "typecheck"], {
      cwd: PROJECT_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    proc.stdout.on("data", (d: Buffer) => chunks.push(d));
    proc.stderr.on("data", (d: Buffer) => chunks.push(d));

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve({ ok: false, output: "[超时] 类型检查超过 60 秒未完成" });
    }, 60_000);

    proc.on("close", (code) => {
      clearTimeout(timer);
      const output = Buffer.concat(chunks).toString("utf-8").trim();
      resolve({ ok: code === 0, output });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, output: `启动 tsc 失败：${err.message}` });
    });
  });
}

registerCommand({
  name: "restart",
  description: "类型检查通过后重启 tinyclaw 服务，重启完成后发送通知",
  usage: "/restart",
  modes: ["chat"],
  async execute({ session }) {
    if (session.running) {
      return "⚠️ 当前有任务正在运行，请等待完成后再重启。";
    }

    const { ok, output } = await runTypecheck();

    if (!ok) {
      const truncated = output.length > 1500
        ? output.slice(0, 1500) + "\n…（输出已截断）"
        : output || "（无输出）";
      return `❌ 类型检查失败，已取消重启：\n\`\`\`\n${truncated}\n\`\`\``;
    }

    // 若是 QQ 会话，写 marker 文件，重启后发通知
    if (session.sessionId.startsWith("qqbot:")) {
      const parts = session.sessionId.split(":");
      // qqbot:<msgType>:<peerId>
      const msgType = parts[1] as import("../connectors/base.js").InboundMessage["type"];
      const peerId = parts.slice(2).join(":");
      if (peerId) {
        const markerPath = path.join(os.homedir(), ".tinyclaw", ".restart_notify.json");
        try {
          fs.mkdirSync(path.dirname(markerPath), { recursive: true });
          fs.writeFileSync(markerPath, JSON.stringify({ peerId, msgType }), "utf-8");
        } catch { /* 写失败不影响重启 */ }
      }
    }

    // 延迟退出，给当前 HTTP 响应/消息推送留出时间
    setTimeout(() => process.exit(75), 600);

    return "⏳ 类型检查通过，正在重启服务，稍后恢复...";
  },
});

// ── code 模式命令（/code 和 /chat）────────────────────────────────────────────
// 命令实现在 src/code/，此处触发注册
import "../code/index.js";

// ── /retry ────────────────────────────────────────────────────────────────────

registerCommand({
  name: "retry",
  description: "重试上次失败的请求（复用相同 X-Request-Id，不消耗额外高级请求）",
  usage: "/retry",
  execute({ session }) {
    if (!session.lastFailedRequestId) {
      return "⚠️ 没有可重试的失败请求。只有连接中断类失败（非 4xx/5xx 错误）才支持 /retry。";
    }
    if (session.running) {
      return "⚠️ 当前有请求正在进行，请等待完成后再重试。";
    }
    // 设置 pendingRetry 信号，main.ts 在命令返回后检测并重新触发 runAgent
    const retryPayload: { requestId?: string; userContent?: string } = {};
    if (session.lastFailedRequestId !== undefined) retryPayload.requestId = session.lastFailedRequestId;
    if (session.lastFailedUserContent !== undefined) retryPayload.userContent = session.lastFailedUserContent;
    session.pendingRetry = retryPayload;
    delete session.lastFailedRequestId;
    delete session.lastFailedUserContent;
    return "↩️ 正在重试（复用上次请求 ID，不额外计费）...";
  },
});

// ── /loop ─────────────────────────────────────────────────────────────────────

import { loopTriggerManager } from "../core/loop-trigger.js";
import { loopRunner } from "../core/loop-runner.js";

registerCommand({
  name: "loop",
  description: "管理 Loop 触发器。子命令: pause <id> | resume <id> | list",
  usage: "/loop pause <id> | /loop resume <id> | /loop list",
  modes: ["chat"],
  execute({ args }) {
    const sub = args[0]?.toLowerCase();
    const id = args[1];

    if (sub === "list" || !sub) {
      const ltStatus = loopTriggerManager.listStatus();
      const lrStatus = loopRunner.listStatus();
      if (ltStatus.length === 0 && lrStatus.length === 0) return "ℹ️ 当前没有已加载的 Loop 触发器。";
      const icons: Record<string, string> = { running: "⏳", paused: "⏸️", idle: "✅", not_found: "❓" };
      const lines = ["**Loop 触发器列表**\n"];
      for (const s of ltStatus) {
        lines.push(`${icons[s.status] ?? "❓"} \`${s.id}\` — ${s.status}  (bindTo: \`${s.bindTo}\`)`);
      }
      for (const s of lrStatus) {
        lines.push(`${icons[s.status] ?? "❓"} session \`${s.sessionId}\` — ${s.status}`);
      }
      return lines.join("\n");
    }

    if (sub === "pause") {
      if (!id) return "❌ 用法: \`/loop pause <id>\`";
      const ok1 = loopTriggerManager.pause(id);
      const ok2 = loopRunner.pause(id);
      if (!ok1 && !ok2) return `❌ 未找到 Loop \`${id}\`，发送 \`/loop list\` 查看可用 ID。`;
      return `⏸️ Loop \`${id}\` 已暂停。`;
    }

    if (sub === "resume") {
      if (!id) return "❌ 用法: \`/loop resume <id>\`";
      const ok1 = loopTriggerManager.resume(id);
      const ok2 = loopRunner.resume(id);
      if (!ok1 && !ok2) return `❌ 未找到 Loop \`${id}\`，发送 \`/loop list\` 查看可用 ID。`;
      return `▶️ Loop \`${id}\` 已恢复。`;
    }

    return `❌ 未知子命令 \`${sub}\`。用法: \`/loop list\` / \`/loop pause <id>\` / \`/loop resume <id>\``;
  },
});
