/**
 * IPC 客户端（供 CLI 使用）
 *
 * 连接 agent.sock，发送消息，接收流式响应。
 */

import { connect } from "net";
import { IPC_SOCKET_PATH, type IpcRequest, type IpcResponse } from "./protocol.js";

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
      const req: IpcRequest = { sessionId, message };
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
