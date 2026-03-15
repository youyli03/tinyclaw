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
import { IPC_SOCKET_PATH, type IpcRequest, type IpcResponse, type SessionInfo } from "./protocol.js";
import { Session } from "../core/session.js";
import { runAgent } from "../core/agent.js";
import { agentManager } from "../core/agent-manager.js";
import type { QQBotConnector } from "../connectors/qqbot/index.js";
import type { InboundMessage } from "../connectors/base.js";

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

    socket.on("data", (data) => {
      buf += data.toString("utf-8");
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        void handleRequest(line, socket, sessions, connector);
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
  connector: QQBotConnector | null
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

  // 并发控制：若当前有 runAgent() 正在运行，软中断并等待完成
  if (session.running) {
    session.abortRequested = true;
    session.llmAbortController?.abort();
    session.abortPendingApproval();
    await session.currentRunPromise?.catch(() => {});
  }

  let fullContent = "";
  session.running = true;
  const runPromise = runAgent(session, message, {
    onChunk: (delta) => {
      fullContent += delta;
      send({ type: "chunk", delta });
    },
    onMFAPrompt: (prompt) => {
      send({ type: "chunk", delta: `\n[MFA] ${prompt}\n` });
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
