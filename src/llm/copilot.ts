/**
 * GitHub Copilot LLM 后端支持
 *
 * 功能：
 * 1. 用 GitHub OAuth token 换取短期 Copilot token（自动缓存 + 到期刷新）
 * 2. 从 /models 接口动态获取所有可用模型及其能力参数
 * 3. 构建注入了 Copilot 请求头的 LLMClient
 */

import { execSync } from "child_process";
import { LLMClient } from "./client.js";
import { runCopilotSetup, loadSavedGitHubToken } from "./copilotSetup.js";

const COPILOT_API = "https://api.githubcopilot.com";
const TOKEN_URL = "https://api.github.com/copilot_internal/v2/token";
const COPILOT_HEADERS = {
  "Copilot-Integration-Id": "vscode-chat",
  "Editor-Version": "tinyclaw/1.0",
  "Editor-Plugin-Version": "tinyclaw/1.0",
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
}

const tokenCache = new Map<string, CachedToken>();

function nowSecs(): number {
  return Math.floor(Date.now() / 1000);
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
  const resp = await fetch(TOKEN_URL, {
    headers: {
      Authorization: `token ${ghToken}`,
      Accept: "application/json",
      ...COPILOT_HEADERS,
    },
  });

  if (!resp.ok) {
    throw new Error(
      `Copilot token 换取失败：${resp.status} ${resp.statusText}，请检查 GitHub token 是否有 copilot 权限`
    );
  }

  const data = (await resp.json()) as {
    token: string;
    refresh_in?: number;
  };

  if (!data.token) throw new Error("Copilot token 响应格式异常");

  const expiresAt = nowSecs() + (data.refresh_in ?? 1740) + 60;
  tokenCache.set(githubTokenSource, { value: data.token, expiresAt });
  return data.token;
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
function lookupMultiplier(name: string): number | undefined {
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
  /** 完整上下文窗口大小（对应 summarizer 阈值计算） */
  maxContextWindow: number;
  /** 是否支持 tool_calls（function calling） */
  supportsToolCalls: boolean;
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
  const resp = await fetch(`${COPILOT_API}/models`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      ...COPILOT_HEADERS,
    },
  });

  if (!resp.ok) {
    throw new Error(`Copilot 模型列表获取失败：${resp.status} ${resp.statusText}`);
  }

  const data = (await resp.json()) as { data: RawCopilotModel[] };
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
      supportsToolCalls: m.capabilities.supports.tool_calls ?? false,
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
export async function buildCopilotClient(
  config: CopilotBuildParams
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

  /**
   * 自定义 fetch：每次 API 调用前动态获取最新 Copilot token，
   * 并注入 Copilot 所需的 Editor-Version / Copilot-Integration-Id 请求头。
   * 即使 OpenAI SDK 实例长时间存活，token 到期后自动刷新。
   */
  const copilotFetch: import("./client.js").FetchFn = async (input, init) => {
    const freshToken = await getCopilotToken(githubToken);
    const headers = new Headers(init?.headers);
    headers.set("Authorization", `Bearer ${freshToken}`);
    for (const [k, v] of Object.entries(COPILOT_HEADERS)) {
      headers.set(k, v);
    }
    return globalThis.fetch(input, { ...init, headers });
  };

  const client = new LLMClient(
    {
      baseUrl: COPILOT_API,
      // apiKey 设为占位符，实际 Authorization 头由 copilotFetch 注入
      apiKey: "copilot-managed",
      model: resolvedModel.id,
      maxTokens: resolvedModel.maxOutputTokens,
      timeoutMs: config.timeoutMs,
    },
    copilotFetch
  );

  return { client, contextWindow: resolvedModel.maxContextWindow };
}
