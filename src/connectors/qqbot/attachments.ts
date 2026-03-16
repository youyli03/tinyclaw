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
    "video/mp4": ".mp4",
    "video/webm": ".webm",
  };
  return map[contentType] ?? "";
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
      const resp = await fetch(downloadUrl);
      if (!resp.ok) {
        console.warn(`[attachments] 下载失败 ${downloadUrl}: ${resp.status}`);
        continue;
      }
      const buffer = Buffer.from(await resp.arrayBuffer());
      const effectiveContentType = att.voiceWavUrl
        ? "audio/wav"
        : att.contentType;
      const ext = att.filename
        ? path.extname(att.filename)
        : guessExtension(effectiveContentType);
      const basename = att.filename ?? `${crypto.randomUUID()}${ext}`;
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
 * 每个附件以 <tag src="localPath" name="filename"/> 追加到内容末尾。
 */
export function buildEnrichedContent(
  originalContent: string,
  downloaded: DownloadedAttachment[]
): string {
  if (downloaded.length === 0) return originalContent;
  const parts = [originalContent.trim()];
  for (const d of downloaded) {
    const tag = contentTypeToTag(d.contentType);
    parts.push(`<${tag} src="${d.localPath}" name="${d.filename}"/>`);
  }
  return parts.join("\n");
}
