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
        "将 Markdown 格式的快报渲染为图片，立即推送给用户。\n\n" +
        "适用于：定时简报、数据汇总、结构化通知等需要精美排版的主动推送场景。\n" +
        "调用后立即发送，不等当前任务结束，不影响后续工具调用。\n" +
        "支持三种内容类型：\n" +
        "（1）markdown（默认）：支持标题、列表、表格、代码块、粗体等完整 Markdown 语法；\n" +
        "（2）mermaid：流程图/时序图/类图/甘特图/饼图等，传入 mermaid 语法代码；\n" +
        "（3）python：任意 Python 绘图代码（matplotlib/graphviz 等）。\n" +
        "渲染失败时自动降级为纯文本发送。",
      parameters: {
        type: "object",
        properties: {
          markdown: {
            type: "string",
            description: "Markdown 格式的快报正文（type=markdown 时必填，其余类型可选用于描述文字）",
          },
          type: {
            type: "string",
            enum: ["markdown", "mermaid", "python"],
            description: "内容类型：markdown（默认）/ mermaid（图表代码）/ python（绘图代码）",
          },
          code: {
            type: "string",
            description: "图表代码（type=mermaid 或 type=python 时使用）",
          },
          title: {
            type: "string",
            description: "（可选）快报标题，用于日志记录，方便归档查找",
          },
          filename: {
            type: "string",
            description: "（可选）输出文件名（不含扩展名），默认自动生成时间戳文件名",
          },
          theme: {
            type: "string",
            enum: ["light", "dark"],
            description: "（可选）主题：light（默认）或 dark。仅对 mermaid 类型有效。",
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

    const notify = ctx?.onNotify ?? ((msg: string) => {
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
