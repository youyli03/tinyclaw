/**
 * `fs_grant` —— 路径级"无感提权"。
 *
 * 与 `exec_shell({ elevate: true })` 的区别（见 `tmp/sandbox-permission-design-20260911.md`）：
 *
 * | | `fs_grant`（本模块） | `elevate`（sandbox/elevation.ts） |
 * |---|---|---|
 * | 作用对象 | **一个路径/目录** | **单条 shell 命令** |
 * | 语义 | 把该路径加进可写集合（工具层放行 + 沙箱 bind 成可写） | 这条命令**脱离沙箱**在宿主机跑 |
 * | 复用 | 同路径 + TTL，`write_file`/`edit_file`/`exec_shell` 都受益 | 同命令哈希 + TTL，换命令失效 |
 * | 审批 | **不打扰用户**（agent 显式声明即可），写审计 | E1 免批 / E2 每次确认 |
 * | 适用 | chat 想写 `$HOME` 里某个目录 | `ssh` / `git push` 这类必须跳出沙箱的 |
 *
 * 硬边界：只允许 `$HOME` 内、**非密钥**的路径；`~/.ssh`、`.gitconfig` 之类仍被 `checkWritePath` 拒绝。
 * 无人值守（cron / loop）**一律拒绝** —— 它们的写入范围只能由 job 配置里的 `writablePaths` 声明。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig } from "../config/loader.js";
import type { SandboxConfig } from "../config/schema.js";
import type { RunOrigin } from "../security/audit.js";
import { auditToolCall, isUnattended } from "./tool-policy.js";
import { DANGEROUS_DIRECTORIES, DANGEROUS_FILES, isRuntimeSecretPath } from "../tools/path-guard.js";

export interface GrantRequest {
  rawPath: string;
  origin: RunOrigin | undefined;
  agentId: string;
  sessionId?: string;
  /** 会话级授权集（Session.grantedWritePaths）；缺省则只做校验不做记录 */
  session?: { grantWritePath(absPath: string, ttlMs: number): boolean };
  cfg?: SandboxConfig;
}

export type GrantResult =
  | { granted: true; absPath: string; ttlSecs: number; isNew: boolean }
  | { granted: false; reason: string };

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** 校验 + 记录授权 */
export function grantWritePath(req: GrantRequest): GrantResult {
  const cfg = (req.cfg ?? loadConfig().sandbox).grant;

  if (!cfg.enabled) {
    return {
      granted: false,
      reason:
        "已拒绝：`fs_grant` 未开启。如需让 agent 能无感申请路径写权限，请在 ~/.tinyclaw/config.toml 设置\n" +
        "[sandbox.grant]\nenabled = true",
    };
  }
  if (isUnattended(req.origin)) {
    return {
      granted: false,
      reason:
        "已拒绝：无人值守运行（cron / loop）不能申请路径写权限。它们的可写范围只能由任务配置里的 " +
        "`writablePaths` 声明（改配置而不是运行期申请）。",
    };
  }
  const raw = req.rawPath.trim();
  if (!raw) return { granted: false, reason: "错误：缺少 path 参数" };

  const abs = path.resolve(expandHome(raw));
  const home = os.homedir();

  // 必须在 $HOME 内（默认；可用 allowOutsideHome 放开）
  const inHome = abs === home || abs.startsWith(home + path.sep);
  if (!inHome && !cfg.allowOutsideHome) {
    return {
      granted: false,
      reason:
        `已拒绝：${abs} 不在用户家目录内。` +
        (cfg.allowOutsideHome ? "" : "（如需放开家目录之外，请让用户手动设置 [sandbox.grant].allowOutsideHome = true）"),
    };
  }
  // 密钥路径：任何情况下都不放行
  if (isRuntimeSecretPath(abs)) {
    return { granted: false, reason: `已拒绝：${path.basename(abs)} 属于密钥/凭据，不参与路径授权。` };
  }
  // 受保护目录/文件（.ssh / .git / .bashrc …）
  for (const seg of abs.split(path.sep)) {
    if (DANGEROUS_DIRECTORIES.includes(seg)) {
      return { granted: false, reason: `已拒绝：路径包含受保护目录 "${seg}"。` };
    }
  }
  if (DANGEROUS_FILES.includes(path.basename(abs))) {
    return { granted: false, reason: `已拒绝：${path.basename(abs)} 是受保护的敏感配置文件。` };
  }
  // 必须存在（授权不存在的路径没有意义，也容易写错）
  if (!fs.existsSync(abs)) {
    return { granted: false, reason: `已拒绝：路径不存在（${abs}）。请先确认要写哪个已存在的目录/文件。` };
  }
  // 运行时目录里，**其他 agent** 的目录不放行（跨 agent 隔离）；
  // 其余（cache / data / scripts / reports / sessions …）按"用户家目录内非敏感"一视同仁 —— 与用户口径一致。
  const runtimeRoot = path.join(home, ".tinyclaw");
  const agentsRoot = path.join(runtimeRoot, "agents");
  if (abs.startsWith(agentsRoot + path.sep)) {
    const otherAgent = abs.slice(agentsRoot.length + 1).split(path.sep)[0] ?? "";
    if (otherAgent !== req.agentId) {
      return {
        granted: false,
        reason: `已拒绝：${abs} 属于其他 agent（${otherAgent}）的目录，不能跨 agent 申请写权限。`,
      };
    }
  }

  const ttlMs = cfg.ttlSecs * 1000;
  const isNew = req.session ? req.session.grantWritePath(abs, ttlMs) : true;

  auditToolCall({
    event: "policy",
    origin: req.origin,
    agentId: req.agentId,
    ...(req.sessionId ? { sessionId: req.sessionId } : {}),
    tool: "fs_grant",
    decision: "allow",
    reason: `路径级无感授权${isNew ? "" : "（刷新 TTL）"}：${abs}`,
    args: { path: abs },
    ...(cfg ? {} : {}),
  });

  return { granted: true, absPath: abs, ttlSecs: cfg.ttlSecs, isNew };
}

/** 供 prompt / 工具描述复用的一句话说明 */
export const FS_GRANT_USAGE =
  "写 $HOME 下但不在自己 agent 目录里的路径时，先调用 fs_grant({path}) 申请，" +
  "之后 write_file / edit_file / exec_shell 都可写该路径（默认 1 小时有效）。";
