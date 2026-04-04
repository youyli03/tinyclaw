/**
 * tinyclaw 入口
 *
 * 启动顺序：
 * 1. 验证配置
 * 2. 初始化 LLM / QMD 注册表（懒加载）
 * 3. 启动 QQBot connector
 * 4. 监听信号，优雅退出
 */

// ── 全局日志时间戳注入（daemon 进程，在所有 import 之前执行）────────────────
{
  const _log = console.log.bind(console);
  const _err = console.error.bind(console);
  const _warn = console.warn.bind(console);
  const ts = () => new Date().toISOString().replace("T", " ").slice(0, 19);
  console.log   = (...a) => _log(`[${ts()}]`, ...a);
  console.error = (...a) => _err(`[${ts()}]`, ...a);
  console.warn  = (...a) => _warn(`[${ts()}]`, ...a);
}

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig } from "./config/loader.js";
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
import { looksLikeMarkdown, mdToImage } from "./connectors/utils/md-to-image.js";
import { startIpcServer } from "./ipc/server.js";
import { cronScheduler } from "./cron/scheduler.js";
import { loopRunner } from "./core/loop-runner.js";
import { memoryMaintenance } from "./core/memory-maintenance.js";
import { mcpManager } from "./mcp/client.js";
import type { SlaveNotification, SlaveState } from "./core/slave-manager.js";
import { slaveManager } from "./core/slave-manager.js";
import { parseCommand, executeCommand } from "./commands/registry.js";
import "./commands/builtin.js";
import "./tools/db-write.js";
import { startDashboard, stopDashboard } from "./web/backend/server.js";
import { startCollector, stopCollector } from "./web/backend/collector.js";

// ── 模块级引用（供 Fatal 处理器广播通知）────────────────────────────────────

let _activeConnector: import("./connectors/qqbot/index.js").QQBotConnector | null = null;
let _activeSessions: Map<string, Session> | null = null;

// ── 跨 session 通信（session_send / session_get）——模块级引用，在 startApp() 中赋值 ──
let _sessionSendFn: import("./tools/registry.js").ToolContext["sessionSendFn"] | null = null;
let _sessionGetFn: import("./tools/registry.js").ToolContext["sessionGetFn"] | null = null;

// ── Session 注册表（key 为 sessionId，格式：qqbot:<type>:<peerId>）────────────

const sessions = new Map<string, Session>();

function getSession(sessionId: string): Session {
  let s = sessions.get(sessionId);
  if (!s) {
    // loop session 优先用 loop config 里的 agentId（比 bindings 更权威）
    const loopCfg = agentManager.readSessionLoop(sessionId);
    const agentId = loopCfg?.agentId ?? agentManager.resolveAgent(sessionId);
    s = new Session(sessionId, { agentId });
    sessions.set(sessionId, s);
  }
  return s;
}

// ── 主函数 ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
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

  // 3. 启动 QQBot（可选；若未配置则以纯 IPC 模式运行）
  let connector: QQBotConnector | null = null;

  if (cfg.channels.qqbot) {
    connector = new QQBotConnector();
    _activeConnector = connector;
  } else {
    console.log("[tinyclaw] QQBot not configured, running in IPC-only mode");
  }
  _activeSessions = sessions;

  // ── QQBot 消息处理 ──────────────────────────────────────────────────────

  async function handleMessage(msg: InboundMessage): Promise<string> {
    // connector 在此函数被注册前已检查非 null，此 guard 仅用于 TS 类型收窄
    if (!connector) return "";
    const sessionId = `qqbot:${msg.type}:${msg.peerId}`;
    const session = getSession(sessionId);

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
            const transcript = await transcribeAudio(d.localPath, voiceCfg.model, voiceCfg.language);
            if (transcript) {
              d.transcript = transcript;
              console.log(`[whisper] 转录完成: "${transcript}"`);
              resolvedContent = transcript; // 用转录文本替代原始消息内容
              void connector.send(msg.peerId, msg.type, `🎤 语音识别：${transcript}`).catch((e: unknown) => console.error("[qqbot] send error:", e));
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
    if (session.pendingPlanApproval) {
      const trimmed = resolvedContent.trim();
      const actions = session.pendingPlanApproval.actions;
      const n = parseInt(trimmed, 10);

      if (!isNaN(n) && n >= 1 && n <= actions.length) {
        // 数字选项：最后一项（exit_only 惯例）视为取消
        const selectedAction = actions[n - 1]!;
        const isLastAction = n === actions.length;
        session.pendingPlanApproval.resolve({
          approved: !isLastAction,
          selectedAction,
        });
      } else {
        // 自由文本 → feedback，AI 将修改计划后重新提交
        session.pendingPlanApproval.resolve({ approved: false, feedback: trimmed });
      }
      void connector.send(msg.peerId, msg.type, "已收到，处理中...", msg.messageId).catch((e: unknown) => console.error("[qqbot] send error:", e));
      return "";
    }

    // ── Interface A：检测 MFA 确认消息 ──────────────────────────────────
    if (session.pendingApproval) {
      const trimmed = resolvedContent.trim();
      if (trimmed === "确认") {
        session.pendingApproval.resolve(true);
        // "已收到，执行中..." 由 onMFARequest 的调用方在 resolve 后发送
        void connector.send(msg.peerId, msg.type, "已收到，执行中...", msg.messageId).catch((e: unknown) => console.error("[qqbot] send error:", e));
      } else {
        // 任何非"确认"的回复视为取消
        session.pendingApproval.resolve(false);
      }
      return "";
    }

    // ── ask_master 拦截：daily subagent 等待用户回复时转发给它 ─────────────
    if (session.pendingSlaveQuestion) {
      const { resolve } = session.pendingSlaveQuestion;
      session.pendingSlaveQuestion = null;
      resolve(resolvedContent.trim());
      void connector.send(msg.peerId, msg.type, "已收到，已转发给 AI 继续处理...", msg.messageId).catch((e: unknown) => console.error("[qqbot] send error:", e));
      return "";
    }

    // ── ask_user 拦截：AI 通过 ask_user 工具等待用户选择/输入时 ─────────
    if (session.pendingAskUser) {
      const trimmed = resolvedContent.trim();
      const { optionLabels, allowFreeform } = session.pendingAskUser;
      const n = parseInt(trimmed, 10);

      if (!isNaN(n) && n >= 1 && n <= optionLabels.length) {
        // 用户输入数字，映射到预设选项
        session.pendingAskUser.resolve({
          answer: optionLabels[n - 1]!,
          isFreeform: false,
        });
      } else if (allowFreeform) {
        // 自由输入
        session.pendingAskUser.resolve({ answer: trimmed, isFreeform: true });
      } else {
        // 不允许自由输入，提示用户重新选择
        const hint = optionLabels.map((l, i) => `${i + 1}. ${l}`).join("\n");
        void connector.send(msg.peerId, msg.type, `请输入选项编号（1～${optionLabels.length}）：\n${hint}`, msg.messageId).catch((e: unknown) => console.error("[qqbot] send error:", e));
        return "";
      }
      void connector.send(msg.peerId, msg.type, "已收到，处理中...", msg.messageId).catch((e: unknown) => console.error("[qqbot] send error:", e));
      return "";
    }

    // ── 斜杠命令拦截：以 "/" 开头的消息直接执行，不中断当前运行的 agent ─
    const parsedCmd = parseCommand(msg.content);
    if (parsedCmd) {
      const result = await executeCommand(parsedCmd.name, parsedCmd.args, { session });
      if (result) {
        await connector.send(msg.peerId, msg.type, result, msg.messageId).catch(() => {});
      }
      // /retry 命令设置了 pendingRetry：fall-through，继续构建 opts 并重新调用 runAgent
      if (!session.pendingRetry) {
        return "";
      }
    }

    // ── 软中断：若当前有 runAgent() 正在运行则中断它 ──────────────────
    if (session.running) {
      session.abortRequested = true;
      session.llmAbortController?.abort();
      session.abortPendingApproval();
      session.abortPendingPlanApproval();
      session.abortPendingAskUser();
      // 等待当前 run 自然结束（工具会跑完，但不会进入下一轮 LLM）
      await session.currentRunPromise?.catch(() => {});
    }

    // ── 构建 MFA callbacks ─────────────────────────────────────────────
    const mfaTimeoutSecs = loadConfig().auth.mfa?.timeoutSecs ?? 0;

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

      // 等待 Master 当前任务完成（避免并发写入 session）
      if (targetSession.running && targetSession.currentRunPromise) {
        await targetSession.currentRunPromise.catch(() => {});
      }

      // 构建注入内容
      const statusIcon = notif.status === "done" ? "✅" : notif.status === "error" ? "❌" : "⛔";
      const content =
        `<slave-results>\n` +
        `[slave:${notif.slaveId}] ${statusIcon} 后台任务已完成\n` +
        `任务：${notif.task}\n` +
        `状态：${notif.status}\n` +
        `结果：\n${notif.result || "（无输出）"}\n` +
        `</slave-results>`;

      // 重用当前连接的 MFA/Compress 回调（peerId/msgType 通过闭包捕获）
      const slaveOpts: AgentRunOptions = {
        onMFARequest: async (warningMsg: string, verifyCode?: (code: string) => boolean) => {
          return connector.buildMFARequest(
            msg.peerId, msg.type, warningMsg,
            mfaTimeoutSecs * 1000,
            verifyCode
          );
        },
        onMFAPrompt: (statusMsg: string) => {
          void connector.send(msg.peerId, msg.type, statusMsg).catch((e: unknown) => console.error("[qqbot] send error:", e));
        },
        // 后台注入不需要心跳：用户没有主动发起请求，不应收到「仍在处理中」消息
        onCompress: (phase, summary) => {
          if (phase === "start") {
            void connector.send(msg.peerId, msg.type, "🧠 对话较长，正在整理记忆...").catch((e: unknown) => console.error("[qqbot] send error:", e));
          } else if (phase === "done" && summary) {
            void connector.send(msg.peerId, msg.type, `✅ 记忆整理完成\n\n${summary}`).catch((e: unknown) => console.error("[qqbot] send error:", e));
          }
        },
        // 不传 onSlaveComplete，避免 Slave 触发递归 fork
        ...(_sessionSendFn ? { sessionSendFn: _sessionSendFn } : {}),
        ...(_sessionGetFn ? { sessionGetFn: _sessionGetFn } : {}),
      };

      // 将 slave 结果注入 Master session 并运行 agent → 通知用户
      targetSession.running = true;
      const slaveRunPromise = runAgent(targetSession, content, slaveOpts);
      targetSession.currentRunPromise = slaveRunPromise;
      try {
        const runResult = await slaveRunPromise;
        if (runResult.content) {
          await connector.send(msg.peerId, msg.type, runResult.content).catch(() => {});
        }
      } catch (err) {
        console.error(`[slave:${notif.slaveId}] master inject error:`, err);
      } finally {
        targetSession.running = false;
        targetSession.currentRunPromise = null;
      }
    };

    /**
     * Slave 定期进度推送回调：直接通过 connector 推送进度快照，不触发 runAgent。
     */
    const onProgressNotify = async (slaveId: string, state: SlaveState): Promise<void> => {
      const elapsed = Math.round(
        (Date.now() - new Date(state.startedAt).getTime()) / 1000
      );
      const toolsSummary =
        state.progress.toolsUsed.length > 0
          ? `\n已用工具：${state.progress.toolsUsed.join(", ")}`
          : "";
      const partialSummary = state.progress.partialOutput
        ? `\n最新输出：…${state.progress.partialOutput.slice(-200)}`
        : "";

      const progressMsg =
        `⏳ **[后台任务进度汇报]** Slave \`${slaveId}\`\n` +
        `任务：${state.task.slice(0, 80)}${state.task.length > 80 ? "…" : ""}\n` +
        `状态：${state.status}（已运行 ${elapsed}s）` +
        toolsSummary +
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
      if (session.mode !== "code" || session.codeSubMode !== "plan") return undefined;

      return async (
        summary: string,
        actions?: string[],
        recommendedAction?: string,
        planPath?: string,
      ): Promise<PlanApprovalResult> => {
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
            os.homedir(), ".tinyclaw", "agents", session.agentId, "workspace", "output", "md-renders"
          );
          fs.mkdirSync(outDir, { recursive: true });
          const imgPath = await mdToImage(menuMsg, outDir);
          await connector.send(msg.peerId, msg.type, `<img src="${imgPath}"/>`).catch(() => {});
          sent = true;
        } catch (renderErr) {
          console.warn("[plan] 计划摘要渲染图片失败，降级为文本:", renderErr);
        }
        if (!sent) {
          // fallback：发送纯文本版本（去掉 Markdown 特殊符号）
          const plainMsg =
            `📋 计划已就绪\n\n${summary}${planPath ? `\n📄 详细计划：${planPath}` : ""}\n\n` +
            `─────────────────\n请选择操作：\n${resolvedActions.map((action, i) => {
              const icons: Record<string, string> = { autopilot: "🚀", interactive: "💬", exit_only: "❌" };
              const isRecommended = action === resolvedRecommended;
              return `  ${i + 1}. ${icons[action] ?? "▶️"} ${action}${isRecommended ? " —— 推荐" : ""}`;
            }).join("\n")}\n\n` +
            `或直接输入反馈意见，AI 将修改计划后重新提交。`;
          await connector.send(msg.peerId, msg.type, plainMsg).catch(() => {});
        }

        return session.waitForPlanApproval(planTimeoutSecs, resolvedActions);
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
      allowFreeform = true,
    ): Promise<{ answer: string; isFreeform: boolean }> => {
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

      let sent = false;
      try {
        const outDir = path.join(
          os.homedir(), ".tinyclaw", "agents", session.agentId, "workspace", "output", "md-renders"
        );
        fs.mkdirSync(outDir, { recursive: true });
        const imgPath = await mdToImage(menuMsg, outDir);
        await connector.send(msg.peerId, msg.type, `<img src="${imgPath}"/>`).catch(() => {});
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

      return session.waitForAskUser(optionLabels, allowFreeform);
    };

    const opts: AgentRunOptions = {
      onSlaveComplete,
      onProgressNotify,
      onNotify: async (message: string) => {
        await connector.send(msg.peerId, msg.type, message).catch((err) => {
          console.error("[notify_user] send error:", err);
        });
      },
      ...(onPlanRequest !== undefined ? { onPlanRequest } : {}),
      onAskUser,
      onMFARequest: async (warningMsg: string, verifyCode?: (code: string) => boolean) => {
        return connector.buildMFARequest(
          msg.peerId, msg.type, warningMsg,
          mfaTimeoutSecs * 1000,
          verifyCode
        );
      },
      onMFAPrompt: (statusMsg: string) => {
        void connector.send(msg.peerId, msg.type, statusMsg).catch((e: unknown) => console.error("[qqbot] send error:", e));
      },
      onHeartbeat: (msg2: string) => {
        void connector.send(msg.peerId, msg.type, msg2).catch((e: unknown) => console.error("[qqbot] send error:", e));
      },
      onCompress: (phase, summary) => {
        if (phase === "start") {
          void connector.send(msg.peerId, msg.type, "🧠 对话较长，正在整理记忆...").catch((e: unknown) => console.error("[qqbot] send error:", e));
        } else if (phase === "done" && summary) {
          void connector.send(msg.peerId, msg.type, `✅ 记忆整理完成\n\n${summary}`).catch((e: unknown) => console.error("[qqbot] send error:", e));
        }
      },
      ...(_sessionSendFn ? { sessionSendFn: _sessionSendFn } : {}),
      ...(_sessionGetFn ? { sessionGetFn: _sessionGetFn } : {}),
    };

    // ── Fire-and-forget：启动新 run，结果通过 connector.send() 推送 ──
    session.running = true;

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
      const nowStr = new Date().toLocaleString();
      messageContent = `[${nowStr}] ${messageContent}`;
    }

    const finalOpts: AgentRunOptions = pendingRetry
      ? {
          ...opts,
          // 不设 skipAddUserMessage：原始用户消息已被 trimToLength 回滚，需要重新添加
          ...(pendingRetry.requestId ? { turnRequestIdOverride: pendingRetry.requestId } : {}),
        }
      : opts;

    const runPromise = runAgent(session, messageContent, finalOpts);
    session.currentRunPromise = runPromise;

    void runPromise
      .then(async (result) => {
        // 工具执行完但 LLM 最终返回空 content 时（非中断），发送兜底消息
        let toSend = result.content ||
          (result.toolsUsed.length > 0 && !session.abortRequested ? "✅ 已完成" : "");
        if (!toSend) return;

        // 发给用户前预检本地媒体文件，失败则回传给 agent 重跑，用户不感知
        const mediaErrors = validateMediaContent(toSend);
        if (mediaErrors.length > 0) {
          const feedback = mediaErrors.map(e => `${e.src}: ${e.error}`).join("\n");
          console.log(`[main] 媒体预检失败，重跑 agent:\n${feedback}`);
          const retryResult = await runAgent(
            session,
            `[系统] ${feedback}`,
            opts
          );
          if (retryResult.content) {
            toSend = retryResult.content;
          } else {
            // 重跑无输出（如原始回复含文档示例标签），回退到纯文本部分
            console.log("[main] 重跑无输出，回退到纯文本");
            toSend = extractTextContent(toSend);
            if (!toSend) return;
          }
        }

        // Code 模式：将含 Markdown 特征的纯文本回复渲染为图片
        if (session.mode === "code" && looksLikeMarkdown(toSend)) {
          try {
            const outDir = path.join(
              os.homedir(), ".tinyclaw", "agents", session.agentId, "workspace", "output", "md-renders"
            );
            fs.mkdirSync(outDir, { recursive: true });
            const imgPath = await mdToImage(toSend, outDir);
            console.log(`[main] Markdown 渲染为图片: ${imgPath}`);
            toSend = `<img src="${imgPath}"/>`;
          } catch (renderErr) {
            console.warn("[main] Markdown 渲染失败，降级为文本:", renderErr);
          }
        }

        try {
          await connector.send(msg.peerId, msg.type, toSend, msg.messageId);
        } catch (sendErr) {
          console.error("[qqbot] send error:", sendErr);
        }
      })
      .catch(async (err: unknown) => {
        console.error("[qqbot] runAgent error:", err);
        const userMsg = err instanceof Error && err.name === "LLMConnectionError"
          ? err.message
          : "抱歉，处理消息时出现错误";
        try {
          await connector.send(msg.peerId, msg.type, userMsg, msg.messageId);
        } catch {
          // 发送失败（如网络/证书错误），静默忽略，不能让进程崩溃
        }
      })
      .finally(() => {
        // 只在本 run 仍是当前 run 时才清状态，防止新 run 启动后被旧 .finally() 覆盖
        if (session.currentRunPromise === runPromise) {
          session.running = false;
          session.currentRunPromise = null;
        }
      });

    // 返回 "" — 实际回复通过 connector.send() 推送，connector 不会重复发送
    return "";
  }

  // ── 注册处理器并启动 ───────────────────────────────────────────────────

  if (connector) {
    connector.onMessage(handleMessage);
  }

  // 4. 启动 IPC server（供 CLI chat 命令通过 Unix socket 接入）
  const ipcServer = startIpcServer(sessions, connector);
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
  ): Promise<string> => {
    // 获取目标 session（不存在时 lazy 创建）
    const targetSession = getSession(targetSessionId);
    const targetAgentId = targetSession.agentId;

    // 双向权限检查
    const senderAccess = agentManager.readAccessConfig(fromAgentId);
    if (!senderAccess.can_access.includes("*") && !senderAccess.can_access.includes(targetAgentId)) {
      return `权限拒绝：agent "${fromAgentId}" 未配置对 agent "${targetAgentId}" 的访问权限（在 ${agentManager.accessConfigPath(fromAgentId)} 中添加 can_access = ["${targetAgentId}"] 或 can_access = ["*"]）`;
    }
    const receiverAccess = agentManager.readAccessConfig(targetAgentId);
    if (!receiverAccess.allow_from.includes(fromAgentId)) {
      return `权限拒绝：agent "${targetAgentId}" 未允许来自 agent "${fromAgentId}" 的消息（在 ${agentManager.accessConfigPath(targetAgentId)} 中添加 allow_from = ["${fromAgentId}"]）`;
    }

    // 等待目标 session 空闲
    if (targetSession.running && targetSession.currentRunPromise) {
      await targetSession.currentRunPromise.catch(() => {});
    }

    // 注入消息，走完整 runAgent 路径
    const nowStr = new Date().toLocaleString();
    await runAgent(targetSession, `[来自 ${fromAgentId} @ ${nowStr}] ${message}`, {
      sessionSendFn,
      sessionGetFn,
    });
    return `消息已成功注入 session "${targetSessionId}"`;
  };

  const sessionGetFn = async (
    fromAgentId: string,
  ): Promise<import("./tools/registry.js").SessionInfo[]> => {
    const senderAccess = agentManager.readAccessConfig(fromAgentId);
    const result: import("./tools/registry.js").SessionInfo[] = [];
    for (const [sid, session] of sessions) {
      const targetAgentId = session.agentId;
      if (!senderAccess.can_access.includes("*") && !senderAccess.can_access.includes(targetAgentId)) continue;
      const receiverAccess = agentManager.readAccessConfig(targetAgentId);
      if (!receiverAccess.allow_from.includes(fromAgentId)) continue;
      const loopCfg = agentManager.readSessionLoop(sid);
      result.push({
        sessionId: sid,
        agentId: targetAgentId,
        running: session.running,
        isLoop: loopCfg !== null,
      });
    }
    return result;
  };

  // 注册到模块级变量，供 handleMessage 中的 opts 引用
  _sessionSendFn = sessionSendFn;
  _sessionGetFn = sessionGetFn;

  const loopTick = async (sessionId: string, content: string, taskFilePath: string): Promise<void> => {
    const session = getSession(sessionId);
    // stateful=false：每轮开始前清空历史，避免 context 无限积累
    const loopCfg = agentManager.readSessionLoop(sessionId);
    if (loopCfg && !loopCfg.stateful) {
      session.clearMessages();
    }
    // 通过 addLoopTaskMessage 注入 loop task，携带 taskFilePath 用于 getMessagesForLLM 折叠
    session.addLoopTaskMessage(taskFilePath, content);
    await runAgent(session, content, {
      sessionSendFn,
      sessionGetFn,
      skipAddUserMessage: true,
    });
  };
  await loopRunner.start(loopTick);

  // 7. 启动内置每日记忆维护调度器
  memoryMaintenance.start();

  // 8. 启动 Web Dashboard（若配置启用）
  if (cfg.web.enabled) {
    startDashboard(cfg.web.port, cfg.web.token);
    startCollector();
  }

  // 7. 定期清理已完成的 Slave（每小时一次，防止 Map 无限增长）
  const gcInterval = setInterval(() => { slaveManager.gc(); }, 60 * 60 * 1000);

  // 8. 优雅退出
  const handleExit = async (signal: string) => {
    console.log(`\n[tinyclaw] Received ${signal}, shutting down...`);
    clearInterval(gcInterval);
    ipcServer.close();
    cronScheduler.stop();
    loopRunner.stop();
    memoryMaintenance.stop();
    stopCollector();
    stopDashboard();
    if (connector) await connector.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => void handleExit("SIGINT"));
  process.on("SIGTERM", () => void handleExit("SIGTERM"));

  if (connector) {
    console.log("[tinyclaw] Starting QQBot connector...");

    // 检查重启通知 marker（由 /restart 命令或 restart_tool 写入，用于重启后发送通知）
    const RESTART_NOTIFY_FILE = path.join(os.homedir(), ".tinyclaw", ".restart_notify.json");
    if (fs.existsSync(RESTART_NOTIFY_FILE)) {
      try {
        const marker = JSON.parse(fs.readFileSync(RESTART_NOTIFY_FILE, "utf-8")) as {
          peerId: string;
          msgType: InboundMessage["type"];
          /** restart_tool 写入的字段：code 模式 sessionId，重启后注入续接消息 */
          codeSessionId?: string;
        };
        fs.unlinkSync(RESTART_NOTIFY_FILE);
        connector.onReady = () => {
          // 1. 发 QQ 通知（原有逻辑）
          void connector!.send(marker.peerId, marker.msgType, "✅ 重启完成，服务已恢复").catch(() => {});

          // 2. 若是 restart_tool 触发的重启（含 codeSessionId），延迟 1s 后向 code session 注入续接消息
          if (marker.codeSessionId) {
            setTimeout(() => {
              const codeSession = sessions.get(marker.codeSessionId!);
              if (codeSession) {
                codeSession.running = true;
                const resumePromise = runAgent(codeSession, "[系统] 重启完成，请继续之前未完成的任务。");
                codeSession.currentRunPromise = resumePromise;
                resumePromise
                  .then((result) => {
                    if (result.content) {
                      void connector!.send(marker.peerId, marker.msgType, result.content).catch(() => {});
                    }
                  })
                  .catch((err: unknown) => {
                    console.error("[restart_tool] resume runAgent error:", err);
                  })
                  .finally(() => {
                    codeSession.running = false;
                    codeSession.currentRunPromise = null;
                  });
              } else {
                console.log(`[restart_tool] codeSession "${marker.codeSessionId}" not found after restart, skip resume`);
              }
            }, 1000);
          }
        };
      } catch {
        try { fs.unlinkSync(RESTART_NOTIFY_FILE); } catch { /* ignore */ }
      }
    }

    await connector.start(); // 阻塞直到 abort
  } else {
    // IPC-only 模式：无限等待信号
    console.log("[tinyclaw] Running in IPC-only mode (no QQBot). Send SIGTERM to stop.");
    await new Promise<void>(() => { /* 永不 resolve，依靠 SIGTERM/SIGINT 退出 */ });
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
