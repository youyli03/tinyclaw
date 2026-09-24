/**
 * cron 运行的额外环境变量 —— 与 `job_start` **同口径**，但只产出「增量」。
 *
 * 背景（2026-09 实测的缺口）：
 * - `agents/<id>/env` 之前只由 `job_start` 叠加（`core/job-manager.ts` 是唯一调用点），
 *   所以 cron 的 runAgent / exec_shell 看不到 `env_set` 写的变量；
 * - `${SECRET:NAME}` 也只在 `job_start` 里解析。
 *
 * 这里的口径与 job_start 一致：`process.env`（含服务启动时载入的 `~/.tinyclaw/env`）
 * `< agents/<id>/env`；值里写 `${SECRET:NAME}` 时才去 `secrets.toml` 取值，
 * 且**必须先过 `[secrets].agents` 授权闸**（未授权 → 不解析该键 + 审计 deny）。
 *
 * ⚠️ 两条设计约束：
 * 1. **只返回增量**（相对 `process.env` 有变化/新增的键）：沙箱路径下 `exec_shell` 用的是
 *    bwrap `plan.env`（可能被 `[sandbox].network = "deny"` 收敛过），整份 process.env 覆盖上去
 *    会把那道收敛抹掉；
 * 2. **不改 `process.env`**：cron worker 是**跨 agent 共享**的长驻进程，多个 job 可能并发，
 *    临时改全局 env 会互相串味。env 走 `AgentRunOptions.extraEnv` → `ToolContext` → 子进程。
 */

import { buildJobEnvBase } from "../config/agent-env.js";
import { isSecretRef, resolveSecretRefs } from "../mcp/secret-ref.js";
import { canReadSecrets, secretsDeniedReason } from "../auth/secrets-access.js";
import { auditToolCall } from "../auth/tool-policy.js";
import type { RunOrigin } from "../security/audit.js";

/**
 * 组装本次 cron 运行要额外注入的环境变量（只含增量，绝不改 `process.env`）。
 *
 * @param agentId   该 job 的 agent（决定读哪个 `agents/<id>/env`）
 * @param opts.sessionId 仅用于审计记录
 * @param opts.origin    审计里的来源（默认 `cron`）
 * @param opts.root      agents 根目录（仅测试用；默认 `~/.tinyclaw/agents`）
 */
export function buildCronRunEnv(
  agentId: string,
  opts: {
    sessionId?: string;
    origin?: RunOrigin;
    root?: string;
    /** 额外注入的键值（任务自标识等），参与增量计算 */
    extraEnv?: Record<string, string>;
  } = {}
): Record<string, string> {
  const origin = opts.origin ?? "cron";
  let values: Record<string, string>;
  try {
    values = buildJobEnvBase(process.env, agentId, undefined, opts.root).env;
    for (const [k, v] of Object.entries(opts.extraEnv ?? {})) values[k] = v;
  } catch (err) {
    console.warn(
      `[cron] 读取 agent "${agentId}" 的 env 失败，本次运行不叠加 agent env：`,
      err instanceof Error ? err.message : err
    );
    return {};
  }

  // 值里出现 `${SECRET:NAME}` 才需要碰 secrets.toml —— 密钥不会"因为声明过"就自动进 env
  const refKeys = Object.keys(values).filter((k) => isSecretRef(values[k] ?? ""));
  if (refKeys.length > 0) {
    if (!canReadSecrets(agentId)) {
      const reason = secretsDeniedReason("cron job 的 ${SECRET:NAME} 引用", agentId);
      console.warn(`[cron] agent "${agentId}" ${reason}；这些键本次不注入`);
      auditToolCall({
        event: "policy",
        origin,
        agentId,
        ...(opts.sessionId ? { sessionId: opts.sessionId } : {}),
        tool: "cron_run",
        decision: "deny",
        reason: "未授权读 secrets.toml（[secrets].agents）",
        args: { secretRefKeys: refKeys },
      });
      for (const k of refKeys) delete values[k];
    } else {
      const resolved = resolveSecretRefs(values);
      if (resolved.missing.length > 0) {
        console.warn(
          `[cron] secrets.toml 缺少 ${resolved.missing.join(", ")}，对应 env 未注入（agent=${agentId}）`
        );
      }
      values = resolved.values;
    }
  }

  const delta: Record<string, string> = {};
  for (const [k, v] of Object.entries(values)) {
    if (process.env[k] !== v) delta[k] = v;
  }
  return delta;
}
