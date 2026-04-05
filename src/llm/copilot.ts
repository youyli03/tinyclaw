/**
 * GitHub Copilot LLM 后端支持
 *
 * 功能：
 * 1. 用 GitHub OAuth token 换取短期 Copilot token（自动缓存 + 到期刷新）
 * 2. 从 /models 接口动态获取所有可用模型及其能力参数
 * 3. 构建注入了 Copilot 请求头的 LLMClient
 */

import { execSync } from "child_process";
import { readFileSync, existsSync, writeFileSync, mkdirSync } from "fs";
import * as os from "os";
import * as path from "path";
import { LLMClient } from "./client.js";
import { toResponsesWsUrl } from "./responses-ws.js";
import { insertMetric } from "../web/backend/db.js";
import { runCopilotSetup, loadSavedGitHubToken } from "./copilotSetup.js";
import { getRetryPolicy } from "../config/loader.js";
import { withCA, getSystemCA } from "../utils/tls.js";

const COPILOT_API = "https://api.githubcopilot.com";
const TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";
const USER_URL = "https://api.github.com/copilot_internal/user";

/**
 * 使用 undici Agent 发送请求（HTTP/2 优先，与 @github/copilot CLI 一致）。
 * Copilot CLI 始终通过 EnvHttpProxyAgent({allowH2: true}) 使用 HTTP/2。
 * HTTP/2 多路复用 + keepalive 使代理不对流式请求应用严格的 TTFB timeout；
 * HTTP/1.1 每次请求独立 TCP，代理约 60s 无响应即终止（"terminated"）。
 * GOAWAY 错误（HTTP/2 连接重置）由 isRetryableError / copilotFetch 处理：
 * 检测到 GOAWAY 时重置 agent（_undiciAgent = undefined），withRetry 用新连接重试。
 */
let _undiciAgent: import("undici").Agent | undefined;
async function getUndiciAgent(): Promise<import("undici").Agent> {
  if (_undiciAgent) return _undiciAgent;
  const { Agent } = await import("undici");
  const ca = getSystemCA();
  _undiciAgent = new Agent({
    allowH2: true,  // HTTP/2，匹配 Copilot CLI EnvHttpProxyAgent({allowH2: true})
    ...(ca ? { connect: { ca } } : {}),
  });
  return _undiciAgent;
}

/** 丢弃当前 undici 连接池，下次请求将建立新连接。在流中断后由 streamChat 调用。 */
export function resetUndiciAgent(): void {
  _undiciAgent = undefined;
}

const COPILOT_HEADERS = {
  "Copilot-Integration-Id": "vscode-chat",
  "Editor-Version": "tinyclaw/1.0",
  "Editor-Plugin-Version": "tinyclaw/1.0",
  // Headers present in @github/copilot CLI's every request (qj.baseHeaders).
  // Missing these may cause the Copilot proxy to route requests to a slower backend
  // or apply stricter timeouts compared to known first-party clients.
  "Openai-Intent": "conversation-agent",
  "X-GitHub-Api-Version": "2025-05-01",
} as const;

// ── GitHub token 解析 ─────────────────────────────────────────────────────────

/** 内存缓存：同一进程内避免对同一 source 重复触发 device flow */
const ghTokenCache = new Map<string, string>();

async function resolveGitHubToken(source: string): Promise<string> {
  // 同一进程内命中缓存，直接返回（device flow 只触发一次）
  const mem = ghTokenCache.get(source);
  if (mem) return mem;

  let token: string;

  if (source === "gh_cli") {
    // 优先：已保存的 token 文件
    const saved = loadSavedGitHubToken();
    if (saved) {
      ghTokenCache.set(source, saved);
      return saved;
    }
    // 次之：gh CLI
    try {
      const t = execSync("gh auth token", { encoding: "utf-8" }).trim();
      if (t && t.length > 0) {
        ghTokenCache.set(source, t);
        return t;
      }
    } catch {
      // gh 未登录，跌入 device flow
    }
    token = await runCopilotSetup();
  } else if (source === "env") {
    const t = process.env["GITHUB_TOKEN"];
    if (t && t.length > 0) {
      ghTokenCache.set(source, t);
      return t;
    }
    // 优先：已保存的 token 文件（env 未设置时也尝试读）
    const saved = loadSavedGitHubToken();
    if (saved) {
      ghTokenCache.set(source, saved);
      return saved;
    }
    console.log("[tinyclaw] $GITHUB_TOKEN 未设置，启动 Token 配置向导...");
    token = await runCopilotSetup();
  } else {
    return source; // 直接作为 token 使用，无需缓存
  }

  // device flow 成功后缓存，避免同进程重复授权
  ghTokenCache.set(source, token);
  return token;
}

// ── Copilot token 换取与缓存 ──────────────────────────────────────────────────

interface CachedToken {
  value: string;
  expiresAt: number; // unix seconds
  /** 完整 token API 响应体（含 limited_user_quotas 等字段，若存在） */
  responseBody?: Record<string, unknown>;
}

const tokenCache = new Map<string, CachedToken>();

function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
}

// ── Copilot rate-limit 缓存（持久化到 ~/.tinyclaw/copilot-ratelimit.json）────

export interface CopilotRateLimit {
  /** x-ratelimit-remaining-requests */
  remaining: number;
  /** x-ratelimit-limit-requests */
  limit: number;
  /** x-ratelimit-reset-requests（原始字符串，ISO 8601 或 unix timestamp） */
  resetAt?: string;
  /** 捕获时间（unix ms） */
  capturedAt: number;
}

const RATELIMIT_FILE = path.join(os.homedir(), ".tinyclaw", "copilot-ratelimit.json");

/** 内存缓存，启动时从文件加载 */
const rateLimitCache = new Map<string, CopilotRateLimit>();

function loadRateLimitFromDisk(): void {
  try {
    if (!existsSync(RATELIMIT_FILE)) return;
    const raw = readFileSync(RATELIMIT_FILE, "utf-8");
    const obj = JSON.parse(raw) as Record<string, CopilotRateLimit>;
    for (const [k, v] of Object.entries(obj)) {
      if (v && typeof v.remaining === "number" && typeof v.limit === "number") {
        rateLimitCache.set(k, v);
      }
    }
  } catch {
    // 文件损坏或不存在，忽略
  }
}

function saveRateLimitToDisk(githubTokenSource?: string): void {
  try {
    const dir = path.dirname(RATELIMIT_FILE);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const obj: Record<string, CopilotRateLimit> = {};
    for (const [k, v] of rateLimitCache) obj[k] = v;
    writeFileSync(RATELIMIT_FILE, JSON.stringify(obj, null, 2), "utf-8");
  } catch {
    // 写入失败,忽略
  }

  // 异步刷新 premium 配额并写入 dashboard DB
  // 强制清除缓存，确保每次请求后都写入最新余量到 DB
  if (githubTokenSource) {
    userQuotaCache.delete(githubTokenSource);
    getCopilotUserQuota(githubTokenSource).catch(() => {
      // 配额查询失败不影响主流程
    });
  }
}

// 模块加载时读取历史数据
loadRateLimitFromDisk();

/**
 * 读取已缓存的 Copilot rate-limit 信息（优先内存，回退文件）。
 * 每次 LLM 调用后自动更新。
 */
export function getCopilotRateLimit(githubTokenSource: string): CopilotRateLimit | undefined {
  return rateLimitCache.get(githubTokenSource);
}

/**
 * 获取 Copilot API token（缓存 TTL = refresh_in + 60s 缓冲）。
 * 在内部调用，也由 copilotFetch 在每次请求时使用以自动刷新。
 */
export async function getCopilotToken(githubTokenSource: string): Promise<string> {
  const cached = tokenCache.get(githubTokenSource);
  if (cached && cached.expiresAt > nowSecs() + 60) {
    return cached.value;
  }

  const ghToken = await resolveGitHubToken(githubTokenSource);

  const policy = (() => { try { return getRetryPolicy(); } catch { return null; } })();
  const MAX_RETRIES = policy?.maxAttempts ?? 3;
  const BASE_DELAY = policy?.baseDelayMs ?? 500;
  const infinite = MAX_RETRIES === -1;

  let resp: Response | undefined;
  for (let attempt = 1; infinite || attempt <= MAX_RETRIES + 1; attempt++) {
    try {
      resp = await fetch(TOKEN_URL, withCA({
        headers: {
          Authorization: `token ${ghToken}`,
          Accept: "application/json",
          ...COPILOT_HEADERS,
        },
      }));
      break; // 成功，退出重试循环
    } catch (err: unknown) {
      if (!infinite && attempt > MAX_RETRIES) throw err;
      console.warn(`[tinyclaw] Copilot token 请求失败（第 ${attempt} 次），${BASE_DELAY}ms 后重试…`);
      await new Promise(r => setTimeout(r, BASE_DELAY));
    }
  }

  if (!resp!.ok) {
    throw new Error(
      `Copilot token 换取失败：${resp!.status} ${resp!.statusText}，请检查 GitHub token 是否有 copilot 权限`
    );
  }

  const data = (await resp!.json()) as Record<string, unknown>;
  const token = data["token"];
  const refreshIn = typeof data["refresh_in"] === "number" ? data["refresh_in"] : undefined;

  if (typeof token !== "string" || !token) throw new Error("Copilot token 响应格式异常");

  const expiresAt = nowSecs() + (refreshIn ?? 1740) + 60;
  tokenCache.set(githubTokenSource, { value: token, expiresAt, responseBody: data });
  return token;
}

// ── Copilot token 信息提取 ──────────────────────────────────────────────────

/** 解码 Copilot 代理 token JWT（无需验证签名，仅提取 payload 供展示用） */
function decodeCopilotJWT(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const payloadB64 = parts[1]!;
    // base64url → base64
    const padded = payloadB64 + "=".repeat((4 - (payloadB64.length % 4)) % 4);
    const decoded = Buffer.from(padded.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8");
    return JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export interface CopilotCachedInfo {
  /** Copilot 计划 SKU（如 "copilot_for_github_pro"）；解码 JWT 失败时为 undefined */
  sku?: string;
  /**
   * Token API 响应体中的 limited_user_quotas 字段（若存在）。
   * 结构通常为 `{ chat_completions: { remaining, monthly_limit, ... } }`。
   * 目前 GitHub API 不一定会返回此字段，可能为 undefined。
   */
  quotas?: Record<string, unknown>;
  /** 是否有缓存的 token（false 表示 Copilot 客户端尚未初始化） */
  tokenCached: boolean;
}

/**
 * 读取已缓存的 Copilot token 信息（不触发新的网络请求）。
 * 供 /status 命令展示 Copilot 计划类型和配额信息。
 */
export function getCachedCopilotInfo(githubTokenSource: string): CopilotCachedInfo {
  const cached = tokenCache.get(githubTokenSource);
  if (!cached) return { tokenCached: false };

  const payload = decodeCopilotJWT(cached.value);
  const sku = typeof payload?.["sku"] === "string" ? payload["sku"] : undefined;
  const quotas =
    cached.responseBody?.["limited_user_quotas"] != null &&
    typeof cached.responseBody["limited_user_quotas"] === "object"
      ? (cached.responseBody["limited_user_quotas"] as Record<string, unknown>)
      : undefined;

  const result: CopilotCachedInfo = { tokenCached: true };
  if (sku !== undefined) result.sku = sku;
  if (quotas !== undefined) result.quotas = quotas;
  return result;
}

// ── Copilot 用户配额（premium_interactions）──────────────────────────────────

export interface CopilotQuotaSnapshot {
  remaining: number;
  entitlement: number;
  percent_remaining: number;
  unlimited: boolean;
  overage_permitted: boolean;
  overage_count: number;
  timestamp_utc: string;
}

export interface CopilotUserQuota {
  quota_reset_date?: string;
  premium_interactions?: CopilotQuotaSnapshot;
  chat?: CopilotQuotaSnapshot;
  completions?: CopilotQuotaSnapshot;
}

/** 内存缓存（TTL = 3 分钟），避免 /status 多次重复请求 */
const userQuotaCache = new Map<string, { data: CopilotUserQuota; ts: number }>();

/**
 * 从 `copilot_internal/user` 获取实时配额快照（premium_interactions 等）。
 * 使用 GitHub OAuth token（非 Copilot API token），结果缓存 3 分钟。
 * 失败时静默返回空对象，不影响 /status 其他字段。
 */
export async function getCopilotUserQuota(
  githubTokenSource: string
): Promise<CopilotUserQuota> {
  const cached = userQuotaCache.get(githubTokenSource);
  if (cached && Date.now() - cached.ts < 3 * 60 * 1000) return cached.data;

  try {
    const ghToken = await resolveGitHubToken(githubTokenSource);
    const resp = await globalThis.fetch(USER_URL, withCA({
      headers: {
        Authorization: `token ${ghToken}`,
        Accept: "application/json",
        "User-Agent": "tinyclaw/1.0",
      },
    }));
    if (!resp.ok) return {};
    const body = await resp.json() as Record<string, unknown>;
    const snapshots = body["quota_snapshots"] as Record<string, unknown> | undefined;
    const result: CopilotUserQuota = {};
    if (typeof body["quota_reset_date"] === "string") {
      result.quota_reset_date = body["quota_reset_date"];
    }
    if (snapshots && typeof snapshots === "object") {
      for (const key of ["premium_interactions", "chat", "completions"] as const) {
        const s = snapshots[key] as Record<string, unknown> | undefined;
        if (s && typeof s.remaining === "number") {
          result[key] = {
            remaining: s.remaining as number,
            entitlement: (s.entitlement as number) ?? 0,
            percent_remaining: (s.percent_remaining as number) ?? 0,
            unlimited: Boolean(s.unlimited),
            overage_permitted: Boolean(s.overage_permitted),
            overage_count: (s.overage_count as number) ?? 0,
            timestamp_utc: (s.timestamp_utc as string) ?? "",
          };
        }
      }
    }
    userQuotaCache.set(githubTokenSource, { data: result, ts: Date.now() });
    // 同步写入 dashboard DB（premium_interactions 剩余次数）
    // 写入 dashboard DB（无论 unlimited 与否，每次请求后都记录）
    if (result.premium_interactions) {
      try {
        const val = result.premium_interactions.unlimited
          ? -1  // -1 表示无限制
          : result.premium_interactions.remaining;
        insertMetric({ category: "copilot", key: "remaining", value: val });
      } catch {
        // dashboard DB 未初始化时忽略
      }
    }
    return result;
  } catch {
    return {};
  }
}

// ── 模型乘数静态表 ────────────────────────────────────────────────────────────
//
// 来源：https://github.com/github/docs/blob/main/data/tables/copilot/model-multipliers.yml
// 含义：付费计划（Pro/Pro+/Business/Enterprise）中每次请求消耗的 premium request 倍数
//   0     = 包含模型，不消耗 premium requests（GPT-4o / GPT-4.1 / GPT-5 mini）
//   0.25  = 消耗 0.25× （Grok Code Fast 1）
//   0.33  = 消耗 0.33× （Claude Haiku 4.5 / Gemini 3 Flash / GPT-5.1-Codex-Mini）
//   1     = 消耗 1×    （Claude Sonnet 系列 / GPT-5.1 / Gemini 2.5 Pro 等）
//   3     = 消耗 3×    （Claude Opus 4.5 / Claude Opus 4.6）
//  30     = 消耗 30×   （Claude Opus 4.6 fast mode preview）
//
// 注意：
// - 名称匹配基于 API 返回的 model.name 字段（区分大小写不敏感）
// - Free 计划下的乘数不同（所有模型均记作 1×），此表仅用于付费计划显示
// - 若模型名称不在表中，则 multiplier 为 undefined（显示为 "-"）

const MODEL_MULTIPLIERS_PAID: Record<string, number> = {
  "Claude Haiku 4.5":                          0.33,
  "Claude Opus 4.5":                           3,
  "Claude Opus 4.6":                           3,
  "Claude Opus 4.6 (fast mode) (preview)":     30,
  "Claude Sonnet 4":                           1,
  "Claude Sonnet 4.5":                         1,
  "Claude Sonnet 4.6":                         1,
  "Gemini 2.5 Pro":                            1,
  "Gemini 3 Flash":                            0.33,
  "Gemini 3 Pro":                              1,
  "Gemini 3.1 Pro":                            1,
  "GPT-4.1":                                   0,
  "GPT-4o":                                    0,
  "GPT-5 mini":                                0,
  "GPT-5.1":                                   1,
  "GPT-5.1-Codex":                             1,
  "GPT-5.1-Codex-Mini":                        0.33,
  "GPT-5.1-Codex-Max":                         1,
  "GPT-5.2":                                   1,
  "GPT-5.2-Codex":                             1,
  "GPT-5.3-Codex":                             1,
  "GPT-5.4":                                   1,
  "Grok Code Fast 1":                          0.25,
  "Raptor mini":                               0,
};

/**
 * 根据模型名称查找付费计划下的 premium request 乘数。
 * 匹配策略（按优先级）：
 * 1. 精确匹配
 * 2. 大小写不敏感匹配
 * 3. 双向去掉 " (Preview)" 后缀再匹配（API 与文档互有差异）
 */
export function lookupMultiplier(name: string): number | undefined {
  if (name in MODEL_MULTIPLIERS_PAID) return MODEL_MULTIPLIERS_PAID[name];
  const lower = name.toLowerCase();
  const stripPreview = (s: string) => s.replace(/\s*\(preview\)/gi, "").trim().toLowerCase();
  const nameLower = stripPreview(name);
  for (const [k, v] of Object.entries(MODEL_MULTIPLIERS_PAID)) {
    if (k.toLowerCase() === lower) return v;
    if (stripPreview(k) === nameLower) return v;
  }
  return undefined;
}

// ── 模型发现 ──────────────────────────────────────────────────────────────────

/** Copilot /models 接口原始响应中的单条模型 */
interface RawCopilotModel {
  id: string;
  name?: string;
  vendor?: string;
  version?: string;
  preview?: boolean;
  model_picker_enabled: boolean;
  /** "powerful" | "versatile" | "lightweight"，嵌入模型无此字段 */
  model_picker_category?: string;
  is_chat_default?: boolean;
  is_chat_fallback?: boolean;
  policy?: { state?: string; terms?: string };
  billing?: {
    is_premium: boolean;
    multiplier: number;
    restricted_to?: string[];
  };
  capabilities: {
    type?: string;
    family?: string;
    limits?: {
      max_prompt_tokens?: number;
      max_output_tokens?: number;
      max_context_window_tokens?: number;
    };
    supports: {
      tool_calls?: boolean;
      parallel_tool_calls?: boolean;
      streaming?: boolean;
      vision?: boolean;
      thinking?: boolean;
      adaptive_thinking?: boolean;
      max_thinking_budget?: number;
      min_thinking_budget?: number;
    };
  };
  /**
   * 模型支持的 API 端点列表（来自 Copilot 模型 API 响应）。
   * 例如：["/chat/completions", "/responses", "ws:/responses"]
   * 用于判断是否可以使用 Responses API 或 WebSocket Responses API。
   */
  supported_endpoints?: string[];
}

/** tinyclaw 内部使用的模型能力摘要 */
export interface CopilotModelInfo {
  id: string;
  name: string;
  /** 模型供应商，如 "OpenAI"、"Anthropic"、"Google" */
  vendor: string;
  /**
   * 模型选择器分类：
   * - "powerful"    高能力模型（Claude Opus、GPT-5 codex 等）
   * - "versatile"   通用模型（GPT-4o、GPT-5.1 等）
   * - "lightweight" 轻量快速模型
   * - undefined     嵌入/非聊天模型
   */
  category: string | undefined;
  /** 是否为预览版 */
  preview: boolean;
  /** 最大输出 token 数（对应 LLMClient.maxTokens） */
  maxOutputTokens: number;
  /** 完整上下文窗口大小（prompt + output，来自 max_context_window_tokens） */
  maxContextWindow: number;
  /**
   * 实际可用的提示词 token 上限（来自 max_prompt_tokens）。
   * 部分模型（如 oswe-vscode-prime）的 max_context_window_tokens 大于 API 实际接受的
   * prompt 上限，直接用前者计算摘要阈值会导致 400 溢出；此字段反映真实限制。
   * 未提供时回退到 maxContextWindow。
   */
  maxPromptTokens: number;
  /** 是否支持 tool_calls（function calling） */
  supportsToolCalls: boolean;
  /** 是否支持并行工具调用（parallel_tool_calls） */
  supportsParallelToolCalls: boolean;
  /** 是否支持视觉输入（图片）。来自 capabilities.supports.vision，默认 false。 */
  supportsVision: boolean;
  /** 是否支持 Responses API（/responses 端点）。来自 supported_endpoints，默认 false。 */
  supportsResponsesApi: boolean;
  /** 是否支持 WebSocket Responses API（ws:/responses 端点）。来自 supported_endpoints，默认 false。 */
  supportsWsResponsesApi: boolean;
  /** 是否出现在 Copilot 模型选择器中 */
  isPickerEnabled: boolean;
  /** 是否为 Copilot 标记的默认聊天模型（个人账户通常不返回此字段） */
  isDefault: boolean;
  /** 是否为 premium 模型（企业账户返回，个人账户为 false） */
  isPremium: boolean;
  /**
   * premium 配额消耗倍数（企业账户返回，个人账户为 undefined）。
   * 0 = 免费；1 = 1×；3 = 3×，以此类推。
   */
  multiplier: number | undefined;
}

// 模型列表缓存（TTL = 1h，按 githubTokenSource 分别缓存）
const modelsCache = new Map<string, { models: CopilotModelInfo[]; ts: number }>();
const MODELS_CACHE_TTL = 3600;

/**
 * 获取该账号可用的所有 Copilot 模型（带缓存）。
 */
export async function getCopilotModels(
  githubTokenSource: string
): Promise<CopilotModelInfo[]> {
  const cached = modelsCache.get(githubTokenSource);
  if (cached && nowSecs() - cached.ts < MODELS_CACHE_TTL) return cached.models;

  const token = await getCopilotToken(githubTokenSource);

  const policy = (() => { try { return getRetryPolicy(); } catch { return null; } })();
  const MAX_RETRIES = policy?.maxAttempts ?? 3;
  const BASE_DELAY = policy?.baseDelayMs ?? 1000;
  const infinite = MAX_RETRIES === -1;

  let resp: Response | undefined;
  for (let attempt = 1; infinite || attempt <= MAX_RETRIES + 1; attempt++) {
    try {
      resp = await fetch(`${COPILOT_API}/models`, withCA({
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...COPILOT_HEADERS,
        },
      }));
      break;
    } catch (err: unknown) {
      if (!infinite && attempt > MAX_RETRIES) throw err;
      console.warn(`[tinyclaw] Copilot 模型列表请求失败（第 ${attempt} 次），${BASE_DELAY}ms 后重试…`);
      await new Promise(r => setTimeout(r, BASE_DELAY));
    }
  }

  if (!resp!.ok) {
    throw new Error(`Copilot 模型列表获取失败：${resp!.status} ${resp!.statusText}`);
  }

  const data = (await resp!.json()) as { data: RawCopilotModel[] };
  const models: CopilotModelInfo[] = data.data.map((m) => {
    const name = m.name ?? m.id;
    // 优先使用服务端返回的 billing.multiplier（企业账户），
    // 否则查静态表（个人 Pro/Pro+ 账户）
    const multiplier = m.billing?.multiplier ?? lookupMultiplier(name);
    return {
      id: m.id,
      name,
      vendor: m.vendor ?? "Unknown",
      category: m.model_picker_category,
      preview: m.preview ?? false,
      maxOutputTokens: m.capabilities.limits?.max_output_tokens ?? 4096,
      maxContextWindow: m.capabilities.limits?.max_context_window_tokens ?? 128_000,
      // max_prompt_tokens 是 API 真实接受的 prompt 上限，未提供时回退到 maxContextWindow
      maxPromptTokens: m.capabilities.limits?.max_prompt_tokens
        ?? m.capabilities.limits?.max_context_window_tokens
        ?? 128_000,
      supportsToolCalls: m.capabilities.supports.tool_calls ?? false,
      supportsParallelToolCalls: m.capabilities.supports.parallel_tool_calls ?? false,
      supportsVision: m.capabilities.supports.vision ?? false,
      supportsResponsesApi: m.supported_endpoints?.includes("/responses") ?? false,
      supportsWsResponsesApi: m.supported_endpoints?.includes("ws:/responses") ?? false,
      isPickerEnabled: m.model_picker_enabled,
      isDefault: m.is_chat_default ?? false,
      isPremium: m.billing?.is_premium ?? (multiplier != null && multiplier > 0),
      multiplier,
    };
  });

  modelsCache.set(githubTokenSource, { models, ts: nowSecs() });
  return models;
}

// ── LLMClient 构建 ────────────────────────────────────────────────────────────

export interface CopilotBuildParams {
  githubToken: string;
  /** 模型 ID，或 "auto"（使用 Copilot 标记的默认模型） */
  model: string;
  timeoutMs: number;
  /**
   * 可选：手动限制有效 context window 大小（tokens）。
   * 最终值取 min(模型上报值, maxContextWindowOverride)，用于摘要触发阈值计算。
   */
  maxContextWindowOverride?: number;
}

export interface CopilotClientResult {
  client: LLMClient;
  /** 模型实际上下文窗口大小，用于摘要阈值计算 */
  contextWindow: number;
}

/**
 * 根据 CopilotBuildParams 异步构建 LLMClient。
 *
 * - 自动解析模型（"auto" → is_chat_default）
 * - 从模型元数据自动设置 maxTokens / contextWindow
 * - 注入自刷新的 Copilot token（每次请求动态获取）
 */
interface CopilotBuildParamsWithVision extends CopilotBuildParams {
  supportsVision?: boolean;
}

export async function buildCopilotClient(
  config: CopilotBuildParamsWithVision
): Promise<CopilotClientResult> {
  const models = await getCopilotModels(config.githubToken);
  if (models.length === 0) throw new Error("该 Copilot 账号暂无可用模型");

  let model: CopilotModelInfo | undefined;
  if (config.model === "auto") {
    // 优先级：is_chat_default → versatile+picker → powerful+picker → 任意picker → 第一个
    model =
      models.find((m) => m.isDefault) ??
      models.find((m) => m.isPickerEnabled && m.category === "versatile") ??
      models.find((m) => m.isPickerEnabled && m.category === "powerful") ??
      models.find((m) => m.isPickerEnabled) ??
      models[0];
  } else {
    model = models.find((m) => m.id === config.model);
    if (!model) {
      const ids = models.map((m) => m.id).join(", ");
      throw new Error(
        `Copilot 模型 '${config.model}' 不存在，可用模型：${ids}`
      );
    }
  }

  const resolvedModel = model!;
  const { githubToken } = config;

  // X-Interaction-Id：per-session UUID，匹配 Copilot CLI qj.defaultHeaders() 行为。
  // Copilot CLI 在创建客户端实例时固定注入，整个 session 内不变。
  const interactionId = crypto.randomUUID();

  /**
   * 自定义 fetch：每次 API 调用前动态获取最新 Copilot token，
   * 并注入 Copilot 所需的 Editor-Version / Copilot-Integration-Id / X-Interaction-Id 请求头。
   * 即使 OpenAI SDK 实例长时间存活，token 到期后自动刷新。
   */
  const copilotFetch: import("./client.js").FetchFn = async (input, init) => {
    const freshToken = await getCopilotToken(githubToken);
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${freshToken}`);
    for (const [k, v] of Object.entries(COPILOT_HEADERS)) {
      headers.set(k, v);
    }
    headers.set("X-Interaction-Id", interactionId);

    // 使用 undici Agent（HTTP/2）发送请求，匹配 Copilot CLI EnvHttpProxyAgent 行为。
    // allowH2: true 可避免代理对 HTTP/1.1 连接施加的 ~60s TTFB timeout（"terminated"）。
    // GOAWAY（HTTP/2 连接重置）时 isNetworkErr 检测并重置 agent，让 withRetry 用新连接重试。
    // 若 undici 不可用则 fallback globalThis.fetch。
    let response: Response;
    let undiciFetch: typeof import("undici").fetch | undefined;
    try {
      undiciFetch = (await import("undici")).fetch;
    } catch {
      // undici 模块不可用（极少情况）→ fallback HTTP/1.1
    }

    if (undiciFetch) {
      try {
        const agent = await getUndiciAgent();
        response = await undiciFetch(input as string, {
          ...init, headers,
          dispatcher: agent,
        } as unknown as Parameters<typeof undiciFetch>[1]) as unknown as Response;
      } catch (undiciErr) {
        const msg = undiciErr instanceof Error ? undiciErr.message : String(undiciErr);
        // 遍历 cause 链检测网络错误（模仿 Copilot CLI f_s()）
        // Node.js undici 的 "fetch failed" 是底层网络错误的包装，真实错误在 err.cause 中
        const isNetworkMsgErr = (m: string) =>
          /socket|closed|connect|network|econnreset|abort|terminated|goaway|und_err_socket|fetch failed|etimedout|enotfound|econnrefused/i.test(m);
        let cause: unknown = undiciErr;
        let isNetworkErr = undiciErr instanceof Error && undiciErr.name === "AbortError";
        while (!isNetworkErr && cause instanceof Error) {
          isNetworkErr = isNetworkMsgErr(cause.message);
          cause = (cause as NodeJS.ErrnoException).cause;
        }
        if (isNetworkErr) {
          // 重置 agent（清除过期连接），重新抛出让 withRetry 重试
          _undiciAgent = undefined;
          throw undiciErr;
        }
        // 确认是 undici 内部 API 异常（非网络）→ fallback HTTP/1.1
        console.warn("[copilot] undici non-network error, falling back:", msg);
        const fetchOpts = withCA({ ...init, headers });
        const verboseOpts = process.env.DEBUG_FETCH === "1" ? { verbose: true } : {};
        response = await globalThis.fetch(input, { ...fetchOpts, ...verboseOpts } as RequestInit);
      }
    } else {
      const fetchOpts = withCA({ ...init, headers });
      const verboseOpts = process.env.DEBUG_FETCH === "1" ? { verbose: true } : {};
      response = await globalThis.fetch(input, { ...fetchOpts, ...verboseOpts } as RequestInit);
    }

    // 非 2xx 时 clone 并 log 原始 body，帮助诊断 API 拒绝的具体原因（如 400 text/plain）
    if (!response.ok) {
      response.clone().text().then((body) => {
        console.error(`[copilot] HTTP ${response.status} body: ${body.slice(0, 500)}`);
      }).catch(() => {});
    }

    // 捕获 rate-limit 响应头，更新内存 + 持久化（仅补全接口有此头）
    const remaining = response.headers.get("x-ratelimit-remaining-requests");
    const limit = response.headers.get("x-ratelimit-limit-requests");
    if (remaining !== null && limit !== null) {
      const rl: CopilotRateLimit = {
        remaining: Number(remaining),
        limit: Number(limit),
        capturedAt: Date.now(),
      };
      const resetAt = response.headers.get("x-ratelimit-reset-requests");
      if (resetAt) rl.resetAt = resetAt;
      rateLimitCache.set(githubToken, rl);
    }

    // 每次请求成功后都异步刷新 premium 配额并写入 dashboard DB
    // chat 接口没有 ratelimit 头，不能依赖头部存在才写入
    if (response.ok) {
      saveRateLimitToDisk(githubToken);
    }

    return response;
  };

  const client = new LLMClient(
    {
      baseUrl: COPILOT_API,
      // apiKey 设为占位符，实际 Authorization 头由 copilotFetch 注入
      apiKey: "copilot-managed",
      model: resolvedModel.id,
      maxTokens: resolvedModel.maxOutputTokens,
      timeoutMs: config.timeoutMs,
      supportsToolCalls: resolvedModel.supportsToolCalls,
      supportsParallelToolCalls: resolvedModel.supportsParallelToolCalls,
      isCopilotProvider: true,
      // vision 优先级：config 显式值 > API capabilities.supports.vision > 默认 true
      // Copilot 主流模型均支持视觉，默认开启；可在 config.toml 显式设 supportsVision = false 关闭
      supportsVision: config.supportsVision ?? resolvedModel.supportsVision ?? true,
      // WebSocket Responses API endpoint — only available for models that support it
      // (supported_endpoints includes "ws:/responses"). claude-sonnet-4.6 and similar
      // models use HTTP Chat Completions; oswe-vscode-prime and SWE-capable models
      // support Responses API. Falls back to HTTP Chat Completions if not supported.
      ...(resolvedModel.supportsWsResponsesApi ? {
        wsUrl: toResponsesWsUrl(COPILOT_API),
        // Provide fresh Copilot token + standard headers for each WS handshake.
        getWsHeaders: async () => {
          const freshToken = await getCopilotToken(githubToken);
          return {
            Authorization: `Bearer ${freshToken}`,
            ...COPILOT_HEADERS,
          };
        },
      } : {}),
    },
    copilotFetch,
    // 流中断时重置 undici 连接池，下次重试建立新连接
    resetUndiciAgent
  );

  // 有效 context window 起始值：
  // 1. max_context_window_tokens（总窗口）
  // 2. max_prompt_tokens（API 实际接受的 prompt 上限，防止如 oswe-vscode-prime 溢出）
  // 取两者的最小值作为自动检测结果。
  let effectiveContextWindow = Math.min(
    resolvedModel.maxContextWindow,
    resolvedModel.maxPromptTokens
  );
  // 若 config.toml 手动指定了 maxContextWindow，用 min(override, maxPromptTokens) 作为上限。
  // 允许向下限制（修正上报过大的模型）或向上扩展（API 报值低于实际时），
  // 但始终不超过 maxPromptTokens，避免 override > 实际 prompt 上限时压缩不触发。
  if (config.maxContextWindowOverride != null && config.maxContextWindowOverride > 0) {
    effectiveContextWindow = Math.min(config.maxContextWindowOverride, resolvedModel.maxPromptTokens);
  }

  return { client, contextWindow: effectiveContextWindow };
}
