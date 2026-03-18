/**
 * IPC 服务端
 *
 * 监听 Unix socket，接收来自 CLI 的消息，通过 agent 处理后：
 * 1. 流式推送 chunk 回 socket 客户端（CLI 终端打印）
 * 2. 若 sessionId 以 "qqbot:" 开头，同时通过 QQBotConnector 发送到 QQ
 */

import { createServer, type Server } from "net";
import { unlinkSync, existsSync } from "fs";
import { randomUUID } from "node:crypto";
import { IPC_SOCKET_PATH, type IpcRequest, type IpcResponse, type IpcClientMessage, type SessionInfo } from "./protocol.js";
import { Session } from "../core/session.js";
import { cronScheduler } from "../cron/scheduler.js";
import { runAgent } from "../core/agent.js";
import { agentManager } from "../core/agent-manager.js";
import { loadConfig } from "../config/loader.js";
import type { QQBotConnector } from "../connectors/qqbot/index.js";
import type { InboundMessage } from "../connectors/base.js";
import { parseCommand, executeCommand } from "../commands/registry.js";
import "../commands/builtin.js";

export function startIpcServer(
  sessions: Map<string, Session>,
  connector: QQBotConnector | null
): Server {
  // 清理上次遗留的 socket 文件
  if (existsSync(IPC_SOCKET_PATH)) {
    try { unlinkSync(IPC_SOCKET_PATH); } catch { /* ignore */ }
  }

  const server = createServer((socket) => {
    let buf = "";
    /** 当前待处理的 MFA 确认请求 */
    let pendingMFA: { resolve: (v: boolean) => void; reject: (e: Error) => void } | null = null;

    socket.on("data", (data) => {
      buf += data.toString("utf-8");
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        // 先尝试解析为 IpcClientMessage（包含 mfa_response）
        let msg: IpcClientMessage;
        try { msg = JSON.parse(line) as IpcClientMessage; } catch { continue; }

        if (msg.type === "mfa_response") {
          if (pendingMFA) {
            pendingMFA.resolve((msg as { type: "mfa_response"; approved: boolean }).approved);
            pendingMFA = null;
          }
          continue;
        }
        void handleRequest(line, socket, sessions, connector, (pMFA) => { pendingMFA = pMFA; });
      }
    });

    socket.on("error", (err) => {
      console.error("[ipc] socket error:", err.message);
    });
  });

  server.listen(IPC_SOCKET_PATH, () => {
    console.log(`[ipc] Listening on ${IPC_SOCKET_PATH}`);
  });

  server.on("error", (err) => {
    console.error("[ipc] server error:", err);
  });

  return server;
}

async function handleRequest(
  line: string,
  socket: import("net").Socket,
  sessions: Map<string, Session>,
  connector: QQBotConnector | null,
  setPendingMFA: (p: { resolve: (v: boolean) => void; reject: (e: Error) => void } | null) => void
): Promise<void> {
  const send = (resp: IpcResponse): void => {
    if (!socket.destroyed) socket.write(JSON.stringify(resp) + "\n");
  };

  let req: IpcRequest;
  try {
    req = JSON.parse(line) as IpcRequest;
  } catch {
    send({ type: "error", message: "invalid JSON request" });
    return;
  }

  // ── cron_trigger 请求：委托守护进程触发 cron job ──────────────────────────
  if (req.type === "cron_trigger") {
    const { jobId } = req as { type: "cron_trigger"; jobId: string };
    const ok = cronScheduler.triggerJob(jobId);
    if (ok) {
      send({ type: "cron_triggered", jobId });
    } else {
      send({ type: "error", message: `未找到 job "${jobId}"` });
    }
    return;
  }

  // ── memorize 请求：手动触发 session 摘要 → 持久化 → QMD 向量化 ───────────
  if (req.type === "memorize") {
    const { sessionId: memSid } = req as { type: "memorize"; sessionId: string };
    // 若 session 不在内存中（如服务刚重启还未收到消息），从 JSONL 恢复
    let memSession = sessions.get(memSid);
    if (!memSession) {
      const agentId = agentManager.resolveAgent(memSid);
      memSession = new Session(memSid, { agentId });
      if (memSession.getMessages().length === 0) {
        send({ type: "error", message: `找不到 session "${memSid}" 的历史记录` });
        return;
      }
      sessions.set(memSid, memSession);
    }
    // 通知 qqbot session 的用户：开始
    if (connector && memSid.startsWith("qqbot:")) {
      const parts = memSid.slice("qqbot:".length).split(":");
      const msgType = parts[0] as import("../connectors/base.js").InboundMessage["type"];
      const peerId = parts.slice(1).join(":");
      void connector.send(peerId, msgType, "⏳ 正在整理记忆，请稍候...");
    }
    try {
      const summary = await memSession.compress();
      // 通知 qqbot session 的用户：完成
      if (connector && memSid.startsWith("qqbot:")) {
        const parts = memSid.slice("qqbot:".length).split(":");
        const msgType = parts[0] as import("../connectors/base.js").InboundMessage["type"];
        const peerId = parts.slice(1).join(":");
        void connector.send(peerId, msgType, `✅ 记忆已整理完成\n\n${summary}`);
      }
      send({ type: "memorized", summary });
    } catch (e) {
      send({ type: "error", message: `记忆整理失败：${e instanceof Error ? e.message : String(e)}` });
    }
    return;
  }

  // ── new 请求：创建新会话 ─────────────────────────────────────────────────
  if (req.type === "new") {
    const newReq = req as { type: "new"; agentId?: string };
    const agentId = newReq.agentId ?? "default";
    const sessionId = `cli:${randomUUID()}`;
    const session = new Session(sessionId, { agentId });
    sessions.set(sessionId, session);
    send({ type: "created", sessionId });
    return;
  }

  // ── list 请求：返回所有会话信息 ─────────────────────────────────────────────
  if (req.type === "list") {
    try {
      const list: SessionInfo[] = [...sessions.entries()].map(([id, sess]) => {
        const msgs = sess.getMessages();
        const userMsgs = msgs.filter((m) => m.role === "user");
        const lastContent = userMsgs.at(-1)?.content;
        const lastUserMessage =
          typeof lastContent === "string" ? lastContent.slice(0, 80) : "";
        return {
          sessionId: id,
          messageCount: msgs.filter((m) => m.role !== "system").length,
          running: sess.running,
          lastUserMessage,
        };
      });
      send({ type: "sessions", sessions: list });
    } catch (e) {
      send({ type: "error", message: String(e) });
    }
    return;
  }

  const { sessionId, message } = req as { type: "chat"; sessionId: string; message: string };

  // 防御：sessionId 或 message 缺失时拒绝处理（可能来自不兼容的旧客户端）
  if (!sessionId || typeof message !== "string") {
    send({ type: "error", message: "missing sessionId or message" });
    return;
  }

  // 获取或创建 session（解析 agentId 绑定）
  let session = sessions.get(sessionId);
  if (!session) {
    const agentId = agentManager.resolveAgent(sessionId);
    session = new Session(sessionId, { agentId });
    sessions.set(sessionId, session);
  }

  // ── 斜杠命令拦截：以 "/" 开头的消息直接执行，不中断当前运行的 agent ─
  const parsedCmd = parseCommand(message);
  if (parsedCmd) {
    const result = await executeCommand(parsedCmd.name, parsedCmd.args, { session });
    send({ type: "chunk", delta: result });
    send({ type: "done" });
    return;
  }

  // 并发控制：若当前有 runAgent() 正在运行，软中断并等待完成
  if (session.running) {
    session.abortRequested = true;
    session.llmAbortController?.abort();
    session.abortPendingApproval();
    await session.currentRunPromise?.catch(() => {});
  }

  let fullContent = "";
  session.running = true;
  const mfaTimeoutMs = (loadConfig().auth.mfa?.timeoutSecs ?? 60) * 1000;
  const runPromise = runAgent(session, message, {
    onChunk: (delta) => {
      fullContent += delta;
      send({ type: "chunk", delta });
    },
    onMFAPrompt: (prompt) => {
      send({ type: "chunk", delta: `\n[MFA] ${prompt}\n` });
    },
    onMFARequest: (warningMessage, verifyCode) =>
      new Promise<boolean>((resolve, reject) => {
        setPendingMFA({ resolve, reject });
        send({ type: "mfa_request", warningMessage });
        setTimeout(() => {
          setPendingMFA(null);
          reject(new Error("MFA 超时"));
          send({ type: "chunk", delta: "\n[MFA] 超时，操作已取消\n" });
        }, mfaTimeoutMs);
        void verifyCode; // verifyCode 由 agent 层在 onMFARequest 中需要的地方调用，这里不需要
      }),
    onCompress: (phase, summary) => {
      if (phase === "start") {
        send({ type: "chunk", delta: "\n🧠 正在整理记忆...\n" });
      } else if (phase === "done" && summary) {
        send({ type: "chunk", delta: `✅ 记忆整理完成\n\n${summary}\n` });
      }
    },
  });
  session.currentRunPromise = runPromise;

  try {
    const result = await runPromise;
    if (!fullContent) {
      fullContent = result.content;
      send({ type: "chunk", delta: fullContent });
    }
    send({ type: "done" });
  } catch (e) {
    send({ type: "error", message: String(e) });
  } finally {
    session.running = false;
    session.currentRunPromise = null;
  }

  // ── 路由到 QQBot（如果 sessionId 编码了 QQ 频道信息）────────────────────────
  if (connector && sessionId.startsWith("qqbot:")) {
    // 格式：qqbot:<type>:<peerId>
    // type 可为 c2c | group | guild | dm
    const withoutPrefix = sessionId.slice("qqbot:".length);
    const colonIdx = withoutPrefix.indexOf(":");
    if (colonIdx !== -1) {
      const msgType = withoutPrefix.slice(0, colonIdx) as InboundMessage["type"];
      const peerId = withoutPrefix.slice(colonIdx + 1);
      try {
        await connector.send(peerId, msgType, fullContent);
      } catch (e) {
        console.error("[ipc] QQBot route failed:", e);
      }
    }
  }
}
