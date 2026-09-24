/**
 * 每个 agent 自己的环境变量文件：`~/.tinyclaw/agents/<id>/env`
 *
 * 格式与全局 `~/.tinyclaw/env` 一致（每行 `KEY=VALUE`，`#` 注释，值可带引号），这样两处的解析与心智模型一致。
 * 位置与 `workspace/` 同级（用户指定）。
 *
 * 分层（低 → 高，后者覆盖前者）：
 *   1. `process.env`（启动时已把 `~/.tinyclaw/env` 注入进来，见 main.ts 的 `loadDotEnv`）
 *   2. 该 agent 的 `agents/<id>/env`
 *   3. 单次调用显式传入的 env（job 的 `env` 参数）
 *
 * 安全约定：
 * - 文件 0600；不落进仓库；沙箱内被掩码（见 `sandbox/bwrap.ts` 的按 agent 掩码）
 * - **值永不回显**给模型（工具只回键名）；读取只发生在构造子进程 env 的时候
 * - 值支持 `${SECRET:NAME}` 引用（与 mcp.toml 同款语法），在**注入子进程前**才从 secrets.toml 解析
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWriteText } from "../config/safe-write.js";
import { withWakeShimPath } from "../core/wake-shim.js";

/** agent 目录根（与 core/agent-manager.ts 的 AGENTS_ROOT 一致；此处不 import 它以免循环依赖） */
export function agentsRoot(): string {
  return path.join(os.homedir(), ".tinyclaw", "agents");
}

/** 某个 agent 的环境变量文件路径（`root` 仅测试注入） */
export function agentEnvPath(agentId: string, root: string = agentsRoot()): string {
  return path.join(root, agentId, "env");
}

/** 被视为"像密钥"的键名（命中即需要用户审批） */
const SECRET_KEY_RE =
  /(KEY|TOKEN|SECRET|PASS|PASSWORD|CRED|CREDENTIAL|AUTH|API|PRIVATE|SIGNATURE|COOKIE)/i;

/** 键名是否像密钥（决定是否走审批） */
export function looksLikeSecretKey(key: string): boolean {
  return SECRET_KEY_RE.test(key);
}

/** 值是否是 `${SECRET:NAME}` 引用式（引用式不落明文，但仍算密钥语义） */
export function isSecretRefValue(value: string): boolean {
  return /^\$\{SECRET:[A-Za-z0-9_]+\}$/.test(value.trim());
}

export interface AgentEnvEntry {
  key: string;
  /** 原始值（可能含密钥）——**只在内部使用，绝不返回给模型** */
  raw: string;
  /** 是否引用式（`${SECRET:NAME}`） */
  isRef: boolean;
  /** 是否像密钥（审批口径） */
  secretLike: boolean;
}

/** 键名合法性：POSIX 环境变量名 */
export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** 解析 `KEY=VALUE` 文本（与 main.ts 的 loadDotEnv 同口径） */
export function parseEnvText(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (key !== "") out.set(key, value);
  }
  return out;
}

/** 读取该 agent 的 env 文件（不存在返回空 Map；读不到也返回空，绝不抛错） */
export function readAgentEnv(agentId: string, root: string = agentsRoot()): Map<string, string> {
  try {
    return parseEnvText(fs.readFileSync(agentEnvPath(agentId, root), "utf-8"));
  } catch {
    return new Map();
  }
}

/** 列出条目（含分类，供工具展示；调用方只输出键名） */
export function listAgentEnv(agentId: string, root: string = agentsRoot()): AgentEnvEntry[] {
  return [...readAgentEnv(agentId, root)].map(([key, raw]) => ({
    key,
    raw,
    isRef: isSecretRefValue(raw),
    secretLike: looksLikeSecretKey(key),
  }));
}

/** 覆盖写整份 env 文件（0600，原子） */
export function writeAgentEnv(
  agentId: string,
  entries: Map<string, string>,
  root: string = agentsRoot()
): void {
  const lines = [
    `# ${agentId} 的环境变量（由 tinyclaw 管理；每行 KEY=VALUE）`,
    "# 值可用 ${SECRET:NAME} 引用 ~/.tinyclaw/secrets.toml；本文件 0600，沙箱内被掩码",
    "",
  ];
  for (const [k, v] of entries) lines.push(`${k}=${JSON.stringify(v)}`);
  atomicWriteText(agentEnvPath(agentId, root), lines.join("\n") + "\n", 0o600);
}

/** 设置/覆盖一个变量（返回覆盖后的完整表，便于调用方决定是否落盘） */
export function setAgentEnvVar(
  agentId: string,
  key: string,
  value: string,
  root: string = agentsRoot()
): Map<string, string> {
  const entries = readAgentEnv(agentId, root);
  entries.set(key, value);
  return entries;
}

/** 删除一个变量；`found` 表示原本是否存在 */
export function deleteAgentEnvVar(
  agentId: string,
  key: string,
  root: string = agentsRoot()
): { entries: Map<string, string>; found: boolean } {
  const entries = readAgentEnv(agentId, root);
  const found = entries.delete(key);
  return { entries, found };
}

/**
 * 组装要注入子进程的 env（**不解析** `${SECRET:...}`，解析在 `resolveJobEnv` 里做）。
 *
 * @param base      基础环境（一般是 `process.env`）
 * @param agentId   叠加该 agent 的 env 文件
 * @param overrides 单次调用的显式覆盖
 */
export function buildJobEnvBase(
  base: NodeJS.ProcessEnv,
  agentId: string | undefined,
  overrides?: Record<string, string>,
  root: string = agentsRoot()
): { env: Record<string, string>; agentKeys: string[]; overrideKeys: string[] } {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined) env[k] = v;

  const agentEntries =
    agentId !== undefined ? readAgentEnv(agentId, root) : new Map<string, string>();
  for (const [k, v] of agentEntries) env[k] = v;

  const overrideEntries = overrides ?? {};
  for (const [k, v] of Object.entries(overrideEntries)) env[k] = v;

  return {
    // 让 job / cron 的 shell 里"喊一声 wake 就有"（shim 目录前置到 PATH，见 core/wake-shim.ts）
    env: withWakeShimPath(env),
    agentKeys: [...agentEntries.keys()],
    overrideKeys: Object.keys(overrideEntries),
  };
}
