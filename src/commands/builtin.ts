/**
 * 内置斜杠命令
 *
 * 副作用 import：import "./builtin.js" 即完成注册。
 * 在 main.ts 和 ipc/server.ts 中各 import 一次（幂等：重复注册会抛出，
 * 但因模块缓存只执行一次，不会重复注册）。
 */

import { registerCommand, listCommands, getCommand } from "./registry.js";
import { slaveManager } from "../core/slave-manager.js";
import { llmRegistry, parseModelSymbol } from "../llm/registry.js";
import { loadConfig } from "../config/loader.js";
import { getCachedCopilotInfo, getCopilotRateLimit, getCopilotUserQuota, lookupMultiplier } from "../llm/copilot.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { waitForOtherSessions } from "../tools/restart.js";

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

    // ── Project 绑定(Code 模式且已绑定 project 时显示) ──────────────
    if (session.projectSlug) {
      const { slugToWorkdir, readLock } = await import("../core/project-router.js");
      const wd = slugToWorkdir(session.projectSlug);
      const lock = readLock(session.agentId, session.projectSlug);
      lines.push("");
      lines.push("**项目绑定**");
      lines.push(`  Slug: \`${session.projectSlug}\``);
      if (wd) lines.push(`  工作目录: \`${wd}\``);
      if (lock) {
        const isHolder = lock.holder === session.sessionId;
        lines.push(`  锁: ${isHolder ? "✅ 当前 session 持有" : `⚠️ \`${lock.holder}\` 持有`}`);
      } else {
        lines.push(`  锁: 未锁定`);
      }
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

    // ── 后端信息(按 provider 动态显示) ───────────────────────────
    try {
      const config = loadConfig();
      // config 直接读取 model symbol，避免 init 未完整时报错
      const modelSymbol = (isCodeMode ? config.llm.backends.code?.model : undefined) ?? config.llm.backends.daily.model;
      const { provider, modelId } = parseModelSymbol(modelSymbol);

      if (provider === "copilot") {
        const copilotCfg = config.providers?.copilot;
        if (copilotCfg?.githubToken) {
          const multiplier = lookupMultiplier(modelId);
          let multiplierStr: string;
          if (multiplier === undefined) multiplierStr = "-";
          else if (multiplier === 0) multiplierStr = "免费(不计配额)";
          else multiplierStr = `${multiplier}×`;

          const info = getCachedCopilotInfo(copilotCfg.githubToken);
          let quotaStr = "N/A";
          const userQuota = await getCopilotUserQuota(copilotCfg.githubToken);
          const pi = userQuota.premium_interactions;
          if (pi) {
            if (pi.unlimited) {
              quotaStr = "无限制";
            } else {
              const resetSuffix = userQuota.quota_reset_date ? `,${userQuota.quota_reset_date} 重置` : "";
              const overageSuffix = pi.overage_permitted && pi.overage_count > 0
                ? `(超额 ${pi.overage_count})`
                : "";
              quotaStr = `${pi.remaining} / ${pi.entitlement} premium 请求${overageSuffix}${resetSuffix}`;
            }
          } else {
            const rl = getCopilotRateLimit(copilotCfg.githubToken);
            if (rl) {
              const ageMin = Math.round((Date.now() - rl.capturedAt) / 60_000);
              const ageSuffix = ageMin < 1 ? "" : `(${ageMin} 分钟前)`;
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

          const skuStr = info.sku ?? (info.tokenCached ? "(SKU 未知)" : "(未初始化)");
          let modelDisplayName = `\`${modelId}\``;
          if (isCodeMode && !config.llm.backends.code) {
            modelDisplayName += "(与 Chat 共用 daily 模型,可在 [llm.backends.code] 独立配置)";
          }
          lines.push(
            "",
            `Copilot:\`${modelId}\` · ${multiplierStr} premium/请求 · 剩余配额:${quotaStr} · 计划:${skuStr}`,
          );
        }
      } else if (provider === "deepseek") {
        const dsCfg = config.providers?.deepseek;
        if (dsCfg?.apiKey) {
          let balanceLine = `DeepSeek:\`${modelId}\` · 余额获取中...`;
          try {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 5000);
            const resp = await fetch("https://api.deepseek.com/user/balance", {
              headers: { Authorization: `Bearer ${dsCfg.apiKey}` },
              signal: ctrl.signal,
            });
            clearTimeout(timer);
            const data = await resp.json() as {
              is_available: boolean;
              balance_infos: Array<{ currency: string; total_balance: string; granted_balance: string; topped_up_balance: string }>;
            };
            const bi = data.balance_infos?.[0];
            if (bi) {
              const total = parseFloat(bi.total_balance).toFixed(4);
              const granted = parseFloat(bi.granted_balance).toFixed(4);
              const toppedUp = parseFloat(bi.topped_up_balance).toFixed(4);
              balanceLine = `DeepSeek:\`${modelId}\` · 余额 ¥${total}（赠金 ¥${granted} + 充值 ¥${toppedUp}）`;
            } else {
              balanceLine = `DeepSeek:\`${modelId}\` · 余额获取失败`;
            }
          } catch {
            balanceLine = `DeepSeek:\`${modelId}\` · 余额获取失败`;
          }
          lines.push("", balanceLine);
        }
      } else {
        lines.push("", `模型:\`${modelSymbol}\``);
      }
    } catch {
      // 后端未配置或初始化失败,忽略
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

/**
 * 通用「typecheck → 写重启通知 marker → 等待其他 session → 退出(码75)」流程。
 * /restart 与 /model 切换后均复用此 helper。
 */
async function performRestart(
  session: import("../core/session.js").Session,
  noteMsg?: string,
  skipTypecheck = false,
): Promise<string> {
  if (session.running) {
    return "⚠️ 当前有任务正在运行,请等待完成后再重启。";
  }

  if (!skipTypecheck) {
    const { ok, output } = await runTypecheck();
    if (!ok) {
      const truncated = output.length > 1500
        ? output.slice(0, 1500) + "\n...(输出已截断)"
        : output || "(无输出)";
      return `❌ 类型检查失败,已取消重启:\n\`\`\`\n${truncated}\n\`\`\``;
    }
  }

  if (session.sessionId.startsWith("qqbot:")) {
    const parts = session.sessionId.split(":");
    const msgType = parts[1] as import("../connectors/base.js").InboundMessage["type"];
    const peerId = parts.slice(2).join(":");
    if (peerId) {
      const markerPath = path.join(os.homedir(), ".tinyclaw", ".restart_notify.json");
      try {
        fs.mkdirSync(path.dirname(markerPath), { recursive: true });
        fs.writeFileSync(
          markerPath,
          JSON.stringify({ peerId, msgType, ...(noteMsg ? { note: noteMsg } : {}) }),
          "utf-8",
        );
      } catch { /* 写失败不影响重启 */ }
    }
  }

  await waitForOtherSessions(session.sessionId);
  setTimeout(() => process.exit(75), 600);

  const tail = noteMsg ? `${noteMsg},正在重启服务,稍后恢复...` : "正在重启服务,稍后恢复...";
  return skipTypecheck ? `⏳ ${tail}` : `⏳ 类型检查通过,${tail}`;
}

registerCommand({
  name: "restart",
  description: "类型检查通过后重启 tinyclaw 服务,重启完成后发送通知",
  usage: "/restart",
  modes: ["chat"],
  async execute({ session }) {
    return performRestart(session);
  },
});

// ── code 模式命令（/code 和 /chat）────────────────────────────────────────────
// 命令实现在 src/code/，此处触发注册
// ── /model 切换模型 ─────────────────────────────────────────────────────────
import { getAliases, resolveAlias, aliasForSymbol } from "../llm/aliases.js";
import { getCopilotModels } from "../llm/copilot.js";
import { fetchFreeModels } from "../llm/openrouter.js";
import { patchTomlField } from "../config/writer.js";

const BACKEND_KEYWORDS: Record<string, "daily" | "code" | "summarizer" | "vision"> = {
  chat: "daily",
  daily: "daily",
  code: "code",
  summarizer: "summarizer",
  vision: "vision",
};

function currentBackendModels(): Record<string, string | undefined> {
  const cfg = loadConfig();
  const b = cfg.llm.backends;
  return {
    chat: b.daily?.model,
    code: b.code?.model,
    summarizer: b.summarizer?.model,
    vision: b.vision?.model,
  };
}

function validateSymbolProvider(symbol: string): string | null {
  const slash = symbol.indexOf("/");
  if (slash < 0) return "模型格式应为 provider/model-id,收到 " + symbol;
  const provider = symbol.slice(0, slash);
  const cfg = loadConfig();
  const p = cfg.providers as Record<string, unknown>;
  if (!(provider in p) || !p[provider]) {
    return "Provider " + provider + " 未在 [providers." + provider + "] 配置,无法切换。";
  }
  return null;
}

async function listProviderModels(provider: string): Promise<string> {
  const cfg = loadConfig();
  const p = cfg.providers;
  try {
    if (provider === "copilot") {
      if (!p.copilot) return "❌ [providers.copilot] 未配置。";
      const models = await getCopilotModels(p.copilot.githubToken);
      const picker = models.filter((m) => m.isPickerEnabled);
      const lines = picker.map((m) => {
        const mult = m.multiplier === undefined ? "" : m.multiplier === 0 ? " (free)" : " ×" + m.multiplier;
        return "· `copilot/" + m.id + "`" + mult;
      });
      return "**Copilot 可用模型(" + picker.length + ")**\n" + lines.join("\n") +
        "\n\n用 `/model code copilot/<id>` 或 `/model chat copilot/<id>` 切换。";
    }
    if (provider === "openrouter") {
      if (!p.openrouter) return "❌ [providers.openrouter] 未配置。";
      const models = await fetchFreeModels(p.openrouter.apiKey);
      const lines = models.slice(0, 30).map((m) => "· `openrouter/" + m.id + "`");
      return "**OpenRouter 免费模型(top " + Math.min(30, models.length) + "/" + models.length + ")**\n" +
        lines.join("\n") + "\n\n另有 `openrouter/auto-free` 自动路由。";
    }
    if (provider === "deepseek") {
      if (!p.deepseek) return "❌ [providers.deepseek] 未配置。";
      return "**DeepSeek 可用模型**\n· `deepseek/deepseek-v4-flash`\n· `deepseek/deepseek-v4-pro`";
    }
    if (provider === "mimo") {
      if (!p.mimo) return "❌ [providers.mimo] 未配置。";
      return "**MiMo 可用模型**\n· `mimo/mimo-v2.5-pro`\n· `mimo/mimo-v2.5`\n· `mimo/mimo-v2-pro`";
    }
    if (provider === "openai") {
      if (!p.openai) return "❌ [providers.openai] 未配置。";
      return "**OpenAI**\nbaseUrl: " + p.openai.baseUrl + "\n用 `/model chat openai/<model-id>` 直接指定。";
    }
    return "未知 provider " + provider + ",可选:copilot / openrouter / openai / deepseek / mimo";
  } catch (e) {
    return "❌ 拉取 " + provider + " 模型列表失败:" + (e instanceof Error ? e.message : String(e));
  }
}

function renderModelOverview(): string {
  const cur = currentBackendModels();
  const aliases = getAliases();
  const lines: string[] = ["**当前模型配置**"];
  const rows: Array<[string, string]> = [["💬 chat", "chat"], ["🖥️ code", "code"], ["📝 summarizer", "summarizer"], ["👁️ vision", "vision"]];
  for (const [label, key] of rows) {
    const sym = cur[key];
    if (!sym) { lines.push(label + ":_(未配置,回退 chat)_"); continue; }
    const al = aliasForSymbol(sym);
    lines.push(label + ":`" + sym + "`" + (al ? " (别名 `" + al + "`)" : ""));
  }
  lines.push("\n**可用别名**(`/model <别名>` 切 chat,`/model code <别名>` 切 code)");
  const groups: Record<string, string[]> = {};
  for (const [name, sym] of Object.entries(aliases)) {
    const prov = sym.split("/")[0] ?? "?";
    (groups[prov] ??= []).push("`" + name + "`→" + sym.split("/").slice(1).join("/"));
  }
  for (const [prov, items] of Object.entries(groups)) {
    lines.push("· **" + prov + "**:" + items.join("、"));
  }
  lines.push("\n💡 `/model list <provider>` 查实时模型 · `/model reset` 恢复默认");
  return lines.join("\n");
}

registerCommand({
  name: "model",
  description: "查看/切换模型(chat 与 code 分别设置,支持别名,切换后自动重启)",
  usage: "/model [chat|code|summarizer|vision] <别名|provider/model-id> · /model list [provider] · /model reset",
  modes: ["chat"],
  async execute({ session, args }) {
    if (args.length === 0) return renderModelOverview();

    const sub = args[0]!.toLowerCase();

    if (sub === "list") {
      if (args[1]) return listProviderModels(args[1].toLowerCase());
      return renderModelOverview();
    }

    if (sub === "reset") {
      const def = resolveAlias("mimo")!;
      patchTomlField(["llm", "backends", "daily"], "model", '"' + def + '"');
      return performRestart(session, "chat 已恢复默认 " + def, true);
    }

    let backendKw = "chat";
    let modelArg: string;
    if (BACKEND_KEYWORDS[sub] && args.length >= 2) {
      backendKw = sub;
      modelArg = args.slice(1).join(" ").trim();
    } else {
      modelArg = args.join(" ").trim();
    }

    const symbol = resolveAlias(modelArg);
    if (!symbol) {
      return "❌ 无法识别模型 `" + modelArg + "`。\n" +
        "可用别名见 `/model`,或直接传 `provider/model-id`(如 `copilot/gpt-4o`)。";
    }

    const verr = validateSymbolProvider(symbol);
    if (verr) return "❌ " + verr;

    const backend = BACKEND_KEYWORDS[backendKw]!;
    let warn = "";
    if (symbol.startsWith("copilot/")) {
      try {
        const cfg = loadConfig();
        if (cfg.providers.copilot) {
          const models = await getCopilotModels(cfg.providers.copilot.githubToken);
          const id = symbol.slice("copilot/".length);
          if (id !== "auto" && !models.some((m) => m.id === id)) {
            warn = "\n⚠️ Copilot 模型列表中未找到 `" + id + "`,仍按你的输入写入(可能拼写有误)。";
          }
        }
      } catch { /* 校验失败不阻断 */ }
    }

    patchTomlField(["llm", "backends", backend], "model", '"' + symbol + '"');
    const al = aliasForSymbol(symbol);
    const note = backendKw + " 模型已切到 `" + symbol + "`" + (al ? " (别名 " + al + ")" : "");
    const reply = await performRestart(session, note, true);
    return warn ? reply + warn : reply;
  },
});

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
