import * as fs from "node:fs";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { registerTool } from "./registry.js";

// ── exec_shell ────────────────────────────────────────────────────────────────

async function execShellImpl(args: Record<string, unknown>): Promise<string> {
  const command = String(args["command"] ?? "");
  if (!command) return "错误：缺少 command 参数";

  const timeoutMs = 30_000;

  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    const child = spawn("bash", ["-c", command], {
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.stderr.on("data", (d: Buffer) => errChunks.push(d));

    child.on("close", (code) => {
      const stdout = Buffer.concat(chunks).toString("utf-8").trim();
      const stderr = Buffer.concat(errChunks).toString("utf-8").trim();
      const output = [stdout, stderr ? `[stderr] ${stderr}` : ""]
        .filter(Boolean)
        .join("\n");
      resolve(output || `（退出码 ${code}，无输出）`);
    });

    child.on("error", (err) => {
      resolve(`执行失败：${err.message}`);
    });
  });
}

registerTool({
  requiresMFA: true,
  spec: {
    type: "function",
    function: {
      name: "exec_shell",
      description: "在本机执行 shell 命令（需要 MFA 确认）。",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "要执行的 bash 命令" },
        },
        required: ["command"],
      },
    },
  },
  execute: execShellImpl,
});

// ── write_file ────────────────────────────────────────────────────────────────

async function writeFileImpl(args: Record<string, unknown>): Promise<string> {
  const filePath = String(args["path"] ?? "");
  const content = String(args["content"] ?? "");
  if (!filePath) return "错误：缺少 path 参数";

  const resolved = path.resolve(filePath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, content, "utf-8");
  return `已写入：${resolved}（${content.length} 字节）`;
}

registerTool({
  requiresMFA: true,
  spec: {
    type: "function",
    function: {
      name: "write_file",
      description: "写入文件内容（需要 MFA 确认）。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "文件绝对或相对路径" },
          content: { type: "string", description: "文件内容" },
        },
        required: ["path", "content"],
      },
    },
  },
  execute: writeFileImpl,
});

// ── delete_file ───────────────────────────────────────────────────────────────

async function deleteFileImpl(args: Record<string, unknown>): Promise<string> {
  const filePath = String(args["path"] ?? "");
  if (!filePath) return "错误：缺少 path 参数";

  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    return `文件不存在：${resolved}`;
  }
  fs.rmSync(resolved, { recursive: true, force: true });
  return `已删除：${resolved}`;
}

registerTool({
  requiresMFA: true,
  spec: {
    type: "function",
    function: {
      name: "delete_file",
      description: "删除文件或目录（需要 MFA 确认）。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "要删除的文件或目录路径" },
        },
        required: ["path"],
      },
    },
  },
  execute: deleteFileImpl,
});

// ── read_file ─────────────────────────────────────────────────────────────────

async function readFileImpl(args: Record<string, unknown>): Promise<string> {
  const filePath = String(args["path"] ?? "");
  if (!filePath) return "错误：缺少 path 参数";

  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) return `文件不存在：${resolved}`;

  const maxBytes = 50_000;
  const stat = fs.statSync(resolved);
  if (stat.size > maxBytes) {
    return `文件过大（${stat.size} 字节），请使用 exec_shell 配合 head/tail 读取`;
  }

  return fs.readFileSync(resolved, "utf-8");
}

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "read_file",
      description: "读取文件内容（不超过 50KB）。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "文件路径" },
        },
        required: ["path"],
      },
    },
  },
  execute: readFileImpl,
});
