/**
 * tinyclaw 入口
 *
 * 启动顺序：
 * 1. 验证配置
 * 2. 初始化 LLM / QMD 注册表（懒加载）
 * 3. 启动 QQBot connector
 * 4. 监听信号，优雅退出
 */

// ── 全局日志初始化(同步)────────────────
import { initGlobalLogger } from "./utils/logger.js";
initGlobalLogger();

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig } from "./config/loader.js";
import { CONFIG_PATH } from "./config/writer.js";
import { promoteConfig, restoreLastGoodConfig, shouldRollbackConfig } from "./config/state.js";
import { runOfflineHealthChecks, formatHealthReport, appendHealthLog } from "./health/config-health.js";
import { probeDailyBackend, withLlmProbe } from "./health/llm-probe.js";
import { llmRegistry } from "./llm/registry.js";
import { initLLMConcurrency } from "./llm/concurrency.js";
import { Session, type PlanApprovalResult } from "./core/session.js";
import { runAgent, type AgentRunOptions } from "./core/agent.js";
import { agentManager } from "./core/agent-manager.js";
import { QQBotConnector } from "./connectors/qqbot/index.js";
import type { InboundMessage } from "./connectors/base.js";
import { downloadAttachments, buildEnrichedContent } from "./connectors/qqbot/attachments.js";
import { transcribeAudio } from "./connectors/qqbot/transcribe.js";
import { validateMediaContent, extractTextContent } from "./connectors/qqbot/outbound.js";
import { splitMediaText, stripMediaForStream } from "./connectors/utils/media-parser.js";
import { looksLikeMarkdown, mdToImage } from "./connectors/utils/md-to-image.js";
import { startIpcServer, broadcastActivity, getActivityLog } from "./ipc/server.js";
import { cronScheduler } from "./cron/scheduler.js";
import { loopRunner } from "./core/loop-runner.js";
import { loopTriggerManager } from "./core/loop-trigger.js";
import { getProjectBinding } from "./core/project-router.js";
import { memoryMaintenance } from "./core/memory-maintenance.js";
import { initEmbedLlm } from "./memory/qmd.js";
import { startNewsWatcher, stopNewsWatcher } from "./memory/news-watcher.js";
import { tinyclawSubmitter } from "./core/tinyclaw-submitter.js";
import { skillWatcher } from "./skills/watcher.js";
import { mcpManager } from "./mcp/client.js";
import { mcpWatcher } from "./mcp/watcher.js";
import type { SlaveNotification, SlaveState } from "./core/slave-manager.js";
import { slaveManager } from "./core/slave-manager.js";
import { InboundMessageBus, type InboundExtras } from "./core/inbound-bus.js";
import { parseCommand, executeCommand } from "./commands/registry.js";
import "./commands/builtin.js";
import "./tools/db-write.js";
import "./tools/write-report.js";
import "./tools/release-file.js";
import "./tools/loop-exit.js";
import "./tools/loop-control.js";
import "./tools/code-project.js";
import { getTool } from "./tools/registry.js";
import { startDashboard, stopDashboard } from "./web/backend/server.js";
import { startCollector, stopCollector } from "./web/backend/collector.js";
import { setActiveSessionsRef } from "./tools/restart.js";

// ── 模块级引用（供 Fatal 处理器广播通知）────────────────────────────────────

let _activeConnector: import("./connectors/qqbot/index.js").QQBotConnector | null = null;
let _activeSessions: Map<string, Session> | null = null;

// ── 跨 session 通信（session_send / session_get）——模块级引用，在 startApp() 中赋值 ──
let _sessionSendFn: import("./tools/registry.js").ToolContext["sessionSendFn"] | null = null;
let _sessionGetFn: import("./tools/registry.js").ToolContext["sessionGetFn"] | null = null;

// ── Session 注册表（key 为 sessionId，格式：qqbot:<type>:<peerId>）────────────

const sessions = new Map<string, Session>();

// ── 消息 Debounce 合并(非命令/非等待者消息在 5s 内自动合并)──────────────

const MESSAGE_DEBOUNCE_MS = 10000;

interface MergedPendingItem {
  msg: InboundMessage;
  resolvedContent: string;
  earlyDownloaded: import("./connectors/qqbot/attachments.js").DownloadedAttachment[];
}
interface MergedPendingBuffer {
  items: MergedPendingItem[];
  timer: ReturnType<typeof setTimeout>;
  flush: () => Promise<void>;
}
const pendingBuffers = new Map<string, MergedPendingBuffer>();

function getSession(sessionId: string): Session {
  let s = sessions.get(sessionId);
  if (!s) {
    // loop session 优先用 loop config 里的 agentId（比 bindings 更权威）
    const loopCfg = agentManager.readSessionLoop(sessionId);
    const agentId = loopCfg?.agentId ?? agentManager.resolveAgent(sessionId);
    // 读取 .code.project 跳板文件, 恢复 project 绑定
    const projectSlug = getProjectBinding(sessionId);
    const sessionOpts: { agentId: string; projectSlug?: string } = { agentId };
    if (projectSlug) sessionOpts.projectSlug = projectSlug;
    s = new Session(sessionId, sessionOpts);
    sessions.set(sessionId, s);
  }
  return s;
}

// ── 主函数 ────────────────────────────────────────────────────────────────────

/** 清理 Python venv 对 process.env 的污染。
 *  若 tinyclaw 在已激活 venv 的 shell 中启动，VIRTUAL_ENV 和 PATH 前缀都会被继承，
 *  导致所有 spawn("python3"...) 调用走到错误的 venv python3。
 *  在最早的入口处清理，之后所有子进程 spawn 都继承干净的环境。
 */
function stripVenvFromEnv(): void {
  delete process.env.VIRTUAL_ENV;
  delete process.env.VIRTUAL_ENV_PROMPT;
  if (process.env.PATH) {
    const cleaned = process.env.PATH.split(":")
      .filter((p) => !p.includes("venv/bin"))
      .join(":");
    if (cleaned !== process.env.PATH) {
      process.env.PATH = cleaned;
      console.log("[tinyclaw] Stripped venv/bin from PATH");
    }
  }
}

/** 加载 ~/.tinyclaw/env 文件（每行 KEY=VALUE），注入 process.env */
function loadDotEnv(): void {
  const envPath = path.join(os.homedir(), ".tinyclaw", "env");
  if (!fs.existsSync(envPath)) return;
  try {
    const lines = fs.readFileSync(envPath, "utf-8").split("\n");
    let count = 0;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      const val = line
        .slice(eq + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
      if (key && !(key in process.env)) {
        process.env[key] = val;
        count++;
      }
    }
    if (count > 0) console.log(`[tinyclaw] Loaded ${count} env var(s) from ~/.tinyclaw/env`);
  } catch (e) {
    console.warn(`[tinyclaw] Failed to load ~/.tinyclaw/env:`, e);
  }
}

async function main(): Promise<void> {
  // 0. 清理 venv 环境污染 + 加载用户自定义环境变量
  stripVenvFromEnv();
  loadDotEnv();
  // 1. 验证配置（fail-fast）
  const cfg = loadConfig();
  console.log("[tinyclaw] Config loaded");

  // 2. 预初始化 LLM 后端（Copilot 后端需异步 token 换取 + 模型发现）
  await llmRegistry.init();
  console.log(`[tinyclaw] LLM backend ready (model=${llmRegistry.get("daily").model})`);

  // 初始化全局 LLM 并发限流器（在接受请求之前配置）
  initLLMConcurrency(cfg.concurrency.maxConcurrentLLMRequests);

  // 3. 初始化 MCP servers（读取 ~/.tinyclaw/mcp.toml，注册工具到 registry）
  await mcpManager.init();

  // 初始化 Agent 工作区（确保 default agent 存在）
  agentManager.ensureDefault();
  console.log("[tinyclaw] Agent workspace ready");

  // 启动 skill subsystem watcher（主进程；cron worker 通过 IPC 接收失效通知）
  void skillWatcher.start(agentManager.listAgentIds());

  // 启动 mcp.toml watcher（内容哈希判断，不依赖 mtime）：改动后自动 reload 并通知 cron worker
  void mcpWatcher.start(() => cronScheduler.notifyMcpChanged());

  // 3. 启动 QQBot（可选；若未配置则以纯 IPC 模式运行）
  const qqbotsMap = cfg.channels.qqbots ?? {};
  const connectorsMap = new Map<string, QQBotConnector>();
  const connectors: QQBotConnector[] = [];
  // 记录 sessionId → connector，用于 session_send 精确路由
  const sessionConnectorMap = new Map<string, QQBotConnector>();
  for (const [botId, botCfg] of Object.entries(qqbotsMap)) {
    const c = new QQBotConnector(botId, botCfg);
    connectors.push(c);
    connectorsMap.set(botId, c);
  }

  // connector 指向第一个（主）bot，供单 connector 场景（IPC、cron、restart_tool 等）使用
  const connector: QQBotConnector | null = connectors[0] ?? null;
  if (connector) {
    _activeConnector = connector;
    tinyclawSubmitter.setConnector(connector);
  } else {
    console.log("[tinyclaw] QQBot not configured, running in IPC-only mode");
  }
  _activeSessions = sessions;
  setActiveSessionsRef(sessions);

  // ── QQBot 消息处理 ──────────────────────────────────────────────────────

  // 为每个 bot 构建独立的消息处理闭包
  function makeHandleMessage(
    activeConnector: QQBotConnector
  ): (msg: InboundMessage) => Promise<string> {
    return async function handleMessage(msg: InboundMessage): Promise<string> {
       
      const connector = activeConnector;
      const sessionId = `qqbot:${msg.type}:${msg.peerId}`;
      const session = getSession(sessionId);
      // 记录该 session 归属的 connector，供 session_send 路由使用
      sessionConnectorMap.set(sessionId, activeConnector);

      // ── 附件预处理（语音转文字）——必须在所有早期 return 分支之前执行 ──────
      // plan 审批、ask_user、MFA 等分支均需能接收语音消息作为输入。
      let resolvedContent = msg.content;
      let earlyDownloaded: import("./connectors/qqbot/attachments.js").DownloadedAttachment[] = [];
      if (msg.attachments && msg.attachments.length > 0) {
        try {
          earlyDownloaded = await downloadAttachments(
            msg.attachments,
            agentManager.downloadsDir(session.agentId)
          );
          const voiceCfg = loadConfig().voice;
          for (const d of earlyDownloaded) {
            if (!d.contentType.startsWith("audio/")) continue;
            console.log(`[whisper] 开始转录: ${d.filename} (model=${voiceCfg.model})`);
            try {
              const transcript = await transcribeAudio(
                d.localPath,
                voiceCfg.model,
                voiceCfg.language
              );
              if (transcript) {
                d.transcript = transcript;
                console.log(`[whisper] 转录完成: "${transcript}"`);
                resolvedContent = transcript; // 用转录文本替代原始消息内容
                void connector
                  .send(msg.peerId, msg.type, `🎤 语音识别：${transcript}`)
                  .catch((e: unknown) => console.error("[qqbot] send error:", e));
              } else {
                console.log(`[whisper] 转录结果为空: ${d.filename}`);
              }
            } catch (err) {
              console.warn(`[whisper] 语音转文字失败 (${d.filename}):`, err);
            }
          }
        } catch (err) {
          console.warn("[qqbot] 附件下载失败:", err);
        }
      }

      // ── Plan 审批：检测 plan 子模式下等待用户选择操作的消息 ─────────────
      // 收集图片附件路径（供 InboundMessageBus 使用）
      const imagePaths = earlyDownloaded
        .filter((d) => d.contentType.startsWith("image/") && d.localPath)
        .map((d) => d.localPath);
      // 拼入附件标签:供 inboundBus 等待者(ask_user/plan approval/MFA 等)直接获取完整内容
      const enrichedForBus = buildEnrichedContent(resolvedContent, earlyDownloaded);
      const inboundExtras: import("./core/inbound-bus.js").InboundExtras = {
        rawContent: resolvedContent,
        imagePaths,
        enrichedContent: enrichedForBus,
      };

      // ── 斜杠命令拦截:以 "/" 开头的消息优先执行,不走 inboundBus ────────
      // /status 等查询命令在 plan/ask_user 等待期间也应直接响应
      const parsedCmd = parseCommand(msg.content);
      if (parsedCmd) {
        const result = await executeCommand(parsedCmd.name, parsedCmd.args, { session });
        if (result) {
          await connector.send(msg.peerId, msg.type, result, msg.messageId).catch(() => {});
        }
        // /retry 命令设置了 pendingRetry:fall-through,继续构建 opts 并重新调用 runAgent
        if (!session.pendingRetry) {
          return "";
        }
      }

      // ── InboundMessageBus 分发:将消息路由给注册的等待者 ──────────────────
      // 覆盖:MFA pendingApproval、plan approval、ask_user(含 async slave)
      // 严格 FIFO:按注册时间顺序,找到第一个 match() 的 Waiter 并调用其 handle()
      if (session.inboundBus.dispatch(enrichedForBus, inboundExtras)) {
        return "";
      }

      // ── Debounce:非命令/非 inboundBus 消息缓冲 5s 后合并送入 runAgent ────
      {
        const item: MergedPendingItem = { msg, resolvedContent, earlyDownloaded };
        const existing = pendingBuffers.get(sessionId);

        if (existing) {
          // 追加消息，重置 timer
          // 如果 runAgent 已注册了 inboundBus 等待者（askUser/exitPlan），优先 dispatch
          if (
            !session.inboundBus.hasNoBounceWaiter() &&
            session.inboundBus.dispatch(enrichedForBus, inboundExtras)
          ) {
            clearTimeout(existing.timer);
            pendingBuffers.delete(sessionId);
            // 合并先前缓冲的消息再送入 runAgent
            if (existing.items.length > 0) {
              const bText = existing.items.map((i) => i.resolvedContent).join("\n");
              const bDl = existing.items.flatMap((i) => i.earlyDownloaded);
              const bLast = existing.items[existing.items.length - 1]!;
              void handleMessageCore(
                connector,
                session,
                { ...bLast.msg, content: bText },
                bText,
                bDl
              );
            }
            return "";
          }
          clearTimeout(existing.timer);
          existing.items.push(item);
          existing.timer = setTimeout(() => void existing.flush(), MESSAGE_DEBOUNCE_MS);
          console.log(`[debounce] 追加第 ${existing.items.length} 条 → sessionId=${sessionId}`);
          return "";
        } else {
          return await new Promise<string>((resolve) => {
            const newBuf: MergedPendingBuffer = {
              items: [item],
              timer: null as unknown as ReturnType<typeof setTimeout>,
              flush: async () => {
                pendingBuffers.delete(sessionId);
                const mergedText = newBuf.items.map((i) => i.resolvedContent).join("\n");
                const mergedDownloaded = newBuf.items.flatMap((i) => i.earlyDownloaded);
                const lastItem = newBuf.items[newBuf.items.length - 1];
                const lastMsg = lastItem!.msg;
                if (newBuf.items.length > 1) {
                  console.log(
                    `[debounce] flush 合并 ${newBuf.items.length} 条 → sessionId=${sessionId}`
                  );
                }
                // flush 时再次尝试 dispatch，拦截 askUser/exitPlan
                // flush 时用 mergedText 做 rawContent,enrichedContent 由各 item 的 earlyDownloaded 拼入
                const mergedDownloadedForBus = newBuf.items.flatMap((i) => i.earlyDownloaded);
                const mergedEnrichedForBus = buildEnrichedContent(
                  mergedText,
                  mergedDownloadedForBus
                );
                const mergedImagePaths = mergedDownloadedForBus
                  .filter((d) => d.contentType.startsWith("image/"))
                  .map((d) => d.localPath);
                if (
                  !session.inboundBus.hasNoBounceWaiter() &&
                  session.inboundBus.dispatch(mergedEnrichedForBus, {
                    rawContent: mergedText,
                    imagePaths: mergedImagePaths,
                    enrichedContent: mergedEnrichedForBus,
                  })
                ) {
                  resolve("");
                  return;
                }
                resolve(
                  await handleMessageCore(
                    connector,
                    session,
                    { ...lastMsg, content: mergedText },
                    mergedText,
                    mergedDownloaded
                  )
                );
              },
            };
            newBuf.timer = setTimeout(() => void newBuf.flush(), MESSAGE_DEBOUNCE_MS);
            pendingBuffers.set(sessionId, newBuf);
          });
        }
      }
    };
  }

  async function handleMessageCore(
    connector: QQBotConnector,
    session: Session,
    msg: InboundMessage,
    resolvedContent: string,
    earlyDownloaded: import("./connectors/qqbot/attachments.js").DownloadedAttachment[]
  ): Promise<string> {
    // ── 软中断：若当前有 runAgent() 正在运行则中断它 ──────────────────
    if (session.running) {
      // 多 bot 场景：sessionId 不含 botId，同一 peerId 的消息可能来自不同 bot。
      // 同 bot 新消息 → 软中断当前 run（用户打断为预期行为）；
      // 跨 bot 消息 → 只排队等待当前 run 自然结束，不 abort（避免另一 bot 触发的任务被误打断）。
      const sameBot = !session.lastRunBotId || session.lastRunBotId === connector.botId;
      if (sameBot) {
        session.abortRequested = true;
        session.llmAbortController?.abort();
        session.abortPendingApproval();
        session.abortPendingPlanApproval();
        session.abortPendingAskUser();
      }
      // 等待当前 run 自然结束（工具会跑完，但不会进入下一轮 LLM）
      await session.waitIdle();
    }
    session.lastRunBotId = connector.botId;

    // ── 构建 MFA callbacks ─────────────────────────────────────────────
    const mfaTimeoutSecs = loadConfig().auth.mfa?.timeoutSecs ?? 0;

    /** 每次用户消息处理中，exit_plan_mode + ask_user 合计最多调用次数 */
    const MAX_INTERACTIVE_CALLS = 45;
    /** 当前用户消息处理中已使用的交互调用计数 */
    let interactiveCallCount = 0;

    /**
     * Slave 完成时的通知回调：
     * 1. 等待 Master 当前 run 结束（如果正在运行）
     * 2. 调用 runAgent 将 slave 结果注入 Master session
     * 3. 通过 connector 推送给用户
     */
    const onSlaveComplete = async (notif: SlaveNotification): Promise<void> => {
      const targetSession = sessions.get(notif.masterSessionId);
      if (!targetSession) {
        console.warn(`[slave:${notif.slaveId}] master session ${notif.masterSessionId} not found`);
        return;
      }

      // 串行化交由 Session.runExclusive 负责（见下方 runExclusive 调用）

      // 构建注入内容
      const statusIcon = notif.status === "done" ? "✅" : notif.status === "error" ? "❌" : "⛔";
      const trace = slaveManager.status(notif.slaveId)?.tracePath;
      const content =
        `<!-- subagent:result:${notif.slaveId} -->\n` +
        `<slave-results>\n` +
        `[slave:${notif.slaveId}] ${statusIcon} 后台任务已完成\n` +
        `任务：${notif.task}\n` +
        `状态：${notif.status}\n` +
        `结果：\n${notif.result || "（无输出）"}\n` +
        (trace ? `完整轨迹（含每次工具调用与结果）：${trace}\n` : "") +
        `</slave-results>`;

      // 重用当前连接的 MFA/Compress 回调（peerId/msgType 通过闭包捕获）
      const slaveOpts: AgentRunOptions = {
        onMFARequest: async (warningMsg: string, verifyCode?: (code: string) => boolean) => {
          return connector.buildMFARequest(
            msg.peerId,
            msg.type,
            warningMsg,
            mfaTimeoutSecs * 1000,
            verifyCode
          );
        },
        onMFAPrompt: (statusMsg: string) => {
          void connector
            .send(msg.peerId, msg.type, statusMsg)
            .catch((e: unknown) => console.error("[qqbot] send error:", e));
        },
        // 后台注入不需要心跳：用户没有主动发起请求，不应收到「仍在处理中」消息
        onCompress: (phase, summary) => {
          if (phase === "start") {
            void connector
              .send(msg.peerId, msg.type, "🧠 对话较长，正在整理记忆...")
              .catch((e: unknown) => console.error("[qqbot] send error:", e));
          } else if (phase === "done" && summary) {
            void connector
              .send(msg.peerId, msg.type, `✅ 记忆整理完成\n\n${summary}`)
              .catch((e: unknown) => console.error("[qqbot] send error:", e));
          }
        },
        // 不传 onSlaveComplete，避免 Slave 触发递归 fork
        ...(_sessionSendFn ? { sessionSendFn: _sessionSendFn } : {}),
        ...(_sessionGetFn ? { sessionGetFn: _sessionGetFn } : {}),
      };

      // 将 slave 结果注入 Master session 并运行 agent → 通知用户。
      // 走统一 run 队列（A4）：不再「检查 running → await → 手工置位」，
      // 避免与用户新消息并发跑同一个 session（消息交错 / currentRunPromise 被覆盖）。
      try {
        const runResult = await targetSession.runExclusive(() =>
          runAgent(targetSession, content, slaveOpts)
        );
        if (runResult.content) {
          await connector.send(msg.peerId, msg.type, runResult.content).catch(() => {});
        }
      } catch (err) {
        console.error(`[slave:${notif.slaveId}] master inject error:`, err);
      }
    };

    /**
     * Slave 定期进度推送回调：直接通过 connector 推送进度快照，不触发 runAgent。
     */
    const onProgressNotify = async (slaveId: string, state: SlaveState): Promise<void> => {
      const elapsed = Math.round((Date.now() - new Date(state.startedAt).getTime()) / 1000);
      const toolsSummary =
        state.progress.toolsUsed.length > 0
          ? `\n已用工具（共 ${state.progress.toolCallCount ?? state.progress.toolsUsed.length} 次）：${state.progress.toolsUsed.join(", ")}`
          : "";
      const phaseSummary = state.progress.phase ? `\n当前阶段：${state.progress.phase}` : "";
      const partialSummary = state.progress.partialOutput
        ? `\n最新输出：…${state.progress.partialOutput.slice(-200)}`
        : "";

      const progressMsg =
        `⏳ **[后台任务进度汇报]** Slave \`${slaveId}\`\n` +
        `任务：${state.task.slice(0, 80)}${state.task.length > 80 ? "…" : ""}\n` +
        `状态：${state.status}（已运行 ${elapsed}s）` +
        toolsSummary +
        phaseSummary +
        partialSummary;

      await connector.send(msg.peerId, msg.type, progressMsg).catch((err) => {
        console.error(`[slave:${slaveId}] progress notify send error:`, err);
      });
    };

    const planTimeoutSecs = 0; // 不超时，永久等待用户确认

    /**
     * Plan 审批回调：向 QQ 用户推送计划摘要和操作菜单，等待用户选择。
     * 仅在 code + plan 子模式下注入。
     */
    const buildPlanRequestCallback = (): AgentRunOptions["onPlanRequest"] | undefined => {
      if (session.mode !== "code") return undefined;

      return async (
        summary: string,
        actions?: string[],
        recommendedAction?: string,
        planPath?: string
      ): Promise<PlanApprovalResult> => {
        // 达到最大交互次数：自动拒绝并通知 AI 总结
        interactiveCallCount++;
        if (interactiveCallCount > MAX_INTERACTIVE_CALLS) {
          return {
            approved: false,
            feedback: `⚠️ 本次处理已达到最大交互次数（${MAX_INTERACTIVE_CALLS} 次）。请立即停止规划，总结当前已确认的内容并输出给用户，不要再调用 exit_plan_mode 或 ask_user。`,
          };
        }

        const resolvedActions = actions ?? ["autopilot", "interactive", "exit_only"];
        const resolvedRecommended = recommendedAction ?? "autopilot";

        // 构建操作菜单（Markdown 格式，用于渲染为图片）
        const actionLines = resolvedActions.map((action, i) => {
          const icons: Record<string, string> = {
            autopilot: "🚀",
            interactive: "💬",
            exit_only: "❌",
          };
          const icon = icons[action] ?? "▶️";
          const isRecommended = action === resolvedRecommended;
          return `${i + 1}. ${icon} \`${action}\`${isRecommended ? " **——推荐**" : ""}`;
        });

        const planPathLine = planPath ? `\n\n📄 **详细计划**：\`${planPath}\`` : "";
        const menuMsg =
          `## 📋 计划已就绪\n\n${summary}${planPathLine}\n\n` +
          `---\n\n**请选择操作：**\n\n${actionLines.join("\n")}\n\n` +
          `> 或直接输入反馈意见，AI 将修改计划后重新提交。`;

        // 尝试渲染为图片发送，失败则 fallback 纯文本
        let sent = false;
        try {
          const outDir = path.join(
            os.homedir(),
            ".tinyclaw",
            "agents",
            session.agentId,
            "workspace",
            "output",
            "md-renders"
          );
          fs.mkdirSync(outDir, { recursive: true });
          const imgPath = await mdToImage(menuMsg, outDir);
          await connector.send(msg.peerId, msg.type, `<img src="${imgPath}"/>`);
          sent = true;
        } catch (renderErr) {
          console.warn("[plan] 计划摘要渲染图片失败，降级为文本:", renderErr);
        }
        if (!sent) {
          // fallback：发送纯文本版本（去掉 Markdown 特殊符号）
          const plainMsg =
            `📋 计划已就绪\n\n${summary}${planPath ? `\n📄 详细计划：${planPath}` : ""}\n\n` +
            `─────────────────\n请选择操作：\n${resolvedActions
              .map((action, i) => {
                const icons: Record<string, string> = {
                  autopilot: "🚀",
                  interactive: "💬",
                  exit_only: "❌",
                };
                const isRecommended = action === resolvedRecommended;
                return `  ${i + 1}. ${icons[action] ?? "▶️"} ${action}${isRecommended ? " —— 推荐" : ""}`;
              })
              .join("\n")}\n\n` +
            `或直接输入反馈意见，AI 将修改计划后重新提交。`;
          await connector.send(msg.peerId, msg.type, plainMsg).catch(() => {});
        }

        const interactiveCfg = loadConfig().interactive;
        return session.waitForPlanApproval(planTimeoutSecs, resolvedActions, {
          afterSecs: interactiveCfg.remindAfterSecs,
          intervalSecs: interactiveCfg.remindIntervalSecs,
          maxReminds: interactiveCfg.maxReminds,
          send: () =>
            connector
              .send(msg.peerId, msg.type, "⏳ 还在等待您的选择...")
              .catch(() => {}),
        });
      };
    };

    const onPlanRequest = buildPlanRequestCallback();

    /**
     * ask_user 回调：向 QQ 用户展示问题和选项菜单，等待用户选择或输入。
     * Chat 和 Code 模式均注入，始终可用。
     */
    const onAskUser = async (
      question: string,
      options?: Array<{ label: string; description?: string; recommended?: boolean }>,
      allowFreeform = true
    ): Promise<{ answer: string; isFreeform: boolean }> => {
      // 达到最大交互次数:通知 AI 总结（code 模式限制，chat 模式不限）
      interactiveCallCount++;
      if (session.mode !== "code" && interactiveCallCount > MAX_INTERACTIVE_CALLS) {
        const limitMsg = `⚠️ 本次处理已达到最大交互次数(${MAX_INTERACTIVE_CALLS} 次),请立即总结当前内容并输出给用户,不要再调用 ask_user 或 exit_plan_mode。`;
        await connector.send(msg.peerId, msg.type, limitMsg).catch(() => {});
        throw new Error(limitMsg);
      }
      const optionLabels = (options ?? []).map((o) => o.label);

      // 构建菜单消息（Markdown 格式，尝试渲染为图片）
      const optionLines = (options ?? []).map((opt, i) => {
        const recMark = opt.recommended ? " **——推荐**" : "";
        const desc = opt.description ? `：${opt.description}` : "";
        return `${i + 1}. ${opt.label}${desc}${recMark}`;
      });
      const freeformNote = allowFreeform ? "\n\n> 或直接输入你的想法…" : "";
      const menuMsg =
        `## 🤔 有一个问题\n\n${question}\n\n` +
        (optionLines.length > 0 ? `---\n\n${optionLines.join("\n")}` : "") +
        freeformNote;

      // ── render_diagram 抢发修复 ──────────────────────────────────────────────
      // ask_user 会阻塞等待用户回复，若本轮同时调用了 render_diagram，
      // 其图片不会出现在 final content 里。在此先主动发出。
      try {
        const allMsgs = session.getMessages();
        for (let mi = allMsgs.length - 1; mi >= 0; mi--) {
          const mm = allMsgs[mi]!;
          if (mm.role === "assistant") {
            const tcs = (
              mm as {
                role: "assistant";
                tool_calls?: Array<{ function: { name: string }; id: string }>;
              }
            ).tool_calls;
            if (!tcs) break; // 最近一批 assistant 消息无 tool_calls，停止扫描
            for (const tc of tcs) {
              if (tc.function.name === "render_diagram") {
                const tmsg = allMsgs.find(
                  (x) =>
                    x.role === "tool" &&
                    (x as { role: "tool"; tool_call_id: string }).tool_call_id === tc.id
                ) as { role: "tool"; content: string } | undefined;
                if (tmsg) {
                  const imgM = tmsg.content.match(/<img\s+src="([^"]+)"/);
                  if (imgM?.[1] && fs.existsSync(imgM[1])) {
                    console.log(`[main] ask_user 前预发 render_diagram 图片: ${imgM[1]}`);
                    await connector
                      .send(msg.peerId, msg.type, `<img src="${imgM[1]}"/>`)
                      .catch(() => {});
                  }
                }
              }
            }
            break; // 只处理最近一批
          }
        }
      } catch (preErr) {
        console.warn("[main] render_diagram 预发失败:", preErr);
      }
      // ────────────────────────────────────────────────────────────────────────

      let sent = false;
      try {
        const outDir = path.join(
          os.homedir(),
          ".tinyclaw",
          "agents",
          session.agentId,
          "workspace",
          "output",
          "md-renders"
        );
        fs.mkdirSync(outDir, { recursive: true });
        const imgPath = await mdToImage(menuMsg, outDir);
        // 注意：不加 .catch() — send 失败应抛出，让外层 catch 捕获，sent 保持 false，走 fallback
        await connector.send(msg.peerId, msg.type, `<img src="${imgPath}"/>`);
        sent = true;
      } catch {
        // 渲染失败，降级为纯文本
      }
      if (!sent) {
        const plainOptLines = (options ?? []).map((opt, i) => {
          const recMark = opt.recommended ? " —— 推荐" : "";
          const desc = opt.description ? `（${opt.description}）` : "";
          return `  ${i + 1}. ${opt.label}${desc}${recMark}`;
        });
        const plainMsg =
          `🤔 有一个问题\n\n${question}` +
          (plainOptLines.length > 0 ? `\n\n─────────────────\n${plainOptLines.join("\n")}` : "") +
          (allowFreeform ? "\n\n或直接输入你的想法…" : "");
        await connector.send(msg.peerId, msg.type, plainMsg).catch(() => {});
      }

      // 等待用户回复，INVALID_CHOICE 时重新提示并循环
       
      const interactiveCfg = loadConfig().interactive;
      const askRemind = {
        afterSecs: interactiveCfg.remindAfterSecs,
        intervalSecs: interactiveCfg.remindIntervalSecs,
        maxReminds: interactiveCfg.maxReminds,
        send: () =>
          connector.send(msg.peerId, msg.type, "⏳ 还在等待您的回答...").catch(() => {}),
      };
      while (true) {
        try {
          return await session.waitForAskUser(optionLabels, allowFreeform, askRemind);
        } catch (e) {
          if (e instanceof Error && e.message.startsWith("INVALID_CHOICE:")) {
            const hint = e.message.slice("INVALID_CHOICE:".length);
            await connector.send(msg.peerId, msg.type, hint).catch(() => {});
            // continue loop
          } else {
            throw e;
          }
        }
      }
    };

    // ── C2C 流式回复会话（仅最终回复使用；失败自动回退普通发送）──────────────
    // 单聊 + 该 msg_id 仍有被动回复额度时才开启；群聊/频道不支持流式。
    const stream = connector.openStream(msg.peerId, msg.type, msg.messageId);

    // 流式展示文本的累计量：raw 是 LLM 原始增量，shown 是**已推送给用户的可见文本**。
    // 推送前必须剥掉媒体标签——标签只能由 sendMessage() 正确消费（上传文件后再发消息），
    // 直接推给用户会看到 <file src="/path" name="x.pdf"/> 这样的裸文本。
    let streamRaw = "";
    let streamShown = "";

    const opts: AgentRunOptions = {
      botId: connector.botId,
      onSlaveComplete,
      onProgressNotify,
      onNotify: async (message: string) => {
        const prefixed = message.startsWith("<img")
          ? message
          : `⏳ [进度]
${message}`;
        await connector.send(msg.peerId, msg.type, prefixed).catch((err) => {
          console.error("[notify_user] send error:", err);
        });
      },
      ...(onPlanRequest !== undefined ? { onPlanRequest } : {}),
      onAskUser,
      onMFARequest: async (warningMsg: string, verifyCode?: (code: string) => boolean) => {
        return connector.buildMFARequest(
          msg.peerId,
          msg.type,
          warningMsg,
          mfaTimeoutSecs * 1000,
          verifyCode
        );
      },
      onMFAPrompt: (statusMsg: string) => {
        void connector
          .send(msg.peerId, msg.type, statusMsg)
          .catch((e: unknown) => console.error("[qqbot] send error:", e));
      },
      onPurpose: (purpose: string) => {
        // 进度旁白：取代旧的定时心跳。内容来自模型自己写的 __purpose，
        // 是否展示由 core/purpose-arbiter.ts 仲裁（只有"用户确实在等"的才发）。
        void connector
          .send(msg.peerId, msg.type, purpose)
          .catch((e: unknown) => console.error("[qqbot] send error:", e));
      },
      onCompress: (phase, summary) => {
        if (phase === "start") {
          void connector
            .send(msg.peerId, msg.type, "🧠 对话较长，正在整理记忆...")
            .catch((e: unknown) => console.error("[qqbot] send error:", e));
        } else if (phase === "done" && summary) {
          void connector
            .send(msg.peerId, msg.type, `✅ 记忆整理完成\n\n${summary}`)
            .catch((e: unknown) => console.error("[qqbot] send error:", e));
        }
      },
      ...(_sessionSendFn ? { sessionSendFn: _sessionSendFn } : {}),
      ...(_sessionGetFn ? { sessionGetFn: _sessionGetFn } : {}),
      onToolCall: (name: string, args: Record<string, unknown>) => {
        // 出现工具调用 → 本轮不是最终回复：收尾已流式的内容，后续不再流式
        if (stream?.usable) void stream.closeEarly();
        broadcastActivity(session.sessionId, {
          kind: "tool_call",
          name,
          argsSummary: JSON.stringify(args).slice(0, 200),
        });
      },
      onToolResult: (name: string, result: string) => {
        broadcastActivity(session.sessionId, {
          kind: "tool_result",
          name,
          resultSummary: result.slice(0, 300),
        });
      },
      onChunk: (delta: string) => {
        broadcastActivity(session.sessionId, { kind: "chunk", delta });
        if (!stream?.usable) return;
        streamRaw += delta;
        const visible = stripMediaForStream(streamRaw);
        // 只推送"可见文本的增长部分"；若计算结果不是已推内容的延续（极少见），
        // 本轮不推，交由收尾时的兜底逻辑处理，避免把错乱内容推给用户。
        if (visible.length > streamShown.length && visible.startsWith(streamShown)) {
          stream.push(visible.slice(streamShown.length));
          streamShown = visible;
        }
      },
    };

    // ── Fire-and-forget：启动新 run，结果通过 connector.send() 推送 ──
    // running / currentRunPromise 由下方的 session.runExclusive 维护

    // /retry 命令触发：复用上次失败的 X-Request-Id，跳过添加新用户消息（已在 session 历史中）
    const pendingRetry = session.pendingRetry;
    if (pendingRetry) {
      session.pendingRetry = null;
    }

    // 附件已在 handleMessage 顶部完成下载和转录（earlyDownloaded），直接构建消息内容
    let messageContent: string;
    if (pendingRetry?.userContent) {
      // /retry：使用原始用户消息（含原始时间戳），不再添加新时间戳
      // trimToLength 已回滚了用户消息，需通过 runAgent 重新添加到 session
      messageContent = pendingRetry.userContent;
    } else {
      messageContent = buildEnrichedContent(msg.content, earlyDownloaded);
      // 在用户发出的消息前加上当前时间，方便 Agent 识别当前日期
      const nowStr = new Date().toLocaleString() + " UTC+8";
      messageContent = `[${nowStr}] ${messageContent}`;
    }

    const finalOpts: AgentRunOptions = pendingRetry
      ? {
          ...opts,
          // 不设 skipAddUserMessage：原始用户消息已被 trimToLength 回滚，需要重新添加
          ...(pendingRetry.requestId ? { turnRequestIdOverride: pendingRetry.requestId } : {}),
        }
      : opts;

    // 统一 run 队列（A4）：同一 session 上的 run 严格串行，
    // running / currentRunPromise 由 Session.runExclusive 维护，调用方不再手工置位。
    const runPromise = session.runExclusive(() => runAgent(session, messageContent, finalOpts));
    // 广播用户输入（包含语音转录后的 resolvedContent）
    broadcastActivity(session.sessionId, {
      kind: "user_input",
      message: resolvedContent.slice(0, 500),
    });

    void runPromise
      .then(async (result) => {
        // 工具执行完但 LLM 最终返回空 content 时（非中断）：
        // - 空回复守卫判定为「思考退化 / 被长度截断」→ 诚实告知用户（不能再报「已完成」）
        // - 其余情况（模型确实没说话，结果已由工具交付）→ 沿用「✅ 已完成」
        let toSend = result.content;
        if (!toSend) {
          const kind = result.emptyReplyKind;
          if (kind === "degenerate" || kind === "length") {
            toSend =
              kind === "length"
                ? "⚠️ 模型这轮没有产出正文（输出被长度上限截断，思考过程吃满了预算），请再问一次或换个模型"
                : "⚠️ 模型这轮没有产出正文（思考退化成了重复），请再问一次或换个模型";
          } else {
            toSend =
              result.toolsUsed.length > 0 && !session.abortRequested ? "✅ 已完成" : "";
          }
        }
        if (!toSend) return;

        // 发给用户前预检本地媒体文件，失败则回传给 agent 重跑，用户不感知
        const mediaErrors = validateMediaContent(toSend);
        if (mediaErrors.length > 0) {
          const feedback = mediaErrors.map((e) => `${e.src}: ${e.error}`).join("\n");
          console.log(`[main] 媒体预检失败，重跑 agent:\n${feedback}`);
          const retryResult = await runAgent(session, `[系统] ${feedback}`, opts);
          if (retryResult.content) {
            toSend = retryResult.content;
          } else {
            // 重跑无输出（如原始回复含文档示例标签），回退到纯文本部分
            console.log("[main] 重跑无输出，回退到纯文本");
            toSend = extractTextContent(toSend);
            if (!toSend) return;
          }
        }

        // render_diagram 兜底:若 AI 使用了 render_diagram 但最终 content 未嵌入 <img> 标签,
        // 则从 session 最近的 tool_result 中扫描并自动附加图片路径。
        if (result.toolsUsed.includes("render_diagram") && !/<img\s/i.test(toSend)) {
          const msgs = session.getMessages();
          let foundImgPath: string | null = null;
          for (let i = msgs.length - 1; i >= 0; i--) {
            const m = msgs[i]!;
            if (m.role === "assistant") {
              const tc = (
                m as {
                  role: "assistant";
                  tool_calls?: Array<{ function: { name: string }; id: string }>;
                }
              ).tool_calls;
              if (!tc) continue;
              for (const call of tc) {
                if (call.function.name === "render_diagram") {
                  const toolMsg = msgs.find(
                    (x) =>
                      x.role === "tool" &&
                      (x as { role: "tool"; tool_call_id: string }).tool_call_id === call.id
                  ) as { role: "tool"; content: string } | undefined;
                  if (toolMsg) {
                    const imgMatch = toolMsg.content.match(/<img\s+src="([^"]+)"/);
                    if (imgMatch?.[1]) {
                      foundImgPath = imgMatch[1];
                      break;
                    }
                  }
                }
              }
            }
            if (foundImgPath) break;
          }
          if (foundImgPath && fs.existsSync(foundImgPath)) {
            console.log(`[main] render_diagram 兜底:自动附加图片 ${foundImgPath}`);
            toSend = `${toSend}\n<img src="${foundImgPath}"/>`.trim();
          }
        }

        // Code 模式：将含 Markdown 特征的纯文本回复渲染为图片
        if (session.mode === "code" && looksLikeMarkdown(toSend)) {
          try {
            const outDir = path.join(
              os.homedir(),
              ".tinyclaw",
              "agents",
              session.agentId,
              "workspace",
              "output",
              "md-renders"
            );
            fs.mkdirSync(outDir, { recursive: true });
            const imgPath = await mdToImage(toSend, outDir);
            console.log(`[main] Markdown 渲染为图片: ${imgPath}`);
            toSend = `<img src="${imgPath}"/>`;
          } catch (renderErr) {
            console.warn("[main] Markdown 渲染失败，降级为文本:", renderErr);
          }
        }

        // ── 流式收尾：正文前段已流式送达时，只补发装不下的余量 ──────────────
        if (stream) {
          // 正文与媒体标签分开处理：媒体标签必须走普通发送路径才会被上传，
          // 否则流式会把 <file src=.../> 当作纯文本发给用户、文件永远发不出去。
          const { text: bodyText, mediaText } = splitMediaText(toSend);
          const streamBody = mediaText ? bodyText.trim() || streamShown : toSend;
          const fin = await stream.finish(streamBody);
          if (fin.streamed) {
            // 平台的流式消息有长度预算（remain_msg_len）：超出的余量走普通发送，
            // 否则平台会静默丢弃后续分片，消息停在"生成中"（手机只显示开头几个字）
            if (fin.remainder.trim()) {
              try {
                await connector.send(msg.peerId, msg.type, fin.remainder, msg.messageId);
                console.log(`[qqbot] 流式余量已用普通发送补上（${fin.remainder.length} 字符）`);
              } catch (restErr) {
                console.error("[qqbot] 流式余量发送失败:", restErr);
              }
            }
            if (mediaText) {
              try {
                const outcome = await connector.send(
                  msg.peerId,
                  msg.type,
                  mediaText,
                  msg.messageId
                );
                // 媒体失败会**静默降级为纯文本**（用户只收到正文），所以不能无脑报"已送达"
                if (outcome.mediaFailed) {
                  console.error(
                    `[qqbot] 媒体标签发送失败，已降级为纯文本: ${outcome.mediaError ?? "原因未知"}`
                  );
                } else {
                  console.log("[qqbot] 媒体标签已通过普通发送路径送达（流式仅承载正文）");
                }
              } catch (mediaErr) {
                console.error("[qqbot] 流式回复中的媒体发送失败:", mediaErr);
              }
            }
            console.log(
              `[qqbot] 最终回复已通过流式送达${fin.remainder.trim() ? "（余量已另发）" : ""}，跳过重复发送`
            );
            return;
          }
        }

        try {
          await connector.send(msg.peerId, msg.type, toSend, msg.messageId);
        } catch (sendErr) {
          console.error("[qqbot] send error:", sendErr);
        }
      })
      .then(() => {
        broadcastActivity(session.sessionId, { kind: "done" });
      })
      .catch(async (err: unknown) => {
        broadcastActivity(session.sessionId, { kind: "error", message: String(err) });
        console.error("[qqbot] runAgent error:", err);
        const userMsg =
          err instanceof Error && err.name === "LLMConnectionError"
            ? err.message
            : "抱歉，处理消息时出现错误";
        try {
          await connector.send(msg.peerId, msg.type, userMsg, msg.messageId);
        } catch {
          // 发送失败（如网络/证书错误），静默忽略，不能让进程崩溃
        }
      });
    // running / currentRunPromise 的清理由 Session.runExclusive 的 finally 负责

    // 返回 "" — 实际回复通过 connector.send() 推送，connector 不会重复发送
    return "";
  }

  // ── 注册处理器并启动 ───────────────────────────────────────────────────

  for (const c of connectors) {
    c.onMessage(makeHandleMessage(c));
  }

  // 4. 启动 IPC server（供 CLI chat 命令通过 Unix socket 接入）
  const ipcServer = startIpcServer(sessions, connector, connectorsMap);
  console.log("[tinyclaw] IPC server listening");

  // 5. 启动 Cron 调度器
  await cronScheduler.start(connector);

  // 6. 启动 Loop Session 引擎
  // loopTick：将 TASK.md 内容作为用户消息，直接调 runAgent，走完整 agent 路径。
  // Loop session 本身无 QQ 回调，Agent 若需推送结果通过 notify_user / send_report 工具自行完成。

  // ── 跨 session 通信（session_send / session_get）────────────────────────
  // 双向 access.toml 权限检查：发送方 can_access 包含接收方 agentId，且接收方 allow_from 包含发送方 agentId。
  const sessionSendFn = async (
    targetSessionId: string,
    message: string,
    fromAgentId: string,
    fromSessionId?: string
  ): Promise<string> => {
    // 自锁拦截：向自己所在的 session 发消息会让自己排在队尾等自己，永远无法返回
    if (fromSessionId && targetSessionId === fromSessionId) {
      return "已拒绝：不能向自己所在的 session 发送消息（会导致该会话自锁）";
    }

    // 获取目标 session（不存在时 lazy 创建）
    const targetSession = getSession(targetSessionId);
    const targetAgentId = targetSession.agentId;

    // 双向权限检查
    const senderAccess = agentManager.readAccessConfig(fromAgentId);
    if (
      !senderAccess.can_access.includes("*") &&
      !senderAccess.can_access.includes(targetAgentId)
    ) {
      return `权限拒绝：agent "${fromAgentId}" 未配置对 agent "${targetAgentId}" 的访问权限（在 ${agentManager.accessConfigPath(fromAgentId)} 中添加 can_access = ["${targetAgentId}"] 或 can_access = ["*"]）`;
    }
    const receiverAccess = agentManager.readAccessConfig(targetAgentId);
    if (!receiverAccess.allow_from.includes(fromAgentId)) {
      return `权限拒绝：agent "${targetAgentId}" 未允许来自 agent "${fromAgentId}" 的消息（在 ${agentManager.accessConfigPath(targetAgentId)} 中添加 allow_from = ["${fromAgentId}"]）`;
    }

    // 串行化交由下方 Session.runExclusive 负责（自动等待目标 session 空闲）
    // 注入消息，走完整 runAgent 路径
    const nowStr = new Date().toLocaleString() + " UTC+8";

    // 尝试从 targetSessionId 解析 qqbot peerId，构建 onNotify 推送回调
    let targetOnNotify: ((msg: string) => Promise<void>) | undefined;
    const targetSessionMatch = targetSessionId.match(/^qqbot:(c2c|group|guild|dm):(.+)$/);
    if (targetSessionMatch) {
      const [, targetType, targetPeerId] = targetSessionMatch;
      const targetConnector = sessionConnectorMap.get(targetSessionId) ?? connectors[0] ?? null;
      if (targetConnector) {
        targetOnNotify = async (notifMsg: string) => {
          await targetConnector
            .send(
              targetPeerId!,
              targetType! as import("./connectors/base.js").InboundMessage["type"],
              notifMsg
            )
            .catch(() => {});
        };
      }
    }

    const { content: finalContent } = await targetSession.runExclusive(() =>
      runAgent(targetSession, `[来自 ${fromAgentId} @ ${nowStr}] ${message}`, {
        sessionSendFn,
        sessionGetFn,
        ...(targetOnNotify ? { onNotify: targetOnNotify } : {}),
      })
    );

    // 将 AI 最终回复推给目标用户
    if (targetOnNotify && finalContent?.trim()) {
      await targetOnNotify(finalContent.trim());
    }

    return `消息已成功注入 session "${targetSessionId}"`;
  };

  const sessionGetFn = async (
    fromAgentId: string
  ): Promise<import("./tools/registry.js").SessionInfo[]> => {
    const senderAccess = agentManager.readAccessConfig(fromAgentId);
    const result: import("./tools/registry.js").SessionInfo[] = [];
    for (const [sid, session] of sessions) {
      const targetAgentId = session.agentId;
      if (
        !senderAccess.can_access.includes("*") &&
        !senderAccess.can_access.includes(targetAgentId)
      )
        continue;
      const receiverAccess = agentManager.readAccessConfig(targetAgentId);
      if (!receiverAccess.allow_from.includes(fromAgentId)) continue;
      result.push({
        sessionId: sid,
        agentId: targetAgentId,
        running: session.running,
        isLoop: agentManager.readSessionLoop(sid) !== null || loopTriggerManager.isBound(sid),
        recentActivity: getActivityLog(sid),
      });
    }
    return result;
  };

  // 注册到模块级变量，供 handleMessage 中的 opts 引用
  _sessionSendFn = sessionSendFn;
  _sessionGetFn = sessionGetFn;

  const loopTick = async (
    sessionId: string,
    content: string,
    taskFilePath: string
  ): Promise<void> => {
    const session = getSession(sessionId);
    // stateful=false：每轮开始前清空历史，避免 context 无限积累
    const loopCfg = agentManager.readSessionLoop(sessionId);
    if (loopCfg && !loopCfg.stateful) {
      session.clearMessages();
    }
    // 通过 addLoopTaskMessage 注入 loop task，携带 taskFilePath 用于 getMessagesForLLM 折叠
    session.addLoopTaskMessage(taskFilePath, content);
    // 统一 run 队列：loop tick 不得与用户消息并发（A4）
    await session.runExclusive(() =>
      runAgent(session, content, {
        sessionSendFn,
        sessionGetFn,
        skipAddUserMessage: true,
      })
    );
  };
  await loopRunner.start(loopTick);

  // 启动 loop 触发器管理器（新机制：bindTo 绑定任意 session）
  loopTriggerManager.start({
    getSession,
    runAgent,
    connectors: connectorsMap,
  });

  // 7. 启动内置每日记忆维护调度器
  // 提前初始化 embed LLM，确保 QMD 使用正确的向量模型（避免 GGUF session 先于 rkllm 初始化）
  await initEmbedLlm();
  memoryMaintenance.start();

  // 启动 news 目录 watcher（主动触发增量索引，替代懒触发）
  startNewsWatcher();

  // 8. 启动内置 ~/.tinyclaw 配置仓库自动提交调度器
  tinyclawSubmitter.start();

  // 8. 启动 Web Dashboard（若配置启用）
  if (cfg.web.enabled) {
    startDashboard(cfg.web.port, cfg.web.token, cfg.web.downloads);
    startCollector();
  }

  // 7. 定期清理已完成的 Slave（每小时一次，防止 Map 无限增长）
  const gcInterval = setInterval(
    () => {
      slaveManager.gc();
    },
    60 * 60 * 1000
  );

  // 8. 优雅退出
  const handleExit = async (signal: string) => {
    console.log(`\n[tinyclaw] Received ${signal}, shutting down...`);
    clearInterval(gcInterval);
    ipcServer.close();
    cronScheduler.stop();
    loopRunner.stop();
    loopTriggerManager.stop();
    memoryMaintenance.stop();
    tinyclawSubmitter.stop();
    stopNewsWatcher();
    mcpWatcher.stop();
    stopCollector();
    stopDashboard();
    if (connector) await connector.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => void handleExit("SIGINT"));
  process.on("SIGTERM", () => void handleExit("SIGTERM"));

  // ── 启动健康自检（改坏自动回退的判据）──
  // 顺序很重要：**先自检、再提升 LKG** —— 否则会把一份坏配置记成"可用版本"。
  try {
    const raw = fs.readFileSync(CONFIG_PATH, "utf-8");
    const knownIds = agentManager.listAgentIds();
    let health = runOfflineHealthChecks({
      cfg,
      rawText: raw,
      knownAgent: (id) => knownIds.includes(id),
      knownTool: (name) => getTool(name) !== undefined,
    });
    if (cfg.health.enabled && cfg.health.probeLlm) {
      const probe = await probeDailyBackend(cfg.health.probeTimeoutMs);
      health = withLlmProbe(health, probe);
    }
    appendHealthLog(health);
    for (const line of formatHealthReport(health)) console.log(`[health] ${line}`);

    if (health.rollbackWorthy && shouldRollbackConfig()) {
      // 配置有确定性错误，且与"上一份可用配置"不同 → 回退，并请求立即重启（exit 75 不算崩溃）
      const res = restoreLastGoodConfig("启动健康自检发现确定性配置错误");
      if (res.ok) {
        console.error(
          "[tinyclaw] ⚠️ 配置健康检查失败，已回退到上一份可用配置并立即重启：" +
            `${res.record?.fromHash.slice(0, 8)} → ${res.record?.toHash.slice(0, 8)}`
        );
        process.exit(75);
      }
      console.error(`[tinyclaw] 配置健康检查失败，且无法回退（${res.reason ?? "未知"}），继续带病运行`);
    }

    if (cfg.health.enabled) promoteConfig(raw);
    else console.log("[tinyclaw] 健康自检已关闭（[health].enabled = false），未记录 LKG");
  } catch (err) {
    console.warn(`[tinyclaw] 健康自检/LKG 失败：${err instanceof Error ? err.message : String(err)}`);
  }

  // ── 自动回退通知（supervisor 写入）──：不依赖 connector，先落日志 ──
  const ROLLBACK_NOTIFY_FILE = path.join(os.homedir(), ".tinyclaw", ".rollback_notify.json");
  const ROLLBACK_STATE_FILE = path.join(os.homedir(), ".tinyclaw", ".rollback_state.json");
  let rollbackNotice = "";
  /** 是否发生了**代码**回退（git stash 那份；restart_tool 续接文案用它） */
  let didRollback = false;
  /** 是否发生了**配置**回退（保留 LKG 覆盖） */
  let configRolledBack = false;
  if (fs.existsSync(ROLLBACK_NOTIFY_FILE)) {
    try {
      const rn = JSON.parse(fs.readFileSync(ROLLBACK_NOTIFY_FILE, "utf-8")) as {
        kind?: string;
        originalHead?: string;
        prevHead?: string;
        fromHash?: string;
        toHash?: string;
        reason?: string;
        rejectedPath?: string;
        rollbackAt: string;
      };
      fs.unlinkSync(ROLLBACK_NOTIFY_FILE);
      if (rn.kind === "config") {
        configRolledBack = true;
        rollbackNotice =
          `⚠️ 配置自动回退（${rn.rollbackAt}）\n` +
          `  从 ${rn.fromHash?.slice(0, 8) ?? "?"} 回退到上一份可用配置 ${rn.toHash?.slice(0, 8) ?? "?"}\n` +
          `  原因：${rn.reason ?? "启动失败"}\n` +
          (rn.rejectedPath ? `  坏配置留证：${rn.rejectedPath}\n` : "") +
          `  请检查后重新编辑 ~/.tinyclaw/config.toml`;
        console.warn(`[tinyclaw] ${rollbackNotice}`);
      } else {
        didRollback = true;
        rollbackNotice =
          `⚠️ 代码自动回退（${rn.rollbackAt}）：${rn.originalHead ?? "?"} → ${rn.prevHead ?? "?"}`;
        console.warn(`[tinyclaw] ${rollbackNotice}`);
      }
    } catch {
      /* ignore */
    }
  }

  if (connector) {
    console.log("[tinyclaw] Starting QQBot connector...");

    // 检查重启通知 marker（由 /restart 命令或 restart_tool 写入，用于重启后发送通知）
    const RESTART_NOTIFY_FILE = path.join(os.homedir(), ".tinyclaw", ".restart_notify.json");
    if (fs.existsSync(RESTART_NOTIFY_FILE)) {
      try {
        const marker = JSON.parse(fs.readFileSync(RESTART_NOTIFY_FILE, "utf-8")) as {
          peerId: string;
          msgType: InboundMessage["type"];
          /** restart_tool 写入的字段：code 模式 sessionId，重启后续接任务 */
          codeSessionId?: string;
          /** restart_tool 写入的字段：重启前写入的 tool_result 的 callId，重启后用于回填 */
          restartCallId?: string;
          /** restart_tool 写入的字段：原 run 的 X-Agent-Task-Id，重启后用于续接原任务 */
          restartTaskId?: string;
          /** 多 session 同时 restart_tool: 排队的其他 session 续接信息 */
          additionalSessions?: import("./tools/restart.js").RestartQueueItem[];
          /** /model 等命令写入的自定义提示文本,重启后追加到通知里 */
          note?: string;
        };
        fs.unlinkSync(RESTART_NOTIFY_FILE);
        connector.onReady = () => {
          // one-shot: 发送完通知后立即清除，防止 QQ Bot 后续重连触发 READY 时重复推送
          delete connector!.onReady;

          // 1. 仅非 code 模式重启才主动发通知。
          //    code 模式重启(含 codeSessionId)由 resume runAgent 的 result.content 返回结果，
          //    不额外推送 "✅ 重启完成" 避免重复打扰。
          if (!marker.codeSessionId) {
            const okMsg = marker.note ? `✅ ${marker.note},服务已恢复` : "✅ 重启完成,服务已恢复";
            void connector!.send(marker.peerId, marker.msgType, okMsg).catch(() => {});
          }

          // 2. 若是 restart_tool 触发的重启（含 codeSessionId），延迟 1s 后续接 code session
          if (marker.codeSessionId) {
            setTimeout(() => {
              const codeSession = getSession(marker.codeSessionId!);
              if (codeSession) {
                // 回填 tool_result：将 "⏳ 正在重启..." 更新为 "✅ 重启完成"，避免注入额外用户消息
                if (marker.restartCallId) {
                  const restartMsg = configRolledBack
                    ? `⚠️ 重启完成，但**配置已自动回退**（上一份可用配置已恢复）。\n${rollbackNotice}`
                    : didRollback
                      ? "✅ 重启完成（已自动回退到上一个版本，原改动已 git stash）。继续执行之前的任务。"
                      : "✅ 重启完成，继续执行之前的任务。";
                  codeSession.updateToolResult(marker.restartCallId, restartMsg);
                }
                void connector!
                  .send(
                    marker.peerId,
                    marker.msgType,
                    configRolledBack
                      ? `⚠️ 重启完成，但**配置已自动回退**：\n${rollbackNotice}`
                      : didRollback
                        ? "✅ 重启完成（已自动回退到上一个版本，原改动已 git stash，可用 git stash pop 恢复）"
                        : "✅ 重启完成，继续执行之前的任务。"
                  )
                  .catch(() => {});
                if (didRollback) {
                  try {
                    fs.unlinkSync(ROLLBACK_STATE_FILE);
                  } catch {
                    /* ignore */
                  }
                }
                codeSession.running = true;
                // skipAddUserMessage: true — 直接从已有的 tool_result 续接，不注入多余的用户消息
                // 重建 onAskUser / onNotify,供续接的 runAgent 使用
                // (marker.peerId/msgType 记录了原始请求者,重启后仍向其发送交互消息)
                let restartInteractiveCallCount = 0;
                const MAX_INTERACTIVE_CALLS_RESTART = 45;
                const resumeOnAskUser = async (
                  resumeQuestion: string,
                  resumeOptions?: Array<{
                    label: string;
                    description?: string;
                    recommended?: boolean;
                  }>,
                  resumeAllowFreeform = true
                ): Promise<{ answer: string; isFreeform: boolean }> => {
                  restartInteractiveCallCount++;
                  if (restartInteractiveCallCount > MAX_INTERACTIVE_CALLS_RESTART) {
                    const limitMsg = `⚠️ 本次处理已达到最大交互次数(${MAX_INTERACTIVE_CALLS_RESTART} 次),请立即总结当前内容并输出给用户,不要再调用 ask_user 或 exit_plan_mode。`;
                    await connector!.send(marker.peerId, marker.msgType, limitMsg).catch(() => {});
                    throw new Error(limitMsg);
                  }
                  const optionLabels = (resumeOptions ?? []).map((o) => o.label);
                  const optionLines = (resumeOptions ?? []).map((opt, i) => {
                    const recMark = opt.recommended ? " —— 推荐" : "";
                    const desc = opt.description ? `(${opt.description})` : "";
                    return `  ${i + 1}. ${opt.label}${desc}${recMark}`;
                  });
                  const plainMsg =
                    `🤔 有一个问题\n\n${resumeQuestion}` +
                    (optionLines.length > 0
                      ? `\n\n─────────────────\n${optionLines.join("\n")}`
                      : "") +
                    (resumeAllowFreeform ? "\n\n或直接输入你的想法..." : "");
                  await connector!.send(marker.peerId, marker.msgType, plainMsg).catch(() => {});
                  const resumeInteractive = loadConfig().interactive;
                  return codeSession.waitForAskUser(optionLabels, resumeAllowFreeform, {
                    afterSecs: resumeInteractive.remindAfterSecs,
                    intervalSecs: resumeInteractive.remindIntervalSecs,
                    maxReminds: resumeInteractive.maxReminds,
                    send: () =>
                      connector!
                        .send(marker.peerId, marker.msgType, "⏳ 还在等待您的回答...")
                        .catch(() => {}),
                  });
                };
                const resumeOnNotify = async (notifyMessage: string) => {
                  await connector!
                    .send(marker.peerId, marker.msgType, notifyMessage)
                    .catch(() => {});
                };

                // skipAddUserMessage: true — 直接从已有的 tool_result 续接,不注入多余的用户消息
                const resumePromise = codeSession.runExclusive(() =>
                  runAgent(codeSession, "", {
                    skipAddUserMessage: true,
                    continueAsAgentRound: true,
                    onAskUser: resumeOnAskUser,
                    onNotify: resumeOnNotify,
                    ...(marker.restartTaskId ? { agentTaskIdOverride: marker.restartTaskId } : {}),
                    onChunk: (delta: string) => {
                      broadcastActivity(codeSession.sessionId, { kind: "chunk", delta });
                    },
                    onToolCall: (name: string, args: Record<string, unknown>) => {
                      broadcastActivity(codeSession.sessionId, {
                        kind: "tool_call",
                        name,
                        argsSummary: JSON.stringify(args).slice(0, 200),
                      });
                    },
                    onToolResult: (name: string, result: string) => {
                      broadcastActivity(codeSession.sessionId, {
                        kind: "tool_result",
                        name,
                        resultSummary: result.slice(0, 300),
                      });
                    },
                  })
                );
                resumePromise
                  .then((result) => {
                    broadcastActivity(codeSession.sessionId, { kind: "done" });
                    if (result.content) {
                      void connector!
                        .send(marker.peerId, marker.msgType, result.content)
                        .catch(() => {});
                    }
                  })
                  .catch((err: unknown) => {
                    broadcastActivity(codeSession.sessionId, {
                      kind: "error",
                      message: String(err),
                    });
                    console.error("[restart_tool] resume runAgent error:", err);
                  });
                // running / currentRunPromise 清理由 runExclusive 负责
              } else {
                console.log(
                  `[restart_tool] codeSession "${marker.codeSessionId}" not found after restart, skip resume`
                );
              }

              // ── 续接排队中的其他 session ──────────────────────────────────
              for (const extra of marker.additionalSessions ?? []) {
                if (!extra.sessionId) continue;
                const extraSession = getSession(extra.sessionId);
                if (!extraSession) continue;
                if (extra.callId) {
                  extraSession.updateToolResult(extra.callId, "✅ 重启完成,继续执行之前的任务。");
                }
                if (extra.peerId) {
                  void connector!
                    .send(
                      extra.peerId,
                      extra.msgType as import("./connectors/base.js").InboundMessage["type"],
                      "✅ 重启完成,继续执行之前的任务。"
                    )
                    .catch(() => {});
                }
                const extraPromise = extraSession.runExclusive(() =>
                  runAgent(extraSession, "", {
                    skipAddUserMessage: true,
                    continueAsAgentRound: true,
                    ...(extra.peerId
                      ? {
                          onNotify: async (msg: string) => {
                            await connector!
                              .send(
                                extra.peerId,
                                extra.msgType as import("./connectors/base.js").InboundMessage["type"],
                                msg
                              )
                              .catch(() => {});
                          },
                        }
                      : {}),
                    ...(extra.taskId ? { agentTaskIdOverride: extra.taskId } : {}),
                    onChunk: (delta: string) => {
                      broadcastActivity(extraSession.sessionId, { kind: "chunk", delta });
                    },
                    onToolCall: (name: string, args: Record<string, unknown>) => {
                      broadcastActivity(extraSession.sessionId, {
                        kind: "tool_call",
                        name,
                        argsSummary: JSON.stringify(args).slice(0, 200),
                      });
                    },
                    onToolResult: (name: string, result: string) => {
                      broadcastActivity(extraSession.sessionId, {
                        kind: "tool_result",
                        name,
                        resultSummary: result.slice(0, 300),
                      });
                    },
                  })
                );
                extraPromise
                  .then((result) => {
                    broadcastActivity(extraSession.sessionId, { kind: "done" });
                    if (result.content && extra.peerId) {
                      void connector!
                        .send(
                          extra.peerId,
                          extra.msgType as import("./connectors/base.js").InboundMessage["type"],
                          result.content
                        )
                        .catch(() => {});
                    }
                  })
                  .catch((err: unknown) => {
                    broadcastActivity(extraSession.sessionId, {
                      kind: "error",
                      message: String(err),
                    });
                    console.error("[restart_tool] extra session resume error:", err);
                  });
                // running / currentRunPromise 清理由 runExclusive 负责
              }
            }, 1000);
          }
        };
      } catch {
        try {
          fs.unlinkSync(RESTART_NOTIFY_FILE);
        } catch {
          /* ignore */
        }
      }
    }

    // 额外 bot 非阻塞启动（start 内部走 WebSocket，自动重连）
    for (const c of connectors.slice(1)) {
      void c.start().catch((err: unknown) => console.error("[qqbot] extra bot start error:", err));
    }
    // 主 bot 阻塞直到 abort
    await connector.start();
  } else {
    // IPC-only 模式：无限等待信号
    console.log("[tinyclaw] Running in IPC-only mode (no QQBot). Send SIGTERM to stop.");
    await new Promise<void>(() => {
      /* 永不 resolve，依靠 SIGTERM/SIGINT 退出 */
    });
  }
}

main().catch(async (err) => {
  console.error("[tinyclaw] Fatal:", err);

  // 通知所有活跃 QQ session
  if (_activeConnector && _activeSessions) {
    const errMsg = err instanceof Error ? err.message : String(err);
    const notice = `⚠️ tinyclaw 服务发生致命错误，正在自动重启…\n${errMsg}`;
    const notifyAll = [..._activeSessions.keys()]
      .filter((id) => id.startsWith("qqbot:"))
      .map((id) => {
        const parts = id.split(":");
        if (parts.length < 3) return Promise.resolve();
        const type = parts[1] as "c2c" | "group" | "guild" | "dm";
        const peerId = parts.slice(2).join(":");
        return _activeConnector!.send(peerId, type, notice).catch(() => {});
      });
    await Promise.allSettled(notifyAll);
  }

  process.exit(1);
});
