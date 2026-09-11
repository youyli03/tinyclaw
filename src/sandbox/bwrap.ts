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
  /** 是否用"按任务过滤"的密钥文件替换了 secrets.toml */
  filteredSecrets?: boolean;
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

  /** `[sandbox].readableSecretPaths` 里显式豁免的路径（保持可读） */
  const exempt = new Set(cfg.readableSecretPaths.map((p) => path.resolve(expandHome(p))));
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
    const abs = path.resolve(p);
    if (exempt.has(abs)) {
      skipped.push(abs); // 显式豁免：不掩码（仍受根只读保护）
      continue;
    }
    if (fs.existsSync(abs)) masked.push(abs);
    else skipped.push(abs);
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
/**
 * 展开可写路径：显式声明的**文件**要连同它的 SQLite 边车文件一起放开。
 *
 * 为什么：声明 `~/.tinyclaw/dashboard.db` 时，SQLite 在 WAL 模式下还要写同目录的
 * `dashboard.db-wal` / `-shm`（回滚日志模式还要 `-journal`）；只 bind 主文件会得到
 * `attempt to write a readonly database`。父目录仍保持只读，因此只放开这几个具体文件。
 */
function expandWritablePaths(paths: string[]): string[] {
  const out: string[] = [];
  for (const p of paths) {
    const abs = path.resolve(expandHome(p));
    out.push(abs);
    try {
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
      for (const suffix of ["-wal", "-shm", "-journal"]) {
        const sidecar = abs + suffix;
        if (fs.existsSync(sidecar)) out.push(sidecar);
      }
    } catch {
      /* 忽略 stat 失败 */
    }
  }
  return out;
}

/** 沙箱内 secrets.toml 的绝对路径（掩码与"按任务过滤"都要用它做比对） */
const secretsTomlAbsPath = path.join(os.homedir(), ".tinyclaw", "secrets.toml");

export function buildSandboxPlan(opts: {
  command: string;
  cwd?: string;
  agentId: string;
  cfg: SandboxConfig;
  /** 追加掩码（如处理不可信内容时额外隐藏某些目录） */
  extraMasks?: string[];
  /**
   * 追加可写目录。用途：
   * - **code 模式**：`ctx.cwd` 是项目目录（`codedir`），不 bind 的话 shell 改不了项目
   * - **cron / loop**：job 配置里显式声明的 `writablePaths`
   */
  extraRwPaths?: string[];
  /**
   * 按任务声明过滤后的密钥文件（方案 B）：bind 到沙箱内的 `~/.tinyclaw/secrets.toml`，
   * 让脚本"零改动"读到**只含该任务声明的 key** 的内容。
   */
  filteredSecretsFile?: string;
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
  // **默认只有 workspace**（+ 系统临时目录）。agent 目录下的其他部分
  // （memory / cards / skills / notes / logs / MEM.md / SYSTEM.md / agent.toml …）
  // 以及运行时目录的其他部分与 code 项目目录，都必须**显式声明**：
  // cron/loop 用 `writablePaths`，chat/cli 用 `fs_grant`（agent 主动触发提权）。
  const rwPaths = [
    agentManager.workspaceDir(agentId), // agents/<id>/workspace
    path.join(os.tmpdir()),
    ...expandWritablePaths(cfg.extraRwPaths),
    // code 模式的 cwd（项目目录）：不 bind 就没法改项目（2026-09-11 修复）
    ...(cwd ? [path.resolve(expandHome(cwd))] : []),
    ...expandWritablePaths(opts.extraRwPaths ?? []),
  ].filter((p, i, arr) => {
    // 去重 + 只保留存在的目录
    if (arr.indexOf(p) !== i) return false;
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
    // 密钥文件若有"按任务过滤"的版本，用它覆盖（脚本零改动，但只看得见声明的 key）
    if (opts.filteredSecretsFile && p === secretsTomlAbsPath) {
      argv.push("--ro-bind", opts.filteredSecretsFile, p);
      continue;
    }
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
    ...(opts.filteredSecretsFile ? { filteredSecrets: true } : {}),
    ...(env ? { env } : {}),
  };
}

/** 人类可读的一行摘要（写进审计与日志） */
export function describeSandboxPlan(plan: SandboxPlan): string {
  return (
    `sandbox: masked=${plan.masked.length} rw=${plan.rwPaths.length} ` +
    `net=${plan.network ? "allow" : "deny"} env=${plan.env ? "scrubbed" : "inherit"}` +
    (plan.filteredSecrets ? " secrets=filtered" : "")
  );
}
