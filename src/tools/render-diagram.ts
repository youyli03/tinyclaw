import { spawn } from "node:child_process";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import { registerTool } from "./registry.js";
import type { ToolContext } from "./registry.js";

// ── beautiful-mermaid 主题配置（改这里换主题）────────────────────────────────
const MERMAID_THEME_LIGHT = "solarized-light";
const MERMAID_THEME_DARK  = "tokyo-night";

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
  outPath: string,
  theme: "light" | "dark" = "light"
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

  // 2. beautiful-mermaid（高质量本地渲染，支持大多数图表类型）
  const bm = await tryBeautifulMermaid(code, outPath, theme);
  if (bm !== null) {
    if (bm === "") return; // 成功
    // beautiful-mermaid 失败（不支持的图表类型等），fallback
    console.warn(`[render-diagram] beautiful-mermaid 失败，fallback 到 mermaid.js：${bm}`);
  }

  // 3. 本地 Playwright + mermaid.js（支持 gantt/pie 等更多类型）
  const chromium = await tryChromium(code, outPath);
  if (chromium !== null) {
    if (chromium === "") return; // 成功
    console.warn(`[render-diagram] chromium 渲染失败，尝试 mermaid.ink：${chromium}`);
  }

  // 4. mermaid.ink HTTP API（最后兜底，需要网络）
  await tryMermaidInk(code, outPath);
}

/** 使用 beautiful-mermaid 渲染（高质量，零字体依赖）
 *  返回 null（不支持该图表类型）、""（成功）、或错误信息字符串
 */
async function tryBeautifulMermaid(
  code: string,
  outFile: string,
  theme: "light" | "dark"
): Promise<string | null> {
  // 动态 import，避免启动时报错
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let renderMermaidSVG: (code: string, opts: any) => string;
  let THEMES: Record<string, unknown>;
  try {
    const bm = await import("beautiful-mermaid");
    renderMermaidSVG = bm.renderMermaidSVG;
    THEMES = bm.THEMES as Record<string, unknown>;
  } catch {
    return null;
  }

  // 选主题
  const themeName = theme === "dark" ? MERMAID_THEME_DARK : MERMAID_THEME_LIGHT;
  const themeOpts = THEMES[themeName];
  if (!themeOpts) return `未找到主题：${themeName}`;

  // 渲染 SVG（同步）
  let svg: string;
  try {
    svg = renderMermaidSVG(code, themeOpts);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // "Invalid mermaid header" = 不支持的图表类型，返回 null 触发 fallback
    if (msg.includes("Invalid mermaid header") || msg.includes("Expected")) {
      return null;
    }
    return msg;
  }

  // 用 playwright-core 截图（DPR=2 保证清晰度）
  let playwrightChromium: import("playwright-core").BrowserType;
  try {
    const pw = await import("playwright-core");
    playwrightChromium = pw.chromium;
  } catch {
    return "playwright-core 不可用";
  }

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>*{margin:0;padding:0;}body{background:${theme === "dark" ? "#1a1b26" : "#fdf6e3"};display:inline-block;padding:24px;}</style>
</head><body>${svg}</body></html>`;
  const htmlFile = outFile.replace(/\.png$/, "_bm.html");
  writeFileSync(htmlFile, html, "utf-8");

  try {
    const browser = await playwrightChromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-gpu", "--disable-software-rasterizer"],
    });
    try {
      const page = await browser.newPage({ deviceScaleFactor: 2 });
      page.setDefaultTimeout(15000);
      await page.goto(`file://${htmlFile}`);
      await page.waitForSelector("svg", { timeout: 8000 });
      const el = await page.$("svg");
      if (!el) {
        return "未找到 SVG 元素";
      }
      await el.screenshot({ path: outFile, type: "png" });
    } finally {
      await browser.close();
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Playwright 截图失败：${msg}`;
  }

  return "";
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

/** 本地 chromium headless 渲染 mermaid（完全离线，使用 Playwright）
 *  返回 null（playwright-core 不可用）、""（成功）、或错误信息字符串
 */
async function tryChromium(code: string, outFile: string): Promise<string | null> {
  // 确认 playwright-core 可用
  let chromium: import("playwright-core").BrowserType;
  try {
    const pw = await import("playwright-core");
    chromium = pw.chromium;
  } catch {
    return null;
  }

  // 读取本地 mermaid.min.js（离线，从 node_modules 获取）
  const mermaidJsCandidates = [
    join(process.cwd(), "node_modules/mermaid/dist/mermaid.min.js"),
    join(homedir(), "tinyclaw/node_modules/mermaid/dist/mermaid.min.js"),
    "/home/lyy/tinyclaw/node_modules/mermaid/dist/mermaid.min.js",
  ];
  const resolvedMermaidPath = mermaidJsCandidates.find(existsSync) ?? null;
  if (!resolvedMermaidPath) {
    return "未找到 node_modules/mermaid/dist/mermaid.min.js，请在 tinyclaw 目录运行 bun install";
  }

  // 生成 HTML 文件，通过 file:// 外链 mermaid.min.js
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

  // 使用 Playwright 启动 Chromium，waitForSelector 确保 SVG 渲染完成后截图
  try {
    const browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-gpu", "--disable-software-rasterizer"],
    });
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(15000);
      await page.goto(`file://${htmlFile}`);
      // 等待 mermaid async render 完成：#diagram 内出现 svg 元素
      await page.waitForSelector("#diagram svg", { timeout: 10000 });
      // 截取 #diagram 元素（自动裁到内容边界，含 24px body padding）
      const el = await page.$("#diagram");
      if (!el) {
        await browser.close();
        return "Playwright：未找到 #diagram 元素";
      }
      await el.screenshot({ path: outFile, type: "png" });
    } finally {
      await browser.close();
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return `Playwright 渲染失败：${msg}`;
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
        await renderMermaid(code, outPath, theme);
      } else {
        await renderPython(code, outPath);
      }
      return ok(outPath);
    } catch (err) {
      return fail(type, err instanceof Error ? err.message : String(err));
    }
  },
});
