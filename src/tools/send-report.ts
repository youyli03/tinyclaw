/**
 * send_report 工具 — Agent 主动将内容渲染为图片立即推送给用户
 *
 * 支持三种内容类型：
 *   1. markdown（默认）：将 Markdown 文本渲染为 PNG 图片，通过 mdToImage
 *   2. mermaid：将 mermaid 图表代码渲染为 PNG，通过 render-core
 *   3. python：将 Python 绘图代码渲染为 PNG，通过 render-core
 *
 * 与 render_diagram 的区别：
 *   - render_diagram 返回 <img> 标签字符串，由 LLM 控制发出时机（适合内联回复）
 *   - send_report 立即调用 ctx.onNotify() 推送，不等当前任务结束（适合定时任务/进度汇报）
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { registerTool, type ToolContext } from "./registry.js";
import { mdToImage } from "../connectors/utils/md-to-image.js";
import {
  renderMermaidToFile,
  renderPythonToFile,
  timestampName,
} from "../connectors/utils/render-core.js";

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "send_report",
      description:
        "Render Markdown to an image and push it immediately. type: markdown (default; " +
        "supports headings/lists/tables/code blocks) / mermaid (diagram code) / python " +
        "(plotting code).\n" +
        "On render failure it automatically falls back to sending plain text",
      parameters: {
        type: "object",
        properties: {
          markdown: {
            type: "string",
            description:
              "Report body in Markdown (required when type=markdown; optional caption for others)",
          },
          type: {
            type: "string",
            enum: ["markdown", "mermaid", "python"],
            description: "Content type: markdown (default) / mermaid (diagram) / python (plot)",
          },
          code: {
            type: "string",
            description: "Diagram code (used when type=mermaid or type=python)",
          },
          title: {
            type: "string",
            description: "(Optional) Report title, logged for easier archiving and lookup",
          },
          filename: {
            type: "string",
            description:
              "(Optional) Output file name without extension, defaults to a timestamp name",
          },
          theme: {
            type: "string",
            enum: ["light", "dark"],
            description: "Optional theme: light (default) or dark. Only for the mermaid type.",
          },
        },
        required: [],
      },
    },
  },
  execute: async (args: Record<string, unknown>, ctx?: ToolContext): Promise<string> => {
    const contentType = (args["type"] as string | undefined) ?? "markdown";
    const markdown = String(args["markdown"] ?? "").trim();
    const code = String(args["code"] ?? "").trim();
    const title = args["title"] ? String(args["title"]).trim() : undefined;
    const filename = args["filename"] ? String(args["filename"]).trim() : undefined;
    const theme = (args["theme"] === "dark" ? "dark" : "light") as "light" | "dark";

    // 确定输出目录
    const agentId = ctx?.agentId ?? "default";
    const outDir = join(
      homedir(),
      ".tinyclaw",
      "agents",
      agentId,
      "workspace",
      "output",
      "reports"
    );
    mkdirSync(outDir, { recursive: true });

    const notify =
      ctx?.onNotify ??
      ((msg: string) => {
        console.log(`[send_report]${title ? ` [${title}]` : ""} ${msg}`);
        return Promise.resolve();
      });

    // 尝试渲染为图片
    let imgPath: string | null = null;
    let renderError: string | null = null;

    try {
      if (contentType === "mermaid") {
        if (!code) throw new Error("type=mermaid 时 code 参数不能为空");
        const outPath = join(outDir, timestampName(filename, "png"));
        await renderMermaidToFile(code, outPath, theme);
        imgPath = outPath;
      } else if (contentType === "python") {
        if (!code) throw new Error("type=python 时 code 参数不能为空");
        const outPath = join(outDir, timestampName(filename, "png"));
        await renderPythonToFile(code, outPath);
        imgPath = outPath;
      } else {
        // 默认 markdown 类型
        if (!markdown) throw new Error("markdown 参数不能为空");
        imgPath = await mdToImage(markdown, outDir);
      }
    } catch (err) {
      renderError = err instanceof Error ? err.message : String(err);
    }

    if (imgPath) {
      await notify(`<img src="${imgPath}"/>`);
      return `快报已发送（图片）${title ? `：${title}` : ""}`;
    } else {
      // 降级：发送原始文本（markdown 类型用 markdown，其他类型用 code）
      const fallbackText = contentType === "markdown" ? markdown : code;
      if (fallbackText) await notify(fallbackText);
      return `快报已发送（纯文本，渲染失败：${renderError ?? "未知错误"}）`;
    }
  },
});
