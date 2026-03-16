/**
 * 平台无关的富媒体标签解析工具
 *
 * LLM 输出示例：
 *   <img src="/path/to/chart.png"/>
 *   <audio src="/path/to/voice.mp3"/>
 *   <video src="https://example.com/clip.mp4"/>
 *   <file src="/path/to/doc.pdf" name="doc.pdf"/>
 *
 * 别名修正：qqimg/image/pic/photo → img；qqvoice/voice → audio；等
 */

export interface MediaSegment {
  type: "text" | "img" | "audio" | "video" | "file";
  /** 文本内容（type=text）或 本地路径/URL（type=media） */
  content: string;
  /** 文件名提示（type=media，可选） */
  filename?: string;
}

// 别名 → 规范类型
const ALIAS_MAP: Record<string, "img" | "audio" | "video" | "file"> = {
  // 图片
  img: "img", image: "img", pic: "img", photo: "img", picture: "img",
  qqimg: "img", qq_img: "img", qqimage: "img", qq_image: "img",
  qqpic: "img", qqphoto: "img",
  // 音频
  audio: "audio", voice: "audio",
  qqvoice: "audio", qq_voice: "audio", qqaudio: "audio", qq_audio: "audio",
  // 视频
  video: "video", qqvideo: "video", qq_video: "video",
  // 文件
  file: "file", doc: "file", document: "file",
  qqfile: "file", qq_file: "file", qqdoc: "file",
};

function extractAttr(attrStr: string, name: string): string | undefined {
  const m = new RegExp(`${name}="([^"]*)"`, "i").exec(attrStr);
  return m ? m[1] : undefined;
}

/**
 * 将含有媒体标签的文本拆分为有序段落列表。
 * 纯文本输入（无媒体标签）返回单个 type="text" 段落。
 */
export function parseMediaTags(text: string): MediaSegment[] {
  // 匹配：<tagname attr="val" .../> 或 <tagname ...>content</tagname>
  const re = /<([a-z_]+)((?:\s+[a-z_-]+="[^"]*")*)\s*(?:\/>|>([\s\S]*?)<\/\1>)/gi;
  const segments: MediaSegment[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = re.exec(text)) !== null) {
    const tagName = match[1]!.toLowerCase();
    const mediaType = ALIAS_MAP[tagName];
    if (!mediaType) continue; // 不是已知媒体标签，跳过

    // 把标签之前的文本推入段落
    if (match.index > lastIndex) {
      const textContent = text.slice(lastIndex, match.index);
      if (textContent.trim()) {
        segments.push({ type: "text", content: textContent });
      }
    }

    const attrStr = match[2] ?? "";
    const innerContent = match[3]?.trim() ?? "";
    // src 属性或标签内容作为路径/URL
    const src = extractAttr(attrStr, "src") ?? innerContent;
    const filename =
      extractAttr(attrStr, "name") ?? extractAttr(attrStr, "filename");

    if (src) {
      segments.push({
        type: mediaType,
        content: src,
        ...(filename ? { filename } : {}),
      });
    }

    lastIndex = match.index + match[0].length;
  }

  // 尾部剩余文本
  if (lastIndex < text.length) {
    const remaining = text.slice(lastIndex);
    if (remaining.trim()) {
      segments.push({ type: "text", content: remaining });
    }
  }

  // 没有识别到任何媒体标签——整段作为纯文本返回
  if (segments.length === 0) {
    return [{ type: "text", content: text }];
  }

  return segments;
}

// ── Vision 支持 ───────────────────────────────────────────────────────────────

import type { ContentPart } from "../../llm/client.js";

/**
 * 将含媒体标签的用户消息转为 LLM vision ContentPart[] 格式。
 * - 无图片标签 → 返回原始 string（不触发 vision 路径）
 * - 有图片标签 → 返回 ContentPart[]（text + image_path/image_url 交替）
 *   本地路径使用 image_path（延迟 base64 转换），HTTP URL 使用 image_url。
 */
export function buildVisionContent(text: string): string | ContentPart[] {
  const segments = parseMediaTags(text);
  if (!segments.some((s) => s.type === "img")) return text;

  const parts: ContentPart[] = [];
  for (const seg of segments) {
    if (seg.type === "text") {
      if (seg.content.trim()) {
        parts.push({ type: "text", text: seg.content });
      }
    } else if (seg.type === "img") {
      const src = seg.content;
      if (src.startsWith("http://") || src.startsWith("https://")) {
        parts.push({ type: "image_url", image_url: { url: src, detail: "auto" } });
      } else {
        // 本地路径：延迟读取，由 LLMClient 在 API 调用前转换为 base64
        parts.push({ type: "image_path", path: src });
      }
    }
    // audio/video/file 不传给视觉 API，跳过
  }
  return parts.length > 0 ? parts : text;
}
