/**
 * LLM 在线探测（唯一会花 token 的健康检查项）
 *
 * 用途：配置改了之后，"进程活着但每条回复都失败"是现状**完全没救**的一类故障
 * （401 key 失效 / 404 模型名写错 / provider 未配置）。这里发一次**极小**请求把这类问题提前暴露。
 *
 * 关键设计：**按错误类型分流**
 * - 确定性配置错（401/403/404/model not found/参数非法）→ 允许自动回退到上一份可用配置
 * - 暂时性故障（5xx / 超时 / DNS / 网络不可达 / 429）→ **只告警，绝不回退**（否则上游抽风会把好配置回退掉）
 *
 * 探测方式照抄 `commands/builtin.ts` 的 `/ping`：流式请求，收到第一个 token 立刻 abort（省 token）。
 */

import { llmRegistry } from "../llm/registry.js";
import type { HealthCheck, HealthReport } from "./config-health.js";

/** 默认探测超时 */
export const DEFAULT_PROBE_TIMEOUT_MS = 5_000;

export interface LlmProbeResult {
  /** 是否认为配置有确定性错误（可回退） */
  deterministic: boolean;
  message: string;
  /** 探测是否成功 */
  ok: boolean;
}

/**
 * 把 LLM 报错分流：确定性配置错 vs 暂时性故障。
 *
 * 默认偏保守：**认不出来就算暂时性**（宁可漏一次回退，也不要把好配置回退掉）。
 */
export function classifyLlmError(err: unknown): { deterministic: boolean; message: string } {
  const raw = err instanceof Error ? err.message : String(err);
  const msg = raw.replace(/\s+/g, " ").slice(0, 300);

  const deterministicPatterns = [
    /\b40[13]\b/, // 401 Unauthorized / 403 Forbidden（key 无效、无权限）
    /\b404\b/, // 端点/模型不存在
    /model[\s_-]*(not[\s_-]*found|does not exist|unknown)/i,
    /unknown[\s_-]*model/i,
    /invalid[\s_-]*(api[\s_-]*key|token|model|request)/i,
    /unauthorized/i,
    /forbidden/i,
    /incorrect api key/i,
    /no such (model|provider)/i,
  ];
  const transientPatterns = [
    /\b5\d\d\b/, // 5xx 上游错误
    /\b429\b/, // 限流（等一下就好）
    /timeout|timed out|ETIMEDOUT/i,
    /ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|EPIPE/i,
    /network|socket hang up|fetch failed/i,
    /overloaded|rate.?limit/i,
  ];

  if (transientPatterns.some((re) => re.test(msg))) return { deterministic: false, message: msg };
  if (deterministicPatterns.some((re) => re.test(msg))) return { deterministic: true, message: msg };
  return { deterministic: false, message: msg };
}

/**
 * 对 `daily` 后端发一次最小请求。
 *
 * @param timeoutMs 超时（默认 5s；超时按**暂时性**处理）
 */
export async function probeDailyBackend(
  timeoutMs: number = DEFAULT_PROBE_TIMEOUT_MS
): Promise<LlmProbeResult> {
  let client: ReturnType<typeof llmRegistry.get>;
  try {
    client = llmRegistry.get("daily");
  } catch (err) {
    // 拿不到后端 = 配置问题（注册表没能建起来）
    return {
      ok: false,
      deterministic: true,
      message: `无法取得 daily 后端：${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let gotToken = false;

  try {
    await client.streamChat(
      [{ role: "user", content: "ping" }],
      () => {
        if (!gotToken) {
          gotToken = true;
          ac.abort(); // 收到首个 token 立刻中断，省 token
        }
      },
      { signal: ac.signal, tool_choice: "none" }
    );
    // 流正常结束：要么已经收到 token，要么空响应（都算连通）
    return {
      ok: true,
      deterministic: false,
      message: gotToken ? "daily 后端连通（收到首个 token）" : "daily 后端连通（空响应）",
    };
  } catch (err) {
    // 我们自己 abort 触发的 AbortError 属成功路径
    if (gotToken || (err instanceof Error && err.name === "AbortError" && ac.signal.aborted)) {
      if (gotToken) return { ok: true, deterministic: false, message: "daily 后端连通" };
      return {
        ok: false,
        deterministic: false, // 超时按暂时性处理
        message: `探测超时（>${timeoutMs}ms）`,
      };
    }
    const classified = classifyLlmError(err);
    return { ok: false, deterministic: classified.deterministic, message: classified.message };
  } finally {
    clearTimeout(timer);
  }
}

/** 把探测结果并进健康报告（在线项） */
export function withLlmProbe(report: HealthReport, probe: LlmProbeResult): HealthReport {
  const c: HealthCheck = {
    name: "llm-probe",
    level: probe.ok ? "ok" : probe.deterministic ? "error" : "warn",
    deterministic: probe.deterministic,
    message: probe.message,
    ...(probe.ok
      ? {}
      : probe.deterministic
        ? { hint: "这是配置类错误（key/模型名/provider）：修好后重试，或让它自动回退到上一份可用配置" }
        : { hint: "暂时性故障（上游/网络）：不自动回退，稍后重试" }),
  };
  const checks = [...report.checks, c];
  const errors = checks.filter((x) => x.level === "error");
  return {
    ok: errors.length === 0,
    rollbackWorthy: errors.some((x) => x.deterministic),
    checks,
  };
}
