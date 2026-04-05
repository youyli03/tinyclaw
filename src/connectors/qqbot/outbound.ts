/**
 * QQBot 消息发送 + 限流
 * 移植自 openclaw qqbot 插件
 *
 * QQ 官方规则：同一 message_id 被动回复最多 4 次，1小时有效期
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
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
 * 从含媒体标签的文本中提取纯文本部分（去除所有媒体标签）。
 * 用于回退：媒体发送失败时至少把文字内容发给用户。
 */
export function extractTextContent(text: string): string {
  return parseMediaTags(text)
    .filter(seg => seg.type === "text")
    .map(seg => seg.content)
    .join("")
    .trim();
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

// ── 错误判断辅助 ──────────────────────────────────────────────────────────────

function isTokenError(err: unknown): boolean {
  const msg = String(err);
  return msg.includes("401") || msg.includes("token") || msg.includes("11244");
}

function isTimeoutError(err: unknown): boolean {
  if (err instanceof DOMException && (err.code === 23 || err.name === "TimeoutError")) return true;
  if (err instanceof Error) {
    if (err.name === "TimeoutError") return true;
    // undici ConnectTimeoutError / SocketError（UND_ERR_CONNECT_TIMEOUT、UND_ERR_SOCKET 等）
    const code = (err as NodeJS.ErrnoException & { code?: string }).code ?? "";
    if (code.startsWith("UND_ERR_CONNECT") || code === "UND_ERR_SOCKET") return true;
    // 兜底：消息含 Connect Timeout / fetch failed + timeout 相关
    const msg = err.message ?? "";
    if (msg.includes("Connect Timeout Error") || msg.includes("connect ETIMEDOUT")) return true;
  }
  return false;
}

function isTLSError(err: unknown): boolean {
  const msg = String(err);
  return (
    msg.includes("UNKNOWN_CERTIFICATE_VERIFICATION_ERROR") ||
    msg.includes("certificate") ||
    msg.includes("CERT_") ||
    msg.includes("SSL") ||
    msg.includes("TLS")
  );
}

/** 指数退避：delay ms 后 resolve，不设上限 */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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
        let backoffMs = 2_000;
        // eslint-disable-next-line no-constant-condition
        while (true) {
          try {
            await doSend(token, type, peerId, chunk, replyToId);
            break;
          } catch (err) {
            if (isTokenError(err)) {
              clearTokenCache();
              token = await getAccessToken(appId, clientSecret);
              await doSend(token, type, peerId, chunk, replyToId);
              break;
            } else if (isTimeoutError(err)) {
              console.warn(`[qqbot] 发送超时，${backoffMs / 1000}s 后重试...`);
              await sleep(backoffMs);
              backoffMs *= 2;
            } else if (isTLSError(err)) {
              // TLS/证书错误：记录日志但不 throw，避免 unhandled rejection 导致进程崩溃
              console.error(`[qqbot] TLS/证书错误，消息发送失败（已跳过）:`, err);
              break;
            } else {
              throw err;
            }
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
      let backoffMs = 2_000;
      // eslint-disable-next-line no-constant-condition
      while (true) {
        try {
          await doSendMedia(token, type, peerId, segment.type, segment.content, mediaReplyToId);
          break;
        } catch (err) {
          if (isTokenError(err)) {
            clearTokenCache();
            token = await getAccessToken(appId, clientSecret);
            await doSendMedia(token, type, peerId, segment.type, segment.content, mediaReplyToId);
            break;
          } else if (isTimeoutError(err)) {
            console.warn(`[qqbot] 媒体发送超时，${backoffMs / 1000}s 后重试...`);
            await sleep(backoffMs);
            backoffMs *= 2;
          } else {
            console.error("[qqbot] 媒体发送失败:", err);
            // 降级：提取纯文本内容发送给用户，确保用户至少能收到信息
            const fallbackText = extractTextContent(text);
            if (fallbackText) {
              try {
                await doSend(token, type, peerId, fallbackText, replyToId);
              } catch (fallbackErr) {
                console.error("[qqbot] 媒体降级发文本也失败:", fallbackErr);
              }
            }
            break;
          }
        }
      }
      if (replyToId) recordReply(replyToId);
    }
  }
}

/**
 * 将本地 PNG 文件转换为临时 JPEG 文件，返回 JPEG 路径。
 * 转换失败时 throw Error，调用方应 catch 并回退使用原始文件。
 */
function convertPngToJpeg(pngPath: string, quality = 85): Promise<string> {
  const jpgPath = path.join(
    os.tmpdir(),
    `qqbot_${Date.now()}_${path.basename(pngPath, ".png")}.jpg`
  );
  return new Promise((resolve, reject) => {
    const py = spawn("python3", ["-c", `
import sys
from PIL import Image
img = Image.open(sys.argv[1]).convert("RGB")
img.save(sys.argv[2], "JPEG", quality=int(sys.argv[3]), optimize=True)
`, pngPath, jpgPath, String(quality)], { stdio: ["ignore", "pipe", "pipe"] });

    let err = "";
    py.stderr.on("data", (d: Buffer) => { err += d.toString("utf-8"); });
    py.on("close", (code) => {
      if (code === 0 && fs.existsSync(jpgPath)) resolve(jpgPath);
      else reject(new Error(`PNG→JPEG 转换失败 (code=${code}): ${err.trim()}`));
    });
    py.on("error", (e) => reject(new Error(`python3 启动失败: ${e.message}`)));
  });
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

    // PNG 图片自动转 JPEG，大幅减小体积，避免 QQ 上传超限（code=850031）
    let uploadPath = pathOrUrl;
    let tempJpg: string | null = null;
    if (mediaType === "img" && pathOrUrl.toLowerCase().endsWith(".png")) {
      try {
        tempJpg = await convertPngToJpeg(pathOrUrl);
        uploadPath = tempJpg;
      } catch (e) {
        console.warn("[qqbot] PNG→JPEG 转换失败，回退使用原始 PNG:", e);
      }
    }

    try {
      const stat = fs.statSync(uploadPath);
      if (stat.size > MAX_BASE64_FILE_SIZE) {
        throw new Error(`文件过大 (${stat.size} bytes): ${uploadPath}`);
      }
      const data = fs.readFileSync(uploadPath);
      source = { fileData: data.toString("base64") };
    } finally {
      // 清理临时 JPEG 文件
      if (tempJpg) {
        try { fs.unlinkSync(tempJpg); } catch { /* ignore */ }
      }
    }
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
