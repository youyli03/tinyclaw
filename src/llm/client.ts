import OpenAI, { APIConnectionError, APIConnectionTimeoutError, RateLimitError, APIError } from "openai";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { readFileSync, existsSync, statSync } from "node:fs";
import { extname } from "node:path";
import { spawnSync } from "node:child_process";
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
    // 408：服务端读请求体超时（context 过大或网络慢），属于瞬态错误，重试 5xx 策略
    if (err.status === 408) return policy.retry5xx;
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
    const attemptsDesc = attempts === -1 ? "已多次" : `已重试 ${attempts} 次`;
    super(
      message ??
      `⚠️ 与 AI 服务的连接失败（${attemptsDesc}）：${cause instanceof Error ? cause.message : String(cause)}`
    );
    this.name = "LLMConnectionError";
  }
}

/**
 * withRetry 的可选外部 hooks，用于并发 slot 控制。
 * 当 withRetry 进入重试等待延迟前调用 onRetryWait()，延迟结束后调用 onRetryResume()，
 * 使 slot 在等待期间归还给其他请求，避免 429 无限重试时 slot 被永久占用。
 */
export interface RetryHooks {
  /** 即将进入重试等待延迟时调用（此时应 release slot） */
  onRetryWait?: () => void;
  /** 重试等待延迟结束、即将重新发起请求时调用（此时应重新 acquire slot）。若 abort 则应 throw。 */
  onRetryResume?: () => Promise<void>;
}

/** 按 RetryConfig 策略重试，固定间隔，abort 后不再重试。maxAttempts=-1 为无限重试 */
async function withRetry<T>(fn: () => Promise<T>, signal?: AbortSignal, hooks?: RetryHooks): Promise<T> {
  const policy = (() => {
    try { return getRetryPolicy(); } catch { return undefined; }
  })();
  const MAX_RETRIES = policy?.maxAttempts ?? 0;
  const BASE_DELAY = policy?.baseDelayMs ?? 1000;
  const MAX_DURATION = policy?.maxRetryDurationMs ?? 0;
  const MAX_5XX = policy?.max5xxAttempts ?? 5;
  const infinite = MAX_RETRIES === -1;
  const infinite5xx = MAX_5XX === -1;
  const startedAt = MAX_DURATION > 0 ? Date.now() : 0;
  let lastErr: unknown;
  let consecutive5xx = 0;
  for (let attempt = 0; infinite || attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // 超时且不重试：立即包装为 LLMConnectionError
      if (err instanceof APIConnectionTimeoutError && !(policy?.retryTimeout)) {
        throw new LLMConnectionError(err, `⚠️ AI 服务请求超时，请稍后重试`);
      }
      if (!policy || !isRetryableError(err, policy) || signal?.aborted) throw err;
      if (!infinite && attempt === MAX_RETRIES) break;
      // 超出最大重试时长：停止重试
      if (MAX_DURATION > 0 && Date.now() - startedAt >= MAX_DURATION) {
        console.warn(`[llm] 已达最大重试时长 ${MAX_DURATION}ms，停止重试`);
        break;
      }
      // 5xx 单独计数：连续 5xx 超限时抛出专用错误（避免请求内容有问题时无限循环）
      const is5xx = err instanceof APIError && err.status != null && (err.status >= 500 || err.status === 499 || err.status === 408);
      if (is5xx) {
        consecutive5xx++;
        if (!infinite5xx && consecutive5xx > MAX_5XX) {
          const statusCode = (err as APIError).status;
          const statusHint = statusCode === 408
            ? `请求体过大导致服务端读取超时（408），建议发送 /new 清空上下文后重试`
            : `AI 服务持续返回 ${statusCode} 错误（已重试 ${consecutive5xx - 1} 次），可能是请求内容导致的问题（如工具参数过长），而非临时故障。建议发送 /new 清空上下文后重试`;
          throw new LLMConnectionError(err, `⚠️ ${statusHint}`);
        }
      } else {
        consecutive5xx = 0; // 非 5xx 成功或其他错误重置计数
      }
      // 429：优先使用 Retry-After，否则固定 baseDelayMs；其他错误使用指数退避
      const delay = err instanceof RateLimitError
        ? (parseRetryAfterMs(err) ?? BASE_DELAY)
        : backoff(BASE_DELAY, attempt);
      const attemptLabel = infinite ? `${attempt + 1}/∞` : `${attempt + 1}/${MAX_RETRIES}`;
      console.warn(`[llm] retryable error (attempt ${attemptLabel}), retrying in ${delay}ms: ${err instanceof Error ? err.message : String(err)}`);
      // 进入等待前通知外部（release slot），等待期间让其他请求使用 slot
      hooks?.onRetryWait?.();
      await new Promise<void>((res, rej) => {
        const t = setTimeout(res, delay);
        signal?.addEventListener("abort", () => { clearTimeout(t); rej(new Error("abort")); }, { once: true });
      }).catch((e: unknown) => {
        if (signal?.aborted) throw e;
      });
      if (signal?.aborted) throw new Error("abort");
      // 等待结束后重新 acquire slot（若 abort 则 onRetryResume 内部 throw，向上传播）
      if (hooks?.onRetryResume) {
        await hooks.onRetryResume();
      }
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
  /** 是否支持并行工具调用（parallel_tool_calls）。未设置时视为 false。 */
  supportsParallelToolCalls?: boolean;
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
  /**
   * 并发控制 hooks（框架内部使用，外部调用方无需设置）。
   * 用于在 withRetry 重试等待期间 release/reacquire LLM slot，
   * 防止 429 无限重试时 slot 被永久占用导致其他请求卡死。
   */
  _retryHooks?: RetryHooks;
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
// 超过此阈值时先压缩，避免 base64 请求体过大导致 Copilot API 返回 400
const IMAGE_COMPRESS_THRESHOLD = 100 * 1024; // 100 KB — 绝大多数截图/照片都会压缩
const IMAGE_COMPRESSED_MAX_BYTES = 4 * 1024 * 1024; // 4 MB — 压缩后仍超则放弃
// 缓存：同一图片在一次会话中只压缩一次（key = path, value = data URL or null）
const dataUrlCache = new Map<string, string | null>();

/**
 * 使用 ImageMagick convert 将图片压缩为 JPEG（resize ≤1024px, quality 75, strip metadata）。
 * 输出直接管道到 stdout，无临时文件。返回压缩后 Buffer，失败返回 null。
 */
function tryCompressImage(imgPath: string): Buffer | null {
  try {
    const result = spawnSync(
      "convert",
      [imgPath, "-resize", "1024x1024>", "-quality", "75", "-strip", "jpeg:-"],
      { maxBuffer: IMAGE_COMPRESSED_MAX_BYTES + 1024 * 1024 },
    );
    if (result.status === 0 && result.stdout && result.stdout.length > 0) {
      return result.stdout as Buffer;
    }
    const errMsg = result.stderr?.toString().slice(0, 200) ?? "unknown error";
    console.warn(`[llm] 图片压缩失败: ${errMsg}`);
    return null;
  } catch {
    return null;
  }
}

function pathToDataUrl(imgPath: string): string | null {
  if (dataUrlCache.has(imgPath)) return dataUrlCache.get(imgPath)!;
  if (!existsSync(imgPath)) { dataUrlCache.set(imgPath, null); return null; }
  try {
    const size = statSync(imgPath).size;
    let result: string | null;
    if (size <= IMAGE_COMPRESS_THRESHOLD) {
      // 小图直接编码
      const buf = readFileSync(imgPath);
      const ext = extname(imgPath).toLowerCase().slice(1);
      const mime =
        ext === "jpg" || ext === "jpeg" ? "image/jpeg" :
        ext === "png" ? "image/png" :
        ext === "gif" ? "image/gif" :
        ext === "webp" ? "image/webp" :
        "image/png";
      result = `data:${mime};base64,${buf.toString("base64")}`;
    } else {
      // 超阈值：压缩为 JPEG 再编码
      const compressed = tryCompressImage(imgPath);
      if (!compressed || compressed.length > IMAGE_COMPRESSED_MAX_BYTES) {
        if (compressed) console.warn(`[llm] 图片压缩后仍过大（${(compressed.length / 1024 / 1024).toFixed(1)} MB），跳过`);
        result = null;
      } else {
        console.log(`[llm] 图片压缩: ${(size / 1024).toFixed(0)} KB → ${(compressed.length / 1024).toFixed(0)} KB`);
        result = `data:image/jpeg;base64,${compressed.toString("base64")}`;
      }
    }
    dataUrlCache.set(imgPath, result);
    return result;
  } catch {
    dataUrlCache.set(imgPath, null);
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

  /** 该模型是否支持并行工具调用（parallel_tool_calls） */
  get supportsParallelToolCalls(): boolean {
    return this.backend.supportsParallelToolCalls ?? false;
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
          ? {
              tools: opts.tools!,
              tool_choice: opts.tool_choice ?? "auto",
              ...(this.supportsParallelToolCalls ? { parallel_tool_calls: true } : {}),
            }
          : {}),
      },
      {
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(xInitiatorHeader ? { headers: xInitiatorHeader } : {}),
      }
    ), opts.signal, opts._retryHooks);

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
      try { return getRetryPolicy().streamIdleTimeoutMs; } catch { return 60_000; }
    })();

    // 在 withRetry 外部解析（含图片压缩），避免每次重试都重新压缩
    const resolvedForStream = resolveMessagesForApi(messages);
    const canUseTools =
      this.supportsToolCalls && !!opts.tools && opts.tools.length > 0;
    const xInitiatorHeader = this.backend.isCopilotProvider && opts.isUserInitiated !== undefined
      ? { "X-Initiator": opts.isUserInitiated ? "user" : "agent" }
      : undefined;

    return withRetry(async () => {
      // Phase-1 timeout: abort if the server doesn't even start responding.
      // Once create() resolves (HTTP 200 + headers), this timer is cleared.
      // After that we rely solely on withStreamIdleTimeout (phase-2).
      const connectCtrl = new AbortController();
      const connectTimer = setTimeout(
        () => connectCtrl.abort(new Error(`connection timeout: no response in ${idleTimeoutMs}ms`)),
        idleTimeoutMs
      );

      const signals = [connectCtrl.signal, opts.signal].filter(Boolean) as AbortSignal[];
      const combinedSignal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];

      const stream = await this.client.chat.completions.create(
        {
          model: this.backend.model,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          messages: resolvedForStream as any,
          max_tokens: opts.maxTokens ?? this.backend.maxTokens,
          ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
          ...(canUseTools
            ? {
                tools: opts.tools!,
                tool_choice: opts.tool_choice ?? "auto",
                ...(this.supportsParallelToolCalls ? { parallel_tool_calls: true } : {}),
              }
            : {}),
          stream: true,
          stream_options: { include_usage: true },
        },
        {
          // Disable SDK-level total timeout for streaming; we handle timeouts ourselves.
          timeout: 0,
          ...(combinedSignal ? { signal: combinedSignal } : {}),
          ...(xInitiatorHeader ? { headers: xInitiatorHeader } : {}),
        }
      );

      // Connection established; cancel connection-phase timeout.
      clearTimeout(connectTimer);

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
    }, opts.signal, opts._retryHooks);
  }
}
