/**
 * tinyclaw 入口
 *
 * 启动顺序：
 * 1. 验证配置
 * 2. 初始化 LLM / QMD 注册表（懒加载）
 * 3. 启动 QQBot connector
 * 4. 监听信号，优雅退出
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig } from "./config/loader.js";
import { llmRegistry } from "./llm/registry.js";
import { Session } from "./core/session.js";
import { runAgent, type AgentRunOptions } from "./core/agent.js";
import { agentManager } from "./core/agent-manager.js";
import { QQBotConnector } from "./connectors/qqbot/index.js";
import type { InboundMessage } from "./connectors/base.js";
import { startIpcServer } from "./ipc/server.js";

const SERVICE_PID_FILE = path.join(os.homedir(), ".tinyclaw", ".service_pid");

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
  // 0. 写 PID 文件（供 CLI restart 使用）
  try {
    fs.mkdirSync(path.dirname(SERVICE_PID_FILE), { recursive: true });
    fs.writeFileSync(SERVICE_PID_FILE, String(process.pid), "utf-8");
  } catch {
    // 非致命，忽略
  }

  // 1. 验证配置（fail-fast）
  const cfg = loadConfig();
  console.log("[tinyclaw] Config loaded");

  // 2. 预初始化 LLM 后端（Copilot 后端需异步 token 换取 + 模型发现）
  await llmRegistry.init();
  console.log(`[tinyclaw] LLM backend ready (model=${llmRegistry.get("daily").model})`);

  // 初始化 Agent 工作区（确保 default agent 存在）
  agentManager.ensureDefault();
  console.log("[tinyclaw] Agent workspace ready");

  // 3. 启动 QQBot
  if (!cfg.channels.qqbot) {
    console.log("[tinyclaw] QQBot not configured, exiting");
    process.exit(0);
  }

  const connector = new QQBotConnector();

  // ── QQBot 消息处理 ──────────────────────────────────────────────────────

  async function handleMessage(msg: InboundMessage): Promise<string> {
    const sessionId = `qqbot:${msg.type}:${msg.peerId}`;
    const session = getSession(sessionId);

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

    // ── 软中断：若当前有 runAgent() 正在运行则中断它 ──────────────────
    if (session.running) {
      session.abortRequested = true;
      session.llmAbortController?.abort();
      session.abortPendingApproval();
      // 等待当前 run 自然结束（工具会跑完，但不会进入下一轮 LLM）
      await session.currentRunPromise?.catch(() => {});
    }

    // ── 构建 MFA callbacks ─────────────────────────────────────────────
    const mfaTimeoutSecs = loadConfig().auth.mfa?.timeoutSecs ?? 60;
    const opts: AgentRunOptions = {
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
    };

    // ── Fire-and-forget：启动新 run，结果通过 connector.send() 推送 ──
    session.running = true;
    const runPromise = runAgent(session, msg.content, opts);
    session.currentRunPromise = runPromise;

    void runPromise
      .then((result) => {
        if (result.content) {
          return connector.send(msg.peerId, msg.type, result.content, msg.messageId);
        }
      })
      .catch((err: unknown) => {
        console.error("[qqbot] runAgent error:", err);
        return connector
          .send(msg.peerId, msg.type, "抱歉，处理消息时出现错误")
          .catch(() => {});
      })
      .finally(() => {
        session.running = false;
        session.currentRunPromise = null;
      });

    // 返回 "" — 实际回复通过 connector.send() 推送，connector 不会重复发送
    return "";
  }

  // ── 注册处理器并启动 ───────────────────────────────────────────────────

  connector.onMessage(handleMessage);

  // 4. 启动 IPC server（供 CLI chat 命令通过 Unix socket 接入）
  const ipcServer = startIpcServer(sessions, connector);
  console.log("[tinyclaw] IPC server listening");

  // 5. 优雅退出
  const handleExit = async (signal: string) => {
    console.log(`\n[tinyclaw] Received ${signal}, shutting down...`);
    ipcServer.close();
    await connector.stop();
    try { fs.unlinkSync(SERVICE_PID_FILE); } catch { /* ignore */ }
    process.exit(0);
  };

  process.on("SIGINT", () => void handleExit("SIGINT"));
  process.on("SIGTERM", () => void handleExit("SIGTERM"));

  console.log("[tinyclaw] Starting QQBot connector...");
  await connector.start(); // 阻塞直到 abort
}

main().catch((err) => {
  console.error("[tinyclaw] Fatal:", err);
  process.exit(1);
});
