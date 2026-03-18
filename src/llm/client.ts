import OpenAI, { APIConnectionError, APIConnectionTimeoutError } from "openai";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { readFileSync, existsSync } from "node:fs";
import { extname } from "node:path";

/** 是否为可重试的瞬态连接错误（超时不重试，直接上报） */
function isRetryableError(err: unknown): boolean {
  // 超时单独处理：不重试，让调用方立即收到错误并回滚 session
  if (err instanceof APIConnectionTimeoutError) return false;
  if (err instanceof APIConnectionError) return true;
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return msg.includes("econnreset") || msg.includes("connection error") || msg.includes("socket");
  }
  return false;
}

/** 连接失败（含超时）后抛出的错误（调用方可据此回滚 session 并发送用户友好提示） */
export class LLMConnectionError extends Error {
  constructor(cause: unknown, message?: string) {
    super(
      message ??
      `⚠️ 与 AI 服务的连接失败（已重试 3 次）：${cause instanceof Error ? cause.message : String(cause)}`
    );
    this.name = "LLMConnectionError";
  }
}

/** 最多重试 3 次，指数退避（1s / 2s / 4s），abort 后不再重试 */
async function withRetry<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const MAX_RETRIES = 3;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // 超时：不重试，立即包装为 LLMConnectionError 让调用方回滚 session
      if (err instanceof APIConnectionTimeoutError) {
        throw new LLMConnectionError(err, `⚠️ AI 服务请求超时，请稍后重试`);
      }
      if (!isRetryableError(err) || signal?.aborted) throw err;
      if (attempt === MAX_RETRIES) break;
      const delay = (2 ** attempt) * 1000;
      console.warn(`[llm] connection error, retrying in ${delay}ms (attempt ${attempt + 1}/${MAX_RETRIES})...`);
      // sleep 期间响应 AbortSignal，以便软中断能立即生效
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
}

/** OpenAI vision API 内容块 */
export type ContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail?: "auto" | "low" | "high" } }
  /** 内部类型：本地图片路径，在 LLM API 调用前由 resolveMessagesForApi() 转换为 base64 */
  | { type: "image_path"; path: string };

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string | ContentPart[];
}

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
      opts.signal ? { signal: opts.signal } : undefined
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
   * 流式聊天，逐 chunk 回调。
   * 返回完整文本和最终 usage（部分 provider 流式不返回 usage，此时为 0）。
   */
  async streamChat(
    messages: ChatMessage[],
    onChunk: (delta: string) => void,
    opts: ChatOptions = {}
  ): Promise<ChatResult> {
    const resolvedForStream = resolveMessagesForApi(messages);
    const stream = await this.client.chat.completions.create(
      {
        model: this.backend.model,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        messages: resolvedForStream as any,
        max_tokens: opts.maxTokens ?? this.backend.maxTokens,
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        stream: true,
        stream_options: { include_usage: true },
      },
      opts.signal ? { signal: opts.signal } : undefined
    );

    let fullContent = "";
    let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    for await (const chunk of stream) {
      if (opts.signal?.aborted) break;
      const delta = chunk.choices[0]?.delta?.content ?? "";
      if (delta) {
        fullContent += delta;
        onChunk(delta);
      }
      if (chunk.usage) {
        usage = {
          promptTokens: chunk.usage.prompt_tokens,
          completionTokens: chunk.usage.completion_tokens,
          totalTokens: chunk.usage.total_tokens,
        };
      }
    }

    return { content: fullContent, usage };
  }
}
