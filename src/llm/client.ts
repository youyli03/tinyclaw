import OpenAI from "openai";
import type { ChatCompletionTool } from "openai/resources/chat/completions";

/** 运行时已解析的后端参数（与 provider 无关的统一结构） */
export interface ResolvedBackend {
  baseUrl: string;
  apiKey: string;
  model: string;
  maxTokens: number;
  timeoutMs: number;
  /** 是否支持 OpenAI function calling（tool_calls）。未设置时视为 true。 */
  supportsToolCalls?: boolean;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
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

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<ChatResult> {
    const canUseTools =
      this.supportsToolCalls && !!opts.tools && opts.tools.length > 0;

    const response = await this.client.chat.completions.create(
      {
        model: this.backend.model,
        messages,
        max_tokens: opts.maxTokens ?? this.backend.maxTokens,
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        ...(canUseTools
          ? { tools: opts.tools!, tool_choice: opts.tool_choice ?? "auto" }
          : {}),
      },
      opts.signal ? { signal: opts.signal } : undefined
    );

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
    const stream = await this.client.chat.completions.create({
      model: this.backend.model,
      messages,
      max_tokens: opts.maxTokens ?? this.backend.maxTokens,
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      stream: true,
      stream_options: { include_usage: true },
    });

    let fullContent = "";
    let usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

    for await (const chunk of stream) {
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
