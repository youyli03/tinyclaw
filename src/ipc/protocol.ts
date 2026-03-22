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
  | { type: "new"; agentId?: string }
  | { type: "cron_trigger"; jobId: string }
  | { type: "memorize"; sessionId: string }
  /**
   * 软中断指定 session 的 runAgent() 循环。
   * idOrSuffix 可为完整 sessionId，或 sessionId 的末尾子串（如日志中显示的 12 位后缀）。
   * 返回 aborted（已中断）或 not_found。
   */
  | { type: "abort_session"; idOrSuffix: string };

export type IpcResponse =
  | { type: "chunk"; delta: string }
  | { type: "done" }
  | { type: "error"; message: string }
  | { type: "sessions"; sessions: SessionInfo[] }
  | { type: "created"; sessionId: string }
  /** MFA 确认请求：服务端向客户端发送，等待用户回复 */
  | { type: "mfa_request"; warningMessage: string }
  | { type: "cron_triggered"; jobId: string }
  /** 手动记忆压缩完成，包含生成的摘要文本 */
  | { type: "memorized"; summary: string }
  /** abort_session 请求的响应 */
  | { type: "session_aborted"; sessionId: string; found: boolean };

export type IpcClientMessage =
  | IpcRequest
  /** MFA 确认响应：客户端向服务端回复。
   *  - simple/msal 模式：approved=true/false
   *  - TOTP 模式：approved 字段忽略，code 字段携带用户输入的 6 位验证码（服务端用 verifyCode 校验）
   */
  | { type: "mfa_response"; approved: boolean; code?: string };
