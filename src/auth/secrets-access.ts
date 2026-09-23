/**
 * 密钥（`~/.tinyclaw/secrets.toml`）的**按 agent 授权**。
 *
 * 为什么需要它：`${SECRET:NAME}`（job 的 env）、`job_start(secrets: [...])`、`exec_shell` 的声明式
 * secrets、`http_request` 的 header `$NAME` 都是**按名字**取密钥，而名字是可猜的
 * （`DEEPSEEK_API_KEY` / `GITHUB_TOKEN` / `QQBOT_*` …）—— 不授权就等于"任何能看到这些工具的 agent
 * 都能读全部密钥"。所以默认只给 `default`（管家角色）：
 *
 * ```toml
 * [secrets]
 * agents = ["default"]   # "*" = 放开给所有 agent；[] = 谁都不给
 * ```
 *
 * 口径与 `tools/agent-binding.ts` 一致：
 * - **undefined / 空 agentId = 没有 agent 上下文**（CLI、cron 无绑定场景）→ 放行，否则 CLI 与定时任务被误伤；
 *   真正的 agent 调用一定带 agentId（`session.agentId`）。
 * - 拒绝文案中文 + 给出如何放开的写法；审计由调用方写（`auditToolCall`）。
 *
 * 不经过本模块的路径（框架自己用密钥，与本策略无关）：provider 的 `$NAME`、MCP server 的
 * `${SECRET:NAME}`、qqbot 的 `clientSecret`。
 */

import { loadConfig } from "../config/loader.js";
import type { SecretsConfig } from "../config/schema.js";
import { secretValue } from "../mcp/secret-ref.js";

/** 默认被授权的 agentId 列表（schema 默认值；改 schema 时同步改这里） */
export const DEFAULT_SECRET_AGENTS: readonly string[] = ["default"];

/** 读 `[secrets].agents`（配置不可用时回退到默认值，绝不抛错） */
export function loadSecretAgents(): readonly string[] {
  try {
    const list = loadConfig().secrets.agents;
    return Array.isArray(list) ? list : DEFAULT_SECRET_AGENTS;
  } catch {
    return DEFAULT_SECRET_AGENTS;
  }
}

/**
 * 该 agent 是否被允许读 secrets.toml。
 *
 * @param agentId 上下文里的 agentId；undefined / "" = 没有 agent 上下文 → 放行
 * @param agents  授权列表；默认从 `config.toml` 的 `[secrets].agents` 读
 */
export function canReadSecrets(agentId?: string, agents?: readonly string[]): boolean {
  if (agentId === undefined || agentId === "") return true;
  const list = agents ?? loadSecretAgents();
  if (list.includes("*")) return true;
  return list.includes(agentId);
}

/**
 * 拒绝文案（`已拒绝：…`）。
 *
 * @param what 被拒绝的动作，例如 `job_start 的 ${SECRET:NAME} 引用`
 */
export function secretsDeniedReason(
  what: string,
  agentId?: string,
  agents?: readonly string[]
): string {
  const list = (agents ?? loadSecretAgents()).join(", ") || "（空）";
  return (
    `已拒绝：${what} 需要读 ~/.tinyclaw/secrets.toml，而 agent "${agentId ?? "?"}" 不在 ` +
    `[secrets].agents 授权列表里（当前：${list}）。` +
    `如需放开，请在 ~/.tinyclaw/config.toml 写入 [secrets] agents = ["default", "${agentId ?? "?"}"]。`
  );
}

/**
 * secrets.toml 里的键名（排序、**永不返回值**）——`env_list` 用它告诉模型"有哪些名字可用"。
 *
 * 只列**非空值**的条目：空值/缺值的键在物化时本来就被跳过（`secrets-filter` 的 `if (!entry?.value) continue`），
 * 列出来只会让模型以为能用。
 */
export function secretKeyNames(secrets: SecretsConfig): string[] {
  return Object.keys(secrets)
    .filter((name) => {
      const v = secretValue(secrets, name);
      return v !== undefined && v !== "";
    })
    .sort();
}
