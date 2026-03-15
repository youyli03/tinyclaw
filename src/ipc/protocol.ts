/**
 * IPC 协议定义
 *
 * Unix socket 路径：~/.tinyclaw/agent.sock
 * 协议：换行分隔的 JSON（newline-delimited JSON）
 *
 * 请求（CLI → 服务）：
 *   { type: "chat", sessionId: string, message: string }  — 发送消息
 *   { type: "list" }                                       — 列出所有会话
 *
 * 响应（服务 → CLI，流式）：
 *   { type: "chunk", delta: string }          — 流式 chunk
 *   { type: "done" }                          — 完成
 *   { type: "error", message: string }        — 出错
 *   { type: "sessions", sessions: SessionInfo[] } — 会话列表
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

export interface SessionInfo {
  sessionId: string;
  /** user + assistant 消息数（不含 system） */
  messageCount: number;
  /** 是否有 runAgent() 正在执行 */
  running: boolean;
  /** 最后一条用户消息（截断至 80 字符），无则为空串 */
  lastUserMessage: string;
}

export type IpcRequest =
  | { type: "chat"; sessionId: string; message: string }
  | { type: "list" }
  | { type: "new"; agentId?: string };

export type IpcResponse =
  | { type: "chunk"; delta: string }
  | { type: "done" }
  | { type: "error"; message: string }
  | { type: "sessions"; sessions: SessionInfo[] }
  | { type: "created"; sessionId: string };
