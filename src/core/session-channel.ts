/**
 * 会话 id → 该会话的**对外通道**（只有 qqbot 会话有）。
 *
 * 为什么单独一个模块：这个解析是两个**安全相关决策**的共同输入 ——
 * 1. `notifyForSession()`：agent 的最终回复推到哪；
 * 2. `mfaForSession()`：被唤醒那一轮算不算"有人值守"（能否把审批送到人）。
 *
 * 两处必须一致（能收到回复 = 也能收到审批提示），所以只留这一份实现；顺带让它可被探针直接断言，
 * 不必把 `main.ts` 的闭包逻辑暴露出来。
 */

import type { InboundMessage } from "../connectors/base.js";

/** qqbot 会话 id 的三段式：`qqbot:<type>:<peerId>` */
const CHAT_SESSION_RE = /^qqbot:(c2c|group|guild|dm):(.+)$/;

export interface ChatChannel {
  /** 消息类型，直接可传给 connector.send / buildMFARequest */
  type: InboundMessage["type"];
  /** 该会话对应的 peerId（QQ 侧的用户/群标识） */
  peerId: string;
}

/**
 * 解析一个会话 id 的对外通道。
 * @returns 非 qqbot 会话（如 `cli:` / `slave:` / `cron:`）返回 `undefined` —— 它们没有常驻连接。
 */
export function parseChatSessionId(sessionId: string): ChatChannel | undefined {
  const m = sessionId.match(CHAT_SESSION_RE);
  if (!m) return undefined;
  const type = m[1];
  const peerId = m[2];
  if (!type || !peerId) return undefined;
  return { type: type as InboundMessage["type"], peerId };
}
