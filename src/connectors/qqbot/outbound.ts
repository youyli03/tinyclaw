/**
 * QQBot 消息发送 + 限流
 * 移植自 openclaw qqbot 插件
 *
 * QQ 官方规则：同一 message_id 被动回复最多 4 次，1小时有效期
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";
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
  uploadPrepare,
  putUploadPart,
  uploadPartFinish,
  mergeChunkedUpload,
  sendMediaByFileInfo,
  streamC2CMessage,
  reserveMsgSeq,
  StreamApiError,
  type C2CStreamChunk,
  type StreamChunkResult,
  type MediaTarget,
} from "./api.js";
import type { InboundMessage, SendOutcome } from "../base.js";
import { parseMediaTags } from "../utils/media-parser.js";
import { mdToImage } from "../utils/md-to-image.js";

/** 超过该字符数时，自动渲染为图片发送（仅 text 段，无 <img>/<audio>/<video> 标签） */
const AUTO_RENDER_THRESHOLD = 500;

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
    if (remaining.length <= CHUNK_LIMIT) {
      chunks.push(remaining);
      break;
    }
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

/**
 * 单次请求 **base64 编码后字符数** 的上限（10 MB）。
 *
 * 官方富媒体上传有两种传法：
 *  - `file_url`：整文件上传；大文件应走**分片上传**（`upload_prepare` → PUT → `upload_part_finish`）
 *  - `file_data`：base64 内联进单次请求 ← **本项目用的就是这条**
 *
 * 实测：内联请求体编码后约 10 MB 即触顶，超出时网关返回
 * `500 {"message":"call inner proxy error","code":850012}` —— 不带任何体积线索。
 *
 * ⚠️ 比较的是**编码后长度**（≈ 原始字节 × 4/3），不是原始字节数。
 * 历史 bug：拿原始字节和 10 MB 比，于是 8.2 MB 的文件顺利通过预检、却在网关侧炸掉，
 * 用户只看到一句"附件已发"（媒体失败被静默降级成文本）。
 *
 * 超过这个上限的文件不再报错，改走官方**分片上传**（`sendViaChunkedUpload`）。
 */
const MAX_BASE64_CHARS = 10 * 1024 * 1024;

/** 原始字节数 → base64 编码后字符数（含 padding） */
function base64Length(rawBytes: number): number {
  return Math.ceil(rawBytes / 3) * 4;
}

/** 官方硬限制：任意 file_type 都是 200 MB（超过直接报错，不再降级） */
const HARD_LIMIT_BYTES = 200 * 1024 * 1024;

/** `md5_10m` 取的是文件**前 10,002,432 字节**（约 9.54 MB）的 MD5，不是整个文件的 MD5 */
const MD5_10M_BYTES = 10_002_432;

/** 大文件分片上传时，单次读取的缓冲块（与官方 block_size 无关，仅控制内存峰值） */
const HASH_READ_CHUNK = 1024 * 1024;

/** 人类可读体积（日志与用户提示共用） */
function formatMiB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 由**文件格式**决定实际下发的 `file_type`，标签只表达意图。
 *
 * 为什么不能直接照搬标签：官方各类型的可用格式是固定的（1=png/jpg、2=mp4、3=silk），
 * 把 `.mp3` 标成 `<audio>` 会走 `file_type=3`（语音），QQ 会把它当**语音气泡**播放——
 * 用户要的是一份 mp3 **附件**。所以除 silk 之外的音频一律按文件发送，
 * 非 mp4 的视频、非 png/jpg 的图片同理。
 */
function wireMediaType(
  mediaType: "img" | "audio" | "video" | "file",
  filename: string
): "img" | "audio" | "video" | "file" {
  const ext = path.extname(filename).toLowerCase();
  switch (mediaType) {
    case "img":
      return /\.(png|jpe?g)$/.test(ext) ? "img" : "file";
    case "video":
      return ext === ".mp4" ? "video" : "file";
    case "audio":
      // 只有 silk 才是官方意义上的"语音"；mp3/m4a/wav/flac 等保持为文件附件
      return ext === ".silk" ? "audio" : "file";
    default:
      return "file";
  }
}

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
    .filter((seg) => seg.type === "text")
    .map((seg) => seg.content)
    .join("")
    .trim();
}

/**
 * 发送前预检：检查本地媒体文件是否存在、base64 内联后是否超网关上限。
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
      continue;
    }
    const stat = fs.statSync(src);
    if (stat.size > HARD_LIMIT_BYTES) {
      errors.push({
        src,
        error:
          `文件超过官方硬限制：${formatMiB(stat.size)} > ${formatMiB(HARD_LIMIT_BYTES)}；` +
          `${formatMiB(MAX_BASE64_CHARS)} 以内走内联上传，更大走分片上传，但都不可超过硬限制`,
      });
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
  // Traverse the full err.cause chain: undici wraps ConnectTimeoutError inside
  // TypeError("fetch failed"), so we must check err.cause.code, not just err.code.
  let cur: unknown = err;
  while (cur != null) {
    if (cur instanceof DOMException && (cur.code === 23 || cur.name === "TimeoutError"))
      return true;
    if (cur instanceof Error) {
      if (cur.name === "TimeoutError") return true;
      const code = (cur as NodeJS.ErrnoException & { code?: string }).code ?? "";
      if (code.startsWith("UND_ERR_CONNECT") || code === "UND_ERR_SOCKET") return true;
      const msg = cur.message ?? "";
      if (msg.includes("Connect Timeout Error") || msg.includes("connect ETIMEDOUT")) return true;
    }
    // Step into cause (Error or plain object with .cause)
    cur = (cur as { cause?: unknown }).cause ?? null;
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

/**
 * 是否是「富媒体类型不被接受」类错误 —— 换 `file_type=4` 重发大概率能救。
 *
 * 官方各类型只吃固定格式：`1`=png/jpg、`2`=mp4、`3`=silk、`4`=任意。
 * 类型对不上时返回 `400 {"message":"富媒体文件格式不支持","code":850019,"err_code":40034002}`。
 */
function isMediaFormatRejection(err: unknown): boolean {
  const msg = String(err);
  return (
    msg.includes("850019") ||
    msg.includes("40034002") ||
    msg.includes("富媒体文件格式不支持") ||
    /failed 400\b/.test(msg)
  );
}

/** 指数退避：delay ms 后 resolve，不设上限 */
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function sendMessage(opts: SendOptions): Promise<SendOutcome> {
  const { appId, clientSecret, peerId, type, text, replyToId } = opts;

  let token = await getAccessToken(appId, clientSecret);

  const segments = parseMediaTags(text);

  // 媒体标签是否出现过 / 是否有失败（失败时已降级为纯文本）
  const hadMedia = segments.some((seg) => seg.type !== "text");
  let firstMediaError: string | undefined;
  /** 本轮是否已把正文文本发出去了（决定媒体失败时要不要再补发一次正文） */
  let sentTextSegment = false;

  for (const segment of segments) {
    if (segment.type === "text") {
      // ── 长文本自动渲染为图片 ─────────────────────────────────────────────
      if (segment.content.length > AUTO_RENDER_THRESHOLD && type !== "guild") {
        try {
          const imgPath = await mdToImage(segment.content);
          const mediaReplyToId2 =
            replyToId && checkLimit(replyToId).allowed ? replyToId : undefined;
          await doSendMedia(token, type, peerId, "img", imgPath, mediaReplyToId2);
          if (replyToId) recordReply(replyToId);
          sentTextSegment = true; // 正文已以图片形式送达
          continue;
        } catch (err) {
          console.warn("[qqbot] 长文本渲染图片失败，降级为文字:", err);
          // 降级继续走文字路径
        }
      }
      // ── 纯文本分块发送 ──────────────────────────────────────────────────
      // 超过 QQ 被动回复次数上限(同 msg_id 4 次)时降级为主动消息(不带 replyToId),
      // 避免继续使用已超限的 msg_id 导致静默失败(与上方长文本图片/富媒体路径一致)。
      const textReplyToId =
        replyToId && checkLimit(replyToId).allowed ? replyToId : undefined;
      const chunks = chunkText(segment.content);
      for (const chunk of chunks) {
        let backoffMs = 2_000;
         
        // 超时重试为无限循环(有意设计):若消息发不出去,通常意味着收消息的通道也已断开,
        // 无限重试保证网络恢复后消息最终送达;请勿添加 maxAttempts 上限(会导致消息永久丢失)。
        while (true) {
          try {
            await doSend(token, appId, type, peerId, chunk, textReplyToId);
            break;
          } catch (err) {
            if (isTokenError(err)) {
              clearTokenCache(appId);
              token = await getAccessToken(appId, clientSecret);
              await doSend(token, appId, type, peerId, chunk, textReplyToId);
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
        if (textReplyToId) recordReply(textReplyToId);
      }
      sentTextSegment = true;
    } else {
      // ── 富媒体发送 ────────────────────────────────────────────────────
      if (type === "guild") {
        console.warn("[qqbot] 频道消息暂不支持富媒体，已跳过");
        firstMediaError ??= "频道消息不支持富媒体";
        continue;
      }
      // 频道次数限制：已超限则改为主动消息（不带 msg_id）
      let mediaReplyToId = replyToId;
      if (replyToId) {
        const { allowed } = checkLimit(replyToId);
        if (!allowed) mediaReplyToId = undefined;
      }
      let backoffMs = 2_000;
       
      while (true) {
        try {
          await doSendMedia(
            token,
            type,
            peerId,
            segment.type,
            segment.content,
            mediaReplyToId,
            segment.filename
          );
          break;
        } catch (err) {
          if (isTokenError(err)) {
            clearTokenCache(appId);
            token = await getAccessToken(appId, clientSecret);
            await doSendMedia(
              token,
              type,
              peerId,
              segment.type,
              segment.content,
              mediaReplyToId,
              segment.filename
            );
            break;
          } else if (isTimeoutError(err)) {
            console.warn(`[qqbot] 媒体发送超时，${backoffMs / 1000}s 后重试...`);
            await sleep(backoffMs);
            backoffMs *= 2;
          } else {
            const reason = err instanceof Error ? err.message : String(err);
            console.error("[qqbot] 媒体发送失败:", err);
            // 只在首个失败上做降级说明，避免多个媒体段各自刷一条 notice
            if (firstMediaError === undefined) {
              firstMediaError = reason.slice(0, 200);
              await notifyMediaFailure({
                token,
                appId,
                type,
                peerId,
                text,
                sentTextSegment,
                reason,
                ...(replyToId !== undefined ? { replyToId } : {}),
              });
            }
            break;
          }
        }
      }
      if (replyToId) recordReply(replyToId);
    }
  }

  return {
    hadMedia,
    mediaFailed: firstMediaError !== undefined,
    ...(firstMediaError !== undefined ? { mediaError: firstMediaError } : {}),
  };
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
    const py = spawn(
      "python3",
      [
        "-c",
        `
import sys
from PIL import Image
img = Image.open(sys.argv[1]).convert("RGB")
img.save(sys.argv[2], "JPEG", quality=int(sys.argv[3]), optimize=True)
`,
        pngPath,
        jpgPath,
        String(quality),
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );

    let err = "";
    py.stderr.on("data", (d: Buffer) => {
      err += d.toString("utf-8");
    });
    py.on("close", (code) => {
      if (code === 0 && fs.existsSync(jpgPath)) resolve(jpgPath);
      else reject(new Error(`PNG→JPEG 转换失败 (code=${code}): ${err.trim()}`));
    });
    py.on("error", (e) => reject(new Error(`python3 启动失败: ${e.message}`)));
  });
}

/**
 * 分片上传一个大文件并把它作为富媒体消息发出（内联 base64 放不下时的出路）。
 *
 * 内存策略：文件**不整体读入内存**——先用一次顺序读取同时算出
 * `md5` / `sha1` / `md5_10m`（三者共用同一遍 IO），再按官方下发的分片大小
 * 逐片 `fs.readSync` 读取、上传、`part_finish`。峰值内存 ≈ 一个分片。
 */
async function sendViaChunkedUpload(args: {
  token: string;
  target: MediaTarget;
  mediaType: "img" | "audio" | "video" | "file";
  uploadPath: string;
  filename: string;
  msgId?: string;
}): Promise<void> {
  const { token, target, mediaType, uploadPath, filename, msgId } = args;

  const fd = fs.openSync(uploadPath, "r");
  try {
    const size = fs.fstatSync(fd).size;

    // ── 一遍 IO 同时算三个校验值 ──────────────────────────────────────────
    const md5All = createHash("md5");
    const sha1All = createHash("sha1");
    const md5Head = createHash("md5");
    const buf = Buffer.allocUnsafe(Math.min(HASH_READ_CHUNK, Math.max(size, 1)));
    let pos = 0;
    let hashed = 0;
    while (pos < size) {
      const want = Math.min(buf.length, size - pos);
      const read = fs.readSync(fd, buf, 0, want, pos);
      if (read <= 0) break;
      const slice = buf.subarray(0, read);
      md5All.update(slice);
      sha1All.update(slice);
      if (hashed < MD5_10M_BYTES) {
        md5Head.update(
          hashed + read <= MD5_10M_BYTES ? slice : slice.subarray(0, MD5_10M_BYTES - hashed)
        );
      }
      hashed += read;
      pos += read;
    }

    const prepOpts = {
      fileSize: size,
      fileName: filename,
      md5: md5All.digest("hex"),
      sha1: sha1All.digest("hex"),
      md5_10m: md5Head.digest("hex"),
    };

    // 预上传阶段服务端就会校验 file_type（850019），此时**一个字节都还没传**，
    // 所以在这里回退成「文件」类型的代价为零——比传完再被拒划算得多。
    let effectiveType = mediaType;
    const prep = await uploadPrepare(token, target, { mediaType: effectiveType, ...prepOpts }).catch(
      async (err: unknown) => {
        if (effectiveType === "file" || !isMediaFormatRejection(err)) throw err;
        console.warn(
          `[qqbot] 分片上传以 ${effectiveType} 预上传被拒（${err instanceof Error ? err.message : String(err)}），` +
            `改用文件类型`
        );
        effectiveType = "file";
        return await uploadPrepare(token, target, { mediaType: effectiveType, ...prepOpts });
      }
    );

    console.log(
      `[qqbot] 分片上传 ${filename}（${formatMiB(size)}，${prep.parts.length} 片，每片 ${formatMiB(prep.blockSize)}，file_type=${effectiveType}）`
    );

    // ── 逐片上传（官方默认并发 1，顺序执行即可）──────────────────────────
    let offset = 0;
    for (const part of prep.parts) {
      const length = part.blockSize > 0 ? part.blockSize : size - offset;
      const chunk = Buffer.allocUnsafe(length);
      const read = fs.readSync(fd, chunk, 0, length, offset);
      if (read <= 0) throw new Error(`读取分片失败（offset=${offset}）`);
      const data = read === length ? chunk : chunk.subarray(0, read);
      await putUploadPart(part.presignedUrl, data);
      await uploadPartFinish(token, target, {
        uploadId: prep.uploadId,
        partIndex: part.index,
        blockSize: data.length,
        md5: createHash("md5").update(data).digest("hex"),
      });
      offset += data.length;
    }
    if (offset !== size) {
      throw new Error(`分片上传不完整：已传 ${offset} / 共 ${size} 字节`);
    }

    // ── 合并 → file_info → 发消息 ─────────────────────────────────────────
    const { fileInfo } = await mergeChunkedUpload(token, target, {
      mediaType: effectiveType,
      fileName: filename,
      uploadId: prep.uploadId,
    });
    await sendMediaByFileInfo(token, target, fileInfo, msgId ? { msgId } : undefined);
    console.log(`[qqbot] 分片上传完成并已发送: ${filename}`);
  } finally {
    fs.closeSync(fd);
  }
}

async function doSendMedia(
  token: string,
  type: "c2c" | "dm" | "group",
  peerId: string,
  mediaType: "img" | "audio" | "video" | "file",
  pathOrUrl: string,
  msgId?: string,
  filename?: string
): Promise<void> {
  // 自动从路径提取文件名
  const resolvedFilename =
    filename ??
    (!pathOrUrl.startsWith("http://") && !pathOrUrl.startsWith("https://")
      ? path.basename(pathOrUrl)
      : undefined);
  // 实际下发的类型由文件格式决定（见 wireMediaType）：mp3 等按文件发，不当语音气泡
  const wireType = wireMediaType(mediaType, resolvedFilename ?? pathOrUrl);
  let source: { url?: string; fileData?: string; filename?: string };

  if (pathOrUrl.startsWith("http://") || pathOrUrl.startsWith("https://")) {
    source = { url: pathOrUrl, ...(resolvedFilename ? { filename: resolvedFilename } : {}) };
  } else {
    if (!fs.existsSync(pathOrUrl)) {
      throw new Error(`媒体文件不存在: ${pathOrUrl}`);
    }

    // PNG 图片自动转 JPEG，大幅减小体积，避免 QQ 上传超限（code=850031）
    let uploadPath = pathOrUrl;
    let tempJpg: string | null = null;
    if (wireType === "img" && pathOrUrl.toLowerCase().endsWith(".png")) {
      try {
        tempJpg = await convertPngToJpeg(pathOrUrl);
        uploadPath = tempJpg;
      } catch (e) {
        console.warn("[qqbot] PNG→JPEG 转换失败，回退使用原始 PNG:", e);
      }
    }

    try {
      const stat = fs.statSync(uploadPath);
      if (stat.size > HARD_LIMIT_BYTES) {
        throw new Error(
          `文件超过官方硬限制：${formatMiB(stat.size)} > ${formatMiB(HARD_LIMIT_BYTES)}: ${uploadPath}`
        );
      }
      // 内联 base64 塞不下 → 走官方分片上传（可到硬限制 200 MB）
      if (base64Length(stat.size) > MAX_BASE64_CHARS) {
        await sendViaChunkedUpload({
          token,
          target: type === "group" ? { kind: "group", id: peerId } : { kind: "user", id: peerId },
          mediaType: wireType,
          uploadPath,
          filename: resolvedFilename ?? path.basename(uploadPath),
          ...(msgId ? { msgId } : {}),
        });
        return;
      }
      const data = fs.readFileSync(uploadPath);
      source = {
        fileData: data.toString("base64"),
        ...(resolvedFilename ? { filename: resolvedFilename } : {}),
      };
    } finally {
      // 清理临时 JPEG 文件
      if (tempJpg) {
        try {
          fs.unlinkSync(tempJpg);
        } catch {
          /* ignore */
        }
      }
    }
  }

  const send =
    type === "c2c" || type === "dm"
      ? (mt: typeof mediaType) => sendC2CMedia(token, peerId, mt, source, msgId)
      : (mt: typeof mediaType) => sendGroupMedia(token, peerId, mt, source, msgId);

  try {
    await send(wireType);
  } catch (err) {
    // 兜底：仍被服务端以"格式不支持"(850019) 拒收时改用「文件」类型重发
    if (wireType === "file" || !isMediaFormatRejection(err)) throw err;
    console.warn(
      `[qqbot] 富媒体以 ${wireType} 发送被拒（${err instanceof Error ? err.message : String(err)}），` +
        `回退为文件类型重试`
    );
    await send("file");
  }
}

/**
 * 媒体发送失败时给用户一个**可见**的交代。
 *
 * 历史行为：吞掉错误、只重发一次正文 —— 用户在聊天里看不到任何异常，
 * 而模型往往已经说了「附件已发」，于是表现为"文件凭空消失"。
 * 现在：正文若已发出就不再重发（避免重复），只补一条简短的失败说明。
 */
async function notifyMediaFailure(args: {
  token: string;
  appId: string;
  type: InboundMessage["type"];
  peerId: string;
  text: string;
  /** 本轮正文是否已经发出（文本段已发 / 已转图片发） */
  sentTextSegment: boolean;
  reason: string;
  replyToId?: string;
}): Promise<void> {
  const { token, appId, type, peerId, text, sentTextSegment, reason, replyToId } = args;
  const hint = reason.length > 160 ? `${reason.slice(0, 157)}...` : reason;
  const notice = `⚠️ 附件发送失败：${hint}`;
  const bodyText = sentTextSegment ? "" : extractTextContent(text);
  const payload = bodyText ? `${bodyText}\n\n${notice}` : notice;
  try {
    await doSend(token, appId, type, peerId, payload, replyToId);
  } catch (fallbackErr) {
    console.error("[qqbot] 媒体失败说明也发送失败:", fallbackErr);
  }
}

async function doSend(
  token: string,
  appId: string,
  type: InboundMessage["type"],
  peerId: string,
  content: string,
  replyToId?: string
): Promise<void> {
  if (type === "c2c" || type === "dm") {
    if (replyToId) {
      const { allowed } = checkLimit(replyToId);
      if (allowed) {
        await sendC2CMessage(token, appId, peerId, content, replyToId);
      } else {
        await sendProactiveC2CMessage(token, appId, peerId, content);
      }
    } else {
      await sendProactiveC2CMessage(token, appId, peerId, content);
    }
  } else if (type === "group") {
    if (replyToId) {
      const { allowed } = checkLimit(replyToId);
      if (allowed) {
        await sendGroupMessage(token, appId, peerId, content, replyToId);
      } else {
        await sendProactiveGroupMessage(token, appId, peerId, content);
      }
    } else {
      await sendProactiveGroupMessage(token, appId, peerId, content);
    }
  } else if (type === "guild") {
    await sendChannelMessage(token, appId, peerId, content, replyToId);
  }
}

// ── C2C 流式回复会话 ──────────────────────────────────────────────────────────

/**
 * 单条流式消息的保守**字节**上限。
 *
 * 平台对整条流式消息有长度上限，响应里用 `remain_msg_len`（"流式消息剩余长度（字符数）"）回报；
 * **超过之后平台不再应用后续分片，但请求仍返回 200** —— 于是消息停在"生成中"，最后一片
 * `input_state=10` 也被丢掉。客户端表现：手机只显示最前面几个字（如 `对…`），别的设备显示完整正文
 * （Dashboard 渲染的是会话正文，与这条流式消息无关）。
 *
 * 实测锚点（本机 QQ 单聊）：585 字（≈1755 B）完整到达；778 字（≈2334 B）、905 字（≈2715 B）被截断
 * → 上限落在 (1755, 2334) 字节之间，取 **2048 B**。平台回报 `remain_msg_len` 时**两个口径都不越**。
 */
const STREAM_MAX_BYTES = 2048;

/** 文本是否仍在流式消息容量内（容量未知时只按字节上限保守判断） */
function fitsStreamBudget(text: string, capacity: number | undefined): boolean {
  if (Buffer.byteLength(text, "utf-8") > STREAM_MAX_BYTES) return false;
  return capacity === undefined || text.length <= capacity;
}

/**
 * 取满足容量限制的**最长前缀**（二分），并尽量在段落/换行处断开，避免把一句话切成两半。
 * 二分保证前提：若 `text.slice(0, n)` 超容量，则更长前缀也超。
 */
function fitStreamPrefix(text: string, capacity: number | undefined): string {
  if (fitsStreamBudget(text, capacity)) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fitsStreamBudget(text.slice(0, mid), capacity)) lo = mid;
    else hi = mid - 1;
  }
  if (lo <= 0) return "";
  const head = text.slice(0, lo);
  const boundary = Math.max(head.lastIndexOf("\n\n"), head.lastIndexOf("\n"));
  // 只在回退幅度不大（不超过已成前缀的 1/3）时才按段落边界收，避免为了整齐丢掉太多内容
  if (boundary >= Math.floor(lo * (2 / 3))) return text.slice(0, boundary + 1);
  return head;
}

/** 单次分片发送函数（可注入，便于测试） */
export type StreamChunkSender = (chunk: C2CStreamChunk) => Promise<StreamChunkResult>;

/** `C2CStreamSession.finish()` 的结果：调用方据此决定还要不要补发、补发什么 */
export interface StreamFinishResult {
  /** 最终回复的前半段是否**已经通过流式送达**（true 时调用方只需补发 `remainder`） */
  streamed: boolean;
  /** 已通过流式送达的正文（平台已显示的部分） */
  sentText: string;
  /** 仍需用普通发送补发的剩余正文（可能为空串） */
  remainder: string;
}

export interface C2CStreamOptions {
  appId: string;
  clientSecret: string;
  userOpenid: string;
  /** 被动回复 ID（同时作为 msg_id） */
  replyToId: string;
  contentType: "text" | "markdown";
  /** 两次分片之间的最小间隔（ms），默认 400 */
  minIntervalMs?: number;
  /** 可注入的发送函数（测试用），默认走官方 stream_messages */
  sender?: StreamChunkSender;
}

/** 流式分片退避（对齐官方 Node SDK：1s / 2s / 4s） */
const STREAM_RETRY_DELAYS_MS = [1_000, 2_000, 4_000];

/**
 * C2C 流式回复会话（**仅用于最终回复**）。
 *
 * 官方约束（`POST /v2/users/{openid}/stream_messages`）：
 *  - `input_mode=replace`：每次提交**累计全文**，必须覆盖已下发正文，否则报 40007
 *  - `index` 必须在**每次请求前**递增（含重试）
 *  - 首片响应返回 `stream_msg_id`，后续分片复用；整个会话复用同一个 `msg_seq`
 *  - 429 / `err_code=50002` 用新 index 退避重试；其它错误直接放弃并回退普通发送
 *  - **整条消息有长度上限**：超限后平台静默不再应用分片（请求仍 200），必须靠
 *    `remain_msg_len` 自行截断，把装不下的部分交给普通发送（见 `finish()`）
 */
export class C2CStreamSession {
  private readonly opts: C2CStreamOptions & { minIntervalMs: number };
  private readonly msgSeq: number;
  private buffer = "";
  private sent = "";
  private index = 0;
  private streamMsgId: string | undefined;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<void> = Promise.resolve();
  private closed = false;
  private failed = false;
  private started = false;
  private lastFlushAt = 0;
  /** 本消息容量（字符）：首个响应 `remain_msg_len` + 该片正文长度；平台未回报则 undefined（只按字节上限） */
  private capacity: number | undefined;
  /** 是否已给平台发过 `input_state=10`（收尾后不得再追加内容） */
  private finalized = false;
  /** 是否已因超出容量而停止推送（避免每个节流周期都白发一次请求） */
  private overBudget = false;

  constructor(opts: C2CStreamOptions) {
    this.opts = { minIntervalMs: 400, ...opts };
    this.msgSeq = reserveMsgSeq(opts.replyToId);
  }

  /** 流式是否仍可用（未被放弃且未收尾） */
  get usable(): boolean {
    return !this.failed && !this.closed;
  }

  /** 是否已成功下发过至少一个分片 */
  get hasSent(): boolean {
    return this.started;
  }

  /** 平台回报的容量（字符），仅在收到首个响应后可用 */
  get messageCapacity(): number | undefined {
    return this.capacity;
  }

  /** 追加一段增量文本（内部节流后以累计全文下发） */
  push(delta: string): void {
    if (this.closed || this.failed || !delta) return;
    this.buffer += delta;
    if (this.overBudget) return; // 已超容量：不再发起请求，等收尾时截断 + 普通发送补余量
    this.schedule();
  }

  /**
   * 本轮触发了工具调用时调用：把已显示内容收尾，后续不再流式。
   * 由此保证「只有最终回复走流式」——中间轮次的文字独立收尾，最终回复走普通发送。
   */
  async closeEarly(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.clearTimer();
    await this.chain.catch(() => {});
    if (this.started && !this.failed) {
      this.finalized = await this.sendChunk(this.sent, 10);
    }
  }

  /**
   * 收尾并给出"还要补发多少正文"。
   *
   * @param finalText 最终回复正文
   * @returns `streamed=true` 时调用方只需发送 `remainder`；`false` 时正文整段走普通发送
   */
  async finish(finalText: string): Promise<StreamFinishResult> {
    this.closed = true;
    this.clearTimer();
    await this.chain.catch(() => {});
    const final = finalText.trim();
    const fallback = (): StreamFinishResult => ({
      streamed: false,
      sentText: this.sent,
      remainder: final,
    });

    // 已经收尾过（中间轮次触发工具调用时 closeEarly 定型了那条消息）→ 不能再追加，
    // 平台会忽略收尾后的分片；此时最终回复整段走普通发送，避免尾部静默丢失
    if (this.finalized || this.failed) return fallback();

    // replace 模式下最终正文必须覆盖已下发正文，否则用已发内容收尾、正文交给普通发送
    if (this.started && final && !final.startsWith(this.sent)) {
      this.finalized = await this.sendChunk(this.sent, 10);
      return fallback();
    }

    // 按容量取最长可发前缀（装不下时不硬灌：平台会静默丢弃，消息停在"生成中"）
    const target = final || this.sent;
    const prefix = fitStreamPrefix(target, this.capacity);
    if (!prefix || (this.started && !prefix.startsWith(this.sent))) {
      if (this.started) this.finalized = await this.sendChunk(this.sent, 10);
      return fallback();
    }

    const ok = await this.sendChunk(prefix, 10);
    this.finalized = ok;
    if (!ok) {
      // 收尾片失败：已下发的前缀仍在，余下部分必须让调用方补发，不能整段丢弃
      return { streamed: true, sentText: this.sent, remainder: final.slice(this.sent.length) };
    }
    if (prefix.length < target.length) {
      console.log(
        `[qqbot] 流式消息容量 ${this.capacity ?? "?"} 字符：前 ${prefix.length} 字符已流式送达，` +
          `剩余 ${target.length - prefix.length} 字符转普通发送`
      );
    }
    return { streamed: true, sentText: prefix, remainder: final.slice(prefix.length) };
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule(): void {
    if (this.timer || this.closed || this.failed) return;
    const wait = Math.max(0, this.opts.minIntervalMs - (Date.now() - this.lastFlushAt));
    this.timer = setTimeout(() => {
      this.timer = null;
      this.chain = this.chain.then(() => this.flush()).catch(() => {});
    }, wait);
  }

  private async flush(): Promise<void> {
    if (this.closed || this.failed) return;
    const target = this.buffer;
    if (target === this.sent) return;
    if (!fitsStreamBudget(target, this.capacity)) {
      // 超容量：继续推会被平台静默丢弃 → 停止推送，等收尾时用能装下的前缀定型
      this.overBudget = true;
      console.log(
        `[qqbot] 流式已达长度预算（已发 ${this.sent.length} 字符，容量 ${this.capacity ?? "未知"}），` +
          `停止流式推送，剩余正文转普通发送`
      );
      return;
    }
    await this.sendChunk(target, 1);
  }

  private async sendChunk(text: string, inputState: 1 | 10): Promise<boolean> {
    const maxRetries = inputState === 1 ? STREAM_RETRY_DELAYS_MS.length : 1;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const index = this.index++; // 必须在请求前消费
      const chunk: C2CStreamChunk = {
        contentRaw: text,
        inputState,
        index,
        contentType: this.opts.contentType,
        msgId: this.opts.replyToId,
        msgSeq: this.msgSeq,
        ...(this.streamMsgId ? { streamMsgId: this.streamMsgId } : {}),
      };
      try {
        const res = this.opts.sender
          ? await this.opts.sender(chunk)
          : await streamC2CMessage(
              await getAccessToken(this.opts.appId, this.opts.clientSecret),
              this.opts.userOpenid,
              chunk
            );
        if (!this.streamMsgId && res.id) this.streamMsgId = res.id;
        if (res.remainMsgLen !== undefined) {
          // 平台第一次回报容量：remain + 本片长度 = 这条流式消息的总容量（字符）。
          // 多次回报时取**最小值**（若平台对某片做了截断，remain 会偏小 → 容量只会收紧不会放宽）。
          const derived = res.remainMsgLen + text.length;
          if (this.capacity === undefined || derived < this.capacity) {
            this.capacity = derived;
            console.log(
              `[qqbot] 流式消息容量 ≈ ${this.capacity} 字符（平台回报剩余 ${res.remainMsgLen} + 本片 ${text.length}）`
            );
          }
        }
        if (!this.started) {
          this.started = true;
          recordReply(this.opts.replyToId);
        }
        this.sent = text;
        this.lastFlushAt = Date.now();
        return true;
      } catch (err) {
        const apiErr = err instanceof StreamApiError ? err : null;
        const retryable =
          apiErr === null ||
          apiErr.status === 429 ||
          apiErr.errCode === 50002 ||
          apiErr.status >= 500;
        if (!retryable || attempt >= maxRetries) {
          this.failed = true;
          console.warn(
            `[qqbot] 流式分片失败，回退普通发送：${err instanceof Error ? err.message : String(err)}`
          );
          return false;
        }
        const delay = STREAM_RETRY_DELAYS_MS[Math.min(attempt, STREAM_RETRY_DELAYS_MS.length - 1)]!;
        console.warn(`[qqbot] 流式分片限流/网络错误，${delay}ms 后重试（index=${index + 1}）`);
        await sleep(delay);
      }
    }
    return false;
  }
}

/** 该 msg_id 是否还能被动回复（流式会话开始前检查） */
export function canReplyPassively(msgId: string): boolean {
  return checkLimit(msgId).allowed;
}
