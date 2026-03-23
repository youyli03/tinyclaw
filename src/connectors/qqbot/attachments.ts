/**
 * QQBot 入站附件下载
 *
 * 用户发给机器人的图片/语音/文件，先下载到 agent 的 workspace/downloads/ 目录，
 * 再以 <img>/<audio>/<video>/<file> 标签形式追加到消息内容，供 LLM 读取。
 */

import type { Attachment } from "../base.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";

export interface DownloadedAttachment {
  originalUrl: string;
  localPath: string;
  contentType: string;
  filename: string;
  /** 语音转文字结果（仅 audio/* 附件，转录成功后填充） */
  transcript?: string;
}

function contentTypeToTag(contentType: string): string {
  if (contentType.startsWith("image/")) return "img";
  if (contentType.startsWith("audio/")) return "audio";
  if (contentType.startsWith("video/")) return "video";
  return "file";
}

function guessExtension(contentType: string): string {
  const map: Record<string, string> = {
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
    "audio/mpeg": ".mp3",
    "audio/wav": ".wav",
    "audio/ogg": ".ogg",
    "audio/silk": ".silk",
    "audio/amr": ".amr",
    "audio/aac": ".aac",
    "audio/mp4": ".m4a",
    "audio/flac": ".flac",
    "video/mp4": ".mp4",
    "video/webm": ".webm",
  };
  return map[contentType] ?? "";
}

/** 根据文件扩展名补全缺失或不精确的 content-type。
 *  QQ Bot 有时对语音附件返回 application/octet-stream 或空字符串。 */
function normalizeContentType(contentType: string, ext: string): string {
  // 已经是规范 MIME 类型，直接使用
  if (
    contentType.startsWith("audio/") ||
    contentType.startsWith("image/") ||
    contentType.startsWith("video/") ||
    contentType.startsWith("text/")
  ) {
    return contentType;
  }
  // 按扩展名推断
  const byExt: Record<string, string> = {
    ".amr":  "audio/amr",
    ".silk": "audio/silk",
    ".mp3":  "audio/mpeg",
    ".wav":  "audio/wav",
    ".ogg":  "audio/ogg",
    ".flac": "audio/flac",
    ".aac":  "audio/aac",
    ".m4a":  "audio/mp4",
    ".mp4":  "video/mp4",
    ".webm": "video/webm",
    ".jpg":  "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png":  "image/png",
    ".gif":  "image/gif",
    ".webp": "image/webp",
  };
  return byExt[ext.toLowerCase()] ?? contentType;
}

/**
 * 将消息附件列表批量下载到 destDir（自动创建）。
 * 对语音附件优先使用 voiceWavUrl（官方 WAV 直链，可跳过 SILK→WAV 转换）。
 */
export async function downloadAttachments(
  attachments: Attachment[],
  destDir: string
): Promise<DownloadedAttachment[]> {
  fs.mkdirSync(destDir, { recursive: true });
  const results: DownloadedAttachment[] = [];

  for (const att of attachments) {
    const downloadUrl = att.voiceWavUrl ?? att.url;
    try {
      const resp = await fetch(downloadUrl, { signal: AbortSignal.timeout(120_000) });
      if (!resp.ok) {
        console.warn(`[attachments] 下载失败 ${downloadUrl}: ${resp.status}`);
        continue;
      }
      const buffer = Buffer.from(await resp.arrayBuffer());
      const rawContentType = att.voiceWavUrl ? "audio/wav" : att.contentType;
      const ext = att.filename
        ? path.extname(att.filename)
        : guessExtension(rawContentType);
      const basename = att.filename ?? `${crypto.randomUUID()}${ext}`;
      // 用扩展名修正 QQ 有时返回的不精确 content-type（如 application/octet-stream）
      const effectiveContentType = normalizeContentType(rawContentType, ext);
      const localPath = path.join(destDir, basename);
      fs.writeFileSync(localPath, buffer);
      results.push({
        originalUrl: att.url,
        localPath,
        contentType: effectiveContentType,
        filename: basename,
      });
    } catch (err) {
      console.warn(`[attachments] 下载异常 ${downloadUrl}:`, err);
    }
  }

  return results;
}

/**
 * 将原始消息内容与已下载附件合并：
 * - 音频附件：若已转录则输出 "[语音转文字]: {transcript}"，否则保留 <audio> 标签
 * - 其他附件：以 <tag src="localPath" name="filename"/> 追加到内容末尾
 */
export function buildEnrichedContent(
  originalContent: string,
  downloaded: DownloadedAttachment[]
): string {
  if (downloaded.length === 0) return originalContent;
  const parts = [originalContent.trim()];
  for (const d of downloaded) {
    if (d.contentType.startsWith("audio/") && d.transcript !== undefined) {
      parts.push(`[语音转文字]: ${d.transcript}`);
    } else {
      const tag = contentTypeToTag(d.contentType);
      parts.push(`<${tag} src="${d.localPath}" name="${d.filename}"/>`);
    }
  }
  return parts.join("\n");
}
