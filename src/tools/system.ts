import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { registerTool, type ToolContext } from "./registry.js";
import { checkWritePath } from "./path-guard.js";
import { loadConfig } from "../config/loader.js";

function expandHome(p: string): string {
  if (p === "~" || p.startsWith("~/")) {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

// ── exec_shell ────────────────────────────────────────────────────────────────

/** exec_shell 输出最大字符数，超出时截断并附注原始大小，防止超大输出撑爆 session 上下文 */
const MAX_EXEC_OUTPUT = 8_000;

async function execShellImpl(args: Record<string, unknown>, ctx?: ToolContext): Promise<string> {
  const command = String(args["command"] ?? "");
  if (!command) return "错误：缺少 command 参数";

  const timeoutMs = 0; // 不超时，允许长时间运行的命令

  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    const child = spawn("bash", ["-c", command], {
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
      ...(ctx?.cwd ? { cwd: ctx.cwd } : {}),
    });

    // 若是 slave session，打印子进程 PID（便于追踪或手动 kill）
    if (ctx?.sessionId?.startsWith("slave:") && child.pid != null) {
      const slaveId = ctx.sessionId.slice("slave:".length);
      console.log(`[slave:${slaveId}] exec pid=${child.pid}: ${command.slice(0, 80)}${command.length > 80 ? "…" : ""}`);
    }

    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.stderr.on("data", (d: Buffer) => errChunks.push(d));

    child.on("close", (code) => {
      const stdout = Buffer.concat(chunks).toString("utf-8").trim();
      const stderr = Buffer.concat(errChunks).toString("utf-8").trim();
      let output = [stdout, stderr ? `[stderr] ${stderr}` : ""]
        .filter(Boolean)
        .join("\n");
      if (output.length > MAX_EXEC_OUTPUT) {
        output = output.slice(0, MAX_EXEC_OUTPUT) +
          `\n[…输出已截断：共 ${output.length} 字符，仅显示前 ${MAX_EXEC_OUTPUT} 字符]`;
      }
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

/**
 * 处理越界写路径的用户确认流程（被 write/edit/delete 三个工具共用）。
 * @returns null 表示用户确认（可继续写入），字符串表示拒绝原因（应直接 return 该字符串）
 */
async function handleOutOfBoundPath(
  resolvedPath: string,
  ctx?: ToolContext,
): Promise<string | null> {
  const mode = (() => {
    try { return loadConfig().auth?.mfa?.path_guard_mode ?? "mfa"; } catch { return "mfa"; }
  })();

  if (mode === "deny") {
    return `错误：写入路径 "${resolvedPath}" 超出允许的工作目录范围`;
  }

  if (mode === "ask" && ctx?.onAskUser) {
    const { answer } = await ctx.onAskUser(
      `AI 请求写入 "${resolvedPath}"（超出 workspace 范围），是否允许？`,
      [{ label: "允许" }, { label: "拒绝", recommended: true }],
    );
    if (answer !== "允许") {
      return `已拒绝：不允许写入 "${resolvedPath}"`;
    }
  } else if ((mode === "simple" || mode === "totp" || mode === "msal") && ctx?.onMFARequest) {
    const ok = await ctx.onMFARequest(
      `⚠️ AI 请求写入 "${resolvedPath}"（超出 workspace 范围），是否允许？`,
    );
    if (!ok) {
      return `已拒绝：不允许写入 "${resolvedPath}"`;
    }
  } else {
    // 无交互回调（CLI/cron 无人值守）→ 直接拒绝
    return `错误：写入路径 "${resolvedPath}" 超出允许的工作目录范围（无交互回调，已自动拒绝）`;
  }

  // 用户确认，记录本轮已授权
  ctx?.masterSession?.approvedOutOfBoundPaths.add(resolvedPath);
  return null;
}

async function writeFileImpl(args: Record<string, unknown>, ctx?: ToolContext): Promise<string> {
  const filePath = String(args["path"] ?? "");
  const content = String(args["content"] ?? "");
  if (!filePath) return "错误：缺少 path 参数";

  const resolved = path.resolve(expandHome(filePath));

  const check = checkWritePath(resolved, ctx);
  if (!check.allow) {
    if (check.isDangerous) {
      return `错误：禁止写入 "${resolved}"（${check.reason}）`;
    }
    const denied = await handleOutOfBoundPath(resolved, ctx);
    if (denied !== null) return denied;
  }

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
  execute: (args, ctx) => writeFileImpl(args, ctx),
});

// ── delete_file ───────────────────────────────────────────────────────────────

async function deleteFileImpl(args: Record<string, unknown>, ctx?: ToolContext): Promise<string> {
  const filePath = String(args["path"] ?? "");
  if (!filePath) return "错误：缺少 path 参数";

  const resolved = path.resolve(expandHome(filePath));

  const check = checkWritePath(resolved, ctx);
  if (!check.allow) {
    if (check.isDangerous) {
      return `错误：禁止删除 "${resolved}"（${check.reason}）`;
    }
    const denied = await handleOutOfBoundPath(resolved, ctx);
    if (denied !== null) return denied;
  }

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
  execute: (args, ctx) => deleteFileImpl(args, ctx),
});

// ── edit_file ─────────────────────────────────────────────────────────────────

async function editFileImpl(args: Record<string, unknown>, ctx?: ToolContext): Promise<string> {
  const filePath = String(args["path"] ?? "");
  const oldStr = String(args["old_str"] ?? "");
  const newStr = String(args["new_str"] ?? "");
  if (!filePath) return "错误：缺少 path 参数";
  if (!oldStr) return "错误：缺少 old_str 参数";

  const resolved = path.resolve(expandHome(filePath));

  const check = checkWritePath(resolved, ctx);
  if (!check.allow) {
    if (check.isDangerous) {
      return `错误：禁止编辑 "${resolved}"（${check.reason}）`;
    }
    const denied = await handleOutOfBoundPath(resolved, ctx);
    if (denied !== null) return denied;
  }

  if (!fs.existsSync(resolved)) return `文件不存在：${resolved}`;

  const content = fs.readFileSync(resolved, "utf-8");
  const count = content.split(oldStr).length - 1;
  if (count === 0) return `错误：old_str 在文件中未找到，请检查是否完全匹配（含空格/换行）`;
  if (count > 1) return `错误：old_str 在文件中出现 ${count} 次，必须唯一才能安全替换。请提供更多上下文使其唯一`;

  const updated = content.replace(oldStr, newStr);
  fs.writeFileSync(resolved, updated, "utf-8");
  return `已替换：${resolved}`;
}

registerTool({
  requiresMFA: true,
  spec: {
    type: "function",
    function: {
      name: "edit_file",
      description: "精确替换文件中的一段文本（需要 MFA 确认）。old_str 必须在文件中唯一出现。适合局部修改，避免 write_file 覆写整个文件。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "文件路径" },
          old_str: { type: "string", description: "要被替换的原始文本，必须与文件内容完全匹配（含空格、换行），且在文件中唯一出现" },
          new_str: { type: "string", description: "替换后的新文本" },
        },
        required: ["path", "old_str", "new_str"],
      },
    },
  },
  execute: (args, ctx) => editFileImpl(args, ctx),
});

// ── read_file ─────────────────────────────────────────────────────────────────

async function readFileImpl(args: Record<string, unknown>): Promise<string> {
  const filePath = String(args["path"] ?? "");
  if (!filePath) return "错误：缺少 path 参数";

  const resolved = path.resolve(expandHome(filePath));
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
