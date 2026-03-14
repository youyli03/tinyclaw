/**
 * IPC 协议定义
 *
 * Unix socket 路径：~/.tinyclaw/agent.sock
 * 协议：换行分隔的 JSON（newline-delimited JSON）
 *
 * 请求（CLI → 服务）：
 *   { sessionId: string, message: string }
 *
 * 响应（服务 → CLI，流式）：
 *   { type: "chunk", delta: string }   — 流式 chunk
 *   { type: "done" }                   — 完成
 *   { type: "error", message: string } — 出错
 *
 * Session ID 约定：
 *   cli:<uuid>               终端会话
 *   qqbot:c2c:<openid>       QQ 私聊（服务端同步推送到 QQ）
 *   qqbot:group:<openid>     QQ 群聊（服务端同步推送到 QQ 群）
 *   qqbot:guild:<channelId>  QQ 频道
 */

import { join } from "path";
import { homedir } from "os";

export const IPC_SOCKET_PATH = join(homedir(), ".tinyclaw", "agent.sock");

export interface IpcRequest {
  sessionId: string;
  message: string;
}

export type IpcResponse =
  | { type: "chunk"; delta: string }
  | { type: "done" }
  | { type: "error"; message: string };
