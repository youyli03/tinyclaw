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
const DEFAULT_EXEC_TIMEOUT_SEC = 60;
const EXEC_TIMEOUT_KILL_GRACE_MS = 1_000;

function parseExecTimeoutSec(raw: unknown): number | string {
  if (raw == null || raw === "") return DEFAULT_EXEC_TIMEOUT_SEC;
  const value = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    return `错误：timeout_sec 必须是正整数，当前值为 ${JSON.stringify(raw)}`;
  }
  return value;
}

function formatExecOutput(stdout: string, stderr: string): string {
  let output = [stdout, stderr ? `[stderr] ${stderr}` : ""]
    .filter(Boolean)
    .join("\n");
  const originalLength = output.length;
  if (originalLength > MAX_EXEC_OUTPUT) {
    output = output.slice(0, MAX_EXEC_OUTPUT) +
      `\n[…输出已截断：共 ${originalLength} 字符，仅显示前 ${MAX_EXEC_OUTPUT} 字符]`;
  }
  return output;
}

async function execShellImpl(args: Record<string, unknown>, ctx?: ToolContext): Promise<string> {
  const command = String(args["command"] ?? "");
  if (!command) return "错误：缺少 command 参数";
  const parsedTimeoutSec = parseExecTimeoutSec(args["timeout_sec"]);
  if (typeof parsedTimeoutSec === "string") return parsedTimeoutSec;
  const timeoutSec = parsedTimeoutSec;
  const timeoutMs = timeoutSec * 1000;

  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let timeoutHandle: NodeJS.Timeout | undefined;
    let killHandle: NodeJS.Timeout | undefined;
    let timedOut = false;
    let settled = false;

    const finish = (message: string) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (killHandle) clearTimeout(killHandle);
      resolve(message);
    };

    const child = spawn("bash", ["-c", command], {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,   // 让 bash 成为新进程组 leader，kill 时可杀整组
      ...(ctx?.cwd ? { cwd: ctx.cwd } : {}),
    });

    // 若是 slave session，打印子进程 PID（便于追踪或手动 kill）
    if (ctx?.sessionId?.startsWith("slave:") && child.pid != null) {
      const slaveId = ctx.sessionId.slice("slave:".length);
      console.log(`[slave:${slaveId}] exec pid=${child.pid}: ${command.slice(0, 80)}${command.length > 80 ? "…" : ""}`);
    }

    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.stderr.on("data", (d: Buffer) => errChunks.push(d));

    timeoutHandle = setTimeout(() => {
      timedOut = true;
      // detached=true 时 bash 是进程组 leader，用 -pid 向整个进程组发信号
      // 这样 bash 下 spawn 的子进程（如 sleep 1800000）也会被一并杀掉
      const killGroup = (sig: NodeJS.Signals) => {
        if (child.pid != null) {
          try { process.kill(-child.pid, sig); return; } catch { /* pgid 可能已消失 */ }
        }
        child.kill(sig);
      };
      killGroup("SIGTERM");
      killHandle = setTimeout(() => {
        if (!settled) killGroup("SIGKILL");
      }, EXEC_TIMEOUT_KILL_GRACE_MS);
    }, timeoutMs);

    child.on("close", (code, signal) => {
      const stdout = Buffer.concat(chunks).toString("utf-8").trim();
      const stderr = Buffer.concat(errChunks).toString("utf-8").trim();
      const output = formatExecOutput(stdout, stderr);
      if (timedOut) {
        const timeoutMsg = `执行超时：命令在 ${timeoutSec} 秒后仍未结束，已终止进程。`;
        finish(output ? `${timeoutMsg}\n\n[部分输出]\n${output}` : timeoutMsg);
        return;
      }
      if (output) {
        finish(output);
        return;
      }
      finish(signal ? `（进程被信号 ${signal} 终止，无输出）` : `（退出码 ${code}，无输出）`);
    });

    child.on("error", (err) => {
      finish(`执行失败：${err.message}`);
    });
  });
}

registerTool({
  requiresMFA: true,
  spec: {
    type: "function",
    function: {
      name: "exec_shell",
      description:
        `在本机执行 shell 命令（需要 MFA 确认）。默认超时 ${DEFAULT_EXEC_TIMEOUT_SEC} 秒；` +
        "对于 build/test/install/长网络请求等长任务，必须显式传入更大的 timeout_sec。",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "要执行的 bash 命令" },
          timeout_sec: {
            type: "integer",
            description:
              `命令超时时间（秒，可选，默认 ${DEFAULT_EXEC_TIMEOUT_SEC}）。` +
              "预计超过 1 分钟的命令必须显式设置更大的值，例如构建、测试、安装依赖。",
          },
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

  // 相对路径基于 ctx.cwd（agent workspace）解析，而非进程 cwd
  const _base = ctx?.cwd ?? process.cwd();
  const resolved = path.isAbsolute(expandHome(filePath))
    ? path.resolve(expandHome(filePath))
    : path.resolve(_base, expandHome(filePath));

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

  // 相对路径基于 ctx.cwd（agent workspace）解析，而非进程 cwd
  const _base = ctx?.cwd ?? process.cwd();
  const resolved = path.isAbsolute(expandHome(filePath))
    ? path.resolve(expandHome(filePath))
    : path.resolve(_base, expandHome(filePath));

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

  // 相对路径基于 ctx.cwd（agent workspace）解析，而非进程 cwd
  const _base = ctx?.cwd ?? process.cwd();
  const resolved = path.isAbsolute(expandHome(filePath))
    ? path.resolve(expandHome(filePath))
    : path.resolve(_base, expandHome(filePath));

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

// ── read_image ────────────────────────────────────────────────────────────────

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "read_image",
      description:
        "读取本地图片文件，返回 base64 data URL，供视觉模型分析图片内容（上限 8 MB）。" +
        "当历史消息中的图片被丢弃（显示为 [历史图片: /path...]）时，可调用此 tool 重新加载查看。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "图片的绝对路径（支持 png/jpg/webp/gif）" },
        },
        required: ["path"],
      },
    },
  },
  execute: async (args: Record<string, unknown>) => {
    const imgPath = path.resolve(String(args["path"] ?? "").replace(/^~/, os.homedir()));
    if (!fs.existsSync(imgPath)) return `文件不存在: ${imgPath}`;
    const stat = fs.statSync(imgPath);
    const MAX = 8 * 1024 * 1024;
    if (stat.size > MAX) return `文件过大(${(stat.size / 1024 / 1024).toFixed(1)} MB)，超过 8 MB 限制`;
    const ext = path.extname(imgPath).toLowerCase().slice(1);
    const mime =
      ext === "jpg" || ext === "jpeg" ? "image/jpeg" :
      ext === "png"  ? "image/png"  :
      ext === "gif"  ? "image/gif"  :
      ext === "webp" ? "image/webp" :
      "image/png";
    const buf = fs.readFileSync(imgPath);
    const dataUrl = `data:${mime};base64,${buf.toString("base64")}`;
    return dataUrl;
  },
});
