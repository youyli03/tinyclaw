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

  // 1. 尝试本地 mmdc（已安装时最优）
  const mmdc = await tryMmdc(mmdFile, outPath);
  if (mmdc !== null) {
    if (mmdc === "") return; // 成功
    throw new Error(mmdc);
  }

  // 2. 本地 chromium headless（离线，主要 fallback）
  const chromium = await tryChromium(code, outPath);
  if (chromium !== null) {
    if (chromium === "") return; // 成功
    // chromium 存在但失败了，继续尝试 mermaid.ink
    console.warn(`[render-diagram] chromium 渲染失败，尝试 mermaid.ink：${chromium}`);
  }

  // 3. mermaid.ink HTTP API（最后兜底，需要网络）
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

/** 本地 chromium headless 渲染 mermaid（完全离线）
 *  返回 null（未找到 chromium）、""（成功）、或错误信息字符串
 */
async function tryChromium(code: string, outFile: string): Promise<string | null> {
  // 查找 chromium 可执行文件
  const candidates = ["chromium-browser", "chromium", "google-chrome"];
  let chromiumBin: string | null = null;
  for (const bin of candidates) {
    const found = await new Promise<boolean>((resolve) => {
      const child = spawn("which", [bin], { stdio: "ignore" });
      child.on("close", (c) => resolve(c === 0));
      child.on("error", () => resolve(false));
    });
    if (found) { chromiumBin = bin; break; }
  }
  if (!chromiumBin) return null;

  // 读取本地 mermaid.min.js（离线，从 node_modules 获取）
  // tinyclaw 进程 cwd 就是项目根目录，直接从 cwd 定位
  const mermaidJsCandidates = [
    join(process.cwd(), "node_modules/mermaid/dist/mermaid.min.js"),
    join(homedir(), "tinyclaw/node_modules/mermaid/dist/mermaid.min.js"),
    "/home/lyy/tinyclaw/node_modules/mermaid/dist/mermaid.min.js",
  ];
  const resolvedMermaidPath = mermaidJsCandidates.find(existsSync) ?? null;
  if (!resolvedMermaidPath) {
    return "未找到 node_modules/mermaid/dist/mermaid.min.js，请在 tinyclaw 目录运行 bun install";
  }
  // 不再内联 mermaid.min.js，改用 file:// 外链

  // 生成 HTML 文件，通过 file:// 外链 mermaid.min.js
  // 不内联，避免 mermaid.min.js 内部的 </body></html> 字符串破坏 HTML 文档结构
  // 使用 mermaid.render() async API + startOnLoad:false，
  // 配合 --virtual-time-budget 确保截图时 SVG 已挂载完成
  const escapedCodeJson = JSON.stringify(code);
  const mermaidSrc = `file://${resolvedMermaidPath}`;
  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { background: white; padding: 24px; font-family: sans-serif; }
#diagram svg { max-width: none !important; }
</style>
<script src="${mermaidSrc}"></script>
</head>
<body>
<div id="diagram"></div>
<script>
(async function() {
  const code = ${escapedCodeJson};
  mermaid.initialize({ startOnLoad: false, theme: 'neutral' });
  try {
    const { svg } = await mermaid.render('mermaid-svg', code);
    document.getElementById('diagram').innerHTML = svg;
  } catch (e) {
    document.body.textContent = 'mermaid render error: ' + e.message;
  }
})();
</script>
</body>
</html>`;

  const htmlFile = outFile.replace(/\.png$/, "_chromium.html");
  writeFileSync(htmlFile, html, "utf-8");

  // chromium headless 截图（全页面）
  const rawScreenshot = outFile.replace(/\.png$/, "_raw.png");
  const chromiumErr = await new Promise<string>((resolve) => {
    const child = spawn(chromiumBin!, [
      "--headless",
      "--no-sandbox",
      "--disable-gpu",
      "--disable-software-rasterizer",
      "--window-size=1400,1000",
      "--virtual-time-budget=5000",
      `--screenshot=${rawScreenshot}`,
      `file://${htmlFile}`,
    ], { stdio: ["ignore", "pipe", "pipe"] });

    const errChunks: Buffer[] = [];
    child.stderr.on("data", (d: Buffer) => errChunks.push(d));
    child.on("close", (c) => {
      if (c === 0 && existsSync(rawScreenshot)) {
        resolve("");
      } else {
        const stderr = Buffer.concat(errChunks).toString("utf-8").trim();
        resolve(`chromium 退出码 ${c}\n${stderr}`);
      }
    });
    child.on("error", (err) => resolve(`chromium 启动失败：${err.message}`));
  });

  if (chromiumErr) return chromiumErr;

  // 用 Python PIL 裁剪白边
  const cropScript = `
from PIL import Image
import numpy as np, sys

img = Image.open(${JSON.stringify(rawScreenshot)}).convert("RGB")
arr = np.array(img)
non_white = (arr < 248).any(axis=2)
rows = np.where(non_white.any(axis=1))[0]
cols = np.where(non_white.any(axis=0))[0]
if len(rows) == 0 or len(cols) == 0:
    sys.exit(1)
pad = 20
top    = max(0, rows[0] - pad)
bottom = min(arr.shape[0], rows[-1] + pad + 1)
left   = max(0, cols[0] - pad)
right  = min(arr.shape[1], cols[-1] + pad + 1)
img.crop((left, top, right, bottom)).save(${JSON.stringify(outFile)})
`;
  const cropErr = await new Promise<string>((resolve) => {
    const child = spawn("python3", ["-c", cropScript], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    const errChunks: Buffer[] = [];
    child.stderr.on("data", (d: Buffer) => errChunks.push(d));
    child.on("close", (c) => {
      if (c === 0 && existsSync(outFile)) {
        resolve("");
      } else {
        const stderr = Buffer.concat(errChunks).toString("utf-8").trim();
        resolve(`PIL 裁剪失败（退出码 ${c}）：${stderr || "图片可能全白，渲染未生效"}`);
      }
    });
    child.on("error", (err) => resolve(`python3 启动失败：${err.message}`));
  });

  if (cropErr) {
    // 裁剪失败时降级：直接使用未裁剪的原始截图
    try {
      const { copyFileSync } = await import("node:fs");
      copyFileSync(rawScreenshot, outFile);
      return ""; // 仍然算成功，只是没裁剪
    } catch {
      return cropErr;
    }
  }

  return "";
}

/** 通过 mermaid.ink 公共 API 下载图片（最后兜底，需要网络） */
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
    import matplotlib.font_manager as _fm
    _fm.fontManager.addfont('/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc')
    _mpl.rcParams['font.family'] = 'Noto Sans CJK JP'
    _mpl.rcParams['axes.unicode_minus'] = False
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
