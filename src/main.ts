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
import { Session, type PlanApprovalResult } from "./core/session.js";
import { runAgent, type AgentRunOptions } from "./core/agent.js";
import { agentManager } from "./core/agent-manager.js";
import { QQBotConnector } from "./connectors/qqbot/index.js";
import type { InboundMessage } from "./connectors/base.js";
import { downloadAttachments, buildEnrichedContent } from "./connectors/qqbot/attachments.js";
import { validateMediaContent, extractTextContent } from "./connectors/qqbot/outbound.js";
import { looksLikeMarkdown, mdToImage } from "./connectors/utils/md-to-image.js";
import { startIpcServer } from "./ipc/server.js";
import { cronScheduler } from "./cron/scheduler.js";
import { mcpManager } from "./mcp/client.js";
import type { SlaveNotification, SlaveState } from "./core/slave-manager.js";
import { parseCommand, executeCommand } from "./commands/registry.js";
import "./commands/builtin.js";

// ── 模块级引用（供 Fatal 处理器广播通知）────────────────────────────────────

let _activeConnector: import("./connectors/qqbot/index.js").QQBotConnector | null = null;
let _activeSessions: Map<string, Session> | null = null;

// ── Session 注册表（key 为 sessionId，格式：qqbot:<type>:<peerId>）────────────

const sessions = new Map<string, Session>();

function getSession(sessionId: string): Session {
  let s = sessions.get(sessionId);
  if (!s) {
    const agentId = agentManager.resolveAgent(sessionId);
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

  // 3. 初始化 MCP servers（读取 ~/.tinyclaw/mcp.toml，注册工具到 registry）
  await mcpManager.init();

  // 初始化 Agent 工作区（确保 default agent 存在）
  agentManager.ensureDefault();
  console.log("[tinyclaw] Agent workspace ready");

  // 3. 启动 QQBot
  if (!cfg.channels.qqbot) {
    console.log("[tinyclaw] QQBot not configured, exiting");
    process.exit(0);
  }

  const connector = new QQBotConnector();
  _activeConnector = connector;
  _activeSessions  = sessions;

  // ── QQBot 消息处理 ──────────────────────────────────────────────────────

  async function handleMessage(msg: InboundMessage): Promise<string> {
    const sessionId = `qqbot:${msg.type}:${msg.peerId}`;
    const session = getSession(sessionId);

    // ── Plan 审批：检测 plan 子模式下等待用户选择操作的消息 ─────────────
    if (session.pendingPlanApproval) {
      const trimmed = msg.content.trim();
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
      void connector.send(msg.peerId, msg.type, "已收到，处理中...", msg.messageId);
      return "";
    }

    // ── Interface A：检测 MFA 确认消息 ──────────────────────────────────
    if (session.pendingApproval) {
      const trimmed = msg.content.trim();
      if (trimmed === "确认") {
        session.pendingApproval.resolve(true);
        // "已收到，执行中..." 由 onMFARequest 的调用方在 resolve 后发送
        void connector.send(msg.peerId, msg.type, "已收到，执行中...", msg.messageId);
      } else {
        // 任何非"确认"的回复视为取消
        session.pendingApproval.resolve(false);
      }
      return "";
    }

    // ── 斜杠命令拦截：以 "/" 开头的消息直接执行，不中断当前运行的 agent ─
    const parsedCmd = parseCommand(msg.content);
    if (parsedCmd) {
      const result = await executeCommand(parsedCmd.name, parsedCmd.args, { session });
      await connector.send(msg.peerId, msg.type, result, msg.messageId).catch(() => {});
      return "";
    }

    // ── 软中断：若当前有 runAgent() 正在运行则中断它 ──────────────────
    if (session.running) {
      session.abortRequested = true;
      session.llmAbortController?.abort();
      session.abortPendingApproval();
      session.abortPendingPlanApproval();
      // 等待当前 run 自然结束（工具会跑完，但不会进入下一轮 LLM）
      await session.currentRunPromise?.catch(() => {});
    }

    // ── 构建 MFA callbacks ─────────────────────────────────────────────
    const mfaTimeoutSecs = loadConfig().auth.mfa?.timeoutSecs ?? 60;

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
          void connector.send(msg.peerId, msg.type, statusMsg);
        },
        // 后台注入不需要心跳：用户没有主动发起请求，不应收到「仍在处理中」消息
        onCompress: (phase, summary) => {
          if (phase === "start") {
            void connector.send(msg.peerId, msg.type, "🧠 对话较长，正在整理记忆...");
          } else if (phase === "done" && summary) {
            void connector.send(msg.peerId, msg.type, `✅ 记忆整理完成\n\n${summary}`);
          }
        },
        // 不传 onSlaveComplete，避免 Slave 触发递归 fork
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

    const opts: AgentRunOptions = {
      onSlaveComplete,
      onProgressNotify,
      onNotify: async (message: string) => {
        await connector.send(msg.peerId, msg.type, message).catch((err) => {
          console.error("[notify_user] send error:", err);
        });
      },
      ...(onPlanRequest !== undefined ? { onPlanRequest } : {}),
      onMFARequest: async (warningMsg: string, verifyCode?: (code: string) => boolean) => {
        return connector.buildMFARequest(
          msg.peerId, msg.type, warningMsg,
          mfaTimeoutSecs * 1000,
          verifyCode
        );
      },
      onMFAPrompt: (statusMsg: string) => {
        void connector.send(msg.peerId, msg.type, statusMsg);
      },
      onHeartbeat: (msg2: string) => {
        void connector.send(msg.peerId, msg.type, msg2);
      },
      onCompress: (phase, summary) => {
        if (phase === "start") {
          void connector.send(msg.peerId, msg.type, "🧠 对话较长，正在整理记忆...");
        } else if (phase === "done" && summary) {
          void connector.send(msg.peerId, msg.type, `✅ 记忆整理完成\n\n${summary}`);
        }
      },
    };

    // ── Fire-and-forget：启动新 run，结果通过 connector.send() 推送 ──
    session.running = true;
    // 如果消息带有附件，先下载到 workspace/downloads/ 并将路径追加到消息内容
    let messageContent = msg.content;
    if (msg.attachments && msg.attachments.length > 0) {
      try {
        const downloaded = await downloadAttachments(
          msg.attachments,
          agentManager.downloadsDir(session.agentId)
        );
        messageContent = buildEnrichedContent(msg.content, downloaded);
      } catch (err) {
        console.warn("[qqbot] 附件下载失败:", err);
      }
    }

    // 在用户发出的消息前加上当前时间，方便 Agent 识别当前日期
    const nowStr = new Date().toLocaleString();
    messageContent = `[${nowStr}] ${messageContent}`;

    const runPromise = runAgent(session, messageContent, opts);
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
          await connector.send(msg.peerId, msg.type, userMsg);
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

  connector.onMessage(handleMessage);

  // 4. 启动 IPC server（供 CLI chat 命令通过 Unix socket 接入）
  const ipcServer = startIpcServer(sessions, connector);
  console.log("[tinyclaw] IPC server listening");

  // 5. 启动 Cron 调度器
  await cronScheduler.start(connector);

  // 6. 优雅退出
  const handleExit = async (signal: string) => {
    console.log(`\n[tinyclaw] Received ${signal}, shutting down...`);
    ipcServer.close();
    cronScheduler.stop();
    await connector.stop();
    process.exit(0);
  };

  process.on("SIGINT", () => void handleExit("SIGINT"));
  process.on("SIGTERM", () => void handleExit("SIGTERM"));

  console.log("[tinyclaw] Starting QQBot connector...");

  // 检查重启通知 marker（由 /restart 命令写入，用于重启后发送通知）
  const RESTART_NOTIFY_FILE = path.join(os.homedir(), ".tinyclaw", ".restart_notify.json");
  if (fs.existsSync(RESTART_NOTIFY_FILE)) {
    try {
      const marker = JSON.parse(fs.readFileSync(RESTART_NOTIFY_FILE, "utf-8")) as {
        peerId: string;
        msgType: InboundMessage["type"];
      };
      fs.unlinkSync(RESTART_NOTIFY_FILE);
      connector.onReady = () => {
        void connector.send(marker.peerId, marker.msgType, "✅ 重启完成，服务已恢复").catch(() => {});
      };
    } catch {
      try { fs.unlinkSync(RESTART_NOTIFY_FILE); } catch { /* ignore */ }
    }
  }

  await connector.start(); // 阻塞直到 abort
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
