/**
 * render-core.ts — 图表渲染公共模块
 *
 * 为 render_diagram 工具和 send_report 工具提供共享的渲染逻辑。
 * 支持 mermaid（beautiful-mermaid → Playwright → mermaid.ink）
 * 和 python（matplotlib / graphviz 等）两种类型。
 */

import { spawn } from "node:child_process";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";

// ── 主题配置（改这里换主题）──────────────────────────────────────────────────
export const MERMAID_THEME_LIGHT = "solarized-light";
export const MERMAID_THEME_DARK  = "tokyo-night";

// ── 输出目录 ──────────────────────────────────────────────────────────────────

export function resolveOutputDir(agentId?: string): string {
  const base = agentId
    ? join(homedir(), ".tinyclaw", "agents", agentId, "workspace", "output")
    : tmpdir();
  const dir = join(base, "diagrams");
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function timestampName(filename?: string, ext = "png"): string {
  const name = filename ?? `diagram_${Date.now()}`;
  return name.endsWith(`.${ext}`) ? name : `${name}.${ext}`;
}

// ── Mermaid 渲染主流程 ────────────────────────────────────────────────────────

/**
 * 渲染 mermaid 代码为 PNG 图片，写入 outPath。
 * 失败时 throw Error。
 */
export async function renderMermaidToFile(
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

  // 2. beautiful-mermaid（高质量本地渲染）
  const bm = await tryBeautifulMermaid(code, outPath, theme);
  if (bm !== null) {
    if (bm === "") return; // 成功
    console.warn(`[render-core] beautiful-mermaid 失败，fallback 到 mermaid.js：${bm}`);
  }

  // 3. 本地 Playwright + mermaid.js（支持 gantt/pie 等更多类型）
  const chromiumResult = await tryChromium(code, outPath);
  if (chromiumResult !== null) {
    if (chromiumResult === "") return; // 成功
    console.warn(`[render-core] chromium 渲染失败，尝试 mermaid.ink：${chromiumResult}`);
  }

  // 4. mermaid.ink HTTP API（最后兜底，需要网络）
  await tryMermaidInk(code, outPath);
}

// ── beautiful-mermaid ─────────────────────────────────────────────────────────

/**
 * 使用 beautiful-mermaid 渲染 SVG，再用 Playwright 截图。
 * 返回 null（不支持该图表类型）、""（成功）、或错误信息字符串。
 */
export async function tryBeautifulMermaid(
  code: string,
  outFile: string,
  theme: "light" | "dark"
): Promise<string | null> {
  // 预处理：剥掉 %%{...}%% 指令行（beautiful-mermaid 不支持 init 指令，会抛 Invalid mermaid header）
  const cleanCode = code.replace(/^%%\{[^\n]*\}%%[ \t]*\n?/gm, "").trim();

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

  const themeName = theme === "dark" ? MERMAID_THEME_DARK : MERMAID_THEME_LIGHT;
  const themeOpts = THEMES[themeName];
  if (!themeOpts) return `未找到主题：${themeName}`;

  let svg: string;
  try {
    svg = renderMermaidSVG(cleanCode, themeOpts);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("Invalid mermaid header") || msg.includes("Expected")) {
      return null;
    }
    return msg;
  }

  let playwrightChromium: import("playwright-core").BrowserType;
  try {
    const pw = await import("playwright-core");
    playwrightChromium = pw.chromium;
  } catch {
    return "playwright-core 不可用";
  }

  // 从主题对象读取背景色，fallback 到各自默认值
  const bgColor = (themeOpts as Record<string, string>).bg
    ?? (theme === "dark" ? "#1a1b26" : "#fdf6e3");

  const html = `<!DOCTYPE html><html><head><meta charset="utf-8">
<style>*{margin:0;padding:0;}body{background:${bgColor};display:inline-block;padding:24px;}</style>
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
      if (!el) return "未找到 SVG 元素";
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

// ── mmdc ─────────────────────────────────────────────────────────────────────

/** 尝试运行本地 mmdc，返回 null（未安装）、""（成功）、或错误信息字符串 */
export function tryMmdc(mmdFile: string, outFile: string): Promise<string | null> {
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
        resolve("");
      } else {
        const stderr = Buffer.concat(errChunks).toString("utf-8").trim();
        const stdout = Buffer.concat(outChunks).toString("utf-8").trim();
        resolve(`mmdc 退出码 ${code}\n${stderr || stdout}`);
      }
    });

    child.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        resolve(null);
      } else {
        resolve(`mmdc 启动失败：${err.message}`);
      }
    });
  });
}

// ── Chromium + mermaid.js ─────────────────────────────────────────────────────

/**
 * 本地 Playwright + mermaid.js 渲染（完全离线）
 * 返回 null（playwright-core 不可用）、""（成功）、或错误信息字符串
 */
export async function tryChromium(code: string, outFile: string): Promise<string | null> {
  let chromium: import("playwright-core").BrowserType;
  try {
    const pw = await import("playwright-core");
    chromium = pw.chromium;
  } catch {
    return null;
  }

  const mermaidJsCandidates = [
    join(process.cwd(), "node_modules/mermaid/dist/mermaid.min.js"),
    join(homedir(), "tinyclaw/node_modules/mermaid/dist/mermaid.min.js"),
    "/home/lyy/tinyclaw/node_modules/mermaid/dist/mermaid.min.js",
  ];
  const resolvedMermaidPath = mermaidJsCandidates.find(existsSync) ?? null;
  if (!resolvedMermaidPath) {
    return "未找到 node_modules/mermaid/dist/mermaid.min.js，请在 tinyclaw 目录运行 bun install";
  }

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

  try {
    const browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-gpu", "--disable-software-rasterizer"],
    });
    try {
      const page = await browser.newPage();
      page.setDefaultTimeout(15000);
      await page.goto(`file://${htmlFile}`);
      await page.waitForSelector("#diagram svg", { timeout: 10000 });
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

// ── mermaid.ink ───────────────────────────────────────────────────────────────

/** 通过 mermaid.ink 公共 API 下载图片（最后兜底，需要网络） */
export async function tryMermaidInk(code: string, outFile: string): Promise<void> {
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
  writeFileSync(outFile, buf);
}

// ── Python 渲染 ──────────────────────────────────────────────────────────────

export const PYTHON_HEADER = `\
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

export const PYTHON_FOOTER = `

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

/**
 * 执行 Python 绘图代码，渲染为 PNG 图片，写入 outPath。
 * 失败时 throw Error。
 */
export async function renderPythonToFile(code: string, outPath: string): Promise<void> {
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
