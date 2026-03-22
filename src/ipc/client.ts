/**
 * IPC 客户端（供 CLI 使用）
 *
 * 连接 agent.sock，发送消息，接收流式响应。
 */

import { connect } from "net";
import { createInterface } from "node:readline";
import { IPC_SOCKET_PATH, type IpcRequest, type IpcResponse, type IpcClientMessage, type SessionInfo } from "./protocol.js";

export interface SendOptions {
  sessionId: string;
  message: string;
  /** 接收到流式 chunk 时的回调 */
  onChunk?: (delta: string) => void;
}

/**
 * 向正在运行的 tinyclaw 服务发送消息。
 * @returns 完整的回复文本
 * @throws 若服务未运行或发生错误
 */
export async function sendToAgent(opts: SendOptions): Promise<string> {
  const { sessionId, message, onChunk } = opts;

  return new Promise<string>((resolve, reject) => {
    const socket = connect(IPC_SOCKET_PATH);
    let buf = "";
    let fullContent = "";
    let settled = false;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      fn();
    };

    socket.on("connect", () => {
      const req: IpcRequest = { type: "chat", sessionId, message };
      socket.write(JSON.stringify(req) + "\n");
    });

    socket.on("data", (data) => {
      buf += data.toString("utf-8");
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        let resp: IpcResponse;
        try { resp = JSON.parse(line) as IpcResponse; } catch { continue; }

        if (resp.type === "chunk") {
          fullContent += resp.delta;
          onChunk?.(resp.delta);
        } else if (resp.type === "mfa_request") {
          // 终端提示用户确认/取消（或输入 TOTP 码）
          const rl = createInterface({ input: process.stdin, output: process.stdout });
          const warningMsg = (resp as { type: "mfa_request"; warningMessage: string }).warningMessage;
          process.stdout.write(`\n${warningMsg}\n> `);
          rl.once("line", (answer) => {
            rl.close();
            const trimmed = answer.trim();
            // 若输入为 6 位数字，视为 TOTP 码：发送 code 字段供服务端 verifyCode 校验
            const isTotp = /^\d{6}$/.test(trimmed);
            const reply: IpcClientMessage = isTotp
              ? { type: "mfa_response", approved: true, code: trimmed }
              : { type: "mfa_response", approved: !/^(取消|n|no)$/i.test(trimmed) };
            socket.write(JSON.stringify(reply) + "\n");
          });
        } else if (resp.type === "done") {
          settle(() => resolve(fullContent));
        } else if (resp.type === "error") {
          settle(() => reject(new Error(resp.message)));
        }
      }
    });

    socket.on("error", (err) => {
      settle(() => reject(err));
    });

    socket.on("close", () => {
      // 连接提前关闭但已有内容时也视为正常结束
      settle(() => {
        if (fullContent) resolve(fullContent);
        else reject(new Error("Connection closed unexpectedly"));
      });
    });
  });
}

/**
 * 向正在运行的 tinyclaw 服务请求创建新会话。
 * @returns 新会话的 sessionId
 */
export async function createSession(agentId?: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = connect(IPC_SOCKET_PATH);
    let buf = "";
    let settled = false;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      fn();
    };

    socket.on("connect", () => {
      const req: IpcRequest = agentId ? { type: "new", agentId } : { type: "new" };
      socket.write(JSON.stringify(req) + "\n");
    });

    socket.on("data", (data) => {
      buf += data.toString("utf-8");
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        let resp: IpcResponse;
        try { resp = JSON.parse(line) as IpcResponse; } catch { continue; }

        if (resp.type === "created") {
          settle(() => resolve(resp.sessionId));
        } else if (resp.type === "error") {
          settle(() => reject(new Error(resp.message)));
        }
      }
    });

    socket.on("error", (err) => settle(() => reject(err)));
    socket.on("close", () => settle(() => reject(new Error("Connection closed unexpectedly"))));
  });
}

/**
 * 向正在运行的 tinyclaw 服务请求所有会话列表。
 * @returns SessionInfo 数组
 */
export async function listSessions(): Promise<SessionInfo[]> {
  return new Promise<SessionInfo[]>((resolve, reject) => {
    const socket = connect(IPC_SOCKET_PATH);
    let buf = "";
    let settled = false;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      fn();
    };

    socket.on("connect", () => {
      const req: IpcRequest = { type: "list" };
      socket.write(JSON.stringify(req) + "\n");
    });

    socket.on("data", (data) => {
      buf += data.toString("utf-8");
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        let resp: IpcResponse;
        try { resp = JSON.parse(line) as IpcResponse; } catch { continue; }

        if (resp.type === "sessions") {
          settle(() => resolve(resp.sessions));
        } else if (resp.type === "error") {
          settle(() => reject(new Error(resp.message)));
        }
      }
    });

    socket.on("error", (err) => settle(() => reject(err)));
    socket.on("close", () => settle(() => reject(new Error("Connection closed unexpectedly"))));
  });
}

/**
 * 向正在运行的 tinyclaw 服务请求对指定 session 执行摘要 → 持久化 → QMD 向量化。
 * @returns 生成的摘要文本
 */
export async function memorizeSession(sessionId: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const socket = connect(IPC_SOCKET_PATH);
    let buf = "";
    let settled = false;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      fn();
    };

    socket.on("connect", () => {
      const req: IpcRequest = { type: "memorize", sessionId };
      socket.write(JSON.stringify(req) + "\n");
    });

    socket.on("data", (data) => {
      buf += data.toString("utf-8");
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        let resp: IpcResponse;
        try { resp = JSON.parse(line) as IpcResponse; } catch { continue; }

        if (resp.type === "memorized") {
          settle(() => resolve(resp.summary));
        } else if (resp.type === "error") {
          settle(() => reject(new Error(resp.message)));
        }
      }
    });

    socket.on("error", (err) => settle(() => reject(err)));
    socket.on("close", () => settle(() => reject(new Error("Connection closed unexpectedly"))));
  });
}

/**
 * 中断正在运行的指定 session 的 runAgent() 循环。
 * @param idOrSuffix 完整 sessionId 或其末尾子串（日志中显示的 12 位短 ID 也可）
 * @returns { found: boolean, sessionId: string }
 */
export async function abortSession(idOrSuffix: string): Promise<{ found: boolean; sessionId: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(IPC_SOCKET_PATH);
    let buf = "";
    let settled = false;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      fn();
    };

    socket.on("connect", () => {
      const req: IpcRequest = { type: "abort_session", idOrSuffix };
      socket.write(JSON.stringify(req) + "\n");
    });

    socket.on("data", (data) => {
      buf += data.toString("utf-8");
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";

      for (const line of lines) {
        if (!line.trim()) continue;
        let resp: IpcResponse;
        try { resp = JSON.parse(line) as IpcResponse; } catch { continue; }

        if (resp.type === "session_aborted") {
          settle(() => resolve({ found: resp.found, sessionId: resp.sessionId }));
        } else if (resp.type === "error") {
          settle(() => reject(new Error(resp.message)));
        }
      }
    });

    socket.on("error", (err) => settle(() => reject(err)));
    socket.on("close", () => settle(() => reject(new Error("Connection closed unexpectedly"))));
  });
}
