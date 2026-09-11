/**
 * bubblewrap 沙箱（边界层）—— 把 `exec_shell` 关进挂载命名空间。
 *
 * 设计（详见 `tmp/sandbox-permission-design-20260911.md` §4）：
 * - **边界层**（本模块）：密钥文件在沙箱内被空文件/空目录掩码覆盖 → **不存在**，而不是"检查后拒绝"；
 *   未绑定目录一律只读；可选断网。内核强制，无法用静态二进制或 `syscall()` 绕过。
 * - **策略层**（`auth/tool-policy.ts`）：审批、白名单、审计。
 *
 * 与 `[selfAccess]` 的关系：沙箱对 `exec_shell` 生效，`~/.tinyclaw` 默认给**可写**
 * （与自指权限一致），但密钥路径随后被掩码覆盖（bwrap 后写的绑定优先）。
 *
 * ⚠️ 已知边界：**掩码不覆盖环境变量**。`~/.tinyclaw/env` 会在服务启动时注入 `process.env`，
 * 因此若非 `network = "deny"` 场景仍需继承环境（`inheritEnv`），沙箱内的命令照样能看到那些变量。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import type { SandboxConfig } from "../config/schema.js";
import { agentManager } from "../core/agent-manager.js";

/** 运行时目录内需要掩码的**文件**（相对 `~/.tinyclaw`） */
const MASK_FILES = [
  "config.toml", // providers 的 apiKey / githubToken
  "secrets.toml", // 所有第三方 token
  "mcp.toml", // MCP server 的 env（可能含 token）
  "env", // IWENCAI_API_KEY 等（另见"环境变量"警告）
  ".github_token",
  "yingli_token.json",
];

/** 运行时目录内需要掩码的**目录** */
const MASK_DIRS = ["auth"]; // totp.key / msal-cache.json

/** 运行时目录内按扩展名掩码的文件 */
const MASK_EXTS = [".key", ".pem", ".p12", ".pfx"];

/** 运行时目录之外需要掩码的路径（家目录下的凭证） */
const MASK_HOME_PATHS = [".ssh", ".aws", ".netrc", ".gnupg", ".config/gh", ".docker/config.json"];

export interface SandboxAvailability {
  available: boolean;
  version?: string;
  reason?: string;
}

/** bwrap 是否可用（未安装 / 内核不支持用户命名空间时不可用） */
export function sandboxAvailable(): SandboxAvailability {
  try {
    const version = execFileSync("bwrap", ["--version"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    }).trim();
    return { available: true, version };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    return {
      available: false,
      reason: e.code === "ENOENT" ? "未安装 bubblewrap（bwrap）" : `bwrap 不可用：${e.message}`,
    };
  }
}

export interface SandboxPlan {
  /** 完整命令行（bwrap … -- bash -c <command>） */
  argv: string[];
  /** 实际生效的掩码路径（供日志/审计） */
  masked: string[];
  /** 声明了但当前不存在的掩码（跳过，记下来便于诊断） */
  skipped: string[];
  /** 可写目录 */
  rwPaths: string[];
  /** 沙箱内是否联网 */
  network: boolean;
  /** 传给子进程的环境变量（undefined = 继承服务进程环境） */
  env?: NodeJS.ProcessEnv;
}

function expandHome(p: string): string {
  return p === "~" || p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

/** 一次沙箱运行需要的空占位（掩码用） */
function placeholders(): { emptyDir: string; emptyFile: string } {
  const base = path.join(os.homedir(), ".tinyclaw", "sandbox");
  const emptyDir = path.join(base, "empty-dir");
  const emptyFile = path.join(base, "empty-file");
  fs.mkdirSync(emptyDir, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(emptyFile)) fs.writeFileSync(emptyFile, "", { mode: 0o600 });
  return { emptyDir, emptyFile };
}

/** 收集本次运行要掩码的路径（只返回实际存在的） */
export function maskTargets(cfg: SandboxConfig): { masked: string[]; skipped: string[] } {
  const masked: string[] = [];
  const skipped: string[] = [];
  if (!cfg.maskSecrets) return { masked, skipped };

  const root = path.join(os.homedir(), ".tinyclaw");
  const candidates: string[] = [
    ...MASK_FILES.map((f) => path.join(root, f)),
    ...MASK_DIRS.map((d) => path.join(root, d)),
    ...MASK_HOME_PATHS.map((p) => path.join(os.homedir(), p)),
  ];
  // 运行时目录内的 *.key / *.pem（如 polymarket.key）
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (MASK_EXTS.some((ext) => entry.name.toLowerCase().endsWith(ext))) {
        candidates.push(path.join(root, entry.name));
      }
    }
  } catch {
    /* 目录不可读时忽略 */
  }

  for (const p of candidates) {
    if (fs.existsSync(p)) masked.push(p);
    else skipped.push(p);
  }
  return { masked, skipped };
}

/**
 * 构造一次沙箱执行的完整计划。
 *
 * @param opts.command  要执行的 shell 命令（最终交给 `bash -c`）
 * @param opts.cwd      工作目录（沙箱内的路径，须在可写目录内）
 * @param opts.agentId  当前 agent（决定可写的 agent 目录）
 */
export function buildSandboxPlan(opts: {
  command: string;
  cwd?: string;
  agentId: string;
  cfg: SandboxConfig;
  /** 追加掩码（如处理不可信内容时额外隐藏某些目录） */
  extraMasks?: string[];
}): SandboxPlan {
  const { command, cwd, agentId, cfg } = opts;
  const home = os.homedir();
  const root = path.join(home, ".tinyclaw");
  const { emptyDir, emptyFile } = placeholders();

  const { masked, skipped } = maskTargets(cfg);
  for (const extra of opts.extraMasks ?? []) {
    const abs = path.resolve(expandHome(extra));
    if (fs.existsSync(abs)) masked.push(abs);
  }

  // ── 可写目录 ──────────────────────────────────────────────────────────────
  const rwPaths = [
    agentManager.agentDir(agentId), // agents/<id>（含 workspace / memory / skills）
    path.join(root, "tmp"),
    path.join(root, "cache"),
    path.join(root, "reports"),
    path.join(root, "scripts"),
    path.join(os.tmpdir()),
    ...cfg.extraRwPaths.map(expandHome),
  ].filter((p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  });

  const network = cfg.network === "allow";
  const argv: string[] = [
    "bwrap",
    "--unshare-all", // PID/IPC/UTS/user/cgroup/net 全部隔离
    ...(network ? ["--share-net"] : []),
    "--die-with-parent",
    "--new-session", // 防止 TIOCSTI 之类的终端注入
    "--hostname",
    "tinyclaw-sandbox",
    "--ro-bind",
    "/",
    "/", // 全盘只读为底
    "--dev",
    "/dev",
    "--proc",
    "/proc",
  ];

  // 可写目录（后写的绑定优先，因此掩码必须在其后）
  for (const p of rwPaths) argv.push("--bind", p, p);
  // 掩码：目录用空目录盖，文件用空文件盖
  for (const p of masked) {
    let isDir = false;
    try {
      isDir = fs.statSync(p).isDirectory();
    } catch {
      continue;
    }
    argv.push(isDir ? "--bind" : "--ro-bind", isDir ? emptyDir : emptyFile, p);
  }

  argv.push("--chdir", cwd && fs.existsSync(cwd) ? cwd : agentManager.workspaceDir(agentId));
  argv.push("--", "bash", "-c", command);

  // 环境：默认继承；断网模式强制收敛（密钥可能就在环境里）
  const scrubEnv = !cfg.inheritEnv || !network;
  const env = scrubEnv
    ? Object.fromEntries(
        cfg.envAllowlist
          .map((k) => [k, process.env[k]] as const)
          .filter(([, v]) => v !== undefined) as Array<[string, string]>
      )
    : undefined;

  return {
    argv,
    masked,
    skipped,
    rwPaths,
    network,
    ...(env ? { env } : {}),
  };
}

/** 人类可读的一行摘要（写进审计与日志） */
export function describeSandboxPlan(plan: SandboxPlan): string {
  return (
    `sandbox: masked=${plan.masked.length} rw=${plan.rwPaths.length} ` +
    `net=${plan.network ? "allow" : "deny"} env=${plan.env ? "scrubbed" : "inherit"}`
  );
}
