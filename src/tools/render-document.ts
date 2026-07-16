/**
 * render_document — 将任意文档/文件渲染为图片
 *
 * 支持所有 LibreOffice 可打开的格式(.docx/.pptx/.txt/.md/.json/.log 等),
 * 以及 PDF 直接转图片。像 vi 一样,什么文件都能尝试打开看。
 *
 * 流程:
 *   1. PDF → pdftoppm -png 逐页转 PNG
 *   2. 其他 → libreoffice --headless → PDF → pdftoppm -png
 *   3. Python PIL resize 到指定宽度
 *
 * 输出到 ~/.tinyclaw/agents/{agentId}/workspace/output/
 * 返回 <img src="..."/> 供 QQ 直接发送
 */

import { join, extname, basename } from "node:path";
import { homedir, tmpdir } from "node:os";
import { existsSync, mkdirSync, readdirSync, unlinkSync, rmdirSync, copyFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { registerTool, type ToolContext } from "./registry.js";

// ── 输出目录 ──────────────────────────────────────────────────────────────────

function outputDir(agentId?: string): string {
  const base = agentId
    ? join(homedir(), ".tinyclaw", "agents", agentId, "workspace", "output")
    : tmpdir();
  mkdirSync(base, { recursive: true });
  return base;
}

// ── 解析页码范围 ──────────────────────────────────────────────────────────────

function parsePages(raw: string): { first: number; last: number } {
  // 支持格式: "3" / "1-5" / "1,3,5"(取最小和最大)
  const nums = raw
    .split(/[,\-]+/)
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => !isNaN(n) && n > 0);
  if (nums.length === 0) return { first: 1, last: 1 };
  return { first: Math.min(...nums), last: Math.max(...nums) };
}

// ── pdftoppm: PDF → PNG ──────────────────────────────────────────────────────

function pdfToPng(
  pdfPath: string,
  outPrefix: string,
  first: number,
  last: number,
  dpi: number
): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const args = ["-png", "-r", String(dpi), "-f", String(first), "-l", String(last), pdfPath, outPrefix];
    const child = spawn("pdftoppm", args, { stdio: ["ignore", "pipe", "pipe"] });

    const errChunks: Buffer[] = [];
    child.stderr.on("data", (d: Buffer) => errChunks.push(d));

    child.on("close", (code) => {
      if (code !== 0) {
        const stderr = Buffer.concat(errChunks).toString("utf-8").trim();
        reject(new Error(`pdftoppm 退出码 ${code}: ${stderr}`));
        return;
      }
      // 收集生成的文件（按名称排序）
      const outDir = join(outPrefix, "..");
      const prefix = basename(outPrefix);
      const files = readdirSync(outDir)
        .filter((f) => f.startsWith(prefix) && f.endsWith(".png"))
        .sort()
        .map((f) => join(outDir, f));
      resolve(files);
    });

    child.on("error", (err) => {
      reject(new Error(`pdftoppm 启动失败: ${err.message}`));
    });
  });
}

// ── LibreOffice: 任意文件 → PDF ───────────────────────────────────────────────

function toPdf(inputPath: string, outDir: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "libreoffice",
      ["--headless", "--convert-to", "pdf", "--outdir", outDir, inputPath],
      { stdio: ["ignore", "pipe", "pipe"] }
    );

    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    child.stdout.on("data", (d: Buffer) => outChunks.push(d));
    child.stderr.on("data", (d: Buffer) => errChunks.push(d));

    child.on("close", (code) => {
      const stdout = Buffer.concat(outChunks).toString("utf-8").trim();
      if (code !== 0) {
        const stderr = Buffer.concat(errChunks).toString("utf-8").trim();
        reject(new Error(`LibreOffice 退出码 ${code}:\n${stderr || stdout}`));
        return;
      }
      // 推断输出文件名: 输入 foo.txt → foo.pdf
      const inputBase = basename(inputPath);
      const nameWithoutExt = inputBase.replace(/\.[^.]+$/, "");
      const pdfPath = join(outDir, `${nameWithoutExt}.pdf`);
      if (!existsSync(pdfPath)) {
        reject(new Error(`LibreOffice 未生成 PDF 文件(预期: ${pdfPath})`));
        return;
      }
      resolve(pdfPath);
    });

    child.on("error", (err) => {
      reject(new Error(`LibreOffice 启动失败: ${err.message}。请确认已安装 libreoffice`));
    });
  });
}

// ── Python PIL: resize ────────────────────────────────────────────────────────

function resizeImages(files: string[], width: number): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const pyCode = `
import sys, json
from PIL import Image

files = json.loads(sys.argv[1])
width = int(sys.argv[2])
results = []

for f in files:
    img = Image.open(f)
    w, h = img.size
    if w != width:
        new_h = int(h * width / w)
        img = img.resize((width, new_h), Image.LANCZOS)
        img.save(f, "PNG")
    results.append({"path": f, "width": img.width, "height": img.height})

print(json.dumps(results))
`.trim();

    const child = spawn("python3", ["-c", pyCode, JSON.stringify(files), String(width)], {
      stdio: ["ignore", "pipe", "pipe"],
    });

    const errChunks: Buffer[] = [];
    child.stderr.on("data", (d: Buffer) => errChunks.push(d));

    let stdout = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`PIL resize 失败: ${Buffer.concat(errChunks).toString("utf-8").trim()}`));
        return;
      }
      try {
        const results = JSON.parse(stdout.trim());
        resolve(results.map((r: { path: string }) => r.path));
      } catch {
        reject(new Error(`PIL 输出解析失败: ${stdout.slice(0, 200)}`));
      }
    });

    child.on("error", (err) => {
      reject(new Error(`python3 启动失败: ${err.message}`));
    });
  });
}

// ── 工具注册 ──────────────────────────────────────────────────────────────────

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "render_document",
      description:
        "将文档或任意文件渲染为图片,通过 QQ 发送。支持 PDF/Office/文本/代码等所有 LibreOffice 可打开的格式。\n" +
        "像 vi 一样,任何文件都可尝试打开查看。PDF 直接用 pdftoppm 转图,其余格式先经 LibreOffice 转 PDF。\n" +
        "多页文档每页生成一张图片。适合快速预览文件内容而不离开聊天窗口。",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "要渲染的文件绝对路径",
          },
          pages: {
            type: "string",
            description:
              "页码范围。支持: 单页 \"3\" / 范围 \"1-5\" / 逗号分隔 \"1,3,5\"。默认渲染第 1 页。",
          },
          dpi: {
            type: "number",
            description: "渲染分辨率(DPI),默认 150。值越大图片越清晰也越大。",
          },
          width: {
            type: "number",
            description: "输出图片宽度(像素),默认 800,适配 QQ 聊天窗口。",
          },
        },
        required: ["path"],
      },
    },
  },

  async execute(args: Record<string, unknown>, ctx?: ToolContext): Promise<string> {
    const inputPath = String(args["path"] ?? "").trim();
    const pagesRaw = args["pages"] ? String(args["pages"]).trim() : "1";
    const dpi = Math.max(72, Math.min(600, Number(args["dpi"] ?? 150)));
    const outWidth = Math.max(200, Math.min(4000, Number(args["width"] ?? 800)));

    // 1. 校验文件存在
    if (!inputPath) return "❌ 错误: 缺少 path 参数";
    if (!existsSync(inputPath)) return `❌ 错误: 文件不存在 → ${inputPath}`;

    const ext = extname(inputPath).toLowerCase();
    const { first, last } = parsePages(pagesRaw);

    // 2. 创建临时工作目录
    const workDir = join(tmpdir(), `render_doc_${Date.now()}`);
    mkdirSync(workDir, { recursive: true });

    let pdfPath: string;
    let isTempPdf = false;

    try {
      // 3. 准备 PDF
      if (ext === ".pdf") {
        pdfPath = inputPath;
      } else {
        // 其他格式 → LibreOffice 转 PDF
        pdfPath = await toPdf(inputPath, workDir);
        isTempPdf = true;
      }

      // 4. PDF → PNG
      const pagePrefix = join(workDir, "page");
      const pageFiles = await pdfToPng(pdfPath, pagePrefix, first, last, dpi);

      if (pageFiles.length === 0) {
        return `❌ 错误: 未生成任何页面图片(页码范围 ${first}-${last} 可能超出文档总页数)`;
      }

      // 5. PIL resize
      const resizedFiles = await resizeImages(pageFiles, outWidth);

      // 6. 移动到输出目录
      const outDir = outputDir(ctx?.agentId);
      const finalPaths: string[] = [];
      for (const src of resizedFiles) {
        const base = basename(inputPath).replace(/\.[^.]+$/, "");
        const pageNum = basename(src).replace(/^page-?/, "").replace(".png", "");
        const dst = join(outDir, `${base}_p${pageNum}.png`);
        copyFileSync(src, dst);
        finalPaths.push(dst);
      }

      // 7. 组装返回
      const lines: string[] = [
        `✅ **render_document** | ${basename(inputPath)} | 第 ${first}-${last} 页 | ${dpi}dpi → ${outWidth}px`,
        "",
      ];
      for (const p of finalPaths) {
        lines.push(`<img src="${p}"/>`);
      }
      lines.push("", `📁 已保存至: \`${outDir}/\``);
      return lines.join("\n");
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `❌ 渲染失败: ${msg}`;
    } finally {
      // 清理临时文件
      try {
        const tmpFiles = readdirSync(workDir);
        for (const f of tmpFiles) unlinkSync(join(workDir, f));
        rmdirSync(workDir);
      } catch {
        // 清理失败不影响主流程
      }
    }
  },
});
