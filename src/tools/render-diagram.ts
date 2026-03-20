import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { registerTool } from "./registry.js";
import type { ToolContext } from "./registry.js";

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

// ── 输出目录 ──────────────────────────────────────────────────────────────────

function resolveOutputDir(agentId?: string): string {
  const base = agentId
    ? join(homedir(), ".tinyclaw", "agents", agentId, "workspace", "output")
    : tmpdir();
  const dir = join(base, "diagrams");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function timestampName(filename?: string, ext = "png"): string {
  const name = filename ?? `diagram_${Date.now()}`;
  return name.endsWith(`.${ext}`) ? name : `${name}.${ext}`;
}

// ── Mermaid 渲染 ──────────────────────────────────────────────────────────────

async function renderMermaid(
  code: string,
  outPath: string
): Promise<void> {
  // 写临时 .mmd 文件
  const mmdFile = outPath.replace(/\.png$/, ".mmd");
  writeFileSync(mmdFile, code, "utf-8");

  // 尝试本地 mmdc（优先）
  const mmdc = await tryMmdc(mmdFile, outPath);
  if (mmdc !== null) {
    if (mmdc === "") return; // 成功
    throw new Error(mmdc);
  }

  // fallback: mermaid.ink HTTP API
  await tryMermaidInk(code, outPath);
}

/** 尝试运行本地 mmdc，返回 null（未安装）、"" （成功）、或错误信息字符串 */
function tryMmdc(mmdFile: string, outFile: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn("mmdc", [
      "-i", mmdFile,
      "-o", outFile,
      "--theme", "neutral",
      "--backgroundColor", "white",
    ], { stdio: ["ignore", "pipe", "pipe"] });

    const errChunks: Buffer[] = [];
    const outChunks: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => outChunks.push(d));
    child.stderr.on("data", (d: Buffer) => errChunks.push(d));

    child.on("close", (code) => {
      if (code === 0) {
        resolve(""); // 成功
      } else {
        const stderr = Buffer.concat(errChunks).toString("utf-8").trim();
        const stdout = Buffer.concat(outChunks).toString("utf-8").trim();
        resolve(`mmdc 退出码 ${code}\n${stderr || stdout}`);
      }
    });

    child.on("error", (err) => {
      // ENOENT = mmdc 未安装，返回 null 触发 fallback
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        resolve(null);
      } else {
        resolve(`mmdc 启动失败：${err.message}`);
      }
    });
  });
}

/** 通过 mermaid.ink 公共 API 下载图片 */
async function tryMermaidInk(code: string, outFile: string): Promise<void> {
  const encoded = Buffer.from(code, "utf-8").toString("base64url");
  const url = `https://mermaid.ink/img/${encoded}?type=png&bgColor=white`;
  const resp = await fetch(url);
  if (!resp.ok) {
    throw new Error(
      `mermaid.ink 返回 ${resp.status}（${resp.statusText}）。\n` +
      `请检查 mermaid 语法是否正确。`
    );
  }
  const buf = Buffer.from(await resp.arrayBuffer());
  const { writeFileSync: wfs } = await import("node:fs");
  wfs(outFile, buf);
}

// ── Python 渲染 ──────────────────────────────────────────────────────────────

const PYTHON_HEADER = `\
import os as _os
import sys as _sys
_OUTPUT_FILE = _os.environ.get("DIAGRAM_OUTPUT_FILE", "/tmp/diagram_out.png")

try:
    import matplotlib as _mpl
    _mpl.use("Agg")
    import matplotlib.pyplot as _plt
except ImportError:
    pass
`;

const PYTHON_FOOTER = `

# ── 自动保存（若用户代码未调用 savefig）────────────────────
try:
    import matplotlib.pyplot as _plt2
    if _plt2.get_fignums():
        _plt2.tight_layout()
        _plt2.savefig(_OUTPUT_FILE, dpi=150, bbox_inches="tight")
        _plt2.close("all")
except Exception:
    pass
`;

async function renderPython(code: string, outPath: string): Promise<void> {
  const wrappedCode = PYTHON_HEADER + code + PYTHON_FOOTER;
  const pyFile = outPath.replace(/\.png$/, ".py");
  writeFileSync(pyFile, wrappedCode, "utf-8");

  await new Promise<void>((resolve, reject) => {
    const child = spawn("python3", [pyFile], {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, DIAGRAM_OUTPUT_FILE: outPath },
    });

    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => outChunks.push(d));
    child.stderr.on("data", (d: Buffer) => errChunks.push(d));

    child.on("close", (code) => {
      const stdout = Buffer.concat(outChunks).toString("utf-8").trim();
      const stderr = Buffer.concat(errChunks).toString("utf-8").trim();
      if (code === 0 && existsSync(outPath)) {
        resolve();
      } else if (code === 0) {
        reject(new Error(
          `Python 代码执行成功但未生成图片文件。\n` +
          `请确认代码会产生图形（如 plt.plot(...)），或手动调用 plt.savefig(os.environ["DIAGRAM_OUTPUT_FILE"])。\n` +
          (stdout ? `stdout:\n${stdout}` : "")
        ));
      } else {
        reject(new Error(
          `Python 退出码 ${code}\n` +
          (stderr ? `stderr:\n${stderr}\n` : "") +
          (stdout ? `stdout:\n${stdout}` : "")
        ));
      }
    });

    child.on("error", (err) => {
      reject(new Error(`python3 启动失败：${err.message}（请确认已安装 Python 3）`));
    });
  });
}

// ── 工具注册 ──────────────────────────────────────────────────────────────────

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "render_diagram",
      description:
        "将图表代码渲染为图片，通过 QQ 发送。" +
        "支持两种类型：" +
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
        },
        required: ["type", "code"],
      },
    },
  },
  execute: async (args: Record<string, unknown>, ctx?: ToolContext) => {
    const type = String(args["type"] ?? "").trim() as "mermaid" | "python";
    const code = String(args["code"] ?? "").trim();
    const filename = args["filename"] ? String(args["filename"]).trim() : undefined;

    if (!code) return fail(type, "code 参数不能为空");
    if (type !== "mermaid" && type !== "python") {
      return fail(type, "type 必须为 'mermaid' 或 'python'");
    }

    const outDir = resolveOutputDir(ctx?.agentId);
    const outPath = join(outDir, timestampName(filename, "png"));

    try {
      if (type === "mermaid") {
        await renderMermaid(code, outPath);
      } else {
        await renderPython(code, outPath);
      }
      return ok(outPath);
    } catch (err) {
      return fail(type, err instanceof Error ? err.message : String(err));
    }
  },
});
