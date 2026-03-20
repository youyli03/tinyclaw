import OpenAI, { APIConnectionError, APIConnectionTimeoutError, RateLimitError, APIError } from "openai";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { readFileSync, existsSync } from "node:fs";
import { extname } from "node:path";
import { getRetryPolicy } from "../config/loader.js";
import type { RetryConfig } from "../config/schema.js";

/** 退避延迟（毫秒），带 ±10% 随机 jitter，防止并发请求同时重试造成"惊群" */
function backoff(baseMs: number, attempt: number): number {
  const exp = Math.pow(2, Math.max(0, attempt - 1));
  const raw = baseMs * exp;
  const jitter = 0.9 + Math.random() * 0.2; // [0.9, 1.1)
  return Math.round(raw * jitter);
}

/** 解析 429 错误消息中的 Retry-After 秒数（如 "Please try again in 5s"）*/
function parseRetryAfterMs(err: unknown): number | undefined {
  const msg = err instanceof Error ? err.message : String(err);
  const match = /try again in\s+([\d.]+)\s*(s|ms|second)/i.exec(msg);
  if (!match) return undefined;
  const value = parseFloat(match[1]!);
  const unit = match[2]!.toLowerCase();
  if (unit === "ms") return Math.round(value);
  return Math.round(value * 1000); // seconds → ms
}

/** 是否为可重试的瞬态错误（受 RetryConfig 开关控制） */
function isRetryableError(err: unknown, policy: RetryConfig): boolean {
  if (err instanceof APIConnectionTimeoutError) return policy.retryTimeout;
  if (err instanceof RateLimitError) return policy.retry429;
  if (err instanceof APIError && err.status != null) {
    // 5xx：服务端错误，可重试
    if (err.status >= 500) return policy.retry5xx;
    // 499：GitHub Copilot 服务端主动中断（模型繁忙/上游断路器），属于瞬态错误，重试 5xx 策略
    if (err.status === 499) return policy.retry5xx;
  }
  if (err instanceof APIConnectionError) return policy.retryTransport;
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (msg.includes("econnreset") || msg.includes("connection error") || msg.includes("socket")) {
      return policy.retryTransport;
    }
    if (msg.includes("idle timeout")) return policy.retryTransport;
  }
  return false;
}

/** 连接失败（含超时）后抛出的错误（调用方可据此回滚 session 并发送用户友好提示） */
export class LLMConnectionError extends Error {
  constructor(cause: unknown, message?: string) {
    const attempts = (() => {
      try { return getRetryPolicy().maxAttempts; } catch { return 3; }
    })();
    super(
      message ??
      `⚠️ 与 AI 服务的连接失败（已重试 ${attempts} 次）：${cause instanceof Error ? cause.message : String(cause)}`
    );
    this.name = "LLMConnectionError";
  }
}

/** 按 RetryConfig 策略重试，指数退避 + jitter，abort 后不再重试 */
async function withRetry<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const policy = (() => {
    try { return getRetryPolicy(); } catch { return undefined; }
  })();
  const MAX_RETRIES = policy?.maxAttempts ?? 3;
  const BASE_DELAY = policy?.baseDelayMs ?? 1000;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // 超时且不重试：立即包装为 LLMConnectionError
      if (err instanceof APIConnectionTimeoutError && !(policy?.retryTimeout)) {
        throw new LLMConnectionError(err, `⚠️ AI 服务请求超时，请稍后重试`);
      }
      if (!policy || !isRetryableError(err, policy) || signal?.aborted) throw err;
      if (attempt === MAX_RETRIES) break;
      // 429：优先使用 Retry-After，否则指数退避
      const delay = (err instanceof RateLimitError ? parseRetryAfterMs(err) : undefined)
        ?? backoff(BASE_DELAY, attempt + 1);
      console.warn(`[llm] retryable error (attempt ${attempt + 1}/${MAX_RETRIES}), retrying in ${delay}ms: ${err instanceof Error ? err.message : String(err)}`);
      await new Promise<void>((res, rej) => {
        const t = setTimeout(res, delay);
        signal?.addEventListener("abort", () => { clearTimeout(t); rej(new Error("abort")); }, { once: true });
      }).catch((e: unknown) => {
        if (signal?.aborted) throw e;
      });
      if (signal?.aborted) throw new Error("abort");
    }
  }
  throw new LLMConnectionError(lastErr);
}

/** 运行时已解析的后端参数（与 provider 无关的统一结构） */
export interface ResolvedBackend {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  timeoutMs: number;
  /** 是否支持 OpenAI function calling（tool_calls）。未设置时视为 true。 */
  supportsToolCalls?: boolean;
  /** 是否支持视觉能力（图片输入）。未设置时视为 false。 */
  supportsVision?: boolean;
  /**
   * 是否为 GitHub Copilot provider。
   * 设为 true 时，LLM 调用会根据 ChatOptions.isUserInitiated 设置 X-Initiator header，
   * 让 GitHub 服务端仅对第一轮（用户发起）计费一次 premium request。
   * 非 Copilot 后端不设此字段，不发送 X-Initiator。
   */
  isCopilotProvider?: boolean;
}

/** OpenAI vision API 内容块 */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } }
  /** 内部类型：本地图片路径，在 LLM API 调用前由 resolveMessagesForApi() 转换为 base64 */
  | { type: "image_path"; path: string };

/** OpenAI function calling 中 tool_calls 数组元素的格式 */
export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/**
 * 会话消息类型。
 * - system/user/assistant：通用角色
 * - assistant with tool_calls：function calling 模式下，assistant 发起工具调用
 * - tool：function calling 模式下，工具执行结果（role: "tool" + tool_call_id 与 assistant.tool_calls[].id 对应）
 *   文本模型（textMode=true）不使用 tool 角色，工具结果存为 system 消息。
 */
export type ChatMessage =
  | { role: "system"; content: string | ContentPart[] }
  | { role: "user"; content: string | ContentPart[] }
  | { role: "assistant"; content: string | ContentPart[]; tool_calls?: OpenAIToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

/** 从 LLM 响应中解析出的单次工具调用 */
export interface ToolCallResult {
  name: string;
  callId: string;
  args: Record<string, unknown>;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  /** 工具列表（OpenAI function calling），仅在模型支持时生效 */
  tools?: ChatCompletionTool[];
  tool_choice?: "auto" | "none";
  /** AbortSignal：用于在 runAgent() 被中断时取消当前 LLM HTTP 请求 */
  signal?: AbortSignal;
  /**
   * 是否为用户主动发起的请求（即 ReAct 循环第 0 轮）。
   * 仅在 Copilot 后端（isCopilotProvider=true）时生效：
   *   true  → X-Initiator: user  （计为一次 premium request）
   *   false → X-Initiator: agent （工具续接轮次，不额外计费）
   * 未设置时不发送此 header。
   */
  isUserInitiated?: boolean;
}

export interface ChatResult {
  content: string;
  /** 模型请求执行的工具调用列表（function calling 格式） */
  toolCalls?: ToolCallResult[];
  /** 本次请求消耗的 token 数 */
  usage: { promptTokens: number; completionTokens: number; totalTokens: number };
}

/**
 * OpenAI-compatible LLM 客户端，封装单个后端。
 * 所有调用方通过 LLMRegistry 获取实例，不直接 new LLMClient。
 *
 * @param fetchFn 可选的自定义 fetch 实现（Copilot 后端用于动态注入 token 和请求头）
 */

/** 与 OpenAI SDK 兼容的最小 fetch 函数类型 */
export type FetchFn = (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>;

/** 将本地图片路径转为 base64 data URL；文件不存在或读取失败返回 null */
function pathToDataUrl(imgPath: string): string | null {
  if (!existsSync(imgPath)) return null;
  try {
    const buf = readFileSync(imgPath);
    const ext = extname(imgPath).toLowerCase().slice(1);
    const mime =
      ext === "jpg" || ext === "jpeg" ? "image/jpeg" :
      ext === "png" ? "image/png" :
      ext === "gif" ? "image/gif" :
      ext === "webp" ? "image/webp" :
      "image/png";
    return `data:${mime};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

/** 在发送给 API 前，将 messages 中的 image_path 条目转换为 image_url（base64 data URL） */
function resolveMessagesForApi(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => {
    // tool 消息 content 只有 string，不含 ContentPart，直接透传
    if (m.role === "tool") return m;
    if (typeof m.content === "string") return m;
    const resolved = m.content.map((p) => {
      if (p.type === "image_path") {
        const url = pathToDataUrl(p.path);
        if (url) return { type: "image_url" as const, image_url: { url, detail: "auto" as const } };
        return { type: "text" as const, text: `[图片已不可用: ${p.path}]` };
      }
      return p;
    });
    return { ...m, content: resolved };
  });
}

/**
 * 为 async iterable 的每次 next() 添加空闲超时检测。
 * 若在 idleMs 毫秒内无新 chunk 到达，抛出 idle timeout 错误（可触发 withRetry 重试）。
 * idleMs <= 0 时直接透传，不添加超时。
 */
async function* withStreamIdleTimeout<T>(
  iter: AsyncIterable<T>,
  idleMs: number,
  signal?: AbortSignal
): AsyncGenerator<T> {
  if (idleMs <= 0) {
    yield* iter;
    return;
  }
  const it = iter[Symbol.asyncIterator]();
  while (true) {
    const result = await new Promise<IteratorResult<T>>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`stream idle timeout: no chunk received in ${idleMs}ms`));
      }, idleMs);
      const cleanup = () => clearTimeout(timer);
      signal?.addEventListener("abort", () => { cleanup(); reject(new Error("abort")); }, { once: true });
      it.next().then((r) => { cleanup(); resolve(r); }, (e) => { cleanup(); reject(e as unknown); });
    });
    if (result.done) return;
    yield result.value;
  }
}

export class LLMClient {
  private readonly client: OpenAI;
  private readonly backend: ResolvedBackend;

  constructor(backend: ResolvedBackend, fetchFn?: FetchFn) {
    this.backend = backend;
    this.client = new OpenAI({
      baseURL: backend.baseUrl,
      apiKey: backend.apiKey,
      timeout: backend.timeoutMs,
      ...(fetchFn ? { fetch: fetchFn } : {}),
    });
  }

  get model(): string {
    return this.backend.model;
  }

  /** 该模型是否支持 OpenAI function calling（tool_calls） */
  get supportsToolCalls(): boolean {
    return this.backend.supportsToolCalls ?? true;
  }

  /** 该模型是否支持视觉能力（图片输入） */
  get supportsVision(): boolean {
    return this.backend.supportsVision ?? false;
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    const canUseTools =
      this.supportsToolCalls && !!opts.tools && opts.tools.length > 0;

    const xInitiatorHeader = this.backend.isCopilotProvider && opts.isUserInitiated !== undefined
      ? { "X-Initiator": opts.isUserInitiated ? "user" : "agent" }
      : undefined;

    const resolved = resolveMessagesForApi(messages);
    const response = await withRetry(() => this.client.chat.completions.create(
      {
        model: this.backend.model,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        messages: resolved as any,
        max_tokens: opts.maxTokens ?? this.backend.maxTokens,
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        ...(canUseTools
          ? { tools: opts.tools!, tool_choice: opts.tool_choice ?? "auto" }
          : {}),
      },
      {
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(xInitiatorHeader ? { headers: xInitiatorHeader } : {}),
      }
    ), opts.signal);

    const choice = response.choices[0];
    if (!choice) throw new Error("LLM returned no choices");

    const rawCalls = choice.message.tool_calls;
    const toolCalls: ToolCallResult[] | undefined =
      rawCalls && rawCalls.length > 0
        ? rawCalls.map((tc) => ({
            name: tc.function.name,
            callId: tc.id,
            args: (() => {
              try {
                return JSON.parse(tc.function.arguments) as Record<string, unknown>;
              } catch {
                return {} as Record<string, unknown>;
              }
            })(),
          }))
        : undefined;

    return {
      content: choice.message.content ?? "",
      ...(toolCalls ? { toolCalls } : {}),
      usage: {
        promptTokens: response.usage?.prompt_tokens ?? 0,
        completionTokens: response.usage?.completion_tokens ?? 0,
        totalTokens: response.usage?.total_tokens ?? 0,
      },
    };
  }

  /**
   * 流式聊天，逐 chunk 回调。支持 tool_calls（function calling）。
   * 返回完整文本、toolCalls 和最终 usage（部分 provider 流式不返回 usage，此时为 0）。
   * 内置 withRetry 保护：流中断时自动重试；每 chunk 间有 idle timeout 防止服务端挂起。
   */
  async streamChat(
    messages: ChatMessage[],
    onChunk: (delta: string) => void,
    opts: ChatOptions = {}
  ): Promise<ChatResult> {
    const idleTimeoutMs = (() => {
      try { return getRetryPolicy().streamIdleTimeoutMs; } catch { return 30_000; }
    })();

    return withRetry(async () => {
      const canUseTools =
        this.supportsToolCalls && !!opts.tools && opts.tools.length > 0;
      const resolvedForStream = resolveMessagesForApi(messages);
      const xInitiatorHeader = this.backend.isCopilotProvider && opts.isUserInitiated !== undefined
        ? { "X-Initiator": opts.isUserInitiated ? "user" : "agent" }
        : undefined;
      const stream = await this.client.chat.completions.create(
        {
          model: this.backend.model,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          messages: resolvedForStream as any,
          max_tokens: opts.maxTokens ?? this.backend.maxTokens,
          ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
          ...(canUseTools
            ? { tools: opts.tools!, tool_choice: opts.tool_choice ?? "auto" }
            : {}),
          stream: true,
          stream_options: { include_usage: true },
        },
        {
          ...(opts.signal ? { signal: opts.signal } : {}),
          ...(xInitiatorHeader ? { headers: xInitiatorHeader } : {}),
        }
      );

      let fullContent = "";
      let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      // 聚合流式 tool_calls delta（各 index 独立累积）
      const toolCallAcc: { id: string; name: string; arguments: string }[] = [];

      for await (const chunk of withStreamIdleTimeout(stream, idleTimeoutMs, opts.signal)) {
        if (opts.signal?.aborted) break;
        const delta = chunk.choices[0]?.delta;

        // 文本 delta
        const textDelta = delta?.content ?? "";
        if (textDelta) {
          fullContent += textDelta;
          onChunk(textDelta);
        }

        // 工具调用 delta（按 index 聚合）
        for (const tcDelta of delta?.tool_calls ?? []) {
          const idx = tcDelta.index;
          if (!toolCallAcc[idx]) {
            toolCallAcc[idx] = {
              id: tcDelta.id ?? "",
              name: tcDelta.function?.name ?? "",
              arguments: "",
            };
          } else {
            if (tcDelta.id) toolCallAcc[idx]!.id = tcDelta.id;
            if (tcDelta.function?.name) toolCallAcc[idx]!.name = tcDelta.function.name;
          }
          toolCallAcc[idx]!.arguments += tcDelta.function?.arguments ?? "";
        }

        if (chunk.usage) {
          usage = {
            promptTokens: chunk.usage.prompt_tokens,
            completionTokens: chunk.usage.completion_tokens,
            totalTokens: chunk.usage.total_tokens,
          };
        }
      }

      const toolCalls: ToolCallResult[] | undefined =
        toolCallAcc.length > 0
          ? toolCallAcc
              // tcDelta.index 可能不连续（如 0, 2），导致 toolCallAcc 为稀疏数组
              // 过滤掉洞（hole）和 undefined，避免后续 for...of 产生 undefined call
              .filter((tc): tc is { id: string; name: string; arguments: string } => tc != null)
              .map((tc) => ({
                name: tc.name,
                callId: tc.id,
                args: (() => {
                  try {
                    return JSON.parse(tc.arguments) as Record<string, unknown>;
                  } catch {
                    return {} as Record<string, unknown>;
                  }
                })(),
              }))
          : undefined;

      return { content: fullContent, ...(toolCalls ? { toolCalls } : {}), usage };
    }, opts.signal);
  }
}
