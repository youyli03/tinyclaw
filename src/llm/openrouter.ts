/**
 * OpenRouter LLM 后端支持
 *
 * 功能:
 * 1. 拉取 OpenRouter 免费模型榜单（按 top-weekly 热度排序），内存缓存
 * 2. 构建普通模型的 LLMClient（带 HTTP-Referer/X-Title headers）
 * 3. AutoFreeClient：遇 429/rate-limit 自动切换到下一个免费模型重试
 */

import { LLMClient, ChatOptions, ChatResult, LLMChatMessage } from "./client.js";
import type { OpenRouterProviderConfig } from "../config/schema.js";
import type { ResolvedBackend } from "./client.js";

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const FREE_MODELS_URL = `${OPENROUTER_BASE}/models?supported_parameters=free&order=top-weekly`;

const DEFAULT_HEADERS = {
  "HTTP-Referer": "https://github.com/tinyclaw",
  "X-Title": "TinyClaw",
} as const;

// ── 免费模型榜单缓存 ──────────────────────────────────────────────────────────

interface FreeModel {
  id: string;
  name: string;
  context_length: number;
  supported_parameters: string[];
  top_provider?: {
    context_length?: number;
    max_completion_tokens?: number | null;
  };
}

interface FreeModelsCache {
  models: FreeModel[];
  fetchedAt: number;
}

let _freeModelsCache: FreeModelsCache | null = null;

/**
 * 拉取 OpenRouter 免费模型榜单，缓存 cacheTtlMs 毫秒（默认 1 小时）。
 * 榜单已由 OpenRouter 按 top-weekly 热度排序，直接使用。
 */
export async function fetchFreeModels(
  apiKey: string,
  cacheTtlMs = 3_600_000
): Promise<FreeModel[]> {
  const now = Date.now();
  if (_freeModelsCache && now - _freeModelsCache.fetchedAt < cacheTtlMs) {
    return _freeModelsCache.models;
  }

  const resp = await fetch(FREE_MODELS_URL, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...DEFAULT_HEADERS,
    },
  });
  if (!resp.ok) {
    throw new Error(`OpenRouter 免费模型列表拉取失败: ${resp.status} ${resp.statusText}`);
  }
  const data = (await resp.json()) as { data: FreeModel[] };
  const models = data.data ?? [];
  _freeModelsCache = { models, fetchedAt: now };
  console.log(`[openrouter] 免费模型榜单已更新，共 ${models.length} 个模型`);
  return models;
}

/** 清除免费模型缓存（测试用） */
export function clearFreeModelsCache(): void {
  _freeModelsCache = null;
}

// ── 普通模型 Client 构建 ──────────────────────────────────────────────────────

/**
 * 构建指定模型的 LLMClient（带 OpenRouter 专用 headers）。
 * modelId 为 OpenRouter 模型 ID，如 "google/gemma-3-27b-it:free"。
 */
export function buildOpenRouterClient(
  cfg: OpenRouterProviderConfig,
  modelId: string
): LLMClient {
  const backend: ResolvedBackend = {
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    model: modelId,
    maxTokens: cfg.maxTokens,
    timeoutMs: cfg.timeoutMs,
    defaultHeaders: { ...DEFAULT_HEADERS },
    supportsToolCalls: true,
    supportsVision: false,
    supportsParallelToolCalls: false,
  };
  return new LLMClient(backend);
}

// ── AutoFreeClient：自动路由到免费模型 ───────────────────────────────────────

/**
 * 判断一个错误是否属于"超过限额，需要切换模型"。
 * OpenRouter 超配额时返回 HTTP 429，或 error message 含 rate limit/quota 字样。
 */
function isRateLimitError(err: unknown): boolean {
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (msg.includes("rate limit") || msg.includes("quota") || msg.includes("429")) return true;
    // openai SDK 会把 HTTP status 附在 error 上
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const status = (err as any).status ?? (err as any).statusCode;
    if (status === 429) return true;
  }
  return false;
}

/** 获取一个免费模型的有效上下文窗口大小（取 context_length 与 top_provider.context_length 的较小值） */
function getModelContextLength(m: FreeModel): number {
  const base = m.context_length ?? 0;
  const provider = m.top_provider?.context_length ?? base;
  return Math.min(base, provider) || base;
}

/** 获取一个免费模型的最大输出 token 数 */
function getModelMaxTokens(m: FreeModel, cfgMaxTokens: number): number {
  const limit = m.top_provider?.max_completion_tokens;
  if (limit != null && limit > 0) {
    return Math.min(cfgMaxTokens, Math.floor(limit * 0.9));
  }
  return cfgMaxTokens;
}

export { getModelContextLength };

/**
 * AutoFreeClient：自动在 OpenRouter 免费模型间路由。
 *
 * - 每次 chat()/streamChat() 按榜单顺序（热度高→低）依次尝试
 * - 遇 429/rate-limit → 换下一个模型继续
 * - 全部耗尽 → 抛出最后一个错误
 *
 * 实现了与 LLMClient 相同的 chat()/streamChat() 接口，可在 registry 中透明替换。
 */
export class AutoFreeClient {
  private readonly cfg: OpenRouterProviderConfig;
  /**
   * 当前选定模型的上下文窗口大小。
   * 初始为 0（未知），首次拉取榜单后更新为榜单第一名的 context_length。
   * 每次成功切换模型后更新为目标模型的值。
   * registry.getContextWindow() 会读取此值，供 agent.ts 的 summarize 逻辑使用。
   */
  contextWindow = 0;
  /** 当前实际使用的模型 ID（最后一次成功发起请求的模型，用于日志） */
  private _currentModelId = "openrouter/auto-free";

  constructor(cfg: OpenRouterProviderConfig) {
    this.cfg = cfg;
  }

  /** 当前绑定的模型（最后一次成功使用的模型） */
  get model(): string {
    return this._currentModelId;
  }

  get supportsToolCalls(): boolean { return true; }
  get supportsVision(): boolean { return false; }
  get supportsParallelToolCalls(): boolean { return false; }

  async chat(messages: LLMChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    const models = await fetchFreeModels(this.cfg.apiKey, this.cfg.freeCacheTtlMs);
    if (models.length === 0) {
      throw new Error("[openrouter] 无可用免费模型");
    }

    if (this.contextWindow === 0 && models.length > 0) {
      this.contextWindow = Math.max(...models.map(getModelContextLength));
    }

    let lastErr: unknown;
    for (const m of models) {
      try {
        const modelCtx = getModelContextLength(m);
        const maxTokens = getModelMaxTokens(m, this.cfg.maxTokens);
        const client = buildOpenRouterClient({ ...this.cfg, maxTokens }, m.id);
        if (this._currentModelId !== m.id) {
          console.log(`[openrouter] auto-free 切换到模型 ${m.id}(上下文窗口: ${modelCtx} tokens)`);
          this._currentModelId = m.id;
          this.contextWindow = modelCtx;
        }
        return await client.chat(messages, opts);
      } catch (err) {
        if (isRateLimitError(err)) {
          console.warn(`[openrouter] 模型 ${m.id} 触发限额,尝试下一个...`);
          lastErr = err;
          continue;
        }
        throw err;
      }
    }
    throw lastErr ?? new Error("[openrouter] 所有免费模型均触发限额");
  }

  async streamChat(
    messages: LLMChatMessage[],
    onChunk: (chunk: string) => void,
    opts: ChatOptions = {}
  ): Promise<ChatResult> {
    const models = await fetchFreeModels(this.cfg.apiKey, this.cfg.freeCacheTtlMs);
    if (models.length === 0) {
      throw new Error("[openrouter] 无可用免费模型");
    }

    if (this.contextWindow === 0 && models.length > 0) {
      this.contextWindow = Math.max(...models.map(getModelContextLength));
    }

    let lastErr: unknown;
    for (const m of models) {
      try {
        const modelCtx = getModelContextLength(m);
        const maxTokens = getModelMaxTokens(m, this.cfg.maxTokens);
        const client = buildOpenRouterClient({ ...this.cfg, maxTokens }, m.id);
        if (this._currentModelId !== m.id) {
          console.log(`[openrouter] auto-free 切换到模型 ${m.id}(上下文窗口: ${modelCtx} tokens)`);
          this._currentModelId = m.id;
          this.contextWindow = modelCtx;
        }
        return await client.streamChat(messages, onChunk, opts);
      } catch (err) {
        if (isRateLimitError(err)) {
          console.warn(`[openrouter] 模型 ${m.id} 触发限额,尝试下一个...`);
          lastErr = err;
          continue;
        }
        throw err;
      }
    }
    throw lastErr ?? new Error("[openrouter] 所有免费模型均触发限额");
  }
}
