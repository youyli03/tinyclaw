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
  img: "img",
  image: "img",
  pic: "img",
  photo: "img",
  picture: "img",
  qqimg: "img",
  qq_img: "img",
  qqimage: "img",
  qq_image: "img",
  qqpic: "img",
  qqphoto: "img",
  // 音频
  audio: "audio",
  voice: "audio",
  qqvoice: "audio",
  qq_voice: "audio",
  qqaudio: "audio",
  qq_audio: "audio",
  // 视频
  video: "video",
  qqvideo: "video",
  qq_video: "video",
  // 文件
  file: "file",
  doc: "file",
  document: "file",
  qqfile: "file",
  qq_file: "file",
  qqdoc: "file",
};

function extractAttr(attrStr: string, name: string): string | undefined {
  const m = new RegExp(`${name}="([^"]*)"`, "i").exec(attrStr);
  return m ? m[1] : undefined;
}

/**
 * 将文本中的代码块（围栏式 ``` 和行内 `）内容替换为占位符，返回替换后的文本和还原函数。
 * 用于防止代码块内的示例媒体标签（如 <img src="..."/>）被误识别为真实媒体。
 */
function maskCodeBlocks(text: string): { masked: string; restore: (s: string) => string } {
  const placeholders: string[] = [];
  // 先处理围栏式代码块（```...```），再处理行内代码（`...`）
  const masked = text
    .replace(/```[\s\S]*?```/g, (m) => {
      const idx = placeholders.push(m) - 1;
      return `\x00CODE${idx}\x00`;
    })
    .replace(/`[^`\n]+`/g, (m) => {
      const idx = placeholders.push(m) - 1;
      return `\x00CODE${idx}\x00`;
    });
  const restore = (s: string) =>
    s.replace(/\x00CODE(\d+)\x00/g, (_, i) => placeholders[Number(i)] ?? "");
  return { masked, restore };
}

/**
 * 将含有媒体标签的文本拆分为有序段落列表。
 * 纯文本输入（无媒体标签）返回单个 type="text" 段落。
 * 代码块（``` 和行内 `）内的内容不会被识别为媒体标签。
 */
export function parseMediaTags(text: string): MediaSegment[] {
  // 屏蔽代码块内容，避免示例标签（如 <img src="..."/>）被误识别
  const { masked, restore } = maskCodeBlocks(text);
  const workText = masked;

  // 匹配：<tagname attr="val" .../> 或 <tagname ...>content</tagname>
  const re = /<([a-z_]+)((?:\s+[a-z_-]+="[^"]*")*)\s*(?:\/>|>([\s\S]*?)<\/\1>)/gi;
  const segments: MediaSegment[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = re.exec(workText)) !== null) {
    const tagName = match[1]!.toLowerCase();
    const mediaType = ALIAS_MAP[tagName];
    if (!mediaType) continue; // 不是已知媒体标签，跳过

    // 把标签之前的文本推入段落（还原代码块占位符）
    if (match.index > lastIndex) {
      const textContent = restore(workText.slice(lastIndex, match.index));
      if (textContent.trim()) {
        segments.push({ type: "text", content: textContent });
      }
    }

    const attrStr = match[2] ?? "";
    const innerContent = match[3]?.trim() ?? "";
    // src 属性或标签内容作为路径/URL
    const src = extractAttr(attrStr, "src") ?? innerContent;
    const filename = extractAttr(attrStr, "name") ?? extractAttr(attrStr, "filename");

    if (src) {
      segments.push({
        type: mediaType,
        content: src,
        ...(filename ? { filename } : {}),
      });
    }

    lastIndex = match.index + match[0].length;
  }

  // 尾部剩余文本（还原代码块占位符）
  if (lastIndex < workText.length) {
    const remaining = restore(workText.slice(lastIndex));
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

// ── 媒体标签的拆分与流式安全剥离 ──────────────────────────────────────────────

/** 与 parseMediaTags 共用同一条标签正则（保持识别口径一致） */
const MEDIA_TAG_RE = /<([a-z_]+)((?:\s+[a-z_-]+="[^"]*")*)\s*(?:\/>|>([\s\S]*?)<\/\1>)/gi;

/**
 * 把文本**无损**拆成「正文」与「媒体标签串」两部分。
 *
 * 与 `parseMediaTags` 的区别：后者会丢弃纯空白的文本段（用于按段落发送），
 * 而本函数必须**逐字符保留**正文（含空行与缩进），因为它的产物会被当作
 * "最终回复正文"展示给用户。
 *
 * 代码块内的示例标签同样不识别（与 parseMediaTags 口径一致）。
 *
 * 用途：流式回复里，正文走流式、媒体标签单独走普通发送路径——
 * 否则 `<file src=.../>` 会被当作纯文本展示，文件永远发不出去。
 */
export function splitMediaText(text: string): { text: string; mediaText: string } {
  const { masked, restore } = maskCodeBlocks(text);
  const mediaParts: string[] = [];
  const out = masked.replace(MEDIA_TAG_RE, (m, tag: string) => {
    if (!ALIAS_MAP[String(tag).toLowerCase()]) return m; // 不是媒体标签 → 原样保留
    mediaParts.push(m);
    return "";
  });
  return { text: restore(out), mediaText: mediaParts.join("") };
}

/** 末尾是否是「尚未闭合的媒体标签起始」（流式期间要暂时扣住，避免闪出半截标签） */
function looksLikeMediaTagStart(tail: string): boolean {
  const openOnly = /^<([a-z_]*)$/i.exec(tail);
  if (openOnly) {
    const name = (openOnly[1] ?? "").toLowerCase();
    if (name.length === 0) return true; // 刚收到 "<"
    return Object.keys(ALIAS_MAP).some((alias) => alias.startsWith(name));
  }
  const withAttr = /^<([a-z_]+)\s/i.exec(tail);
  return withAttr ? ALIAS_MAP[(withAttr[1] ?? "").toLowerCase()] !== undefined : false;
}

/**
 * 流式展示专用：删除媒体标签，并**扣住末尾未完成的标签起始**。
 *
 * 为什么需要它：流式是把 LLM 的增量逐段推给用户的，而媒体标签只能被
 * `sendMessage()` 正确消费（上传文件后再发消息）。若把标签原样推给用户，
 * 用户会看到 `<file src="/path" name="x.pdf"/>` 这样的裸文本。
 *
 * 必须是"累计文本 → 可见文本"的纯函数，且只做删除/扣留、绝不改写其它字符，
 * 这样调用方可以安全地只推送「可见文本的增长部分」。
 */
export function stripMediaForStream(text: string): string {
  const { masked, restore } = maskCodeBlocks(text);
  let out = masked.replace(MEDIA_TAG_RE, (m, tag: string) =>
    ALIAS_MAP[String(tag).toLowerCase()] ? "" : m
  );
  // 末尾未闭合的标签起始 → 暂时扣住（下一个 delta 补齐后再整体删除）
  const lt = out.lastIndexOf("<");
  if (lt >= 0 && out.indexOf(">", lt) === -1 && looksLikeMediaTagStart(out.slice(lt))) {
    out = out.slice(0, lt);
  }
  return restore(out);
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
