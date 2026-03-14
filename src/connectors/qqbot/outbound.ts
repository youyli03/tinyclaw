/**
 * QQBot 消息发送 + 限流
 * 移植自 openclaw qqbot 插件
 *
 * QQ 官方规则：同一 message_id 被动回复最多 4 次，1小时有效期
 */

import {
  getAccessToken,
  clearTokenCache,
  sendC2CMessage,
  sendGroupMessage,
  sendChannelMessage,
  sendProactiveC2CMessage,
  sendProactiveGroupMessage,
} from "./api.js";
import type { InboundMessage } from "../base.js";

// ── 限流 ──────────────────────────────────────────────────────────────────────

const REPLY_LIMIT = 4;
const REPLY_TTL = 60 * 60 * 1000;

interface ReplyRecord {
  count: number;
  firstAt: number;
}

const replyTracker = new Map<string, ReplyRecord>();

function checkLimit(msgId: string): { allowed: boolean; remaining: number } {
  const now = Date.now();
  const rec = replyTracker.get(msgId);
  if (!rec) return { allowed: true, remaining: REPLY_LIMIT };
  if (now - rec.firstAt > REPLY_TTL) {
    replyTracker.delete(msgId);
    return { allowed: true, remaining: REPLY_LIMIT };
  }
  const remaining = REPLY_LIMIT - rec.count;
  return { allowed: remaining > 0, remaining: Math.max(0, remaining) };
}

function recordReply(msgId: string): void {
  const now = Date.now();
  const rec = replyTracker.get(msgId);
  if (!rec) {
    replyTracker.set(msgId, { count: 1, firstAt: now });
  } else if (now - rec.firstAt > REPLY_TTL) {
    replyTracker.set(msgId, { count: 1, firstAt: now });
  } else {
    rec.count++;
  }
}

// ── 文本分块（QQ 单条消息有长度限制）────────────────────────────────────────

const CHUNK_LIMIT = 2000;

function chunkText(text: string): string[] {
  if (text.length <= CHUNK_LIMIT) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= CHUNK_LIMIT) { chunks.push(remaining); break; }
    let splitAt = remaining.lastIndexOf("\n", CHUNK_LIMIT);
    if (splitAt <= 0) splitAt = CHUNK_LIMIT;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks;
}

// ── 主发送函数 ────────────────────────────────────────────────────────────────

export interface SendOptions {
  appId: string;
  clientSecret: string;
  peerId: string;
  type: InboundMessage["type"];
  text: string;
  replyToId?: string;
}

export async function sendMessage(opts: SendOptions): Promise<void> {
  const { appId, clientSecret, peerId, type, text, replyToId } = opts;

  let token = await getAccessToken(appId, clientSecret);

  const chunks = chunkText(text);

  for (const chunk of chunks) {
    try {
      await doSend(token, type, peerId, chunk, replyToId);
    } catch (err) {
      // token 过期时刷新重试一次
      const msg = String(err);
      if (msg.includes("401") || msg.includes("token") || msg.includes("11244")) {
        clearTokenCache();
        token = await getAccessToken(appId, clientSecret);
        await doSend(token, type, peerId, chunk, replyToId);
      } else {
        throw err;
      }
    }
    if (replyToId) recordReply(replyToId);
  }
}

async function doSend(
  token: string,
  type: InboundMessage["type"],
  peerId: string,
  content: string,
  replyToId?: string
): Promise<void> {
  if (type === "c2c" || type === "dm") {
    if (replyToId) {
      const { allowed } = checkLimit(replyToId);
      if (allowed) {
        await sendC2CMessage(token, peerId, content, replyToId);
      } else {
        await sendProactiveC2CMessage(token, peerId, content);
      }
    } else {
      await sendProactiveC2CMessage(token, peerId, content);
    }
  } else if (type === "group") {
    if (replyToId) {
      const { allowed } = checkLimit(replyToId);
      if (allowed) {
        await sendGroupMessage(token, peerId, content, replyToId);
      } else {
        await sendProactiveGroupMessage(token, peerId, content);
      }
    } else {
      await sendProactiveGroupMessage(token, peerId, content);
    }
  } else if (type === "guild") {
    await sendChannelMessage(token, peerId, content, replyToId);
  }
}
