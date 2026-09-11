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
    `❌ 渲染失败（${type}），请修正代码后重新调用 render_diagram。\n` + `错误信息：\n${detail}`
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
        "Render diagram code into an image and send it via QQ. Supports two types: " +
        "(1) mermaid: flowcharts, sequence, class, state, ER, gantt and pie charts; pass the " +
        "mermaid syntax code. (2) python: any Python drawing code (matplotlib/graphviz, etc.) " +
        "that renders the figure directly; no manual savefig needed (the tool saves the file), " +
        'or call plt.savefig(os.environ["DIAGRAM_OUTPUT_FILE"]) to choose the path yourself. ' +
        "On failure the detailed error is returned: fix the code and retry.",
      parameters: {
        type: "object",
        properties: {
          type: {
            type: "string",
            enum: ["mermaid", "python"],
            description:
              "Diagram type: mermaid (flowcharts/architecture) or python (data charts or " +
              "custom plots)",
          },
          code: {
            type: "string",
            description:
              "mermaid syntax code (e.g. `graph LR\\n  A-->B`) or Python drawing code (e.g. " +
              "`import matplotlib.pyplot as plt\\nplt.plot([1,2,3])`)",
          },
          filename: {
            type: "string",
            description: "Output file name (without extension); defaults to a timestamped name",
          },
          theme: {
            type: "string",
            enum: ["light", "dark"],
            description:
              "mermaid color theme: light (bright, default) or dark (dark/technical style). " +
              "Ignored for the python type.",
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
