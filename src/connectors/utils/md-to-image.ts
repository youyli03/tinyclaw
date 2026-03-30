/**
 * Markdown → 图片渲染工具
 *
 * 用于 Code 模式下将 LLM 返回的大段 Markdown 文本渲染为 PNG 图片，
 * 替代直接发送原始 md 格式文本（QQBot 无法渲染）。
 *
 * 渲染流程：
 *   1. markdown-it-py (Python) 将 md 转为 HTML（启用 table 扩展）
 *   2. 包裹为带样式的完整 HTML 页面（450px 宽，适配 QQ 聊天窗口）
 *   3. chromium-browser --headless 截图为 PNG
 *   4. PIL 智能裁剪底部多余白边
 *
 * 任何步骤失败均 throw Error，调用方应 catch 并降级为原始文本发送。
 */

import { spawn } from "node:child_process";
import { writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/** QQ 聊天图片适配宽度（px） */
const RENDER_WIDTH = 450;

// ── Markdown 特征检测 ─────────────────────────────────────────────────────────

/**
 * 判断文本是否含有明显的 Markdown 格式特征，值得渲染为图片。
 * 门槛设较高，避免把简短普通回复也渲染成图片。
 */
export function looksLikeMarkdown(text: string): boolean {
  // 跳过已包含媒体标签的文本（已有 img/audio/video 等，无需二次处理）
  if (/<(img|audio|video|file)\s/i.test(text)) return false;

  // 跳过过短文本（少于 200 字符的回复通常不需要渲染）
  if (text.length < 200) return false;

  let score = 0;

  // 代码块（最强信号，单独就足够触发）
  if (/```[\s\S]+?```/m.test(text)) score += 3;

  // 标题（# / ## / ###）
  if (/^#{1,4}\s+\S/m.test(text)) score += 2;

  // 有序/无序列表
  if (/^[\s]*[-*+]\s+\S/m.test(text)) score += 1;
  if (/^[\s]*\d+\.\s+\S/m.test(text)) score += 1;

  // 表格
  if (/\|.+\|.*\n\s*\|[\s-:|]+\|/m.test(text)) score += 2;

  // 粗体/斜体/行内代码
  if (/\*\*[^*\n]+\*\*|`[^`\n]+`/.test(text)) score += 1;

  // 需要 score >= 3 才触发（必须有代码块，或多种 md 元素组合）
  return score >= 3;
}

// ── HTML 模板 ─────────────────────────────────────────────────────────────────

function buildHtml(mdHtml: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8"/>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body {
    width: ${RENDER_WIDTH}px;
    overflow-x: hidden;
  }
  body {
    font-family: "Noto Sans CJK SC", "WenQuanYi Micro Hei", "Noto Sans", sans-serif;
    font-size: 14px;
    line-height: 1.7;
    color: #657b83;
    background: #fdf6e3;
    padding: 16px 18px;
    word-break: break-word;
  }
  h1, h2, h3, h4, h5, h6 {
    font-weight: 700;
    margin: 0.8em 0 0.4em;
    line-height: 1.3;
    color: #586e75;
  }
  h1 { font-size: 1.4em; border-bottom: 2px solid #268bd2; padding-bottom: 5px; }
  h2 { font-size: 1.2em; border-bottom: 1px solid #93a1a1; padding-bottom: 4px; }
  h3 { font-size: 1.05em; }
  h4 { font-size: 1em; }
  p { margin: 0.5em 0; }
  ul, ol { padding-left: 1.4em; margin: 0.4em 0; }
  li { margin: 0.15em 0; }
  code {
    font-family: "Consolas", "Source Code Pro", "Liberation Mono", monospace;
    background: #ddd8c4;
    color: #586e75;
    padding: 1px 5px;
    border-radius: 3px;
    font-size: 0.85em;
  }
  pre {
    background: #002b36;
    color: #839496;
    border-radius: 6px;
    padding: 10px 12px;
    margin: 0.6em 0;
    font-size: 0.82em;
    line-height: 1.55;
    /* 代码块自动换行，防止超出宽度 */
    white-space: pre-wrap;
    word-break: break-all;
    overflow-x: hidden;
  }
  pre code {
    background: transparent;
    color: inherit;
    padding: 0;
    font-size: inherit;
    white-space: inherit;
  }
  blockquote {
    border-left: 3px solid #268bd2;
    background: #eee8d5;
    padding: 6px 12px;
    margin: 0.5em 0;
    color: #657b83;
    border-radius: 0 4px 4px 0;
  }
  table {
    border-collapse: collapse;
    width: 100%;
    margin: 0.6em 0;
    font-size: 0.9em;
  }
  th, td {
    border: 1px solid #93a1a1;
    padding: 5px 8px;
    text-align: left;
    word-break: break-word;
  }
  th { background: #eee8d5; font-weight: 600; }
  tr:nth-child(even) td { background: #f5f0e0; }
  a { color: #268bd2; text-decoration: none; }
  hr { border: none; border-top: 1px solid #93a1a1; margin: 0.8em 0; }
  strong { font-weight: 700; color: #586e75; }
  em { font-style: italic; color: #657b83; }
</style>
</head>
<body>
${mdHtml}
</body>
</html>`;
}

// ── Python 调用：Markdown → HTML ──────────────────────────────────────────────

function markdownToHtml(mdText: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // 使用 commonmark preset 并启用 table 扩展（支持 GFM 风格表格）
    const py = spawn("python3", ["-c", `
import sys
from markdown_it import MarkdownIt
md = MarkdownIt("commonmark", {"html": False, "typographer": True}).enable("table")
content = sys.stdin.read()
print(md.render(content), end="")
`], { stdio: ["pipe", "pipe", "pipe"] });

    let out = "";
    let err = "";
    py.stdout.on("data", (d: Buffer) => { out += d.toString("utf-8"); });
    py.stderr.on("data", (d: Buffer) => { err += d.toString("utf-8"); });
    py.on("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`markdown-it-py 失败 (code=${code}): ${err.trim()}`));
    });
    py.on("error", (e) => reject(new Error(`python3 启动失败: ${e.message}`)));

    py.stdin.write(mdText, "utf-8");
    py.stdin.end();
  });
}

// ── Chromium headless 截图 ────────────────────────────────────────────────────

function chromiumScreenshot(htmlPath: string, outPng: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      "--headless",
      "--disable-gpu",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      `--screenshot=${outPng}`,
      `--window-size=${RENDER_WIDTH},30000`,
      "--hide-scrollbars",
      `file://${htmlPath}`,
    ];
    const child = spawn("chromium-browser", args, { stdio: ["ignore", "pipe", "pipe"] });

    let stderr = "";
    child.stderr.on("data", (d: Buffer) => { stderr += d.toString("utf-8"); });

    child.on("close", (code) => {
      if (existsSync(outPng)) {
        resolve(); // 图片已生成即视为成功（部分版本非零退出但结果正常）
      } else {
        reject(new Error(`chromium 截图文件未生成 (code=${code})\n${stderr.slice(0, 300)}`));
      }
    });

    child.on("error", (e) => reject(new Error(`chromium-browser 启动失败: ${e.message}`)));
  });
}

// ── PIL 智能裁剪（去除底部多余白边）─────────────────────────────────────────

function cropImage(inPng: string, outPng: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const py = spawn("python3", ["-c", `
import sys
import numpy as np
from PIL import Image

img = Image.open(sys.argv[1]).convert("RGB")
arr = np.array(img)

# 找最后一行不是纯白(R>250 & G>250 & B>250)的位置
white = (arr[:,:,0] > 250) & (arr[:,:,1] > 250) & (arr[:,:,2] > 250)
non_white_rows = np.where(~white.all(axis=1))[0]

if len(non_white_rows) == 0:
    img.save(sys.argv[2])
    sys.exit(0)

bottom = min(img.height, int(non_white_rows[-1]) + 20)
cropped = img.crop((0, 0, img.width, bottom))
cropped.save(sys.argv[2])
`, inPng, outPng], { stdio: ["ignore", "pipe", "pipe"] });

    let err = "";
    py.stderr.on("data", (d: Buffer) => { err += d.toString("utf-8"); });
    py.on("close", (code) => {
      if (code === 0 && existsSync(outPng)) resolve();
      else reject(new Error(`PIL 裁剪失败 (code=${code}): ${err.trim()}`));
    });
    py.on("error", (e) => reject(new Error(`python3 (PIL) 启动失败: ${e.message}`)));
  });
}

// ── PIL PNG → JPEG 转换（大幅减小文件体积）────────────────────────────────────

function pngToJpeg(inPng: string, outJpg: string, quality = 85): Promise<void> {
  return new Promise((resolve, reject) => {
    const py = spawn("python3", ["-c", `
import sys
from PIL import Image

img = Image.open(sys.argv[1]).convert("RGB")
img.save(sys.argv[2], "JPEG", quality=int(sys.argv[3]), optimize=True)
`, inPng, outJpg, String(quality)], { stdio: ["ignore", "pipe", "pipe"] });

    let err = "";
    py.stderr.on("data", (d: Buffer) => { err += d.toString("utf-8"); });
    py.on("close", (code) => {
      if (code === 0 && existsSync(outJpg)) resolve();
      else reject(new Error(`PIL JPEG 转换失败 (code=${code}): ${err.trim()}`));
    });
    py.on("error", (e) => reject(new Error(`python3 (PIL) 启动失败: ${e.message}`)));
  });
}

// ── 主函数 ────────────────────────────────────────────────────────────────────

let _counter = 0;

/**
 * 将 Markdown 文本渲染为 JPEG 图片，返回图片绝对路径。
 * 失败时 throw Error，调用方应 catch 并降级。
 *
 * @param mdText    Markdown 原文
 * @param outputDir 输出目录（默认系统 tmp）
 */
export async function mdToImage(
  mdText: string,
  outputDir?: string
): Promise<string> {
  const dir = outputDir ?? tmpdir();
  mkdirSync(dir, { recursive: true });

  const id = `md_${Date.now()}_${++_counter}`;
  const htmlPath = join(dir, `${id}.html`);
  const rawPng   = join(dir, `${id}_raw.png`);
  const finalPng = join(dir, `${id}.png`);
  const finalJpg = join(dir, `${id}.jpg`);

  // Step 1: Markdown → HTML（含 GFM 表格）
  const mdHtml = await markdownToHtml(mdText);

  // Step 2: 包裹为完整 HTML 页面（固定 450px 宽）
  const fullHtml = buildHtml(mdHtml);
  writeFileSync(htmlPath, fullHtml, "utf-8");

  // Step 3: chromium headless 截图
  await chromiumScreenshot(htmlPath, rawPng);

  // Step 4: 裁剪底部多余白边
  let croppedPath = rawPng;
  try {
    await cropImage(rawPng, finalPng);
    croppedPath = finalPng;
  } catch {
    // 裁剪失败则用原始截图继续
  }

  // Step 5: PNG → JPEG（JPEG 对文字截图体积比 PNG 小 5-8 倍，避免 QQ 上传超限）
  try {
    await pngToJpeg(croppedPath, finalJpg);
    // 删除中间 PNG 临时文件
    for (const f of [rawPng, finalPng]) {
      try { unlinkSync(f); } catch { /* ignore */ }
    }
    return finalJpg;
  } catch {
    // JPEG 转换失败则回退返回裁剪后的 PNG
    return croppedPath;
  }
}
