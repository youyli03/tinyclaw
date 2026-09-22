/**
 * 配置热重载应用器
 *
 * 流程：读盘 → **写前校验**（不过就拒绝，绝不应用）→ 变更分级（`reload-plan.ts`）→
 * 按级别应用（hot 换缓存 / soft 重 init 子系统 / restart 受控重启）→ 健康自检 → 失败则回退 LKG。
 *
 * 子系统重 init 与"受控重启"需要 main.ts 的能力（llmRegistry / 限流器 / Session.waitIdle / exit(75)），
 * 由 main.ts 在启动时通过 `setConfigReloadHooks()` 注入（同 `setActiveSessionsRef` 的既有做法），
 * 这样 agent 工具与文件监听都能复用同一条路径。
 */

import type { Config } from "./schema.js";
import { invalidateConfigCache, loadConfig } from "./loader.js";
import { readRawConfig } from "./writer.js";
import { validateConfigText, hasConfigErrors, formatConfigDiags } from "./validate.js";
import { classifyConfigChange, type ReloadPlan } from "./reload-plan.js";
import { promoteConfig, restoreLastGoodConfig, shouldRollbackConfig } from "./state.js";
import {
  appendHealthLog,
  formatHealthReport,
  runOfflineHealthChecks,
  type HealthReport,
} from "../health/config-health.js";
import { probeDailyBackend, withLlmProbe } from "../health/llm-probe.js";

export type ReloadTrigger = "cli" | "tool" | "watch";

/** 由 main.ts 注入的进程级能力（CLI 等独立进程没有这些，只能报告"需要重启"） */
export interface ConfigReloadHooks {
  /** soft 类变更：重新 init 子系统（LLM 后端客户端 / 限流器 / 别名缓存） */
  applySoft?: (after: Config) => Promise<void>;
  /** restart 前等待会话空闲（内部应有超时，不能无限等） */
  waitIdle?: () => Promise<void>;
  /** 发起受控重启（生产实现为 `process.exit(75)`，supervisor 会立即拉起） */
  requestRestart?: (reason: string) => void;
}

let hooks: ConfigReloadHooks = {};

/** 注入进程级能力（main.ts 启动时调用一次） */
export function setConfigReloadHooks(h: ConfigReloadHooks): void {
  hooks = h;
}

export interface ReloadResult {
  ok: boolean;
  plan: ReloadPlan;
  /** 面向人 / agent 的完整说明 */
  message: string;
  /** 需要重启（且本进程无法自行重启时） */
  needsRestart?: boolean;
  health?: HealthReport;
}

export interface ReloadOptions {
  /** 是否跑 LLM 在线探测（默认：非 watch 触发，或变更不是 hot 时跑） */
  probeLlm?: boolean;
  knownTool?: (name: string) => boolean;
  knownAgent?: (id: string) => boolean;
}

/**
 * 纯逻辑部分：给定"磁盘文本 + 运行中的配置"，判断能否应用以及怎么应用。
 *
 * 抽出来是为了可测（不碰文件系统、不触发 state 写入）。
 */
export function planReloadStep(
  rawText: string,
  current: Config,
  opts: { knownTool?: (name: string) => boolean; knownAgent?: (id: string) => boolean } = {}
): { ok: true; plan: ReloadPlan; config: Config } | { ok: false; message: string } {
  const validation = validateConfigText(rawText, {
    ...(opts.knownTool !== undefined ? { knownTool: opts.knownTool } : {}),
    ...(opts.knownAgent !== undefined ? { knownAgent: opts.knownAgent } : {}),
  });
  if (hasConfigErrors(validation.diagnostics) || validation.config === undefined) {
    return {
      ok: false,
      message: `已拒绝：配置未通过校验，未应用任何改动\n${formatConfigDiags(validation.diagnostics).join("\n")}`,
    };
  }
  return { ok: true, plan: classifyConfigChange(current, validation.config), config: validation.config };
}

/**
 * 执行一次配置重载。**不会抛错**：所有失败都以 `ok:false` + `message` 返回。
 */
export async function reloadConfig(
  trigger: ReloadTrigger,
  opts: ReloadOptions = {}
): Promise<ReloadResult> {
  // 1. 读盘 + 校验（坏内容绝不应用）
  let rawText: string;
  try {
    rawText = readRawConfig();
  } catch (err) {
    return {
      ok: false,
      plan: { cls: "none", sections: [], reason: "配置文件不存在" },
      message: `错误：读取 config.toml 失败 —— ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const before = loadConfig();
  const stepped = planReloadStep(rawText, before, opts);
  if (!stepped.ok) {
    return {
      ok: false,
      plan: { cls: "none", sections: [], reason: "校验未通过" },
      message: stepped.message,
    };
  }
  const { plan, config: after } = stepped;
  if (plan.cls === "none") {
    return { ok: true, plan, message: "配置内容没有变化，未做任何事" };
  }

  // 3. 应用
  const lines: string[] = [`配置变更分级：${plan.cls}（${plan.sections.length} 处）`, `理由：${plan.reason}`];
  if (plan.cls === "restart") {
    if (hooks.waitIdle) {
      try {
        await hooks.waitIdle();
      } catch (err) {
        lines.push(`⚠️ 等待会话空闲失败（继续重启）：${err instanceof Error ? err.message : String(err)}`);
      }
    }
    if (hooks.requestRestart) {
      lines.push("已请求受控重启（exit 75），supervisor 会立即拉起并做启动自检");
      hooks.requestRestart(`配置变更需要重启：${plan.sections.join(", ")}`);
      return { ok: true, plan, message: lines.join("\n"), needsRestart: true };
    }
    lines.push("⚠️ 当前进程无法自行重启（CLI/只读上下文）：请执行 tinyclaw restart");
    return { ok: true, plan, message: lines.join("\n"), needsRestart: true };
  }

  // hot / soft：先失效缓存，让后续 loadConfig() 读到新值
  invalidateConfigCache();
  loadConfig(); // 立即解析一次，坏配置已经在上面拦住了

  if (plan.cls === "soft") {
    if (hooks.applySoft) {
      try {
        await hooks.applySoft(after);
        lines.push("已重新 init 子系统（LLM 后端 / 限流器 / 别名缓存）");
      } catch (err) {
        lines.push(`⚠️ 子系统重新 init 失败：${err instanceof Error ? err.message : String(err)}`);
      }
    } else {
      lines.push("⚠️ 当前进程没有子系统重 init 能力：需要重启服务才能完全生效");
    }
  } else {
    lines.push("已换掉配置缓存，下一次读取即生效");
  }

  // 4. 健康自检（hot-only 且来自文件监听时不花 token）
  const shouldProbe = opts.probeLlm ?? (trigger !== "watch" || plan.cls !== "hot");
  let health = runOfflineHealthChecks({
    cfg: after,
    rawText,
    ...(opts.knownAgent !== undefined ? { knownAgent: opts.knownAgent } : {}),
  });
  if (shouldProbe) {
    health = withLlmProbe(health, await probeDailyBackend(after.health.probeTimeoutMs));
  }
  appendHealthLog(health);
  for (const line of formatHealthReport(health)) lines.push(line);

  // 5. 确定性失败且与 LKG 不同 → 回退
  if (health.rollbackWorthy && shouldRollbackConfig()) {
    const res = restoreLastGoodConfig(
      `配置热重载后健康自检失败（trigger=${trigger}，sections=${plan.sections.join(",")}）`
    );
    if (res.ok) {
      lines.push(
        `⚠️ 健康自检发现确定性错误，已回退到上一份可用配置（${res.record?.fromHash.slice(0, 8)} → ` +
          `${res.record?.toHash.slice(0, 8)}）`
      );
      if (hooks.requestRestart) {
        hooks.requestRestart("配置回退后立即重启");
        lines.push("已请求重启以加载回退后的配置");
      }
      invalidateConfigCache();
      return { ok: false, plan, message: lines.join("\n"), health, needsRestart: true };
    }
    lines.push(`⚠️ 回退失败（${res.reason ?? "未知"}），请人工检查`);
    return { ok: false, plan, message: lines.join("\n"), health };
  }

  // 6. 健康 → 记为新的 LKG（CLI 是独立进程，无法代表运行中的服务，因此不写 LKG）
  if (health.ok && trigger !== "cli") promoteConfig(rawText);
  return { ok: health.ok, plan, message: lines.join("\n"), health };
}
