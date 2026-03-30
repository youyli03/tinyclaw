import { join } from "node:path";
import { registerTool } from "./registry.js";
import type { ToolContext } from "./registry.js";
import {
  renderMermaidToFile,
  renderPythonToFile,
  resolveOutputDir,
  timestampName,
} from "../connectors/utils/render-core.js";

// ── 工具结果格式化 ────────────────────────────────────────────────────────────

function ok(imgPath: string): string {
  return `✅ 图片已生成\n<img src="${imgPath}"/>`;
}

function fail(type: string, detail: string): string {
  return (
    `❌ 渲染失败（${type}），请修正代码后重新调用 render_diagram。\n` +
    `错误信息：\n${detail}`
  );
}

// ── 工具注册 ──────────────────────────────────────────────────────────────────

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "render_diagram",
      description:
        "将图表代码渲染为图片，通过 QQ 发送。支持两种类型：" +
        "（1）mermaid：流程图/时序图/类图/状态机/ER图/甘特图/饼图等，传入 mermaid 语法代码；" +
        "（2）python：任意 Python 绘图代码（matplotlib/graphviz 等），代码直接生成图形即可，" +
        "无需手动 savefig（工具会自动保存），或手动调用 plt.savefig(os.environ[\"DIAGRAM_OUTPUT_FILE\"]) 指定路径。" +
        "渲染失败时工具会返回详细错误，请根据错误修正代码后重试。",
      parameters: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["mermaid", "python"],
            description: "图表类型：mermaid（流程图/架构图）或 python（数据图表/自定义绘图）",
          },
          code: {
            type: "string",
            description:
              "mermaid 语法代码（如 `graph LR\\n  A-->B`）" +
              "或 Python 绘图代码（如 `import matplotlib.pyplot as plt\\nplt.plot([1,2,3])`）",
          },
          filename: {
            type: "string",
            description: "输出文件名（不含扩展名），默认自动生成时间戳文件名",
          },
          theme: {
            type: "string",
            enum: ["light", "dark"],
            description: "mermaid 图表配色主题：light（亮色，默认）或 dark（暗色/技术风格）。python 类型忽略此参数。",
          },
        },
        required: ["type", "code"],
      },
    },
  },
  execute: async (args: Record<string, unknown>, ctx?: ToolContext) => {
    const type = String(args["type"] ?? "").trim() as "mermaid" | "python";
    const code = String(args["code"] ?? "").trim();
    const filename = args["filename"] ? String(args["filename"]).trim() : undefined;
    const theme = (args["theme"] === "dark" ? "dark" : "light") as "light" | "dark";

    if (!code) return fail(type, "code 参数不能为空");
    if (type !== "mermaid" && type !== "python") {
      return fail(type, "type 必须为 'mermaid' 或 'python'");
    }

    const outDir = resolveOutputDir(ctx?.agentId);
    const outPath = join(outDir, timestampName(filename, "png"));

    try {
      if (type === "mermaid") {
        await renderMermaidToFile(code, outPath, theme);
      } else {
        await renderPythonToFile(code, outPath);
      }
      return ok(outPath);
    } catch (err) {
      return fail(type, err instanceof Error ? err.message : String(err));
    }
  },
});
