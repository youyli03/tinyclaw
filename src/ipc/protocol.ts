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
  | { type: "qqbot_send"; peerId: string; msgType: "c2c" | "group" | "guild" | "dm"; text: string; replyToId?: string }
  | { type: "qqbot_prompt"; peerId: string; msgType: "c2c" | "group" | "guild" | "dm"; prompt: string; timeoutMs: number }
  | { type: "memorize"; sessionId: string }
  /** 立即触发指定 loop session 的一次 tick（不影响定时计划） */
  | { type: "loop_trigger"; sessionId: string }
  /** 暂停指定 loop session 的定时触发（不重启，立即生效） */
  | { type: "loop_pause"; sessionId: string }
  /** 恢复指定 loop session 的定时触发（不重启，立即生效） */
  | { type: "loop_resume"; sessionId: string }
  /** 查询指定 loop session 的实时运行状态 */
  | { type: "loop_status"; sessionId: string }
  /** 列出所有已调度 loop session 的实时状态 */
  | { type: "loop_list_status" }
  /**
   * 软中断指定 session 的 runAgent() 循环。
   * idOrSuffix 可为完整 sessionId，或 sessionId 的末尾子串（如日志中显示的 12 位后缀）。
   * 返回 aborted（已中断）或 not_found。
   */
  | { type: "abort_session"; idOrSuffix: string }
  /**
   * 一次性 LLM 调用(无 session 历史，无工具权限)。
   * 直接走指定 backend 的 LLM，流式返回 chunk → done。
   * 用于 TradeJournal-skill 等需要纯 LLM 分析文本但不需要 agent 工具的场景。
   */
  | { type: "llm_oneshot"; prompt: string; backend?: "daily" | "code" | "summarizer" }
  /**
   * 订阅指定 session 的实时活动事件(LLM chunk、工具调用、工具结果、done/error)。
   * 服务端持续推送 activity 帧,直到 socket 断开。
   * idOrSuffix 可为完整 sessionId 或其末尾子串。
   */
  | { type: "subscribe"; idOrSuffix: string };

export type IpcResponse =
  | { type: "chunk"; delta: string }
  | { type: "done" }
  | { type: "error"; message: string }
  | { type: "sessions"; sessions: SessionInfo[] }
  | { type: "created"; sessionId: string }
  | { type: "qqbot_sent" }
  | { type: "qqbot_prompt_result"; answer: string }
  /** MFA 确认请求：服务端向客户端发送，等待用户回复 */
  | { type: "mfa_request"; warningMessage: string }
  | { type: "cron_triggered"; jobId: string }
  /** loop_trigger 请求的响应 */
  | { type: "loop_triggered"; sessionId: string; found: boolean }
  /** loop_pause 请求的响应 */
  | { type: "loop_paused"; sessionId: string; found: boolean }
  /** loop_resume 请求的响应 */
  | { type: "loop_resumed"; sessionId: string; found: boolean }
  /** loop_status 请求的响应 */
  | { type: "loop_status_result"; sessionId: string; status: "running" | "paused" | "idle" | "not_found" }
  /** loop_list_status 请求的响应 */
  | { type: "loop_list_status_result"; items: Array<{ sessionId: string; status: "running" | "paused" | "idle" | "not_found"; agentId: string; tickSeconds: number }> }
  /** 手动记忆压缩完成，包含生成的摘要文本 */
  | { type: "memorized"; summary: string }
  /** abort_session 请求的响应 */
  | { type: "session_aborted"; sessionId: string; found: boolean }
  /**
   * subscribe 的活动事件推送。
   * 每当目标 session 有 chunk/tool_call/tool_result/done/error 时发送一帧。
   */
  | { type: "activity"; sessionId: string; event: ActivityEvent }
  /** subscribe 时 session 未找到的错误 */
  | { type: "subscribed"; sessionId: string };

export type IpcClientMessage =
  | IpcRequest
  /** MFA 确认响应：客户端向服务端回复。
   *  - simple/msal 模式：approved=true/false
   *  - TOTP 模式：approved 字段忽略，code 字段携带用户输入的 6 位验证码（服务端用 verifyCode 校验）
   */
  | { type: "mfa_response"; approved: boolean; code?: string };

/**
 * synchro 订阅事件：描述 session 内发生的一次动作。
 */
export type ActivityEvent =
  | { kind: "chunk"; delta: string }
  | { kind: "tool_call"; name: string; argsSummary: string }
  | { kind: "tool_result"; name: string; resultSummary: string }
  | { kind: "done" }
  | { kind: "error"; message: string };

