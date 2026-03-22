/**
 * send_report 工具 — Agent 主动将 Markdown 快报渲染为图片推送给用户
 *
 * 工作流：
 *   1. 调用 mdToImage 将 Markdown 文本渲染为 PNG 图片
 *   2. 通过 ctx.onNotify 发送 <img src="..."/> 标签（走现有媒体链路）
 *   3. 若渲染失败，降级为发送原始 Markdown 文本
 *
 * 适用场景：定时快报、数据汇总、结构化通知等需要格式化排版的主动推送。
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { registerTool, type ToolContext } from "./registry.js";
import { mdToImage } from "../connectors/utils/md-to-image.js";

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
        "支持标题、列表、表格、代码块、粗体等完整 Markdown 语法。\n" +
        "渲染失败时自动降级为纯文本发送。",
      parameters: {
        type: "object",
        properties: {
          markdown: {
            type: "string",
            description: "快报正文，Markdown 格式（支持标题/列表/表格/代码块等）",
          },
          title: {
            type: "string",
            description: "（可选）快报标题，用于日志记录，方便归档查找",
          },
        },
        required: ["markdown"],
      },
    },
  },
  execute: async (args: Record<string, unknown>, ctx?: ToolContext): Promise<string> => {
    const markdown = String(args["markdown"] ?? "").trim();
    const title = args["title"] ? String(args["title"]).trim() : undefined;

    if (!markdown) return "错误：缺少 markdown 参数";

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

    // 尝试渲染为图片
    let imgPath: string | null = null;
    let renderError: string | null = null;
    try {
      imgPath = await mdToImage(markdown, outDir);
    } catch (err) {
      renderError = err instanceof Error ? err.message : String(err);
    }

    const notify = ctx?.onNotify ?? ((msg: string) => {
      console.log(`[send_report]${title ? ` [${title}]` : ""} ${msg}`);
      return Promise.resolve();
    });

    if (imgPath) {
      await notify(`<img src="${imgPath}"/>`);
      return `快报已发送（图片）${title ? `：${title}` : ""}`;
    } else {
      // 降级：发送原始 Markdown 文本
      await notify(markdown);
      return `快报已发送（纯文本，渲染失败：${renderError ?? "未知错误"}）`;
    }
  },
});
