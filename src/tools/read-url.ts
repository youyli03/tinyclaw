/**
 * read_url — 通过无头浏览器访问 URL，提取文本/截图并缓存到本地
 *
 * 实现方式：spawnSync 调用独立 Node.js 脚本（避免与 browser MCP 竞争进程）
 * 缓存路径：~/.tinyclaw/cache/web/{hostname}/{YYYY-MM-DD}-{hash8}.{md|png}
 *
 * 使用场景：
 * - 访问 search_newsnow 返回的新闻链接，读取正文
 * - 访问任意 URL 提取内容
 */
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { registerTool, type ToolContext } from "./registry.js";

const CACHE_DIR = path.join(os.homedir(), ".tinyclaw", "cache", "web");
const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "scripts", "read-url.mjs");

function urlToFilename(url: string, ext: string): string {
  const u = new URL(url);
  const hostname = u.hostname.replace(/[^a-z0-9.-]/gi, "_");
  const hash8 = crypto.createHash("md5").update(url).digest("hex").slice(0, 8);
  const date = new Date().toISOString().slice(0, 10);
  const dir = path.join(CACHE_DIR, hostname);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${date}-${hash8}.${ext}`);
}

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "read_url",
      description:
        "通过无头浏览器访问 URL，提取页面文本和/或截图，缓存到本地。\n" +
        "适合访问财经新闻链接（华尔街见闻/财联社等）读取正文，支持动态渲染页面（JS 渲染）。\n" +
        "缓存路径：~/.tinyclaw/cache/web/{hostname}/{date}-{hash}.{md|png}",
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "要访问的网页 URL",
          },
          mode: {
            type: "string",
            enum: ["text", "screenshot", "both", "html"],
            description: "获取模式：text（提取正文，默认）/ screenshot（截图）/ both（文本+截图）",
          },
          wait_ms: {
            type: "number",
            description: "页面加载后额外等待时间（毫秒，默认 2000），用于等待 JS 渲染完成",
          },
          width: {
            type: "number",
            description: "viewport 宽度(像素,默认 1280)。截图时也影响全页宽度",
          },
          offset: {
            type: "number",
            description:
              "截图模式:起始 Y 像素(设置后只截 offset~offset+900px 区域)；文字模式:字符偏移量(从第 offset 个字符开始返回)",
          },
        },
        required: ["url"],
      },
    },
  },

  async execute(args: Record<string, unknown>, _ctx?: ToolContext): Promise<string> {
    const url = String(args["url"] ?? "").trim();
    if (!url) return "错误：缺少 url 参数";
    if (!url.startsWith("http")) return `错误：不支持的 URL 格式: ${url}`;

    const mode = String(args["mode"] ?? "text") as "text" | "screenshot" | "both" | "html";
    const wait_ms = Math.min(10000, Math.max(0, Number(args["wait_ms"] ?? 2000)));
    const vp_width = Math.max(320, Math.min(3840, Number(args["width"] ?? 1280)));
    const offset = Math.max(0, Number(args["offset"] ?? 0));

    // 预生成缓存路径
    let textPath = "";
    let imgPath = "";
    let htmlPath = "";
    if (mode === "text" || mode === "both") {
      textPath = urlToFilename(url, "md");
    }
    if (mode === "screenshot" || mode === "both") {
      imgPath = urlToFilename(url, "png");
    }
    if (mode === "html") {
      htmlPath = urlToFilename(url, "html");
    }

    const spawnArgs = [
      SCRIPT,
      "--url",
      url,
      "--mode",
      mode,
      "--wait-ms",
      String(wait_ms),
      "--width",
      String(vp_width),
      "--offset",
      String(offset),
    ];
    if (textPath) spawnArgs.push("--text-out", textPath);
    if (imgPath) spawnArgs.push("--img-out", imgPath);
    if (htmlPath) spawnArgs.push("--html-out", htmlPath);

    const result = spawnSync("node", spawnArgs, {
      encoding: "utf-8",
      timeout: 60_000,
    });

    if (result.error) return `执行失败: ${result.error}`;
    if (result.status !== 0) return `脚本错误:\n${result.stderr?.slice(0, 500)}`;

    let parsed: {
      url: string;
      textPath?: string;
      imgPath?: string;
      htmlPath?: string;
      htmlLength?: number;
      textLength?: number;
      textPreview?: string;
      error?: string;
    };
    try {
      parsed = JSON.parse(result.stdout ?? "{}");
    } catch {
      return `JSON 解析失败: ${result.stdout?.slice(0, 200)}`;
    }

    if (parsed.error) return `读取失败: ${parsed.error}`;

    const lines: string[] = [`**read_url 结果** | ${url}`];
    if (parsed.textPath) {
      lines.push(`📄 文本已保存: \`${parsed.textPath}\` (${parsed.textLength ?? 0} 字符)`);
      if (parsed.textPreview) {
        lines.push("", "**正文预览（前 800 字符）：**", parsed.textPreview);
      }
    }
    if (parsed.imgPath) {
      lines.push(`📸 截图已保存: \`${parsed.imgPath}\``);
      lines.push(`<img src="${parsed.imgPath}"/>`);
    }
    if (parsed.htmlPath) {
      lines.push(`🌐 HTML 已保存: \`${parsed.htmlPath}\` (${parsed.htmlLength ?? 0} 字节)`);
    }
    return lines.join("\n");
  },
});
