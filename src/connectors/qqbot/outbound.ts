/**
 * QQBot 消息发送 + 限流
 * 移植自 openclaw qqbot 插件
 *
 * QQ 官方规则：同一 message_id 被动回复最多 4 次，1小时有效期
 */

import * as fs from "node:fs";
import {
  getAccessToken,
  clearTokenCache,
  sendC2CMessage,
  sendGroupMessage,
  sendChannelMessage,
  sendProactiveC2CMessage,
  sendProactiveGroupMessage,
  sendC2CMedia,
  sendGroupMedia,
} from "./api.js";
import type { InboundMessage } from "../base.js";
import { parseMediaTags } from "../utils/media-parser.js";

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

/** 本地文件 base64 上传的大小上限（10 MB） */
const MAX_BASE64_FILE_SIZE = 10 * 1024 * 1024;

export interface MediaError {
  src: string;
  error: string;
}

/**
 * 发送前预检：检查本地媒体文件是否存在且不超大。
 * 仅检查本地路径，URL 跳过。返回错误列表，空数组表示通过。
 */
export function validateMediaContent(text: string): MediaError[] {
  const segments = parseMediaTags(text);
  const errors: MediaError[] = [];
  for (const seg of segments) {
    if (seg.type === "text") continue;
    const src = seg.content;
    if (src.startsWith("http://") || src.startsWith("https://")) continue;
    if (!fs.existsSync(src)) {
      errors.push({ src, error: `文件不存在: ${src}` });
    } else {
      const stat = fs.statSync(src);
      if (stat.size > MAX_BASE64_FILE_SIZE) {
        errors.push({ src, error: `文件过大 (${stat.size} bytes)` });
      }
    }
  }
  return errors;
}

export async function sendMessage(opts: SendOptions): Promise<void> {
  const { appId, clientSecret, peerId, type, text, replyToId } = opts;

  let token = await getAccessToken(appId, clientSecret);

  const segments = parseMediaTags(text);

  for (const segment of segments) {
    if (segment.type === "text") {
      // ── 纯文本分块发送 ──────────────────────────────────────────────────
      const chunks = chunkText(segment.content);
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
    } else {
      // ── 富媒体发送 ────────────────────────────────────────────────────
      if (type === "guild") {
        console.warn("[qqbot] 频道消息暂不支持富媒体，已跳过");
        continue;
      }
      // 频道次数限制：已超限则改为主动消息（不带 msg_id）
      let mediaReplyToId = replyToId;
      if (replyToId) {
        const { allowed } = checkLimit(replyToId);
        if (!allowed) mediaReplyToId = undefined;
      }
      try {
        await doSendMedia(token, type, peerId, segment.type, segment.content, mediaReplyToId);
      } catch (err) {
        const msg = String(err);
        if (msg.includes("401") || msg.includes("token") || msg.includes("11244")) {
          clearTokenCache();
          token = await getAccessToken(appId, clientSecret);
          await doSendMedia(token, type, peerId, segment.type, segment.content, mediaReplyToId);
        } else {
          console.error("[qqbot] 媒体发送失败:", err);
        }
      }
      if (replyToId) recordReply(replyToId);
    }
  }
}

async function doSendMedia(
  token: string,
  type: "c2c" | "dm" | "group",
  peerId: string,
  mediaType: "img" | "audio" | "video" | "file",
  pathOrUrl: string,
  msgId?: string
): Promise<void> {
  let source: { url?: string; fileData?: string };

  if (pathOrUrl.startsWith("http://") || pathOrUrl.startsWith("https://")) {
    source = { url: pathOrUrl };
  } else {
    if (!fs.existsSync(pathOrUrl)) {
      throw new Error(`媒体文件不存在: ${pathOrUrl}`);
    }
    const stat = fs.statSync(pathOrUrl);
    if (stat.size > MAX_BASE64_FILE_SIZE) {
      throw new Error(`文件过大 (${stat.size} bytes): ${pathOrUrl}`);
    }
    const data = fs.readFileSync(pathOrUrl);
    source = { fileData: data.toString("base64") };
  }

  if (type === "c2c" || type === "dm") {
    await sendC2CMedia(token, peerId, mediaType, source, msgId);
  } else {
    await sendGroupMedia(token, peerId, mediaType, source, msgId);
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
