#!/usr/bin/env node
/**
 * read-url.mjs — 无头浏览器访问 URL，提取文本和/或截图
 *
 * 用法:
 *   node read-url.mjs --url <URL> [--mode text|screenshot|both|html]
 *                     [--wait-ms 2000] [--text-out /path/to/file.md]
 *                     [--img-out /path/to/file.png]
 *                     [--html-out /path/to/file.html]
 *                     [--width 1280] [--offset 0]
 *
 * 依赖: playwright-core（已在 tinyclaw 主包安装）
 * 输出: JSON 到 stdout
 */
import { chromium } from "playwright-core";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const CHROMIUM_PATH = process.env.CHROMIUM_PATH ?? "/usr/bin/chromium-browser";

/** 解析命令行参数 */
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      const key = argv[i].slice(2);
      const val = argv[i + 1];
      args[key] = val;
      i++;
    }
  }
  return args;
}

/** 提取页面主要文本内容 */
async function extractText(page) {
  return await page.evaluate(() => {
    // 移除无用元素
    const selectors = [
      "script", "style", "nav", "header", "footer",
      ".ad", ".ads", ".advertisement", ".cookie",
      "[class*='nav']", "[class*='menu']", "[class*='sidebar']",
      "[id*='nav']", "[id*='menu']",
    ];
    for (const sel of selectors) {
      document.querySelectorAll(sel).forEach(el => el.remove());
    }
    // 优先取正文容器
    const candidates = [
      "article", "main", "[class*='content']", "[class*='article']",
      "[class*='post']", "[class*='entry']", ".detail-content",
      "[class*='detail']", "#article-content", ".news-detail",
    ];
    for (const sel of candidates) {
      const el = document.querySelector(sel);
      if (el && el.textContent && el.textContent.trim().length > 200) {
        return el.textContent.trim();
      }
    }
    return document.body?.textContent?.trim() ?? "";
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const url = args["url"];
  const mode = args["mode"] ?? "text";
  const waitMs = parseInt(args["wait-ms"] ?? "2000", 10);
  const textOut = args["text-out"];
  const imgOut = args["img-out"];
  const htmlOut = args["html-out"];
  const vpWidth = parseInt(args["width"] ?? "1280", 10);
  const vpHeight = 900;
  const offset = parseInt(args["offset"] ?? "0", 10);

  if (!url) {
    console.log(JSON.stringify({ error: "缺少 --url 参数" }));
    process.exit(1);
  }

  let browser;
  const result = { url, textPath: textOut, imgPath: imgOut, htmlPath: htmlOut ?? undefined };

  try {
    browser = await chromium.launch({
      executablePath: CHROMIUM_PATH,
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-web-security",
      ],
    });

    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      viewport: { width: vpWidth, height: vpHeight },
    });

    const page = await context.newPage();
    await page.goto(url, { waitUntil: "networkidle", timeout: 30_000 });

    if (waitMs > 0) {
      await page.waitForTimeout(waitMs);
    }

    // 提取文本
    if (mode === "text" || mode === "both") {
      const text = await extractText(page);
      const title = await page.title();
      // offset 支持：字符切片
      const slicedText = offset > 0 ? text.slice(offset) : text;
      const markdown = `# ${title}\n\n> 来源:${url}\n\n${slicedText}`;

      if (textOut) {
        mkdirSync(dirname(textOut), { recursive: true });
        writeFileSync(textOut, markdown, "utf-8");
        result.textLength = text.length;
        result.textPreview = slicedText.slice(0, 800);
      } else {
        result.textPreview = slicedText.slice(0, 2000);
        result.textLength = text.length;
      }
    }

    // 截图
    if (mode === "screenshot" || mode === "both") {
      if (imgOut) {
        mkdirSync(dirname(imgOut), { recursive: true });
        if (offset > 0) {
          // 从 offset Y 位置截取 viewport 高度的区域
          await page.screenshot({
            path: imgOut,
            fullPage: false,
            clip: { x: 0, y: offset, width: vpWidth, height: vpHeight },
            type: "png",
          });
        } else {
          // 默认截全页
          await page.screenshot({ path: imgOut, fullPage: true, type: "png" });
        }
      }
    }

    // 保存 HTML
    if (mode === "html" || htmlOut) {
      const html = await page.content();
      const outPath = htmlOut;
      if (outPath) {
        mkdirSync(dirname(outPath), { recursive: true });
        writeFileSync(outPath, html, "utf-8");
        result.htmlPath = outPath;
        result.htmlLength = html.length;
      } else {
        // 未指定路径时也记录长度
        result.htmlLength = (await page.content()).length;
      }
    }

    await browser.close();
    console.log(JSON.stringify(result));
  } catch (err) {
    if (browser) {
      try { await browser.close(); } catch { /* ignore */ }
    }
    console.log(JSON.stringify({ url, error: String(err?.message ?? err) }));
    process.exit(1);
  }
}

main();
