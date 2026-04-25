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
import { IPC_SOCKET_PATH, type IpcRequest, type IpcResponse, type IpcClientMessage, type SessionInfo, type ActivityEvent } from "./protocol.js";
import { Session } from "../core/session.js";
import { slaveManager } from "../core/slave-manager.js";
import { cronScheduler } from "../cron/scheduler.js";
import { runAgent } from "../core/agent.js";
import { llmRegistry } from "../llm/registry.js";
import { acquireLLMSlot, releaseLLMSlot } from "../llm/concurrency.js";
import { agentManager } from "../core/agent-manager.js";
import { loopTriggerManager } from "../core/loop-trigger.js";
import type { QQBotConnector } from "../connectors/qqbot/index.js";
import type { InboundMessage } from "../connectors/base.js";
import { parseCommand, executeCommand } from "../commands/registry.js";
import "../commands/builtin.js";

/** sessionId → 所有订阅者的 send 函数 */
const subscriberMap = new Map<string, Set<(event: ActivityEvent) => void>>();

/** 广播 ActivityEvent 给所有订阅该 session 的客户端 */
function broadcastActivity(sessionId: string, event: ActivityEvent) {
  const subs = subscriberMap.get(sessionId);
  if (subs) {
    for (const fn of subs) {
      try { fn(event); } catch { /* ignore closed socket */ }
    }
  }
}

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
    /** 当前待处理的 MFA 确认请求（含可选 TOTP verifyCode） */
    let pendingMFA: {
      resolve: (v: boolean) => void;
      reject: (e: Error) => void;
      verifyCode?: (code: string) => boolean;
    } | null = null;

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
            const { approved } = msg as { type: "mfa_response"; approved: boolean };
            // TOTP 模式：用 verifyCode 校验用户回复的 6 位码（approved 字段此时携带原始文本）
            if (pendingMFA.verifyCode) {
              const raw = String((msg as unknown as Record<string, unknown>)["code"] ?? "").trim();
              const passed = /^\d{6}$/.test(raw) && pendingMFA.verifyCode(raw);
              pendingMFA.resolve(passed);
            } else {
              pendingMFA.resolve(approved);
            }
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
  setPendingMFA: (p: { resolve: (v: boolean) => void; reject: (e: Error) => void; verifyCode?: (code: string) => boolean } | null) => void
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

  if (req.type === "qqbot_send") {
    if (!connector) {
      send({ type: "error", message: "QQBot connector 未运行" });
      return;
    }
    const { peerId, msgType, text, replyToId } = req as {
      type: "qqbot_send";
      peerId: string;
      msgType: InboundMessage["type"];
      text: string;
      replyToId?: string;
    };
    try {
      await connector.send(peerId, msgType, text, replyToId);
      send({ type: "qqbot_sent" });
    } catch (err) {
      send({ type: "error", message: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  if (req.type === "qqbot_prompt") {
    if (!connector) {
      send({ type: "error", message: "QQBot connector 未运行" });
      return;
    }
    const { peerId, msgType, prompt, timeoutMs } = req as {
      type: "qqbot_prompt";
      peerId: string;
      msgType: InboundMessage["type"];
      prompt: string;
      timeoutMs: number;
    };
    try {
      const answer = await connector.requestUserInput(peerId, msgType, prompt, timeoutMs);
      send({ type: "qqbot_prompt_result", answer });
    } catch (err) {
      send({ type: "error", message: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  // ── loop_trigger 请求:立即触发指定 loop（通过 id） ──────────────
  if (req.type === "loop_trigger") {
    const { sessionId: loopSid } = req as { type: "loop_trigger"; sessionId: string };
    const found = loopTriggerManager.triggerNow(loopSid);
    send({ type: "loop_triggered", sessionId: loopSid, found });
    return;
  }

  // ── loop_pause 请求:暂停指定 loop ─────────────────────
  if (req.type === "loop_pause") {
    const { sessionId: loopSid } = req as { type: "loop_pause"; sessionId: string };
    const found = loopTriggerManager.pause(loopSid);
    send({ type: "loop_paused", sessionId: loopSid, found });
    return;
  }

  // ── loop_resume 请求:恢复指定 loop ────────────────────
  if (req.type === "loop_resume") {
    const { sessionId: loopSid } = req as { type: "loop_resume"; sessionId: string };
    const found = loopTriggerManager.resume(loopSid);
    send({ type: "loop_resumed", sessionId: loopSid, found });
    return;
  }

  // ── loop_status 请求:查询指定 loop 的实时状态 ────────────────────
  if (req.type === "loop_status") {
    const { sessionId: loopSid } = req as { type: "loop_status"; sessionId: string };
    const statusList = loopTriggerManager.listStatus();
    const item = statusList.find((s) => s.id === loopSid || s.bindTo === loopSid);
    const status = item?.status ?? "not_found";
    send({ type: "loop_status_result", sessionId: loopSid, status });
    return;
  }

  // ── loop_list_status 请求:列出所有 loop 的实时状态 ───────────────
  if (req.type === "loop_list_status") {
    const items = loopTriggerManager.listStatus().map(({ id, bindTo, status }) => ({
      sessionId: id,
      status,
      agentId: "default",
      tickSeconds: 0,
    }));
    send({ type: "loop_list_status_result", items });
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

      // 追加正在运行的 slave 子 agent（不在 sessions Map 中，需单独列出）
      for (const state of slaveManager.listAll()) {
        if (state.status === "running") {
          list.push({
            sessionId: `slave:${state.slaveId}`,
            messageCount: 0,
            running: true,
            lastUserMessage: state.task.slice(0, 80),
          });
        }
      }

      send({ type: "sessions", sessions: list });
    } catch (e) {
      send({ type: "error", message: String(e) });
    }
    return;
  }

  // ── abort_session 请求：中断指定 session 的 runAgent() 循环 ─────────────────
  if (req.type === "abort_session") {
    const { idOrSuffix } = req as { type: "abort_session"; idOrSuffix: string };
    // 先精确匹配，再按末尾 suffix 匹配（支持日志中的 12 位短 ID）
    let target = sessions.get(idOrSuffix);
    let matchedId = idOrSuffix;
    if (!target) {
      for (const [id, sess] of sessions) {
        if (id.endsWith(idOrSuffix)) {
          target = sess;
          matchedId = id;
          break;
        }
      }
    }
    if (target) {
      target.abortRequested = true;
      target.llmAbortController?.abort();
      target.abortPendingApproval();
      target.abortPendingPlanApproval();
      target.abortPendingAskUser();
      send({ type: "session_aborted", sessionId: matchedId, found: true });
      return;
    }

    // 尝试匹配 slave 子 agent（slave:<slaveId> 或末尾 suffix 匹配）
    const slaveId = idOrSuffix.startsWith("slave:") ? idOrSuffix.slice(6) : idOrSuffix;
    const slaveState = slaveManager.status(slaveId)
      ?? slaveManager.listAll().find((s) => `slave:${s.slaveId}`.endsWith(idOrSuffix));
    if (slaveState) {
      slaveManager.abort(slaveState.slaveId);
      send({ type: "session_aborted", sessionId: `slave:${slaveState.slaveId}`, found: true });
      return;
    }

    send({ type: "session_aborted", sessionId: idOrSuffix, found: false });
    return;
  }

  // ── llm_oneshot 请求:一次性 LLM 调用(无 session 历史，无工具权限)─────────────
  if (req.type === "llm_oneshot") {
    const { prompt, backend = "daily" } = req as { type: "llm_oneshot"; prompt: string; backend?: "daily" | "code" | "summarizer" };
    const client = llmRegistry.get(backend);
    let slotHeld = false;
    const oneshotId = Math.random().toString(36).slice(2, 7);
    const oneshotStart = Date.now();
    console.log(`[llm_oneshot] id=${oneshotId} backend=${backend} prompt_len=${prompt.length} 开始`);
    try {
      await acquireLLMSlot();
      slotHeld = true;
      const slotWait = Date.now() - oneshotStart;
      if (slotWait > 100) console.log(`[llm_oneshot] id=${oneshotId} 等待slot ${slotWait}ms`);
      await client.streamChat(
        [{ role: "user", content: prompt }],
        (delta) => { send({ type: "chunk", delta }); },
        { tools: [], isUserInitiated: true },
      );
      send({ type: "done" });
      console.log(`[llm_oneshot] id=${oneshotId} 完成 耗时=${Date.now() - oneshotStart}ms`);
    } catch (err) {
      console.log(`[llm_oneshot] id=${oneshotId} 失败 耗时=${Date.now() - oneshotStart}ms err=${err instanceof Error ? err.message : String(err)}`);
      send({ type: "error", message: err instanceof Error ? err.message : String(err) });
    } finally {
      if (slotHeld) releaseLLMSlot();
    }
    return;
  }

  // ── subscribe 请求:订阅 session 的实时活动事件 ──────────────────────────
  if (req.type === "subscribe") {
    const { idOrSuffix } = req as { type: "subscribe"; idOrSuffix: string };
    // 解析 sessionId(支持后缀匹配)
    let targetId: string | undefined;
    if (sessions.has(idOrSuffix)) {
      targetId = idOrSuffix;
    } else {
      for (const id of sessions.keys()) {
        if (id.endsWith(idOrSuffix)) { targetId = id; break; }
      }
    }
    if (!targetId) {
      send({ type: "error", message: `找不到 session "${idOrSuffix}"` });
      return;
    }
    const sid = targetId;
    // 注册订阅者
    const handler = (event: ActivityEvent) => {
      try {
        send({ type: "activity", sessionId: sid, event });
      } catch { /* socket already closed */ }
    };
    if (!subscriberMap.has(sid)) subscriberMap.set(sid, new Set());
    subscriberMap.get(sid)!.add(handler);
    send({ type: "subscribed", sessionId: sid });
    // socket 断开时自动取消订阅
    socket.once("close", () => {
      subscriberMap.get(sid)?.delete(handler);
    });
    // 不 return:保持 socket 长连接接收 activity 事件
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
    session.abortPendingPlanApproval();
    session.abortPendingAskUser();
    await session.currentRunPromise?.catch(() => {});
  }

  let fullContent = "";
  session.running = true;
  const runPromise = runAgent(session, message, {
    onChunk: (delta) => {
      fullContent += delta;
      send({ type: "chunk", delta });
      broadcastActivity(session!.sessionId, { kind: "chunk", delta });
    },
    onMFAPrompt: (prompt) => {
      send({ type: "chunk", delta: `\n[MFA] ${prompt}\n` });
    },
    onMFARequest: (warningMessage, verifyCode) =>
      new Promise<boolean>((resolve, reject) => {
        // 保存 verifyCode，TOTP 模式下 mfa_response 时用其验证 6 位码
        const mfaEntry: { resolve: (v: boolean) => void; reject: (e: Error) => void; verifyCode?: (code: string) => boolean } = { resolve, reject };
        if (verifyCode) mfaEntry.verifyCode = verifyCode;
        setPendingMFA(mfaEntry);
        send({ type: "mfa_request", warningMessage });
      }),
    onCompress: (phase, summary) => {
      if (phase === "start") {
        send({ type: "chunk", delta: "\n🧠 正在整理记忆...\n" });
      } else if (phase === "done" && summary) {
        send({ type: "chunk", delta: `✅ 记忆整理完成\n\n${summary}\n` });
      }
    },
    onToolCall: (name, args) => {
      broadcastActivity(session!.sessionId, { kind: "tool_call", name, argsSummary: JSON.stringify(args).slice(0, 200) });
    },
    onToolResult: (name, result) => {
      broadcastActivity(session!.sessionId, { kind: "tool_result", name, resultSummary: result.slice(0, 300) });
    },
  });
  session.currentRunPromise = runPromise;

  try {
    const result = await runPromise;
    if (!fullContent) {
      fullContent = result.content;
      send({ type: "chunk", delta: fullContent });
    }
    broadcastActivity(session.sessionId, { kind: "done" });
    send({ type: "done" });
  } catch (e) {
    broadcastActivity(session.sessionId, { kind: "error", message: String(e) });
    send({ type: "error", message: String(e) });
  } finally {
    // 只在本 run 仍是当前 run 时才清状态，防止新 run 启动后被旧 finally 覆盖
    if (session.currentRunPromise === runPromise) {
      session.running = false;
      session.currentRunPromise = null;
    }
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
