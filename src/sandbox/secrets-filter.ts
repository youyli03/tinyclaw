/**
 * 按任务声明的密钥过滤（方案 B）。
 *
 * 问题：无人值守脚本常直接 `open(~/.tinyclaw/secrets.toml)` 取 key（如 `deepseek_balance_monitor.py`），
 * 而沙箱默认把该文件掩码成空文件 → 脚本 `EXIT 1` 且 cron 只当"步骤完成"。
 *
 * 方案：job / loop 配置里声明 `secrets: ["DEEPSEEK_API_KEY", ...]`，运行时生成一个**只含这些 key** 的
 * 临时文件，在沙箱内 bind 到**原来的路径**（`~/.tinyclaw/secrets.toml`）——
 * 于是：
 *   - 脚本**零改动**（照旧读那个路径）
 *   - 每个任务只看得见自己声明的 key（未声明 = 空文件，安全默认）
 *   - 每次物化都写审计（谁在什么时候读了哪些 key）
 *
 * 生命周期：`materializeFilteredSecrets()` 生成 → exec_shell 用它 bind → 子进程退出后
 * `cleanupFilteredSecrets()` 删除。失败一律**降级为空文件**（宁可脚本拿不到 key，也不放全量）。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomBytes } from "node:crypto";
import { loadSecretsConfig } from "../config/loader.js";
import { auditToolCall } from "../auth/tool-policy.js";
import type { RunOrigin } from "../security/audit.js";

/** 过滤文件落地目录（0600，用完即删） */
function filteredSecretsDir(): string {
  return path.join(os.homedir(), ".tinyclaw", "sandbox", "secrets");
}

/** 沙箱内 secrets.toml 的原始路径（脚本读的就是它） */
export function secretsTomlPath(): string {
  return path.join(os.homedir(), ".tinyclaw", "secrets.toml");
}

/**
 * 生成过滤后的密钥文件。
 *
 * @returns 生成的文件路径；`names` 为空或全部取不到时返回 null（调用方按"全掩码"处理）
 */
export function materializeFilteredSecrets(args: {
  names: string[];
  label: string;
  origin: RunOrigin | undefined;
  agentId: string;
  sessionId?: string;
}): string | null {
  if (args.names.length === 0) return null;

  let secrets: Record<string, { value?: string; allowed_hosts?: string[] }>;
  try {
    secrets = loadSecretsConfig() as typeof secrets;
  } catch (err) {
    console.warn("[secrets-filter] 读取 secrets.toml 失败，降级为空文件:", err);
    return null;
  }

  const lines: string[] = [
    "# 由 tinyclaw 按任务声明动态生成（方案 B）：只含该任务声明的密钥",
    `# 任务：${args.label}`,
    "",
  ];
  const granted: string[] = [];
  for (const name of args.names) {
    const entry = secrets[name];
    if (!entry?.value) continue;
    // 保持与 secrets.toml 相同的结构，脚本的正则/解析逻辑无需改动
    lines.push(`[${name}]`, `value = ${JSON.stringify(entry.value)}`);
    if (entry.allowed_hosts && entry.allowed_hosts.length > 0) {
      lines.push(`allowed_hosts = [${entry.allowed_hosts.map((h) => JSON.stringify(h)).join(", ")}]`);
    }
    lines.push("");
    granted.push(name);
  }

  if (granted.length === 0) return null;

  const dir = filteredSecretsDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${args.label.replace(/[^A-Za-z0-9_-]/g, "_")}-${randomBytes(4).toString("hex")}.toml`);
  fs.writeFileSync(file, lines.join("\n"), { mode: 0o600 });

  auditToolCall({
    event: "policy",
    origin: args.origin,
    agentId: args.agentId,
    ...(args.sessionId ? { sessionId: args.sessionId } : {}),
    tool: "secrets_filter",
    decision: "allow",
    reason: `按任务声明物化密钥：${granted.join(", ")}`,
    args: { label: args.label, requested: args.names, granted },
  });

  return file;
}

/** 删除过滤文件（子进程退出后调用；失败不影响主流程） */
export function cleanupFilteredSecrets(file: string | null | undefined): void {
  if (!file) return;
  try {
    fs.unlinkSync(file);
  } catch {
    /* 已被删或不存在 */
  }
}
