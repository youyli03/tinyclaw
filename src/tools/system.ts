import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { registerTool, type ToolContext } from "./registry.js";
import { checkWritePath, checkExecCommand, checkReadPath } from "./path-guard.js";
import { buildSandboxPlan, describeSandboxPlan, sandboxAvailable } from "../sandbox/bwrap.js";
import { materializeFilteredSecrets, cleanupFilteredSecrets } from "../sandbox/secrets-filter.js";
import { withWakeShimPath } from "../core/wake-shim.js";
import { canReadSecrets } from "../auth/secrets-access.js";
import { announceElevation, requestElevation } from "../sandbox/elevation.js";
import { auditToolCall } from "../auth/tool-policy.js";
import type { RunOrigin } from "../security/audit.js";
import { locateAndReplace } from "./edit-file-core.js";
import { loadConfig } from "../config/loader.js";

const _require = createRequire(import.meta.url);

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
  let output = [stdout, stderr ? `[stderr] ${stderr}` : ""].filter(Boolean).join("\n");
  const originalLength = output.length;
  if (originalLength > MAX_EXEC_OUTPUT) {
    output =
      output.slice(0, MAX_EXEC_OUTPUT) +
      `\n[…输出已截断：共 ${originalLength} 字符，仅显示前 ${MAX_EXEC_OUTPUT} 字符]`;
  }
  return output;
}

/**
 * exec_shell 的实现体。
 *
 * ⚠️ 对外导出仅供同目录的 `fs-search.ts`（grep / glob）复用 —— 目的是让那三个工具
 * **共用同一条执行路径**（沙箱 / 提权 / 超时 / 审计 / 密钥掩码），
 * 而不是自己再 spawn 一个子进程、绕开沙箱边界层。
 */
export async function execShellImpl(
  args: Record<string, unknown>,
  ctx?: ToolContext
): Promise<string> {
  const command = String(args["command"] ?? "");
  if (!command) return "错误：缺少 command 参数";
  const parsedTimeoutSec = parseExecTimeoutSec(args["timeout_sec"]);

  // ── 危险系统路径写操作检测 ────────────────────────────────────────────────
  const execCheck = checkExecCommand(command);
  if (execCheck.blocked) {
    if (execCheck.mode === "overwrite") {
      return `[安全拦截] 不允许直接覆盖系统配置文件 "${execCheck.path}"。请改用 write_file 工具申请授权，或让用户手动操作。`;
    }
    if (ctx?.onAskUser) {
      const { answer } = await ctx.onAskUser(
        `⚠️ AI 请求追加写入系统文件 "${execCheck.path}"，是否允许？此操作可能影响系统网络/安全配置。`,
        [{ label: "允许" }, { label: "拒绝", recommended: true }]
      );
      if (answer !== "允许") {
        return `已拒绝：不允许追加写入系统文件 "${execCheck.path}"`;
      }
    } else {
      return `[安全拦截] 追加写入系统文件 "${execCheck.path}" 需用户确认，但当前无交互回调，已自动拒绝。`;
    }
  }

  if (typeof parsedTimeoutSec === "string") return parsedTimeoutSec;
  const timeoutSec = parsedTimeoutSec;
  const timeoutMs = timeoutSec * 1000;

  // ── 沙箱（边界层）────────────────────────────────────────────────────────
  // `[sandbox].enabled && execShell="sandbox"` 时把命令关进 bwrap：
  // 密钥文件在沙箱内不存在、未绑定目录只读、可选断网。
  // `elevate: true` 则请求**在宿主机执行一次**（需审批 + 一次性令牌，见 sandbox/elevation.ts）。
  const sandboxCfg = loadConfig().sandbox;
  const wantElevate = args["elevate"] === true;
  const wantSandbox = sandboxCfg.enabled && sandboxCfg.execShell === "sandbox" && !wantElevate;
  let spawnCmd = "bash";
  let spawnArgs = ["-c", command];
  let spawnEnv: NodeJS.ProcessEnv | undefined;
  /** 按任务物化的密钥过滤文件（子进程退出后清理） */
  let filteredSecrets: string | null = null;

  const toolOrigin: RunOrigin | undefined =
    ctx?.origin ??
    (ctx?.sessionId?.startsWith("cron_")
      ? "cron"
      : ctx?.sessionId?.startsWith("slave:")
        ? "slave"
        : ctx?.sessionId?.startsWith("probe:")
          ? "cli"
          : ctx?.masterSession
            ? "chat"
            : undefined);

  if (wantElevate && sandboxCfg.enabled) {
    // 子 Agent（approvalPolicy="never"）不允许提权：确定性拒绝，不发起任何审批。
    if (ctx?.approvalPolicy === "never") {
      auditToolCall({
        event: "policy",
        origin: toolOrigin,
        agentId: ctx.agentId ?? "default",
        ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
        tool: "exec_shell",
        decision: "deny",
        reason: "子 Agent approvalPolicy=never，不允许提权",
        args: { command },
        cfg: sandboxCfg,
      });
      return "已拒绝：子 Agent 不允许提权（approvalPolicy=never），请在沙箱内用可行方式完成";
    }
    const decision = await requestElevation({
      command,
      origin: toolOrigin,
      agentId: ctx?.agentId ?? "default",
      ...(ctx?.sessionId ? { sessionId: ctx.sessionId } : {}),
      ...(ctx?.onMFARequest ? { onMFARequest: ctx.onMFARequest } : {}),
      ...(ctx?.onAskUser ? { onAskUser: ctx.onAskUser } : {}),
      cfg: sandboxCfg,
    });
    if (!decision.allowed) {
      auditToolCall({
        event: "policy",
        origin: toolOrigin,
        agentId: ctx?.agentId ?? "default",
        ...(ctx?.sessionId ? { sessionId: ctx.sessionId } : {}),
        tool: "exec_shell",
        decision: "deny",
        reason: `提权被拒（${decision.level ?? "?"}）`,
        args: { command },
        cfg: sandboxCfg,
      });
      return decision.reason ?? "已拒绝：提权未获批准";
    }
    await announceElevation({
      command,
      origin: toolOrigin,
      agentId: ctx?.agentId ?? "default",
      ...(ctx?.sessionId ? { sessionId: ctx.sessionId } : {}),
      ...(decision.level ? { level: decision.level } : {}),
      ...(decision.reusedToken ? { reusedToken: decision.reusedToken } : {}),
      ...(ctx?.onNotify ? { onNotify: ctx.onNotify } : {}),
      cfg: sandboxCfg,
    });
    console.log(`[sandbox] 提权执行（${decision.level}）：${command.slice(0, 80)}`);
  }

  if (wantSandbox) {
    const availability = sandboxAvailable();
    if (!availability.available) {
      const reason = availability.reason ?? "bwrap 不可用";
      if (sandboxCfg.onUnavailable === "deny") {
        return `[安全拦截] 沙箱不可用（${reason}），已拒绝执行。如需退回本机执行，请设置 [sandbox].onUnavailable = "host"。`;
      }
      console.warn(`[sandbox] ${reason}，按配置退回本机执行`);
    } else {
      // 可写豁免 = 任务声明的（cron/loop writablePaths）+ 会话内 fs_grant 授权的路径
      const extraRw = [
        ...(ctx?.sandboxExtraRwPaths ?? []),
        ...(ctx?.masterSession?.listWriteGrants?.() ?? []),
      ];
      // 按任务声明的密钥过滤（方案 B）：脚本零改动，但只看得见自己声明的 key
      // ⚠️ 先过 `[secrets].agents` 授权：声明式 secrets 也是"按名字取密钥"，不能绕过这层
      const declaredSecrets = ctx?.sandboxSecretNames ?? [];
      if (declaredSecrets.length > 0 && !canReadSecrets(ctx?.agentId)) {
        console.warn(
          `[sandbox] agent "${ctx?.agentId ?? "?"}" 未被授权读 secrets.toml，声明的 ${declaredSecrets.join(", ")} 不物化（沙箱内为空文件）`
        );
        auditToolCall({
          event: "policy",
          origin: toolOrigin,
          agentId: ctx?.agentId ?? "default",
          ...(ctx?.sessionId ? { sessionId: ctx.sessionId } : {}),
          tool: "exec_shell",
          decision: "deny",
          reason: "未授权读 secrets.toml（[secrets].agents），声明的 secrets 未物化",
          args: { secretNames: declaredSecrets },
          cfg: sandboxCfg,
        });
      } else if (declaredSecrets.length > 0) {
        filteredSecrets = materializeFilteredSecrets({
          names: declaredSecrets,
          label: ctx?.sessionId ?? "adhoc",
          origin: toolOrigin,
          agentId: ctx?.agentId ?? "default",
          ...(ctx?.sessionId ? { sessionId: ctx.sessionId } : {}),
        });
      }
      const plan = buildSandboxPlan({
        command,
        agentId: ctx?.agentId ?? "default",
        ...(ctx?.cwd ? { cwd: ctx.cwd } : {}),
        ...(extraRw.length > 0 ? { extraRwPaths: extraRw } : {}),
        ...(filteredSecrets ? { filteredSecretsFile: filteredSecrets } : {}),
        cfg: sandboxCfg,
      });
      const [head, ...tail] = plan.argv;
      spawnCmd = head ?? "bwrap";
      spawnArgs = tail;
      if (plan.env) spawnEnv = plan.env;
      console.log(`[sandbox] ${describeSandboxPlan(plan)}: ${command.slice(0, 80)}`);
      auditToolCall({
        event: "sandbox",
        origin: toolOrigin,
        agentId: ctx?.agentId ?? "default",
        ...(ctx?.sessionId ? { sessionId: ctx.sessionId } : {}),
        tool: "exec_shell",
        decision: "info",
        reason: describeSandboxPlan(plan),
        args: { command },
        cfg: sandboxCfg,
      });
    }
  }

  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let killHandle: NodeJS.Timeout | undefined;
    let timedOut = false;
    let settled = false;

    const finish = (message: string) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      if (killHandle) clearTimeout(killHandle);
      // 清理按任务物化的密钥过滤文件（子进程已退出）
      cleanupFilteredSecrets(filteredSecrets);
      resolve(message);
    };

    // 额外环境变量（cron/loop 的 agent env 增量）：只叠加增量，不改宿主 process.env。
    // 沙箱路径下不能整份覆盖 plan.env —— 它可能被 [sandbox].network="deny" 收敛过。
    const extraEnv = ctx?.extraEnv;
    const baseEnv: Record<string, string | undefined> = spawnEnv ?? process.env;
    const merged: Record<string, string | undefined> =
      extraEnv && Object.keys(extraEnv).length > 0 ? { ...baseEnv, ...extraEnv } : { ...baseEnv };
    // 让 shell 里"喊一声 wake 就有"：把 wake shim 目录前置到 PATH（见 core/wake-shim.ts）
    spawnEnv = withWakeShimPath(merged);

    const child = spawn(spawnCmd, spawnArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      detached: true, // 让 bash 成为新进程组 leader，kill 时可杀整组
      ...(ctx?.cwd ? { cwd: ctx.cwd } : {}),
      ...(spawnEnv ? { env: spawnEnv } : {}),
    });

    // 若是 slave session，打印子进程 PID（便于追踪或手动 kill）
    if (ctx?.sessionId?.startsWith("slave:") && child.pid != null) {
      const slaveId = ctx.sessionId.slice("slave:".length);
      console.log(
        `[slave:${slaveId}] exec pid=${child.pid}: ${command.slice(0, 80)}${command.length > 80 ? "…" : ""}`
      );
    }

    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.stderr.on("data", (d: Buffer) => errChunks.push(d));

    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      // detached=true 时 bash 是进程组 leader，用 -pid 向整个进程组发信号
      // 这样 bash 下 spawn 的子进程（如 sleep 1800000）也会被一并杀掉
      const killGroup = (sig: NodeJS.Signals) => {
        if (child.pid != null) {
          try {
            process.kill(-child.pid, sig);
            return;
          } catch {
            /* pgid 可能已消失 */
          }
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
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "exec_shell",
      description:
        `Execute a shell command locally. Default timeout ${DEFAULT_EXEC_TIMEOUT_SEC} seconds; ` +
        "for long-running work such as build, test, install or slow network calls, pass a larger " +
        "timeout_sec explicitly. The execution environment follows the [sandbox] config: " +
        "when the sandbox is enabled the command runs inside bubblewrap (secret files hidden, " +
        "unbound directories read-only), so operations needing ~/.ssh (ssh / git push) fail; " +
        "if truly necessary, pass elevate: true to request one execution outside the sandbox " +
        "(requires user approval, never allowed in unattended scenarios such as cron / loop).",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Bash command to execute" },
          elevate: {
            type: "boolean",
            description:
              "Request execution **outside the sandbox** (on the host), default false. " +
              "Use it only when the sandbox blocks what you must do, for example ssh / git " +
              "push that need ~/.ssh, writing outside the sandbox, or systemctl. It asks " +
              "for user approval, then issues a one-time token (valid for this command " +
              "only, 120 seconds by default); if the user refuses, or the run is " +
              "unattended (cron/loop), it is denied outright and you should use an " +
              "in-sandbox alternative instead.",
          },
          timeout_sec: {
            type: "integer",
            description:
              `Command timeout in seconds (optional, default ${DEFAULT_EXEC_TIMEOUT_SEC}). ` +
              "Commands expected to take over 1 minute must set a larger value explicitly, " +
              "for example build, test or dependency installation.",
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
  ctx?: ToolContext
): Promise<string | null> {
  const mode = (() => {
    try {
      return loadConfig().auth?.mfa?.path_guard_mode ?? "mfa";
    } catch {
      return "mfa";
    }
  })();

  if (mode === "deny") {
    return `错误：写入路径 "${resolvedPath}" 超出允许的工作目录范围`;
  }

  if (mode === "ask" && ctx?.onAskUser) {
    const { answer } = await ctx.onAskUser(
      `AI 请求写入 "${resolvedPath}"（超出 workspace 范围），是否允许？`,
      [{ label: "允许" }, { label: "拒绝", recommended: true }]
    );
    if (answer !== "允许") {
      return `已拒绝：不允许写入 "${resolvedPath}"`;
    }
  } else if ((mode === "simple" || mode === "totp" || mode === "msal") && ctx?.onMFARequest) {
    const ok = await ctx.onMFARequest(
      `⚠️ AI 请求写入 "${resolvedPath}"（超出 workspace 范围），是否允许？`
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
      description: "Write content to a file (requires MFA confirmation).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute or relative file path" },
          content: { type: "string", description: "File content" },
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
      description: "Delete a file or directory (requires MFA confirmation).",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Path of the file or directory to delete" },
        },
        required: ["path"],
      },
    },
  },
  execute: (args, ctx) => deleteFileImpl(args, ctx),
});

async function editFileImpl(args: Record<string, unknown>, ctx?: ToolContext): Promise<string> {
  const filePath = String(args["path"] ?? "");
  const oldStr = String(args["old_str"] ?? "");
  const newStr = String(args["new_str"] ?? "");
  if (!filePath) return "错误:缺少 path 参数";
  if (!oldStr) return "错误:缺少 old_str 参数";

  // 相对路径基于 ctx.cwd(agent workspace)解析,而非进程 cwd
  const _base = ctx?.cwd ?? process.cwd();
  const resolved = path.isAbsolute(expandHome(filePath))
    ? path.resolve(expandHome(filePath))
    : path.resolve(_base, expandHome(filePath));

  const check = checkWritePath(resolved, ctx);
  if (!check.allow) {
    if (check.isDangerous) {
      return `错误:禁止编辑 "${resolved}"(${check.reason})`;
    }
    const denied = await handleOutOfBoundPath(resolved, ctx);
    if (denied !== null) return denied;
  }

  if (!fs.existsSync(resolved)) return `文件不存在:${resolved}`;

  const content = fs.readFileSync(resolved, "utf-8");
  const result = locateAndReplace(content, oldStr, newStr);
  if (result.status === "ok") {
    fs.writeFileSync(resolved, result.content, "utf-8");
    return `已替换:${resolved}${result.note ? `(${result.note})` : ""}`;
  }
  return result.message;
}

registerTool({
  requiresMFA: true,
  spec: {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Replace one exact text segment in a file (requires MFA confirmation). old_str must " +
        "match the file content and appear exactly once; full-width/half-width punctuation, " +
        "ellipsis (U+2026) and leading/trailing whitespace are tolerated automatically, " +
        "and an unmatched old_str returns a diff diagnosis (with line numbers and Unicode " +
        "code points). Use it for local edits instead of overwriting the whole file with " +
        "write_file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path" },
          old_str: {
            type: "string",
            description:
              "Original text to be replaced; it must match the file content exactly (including " +
              "spaces and newlines) and appear exactly once in the file. Full-width/half-width " +
              "punctuation differences are tolerated automatically",
          },
          new_str: { type: "string", description: "New text to replace it with" },
        },
        required: ["path", "old_str", "new_str"],
      },
    },
  },
  execute: (args, ctx) => editFileImpl(args, ctx),
});
// ── read_file ─────────────────────────────────────────────────────────────────

/** 从文件提取纯文本（按后缀分流：PDF/DOCX/XLSX/普通文本）*/
async function extractFileText(resolved: string): Promise<string> {
  const ext = path.extname(resolved).toLowerCase();

  if (ext === ".pdf") {
    const pdfParse = _require("pdf-parse") as (buf: Buffer) => Promise<{ text: string }>;
    const buf = fs.readFileSync(resolved);
    const data = await pdfParse(buf);
    return data.text;
  }

  if (ext === ".docx") {
    const mammoth = _require("mammoth") as {
      extractRawText: (opts: { path: string }) => Promise<{ value: string }>;
    };
    const result = await mammoth.extractRawText({ path: resolved });
    return result.value;
  }

  if (ext === ".xlsx" || ext === ".xls") {
    const XLSX = _require("xlsx") as typeof import("xlsx");
    const wb = XLSX.readFile(resolved);
    return wb.SheetNames.map((name) => {
      const sheet = wb.Sheets[name];
      const csv = sheet ? XLSX.utils.sheet_to_csv(sheet) : "";
      return `=== Sheet: ${name} ===\n${csv}`;
    }).join("\n\n");
  }

  // 普通文本文件
  return fs.readFileSync(resolved, "utf-8");
}

async function readFileImpl(args: Record<string, unknown>): Promise<string> {
  const filePath = String(args["path"] ?? "");
  if (!filePath) return "错误:缺少 path 参数";

  const resolved = path.resolve(expandHome(filePath));
  // 读路径守卫：密钥（~/.tinyclaw/config.toml、secrets.toml、auth/**、*.key …）与受保护目录不可读
  const readCheck = checkReadPath(resolved);
  if (!readCheck.allow) return `错误：禁止读取 "${resolved}"（${readCheck.reason}）`;
  if (!fs.existsSync(resolved)) return `文件不存在:${resolved}`;

  const offset = Math.max(0, Number(args["offset"] ?? 0) || 0);
  const length = Math.max(1, Number(args["length"] ?? 50_000) || 50_000);

  const ext = path.extname(resolved).toLowerCase();
  const isRichFormat = [".pdf", ".docx", ".xlsx", ".xls"].includes(ext);

  // 普通文本：保留原有大小检查（未指定 offset/length 时）
  if (!isRichFormat && offset === 0 && args["length"] == null) {
    const stat = fs.statSync(resolved);
    if (stat.size > 500_000) {
      return `文件过大(${stat.size} 字节),请使用 offset/length 参数分段读取`;
    }
    // 原有简洁路径：直接读取返回
    const text = fs.readFileSync(resolved, "utf-8");
    if (text.length <= 50_000) return text;
    return (
      text.slice(0, 50_000) + `\n[...已截断,共 ${text.length} 字符,可传 offset=50000 继续读取]`
    );
  }

  let fullText: string;
  try {
    fullText = await extractFileText(resolved);
  } catch (err: unknown) {
    return `解析失败:${(err as Error).message}`;
  }

  const total = fullText.length;
  const slice = fullText.slice(offset, offset + length);
  const remaining = Math.max(0, total - offset - slice.length);

  const header = `[偏移: ${offset}, 返回: ${slice.length}, 总长: ${total}]`;
  const footer =
    remaining > 0
      ? `\n[还有 ${remaining} 字符，可传 offset=${offset + slice.length} 继续读取]`
      : "";

  return `${header}\n${slice}${footer}`;
}

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read file content (up to 50KB). Supports PDF (.pdf), Word (.docx), Excel (.xlsx/.xls) " +
        "and plain text files, extracting text automatically. Use offset/length to read large " +
        "files in chunks.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path" },
          offset: {
            type: "integer",
            description: "Character offset to start reading from (default 0)",
          },
          length: {
            type: "integer",
            description:
              "Maximum characters to read (default 50000). For large files, lower this " +
              "value to read in chunks",
          },
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
        "Read a local image file and return a base64 data URL for a vision model to analyze " +
        "(limit 8 MB). When an image in earlier messages was dropped (shown as " +
        "`[历史图片: /path...]`), call this tool to load and view it again.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Absolute path to the image (png/jpg/webp/gif supported)",
          },
          prompt: {
            type: "string",
            description:
              "Optional question for the vision model, prepended to the default description " +
              "prompt, e.g. focus on the color of the liquid in the cup",
          },
        },
        required: ["path"],
      },
    },
  },
  execute: async (args: Record<string, unknown>) => {
    const imgPath = path.resolve(String(args["path"] ?? "").replace(/^~/, os.homedir()));
    const readCheck = checkReadPath(imgPath);
    if (!readCheck.allow) return `错误：禁止读取 "${imgPath}"（${readCheck.reason}）`;
    if (!fs.existsSync(imgPath)) return `文件不存在: ${imgPath}`;
    const stat = fs.statSync(imgPath);
    const MAX = 8 * 1024 * 1024;
    if (stat.size > MAX)
      return `文件过大(${(stat.size / 1024 / 1024).toFixed(1)} MB)，超过 8 MB 限制`;
    const ext = path.extname(imgPath).toLowerCase().slice(1);
    const mime =
      ext === "jpg" || ext === "jpeg"
        ? "image/jpeg"
        : ext === "png"
          ? "image/png"
          : ext === "gif"
            ? "image/gif"
            : ext === "webp"
              ? "image/webp"
              : "image/png";
    const buf = fs.readFileSync(imgPath);
    const dataUrl = `data:${mime};base64,${buf.toString("base64")}`;
    return dataUrl;
  },
});
