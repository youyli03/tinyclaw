/**
 * OpenAI Responses API WebSocket client and message format converters.
 *
 * The Responses API WebSocket endpoint (`wss://.../responses`) is used by the
 * @github/copilot CLI for stable streaming: WebSocket keepalives prevent idle
 * timeouts, and reconnect semantics are cleanly handled at the connection layer.
 *
 * Reference: @github/copilot app.js classes `vqt` (WS connection) and `Z8`/`Kit`
 * (message converters / event processing).
 */

import WebSocket from "ws";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type {
  ResponseInputItem,
  ResponseStreamEvent,
  ResponseTextDeltaEvent,
  ResponseFunctionCallArgumentsDeltaEvent,
  ResponseOutputItemAddedEvent,
  ResponseCompletedEvent,
  ResponseFunctionToolCall,
  FunctionTool,
  Response as OpenAIResponse,
} from "openai/resources/responses/responses";
import type { ChatMessage, ChatResult, ToolCallResult } from "./client.js";

// ============================================================
// Message format converters (Chat Completions ↔ Responses API)
// ============================================================

/**
 * Convert tinyclaw ChatMessage[] to the Responses API request format.
 * Returns the extracted `instructions` (from system messages) and the
 * `input` array (all other messages in Responses API format).
 */
export function chatMessagesToResponsesInput(messages: ChatMessage[]): {
  instructions: string;
  input: ResponseInputItem[];
} {
  const systemParts: string[] = [];
  const input: ResponseInputItem[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      const text =
        typeof msg.content === "string"
          ? msg.content
          : msg.content
              .filter((p) => p.type === "text")
              .map((p) => (p as { type: "text"; text: string }).text)
              .join("\n");
      if (text) systemParts.push(text);
      continue;
    }

    if (msg.role === "tool") {
      // Tool results: function_call_output
      input.push({
        type: "function_call_output",
        call_id: msg.tool_call_id,
        output: msg.content,
      } as ResponseInputItem.FunctionCallOutput);
      continue;
    }

    if (msg.role === "assistant") {
      // If there are tool calls, emit each as a function_call item
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        for (const tc of msg.tool_calls) {
          input.push({
            type: "function_call",
            call_id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
          } as ResponseFunctionToolCall);
        }
      }
      // If there is also text content, emit as an assistant message
      const text =
        typeof msg.content === "string"
          ? msg.content
          : msg.content
              .filter((p) => p.type === "text")
              .map((p) => (p as { type: "text"; text: string }).text)
              .join("");
      if (text) {
        input.push({
          type: "message",
          role: "assistant",
          content: text,
        } as { type: "message"; role: "assistant"; content: string });
      }
      continue;
    }

    if (msg.role === "user") {
      // Build content list
      if (typeof msg.content === "string") {
        input.push({
          role: "user",
          content: msg.content,
        });
      } else {
        // Build typed content list: input_text | input_image
        const contentList: (
          | { type: "input_text"; text: string }
          | { type: "input_image"; image_url: string; detail: "low" | "high" | "auto" }
        )[] = [];
        for (const p of msg.content) {
          if (p.type === "text") {
            contentList.push({ type: "input_text", text: p.text });
          } else if (p.type === "image_url") {
            contentList.push({
              type: "input_image",
              image_url: p.image_url.url,
              detail: (p.image_url.detail ?? "auto") as "low" | "high" | "auto",
            });
          }
          // image_path should already be resolved to image_url before this call
        }
        if (contentList.length > 0) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          input.push({ role: "user", content: contentList as any });
        }
      }
    }
  }

  return {
    instructions: systemParts.join("\n\n"),
    input,
  };
}

/** Convert OpenAI Chat Completions tool definitions to Responses API format. */
export function toolsToResponsesFormat(tools: ChatCompletionTool[]): FunctionTool[] {
  return tools
    .filter((t) => t.type === "function")
    .map((t) => ({
      type: "function" as const,
      name: t.function.name,
      description: t.function.description ?? null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      parameters: (t.function.parameters ?? null) as any,
      strict: false,
    }));
}

/**
 * Convert a completed Responses API response to tinyclaw's ChatResult.
 * Extracts text content and function_call tool calls from the output array.
 */
export function responsesCompletedToResult(response: OpenAIResponse): ChatResult {
  let content = "";
  const toolCalls: ToolCallResult[] = [];

  for (const item of response.output ?? []) {
    if (item.type === "message") {
      for (const c of (item as { type: "message"; content: { type: string; text?: string }[] }).content ?? []) {
        if (c.type === "output_text" && c.text) content += c.text;
      }
    } else if (item.type === "function_call") {
      const fc = item as ResponseFunctionToolCall;
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(fc.arguments) as Record<string, unknown>;
      } catch {
        /* keep empty args on parse error */
      }
      toolCalls.push({ name: fc.name, callId: fc.call_id, args });
    }
  }

  const usage = response.usage;
  const result: ChatResult = {
    content,
    usage: {
      promptTokens: usage?.input_tokens ?? 0,
      completionTokens: usage?.output_tokens ?? 0,
      totalTokens: (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0),
    },
  };
  if (toolCalls.length > 0) result.toolCalls = toolCalls;
  return result;
}

// ============================================================
// WebSocket connection class for Responses API
// ============================================================

/** Error thrown when the WebSocket connection fails or is closed unexpectedly. */
export class WebSocketError extends Error {
  readonly status?: number;
  constructor(message: string, options?: ErrorOptions & { status?: number }) {
    super(message, options);
    this.name = "WebSocketError";
    if (options?.status !== undefined) this.status = options.status;
  }
}

/** Convert an HTTP(S) base URL to a WebSocket Responses API URL. */
export function toResponsesWsUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = url.pathname.replace(/\/$/, "") + "/responses";
  return url.toString();
}

type WaitingState = {
  resolve: (msg: string) => void;
  reject: (err: Error) => void;
  cleanup: () => void;
};

/**
 * Manages a single WebSocket connection to the Responses API endpoint.
 * Implements the same message queue / waiting pattern as @github/copilot's `vqt`.
 *
 * Usage:
 *   const conn = new ResponsesWsConnection();
 *   await conn.connect(url, authHeaders);
 *   conn.send({ type: "response.create", ... });
 *   for await (const event of conn.receiveEvents(signal)) { ... }
 *   conn.close();
 */
export class ResponsesWsConnection {
  private ws: WebSocket | null = null;
  private readonly queue: string[] = [];
  private waiting: WaitingState | null = null;
  private connError: Error | null = null;
  private _closed = false;

  /** x-request-id from the WebSocket upgrade response (set during connect). */
  requestId: string | undefined;

  /** Establish the WebSocket connection and wait for the open event. */
  async connect(url: string, headers: Record<string, string>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url, { headers });
      this.ws = ws;
      let settled = false;

      ws.once("upgrade", (req) => {
        this.requestId = req.headers["x-request-id"] as string | undefined;
      });

      ws.once("open", () => {
        if (settled) return;
        settled = true;
        this.setupHandlers();
        resolve();
      });

      ws.once("error", (err: Error) => {
        if (settled) return;
        settled = true;
        reject(new WebSocketError(`WebSocket connection failed: ${err.message}`, { cause: err }));
      });
    });
  }

  private setupHandlers(): void {
    const ws = this.ws!;
    ws.removeAllListeners("error");

    ws.on("message", (data: WebSocket.RawData) => {
      const text = Buffer.isBuffer(data)
        ? data.toString("utf-8")
        : typeof data === "string"
        ? data
        : Buffer.concat(data as Buffer[]).toString("utf-8");

      if (this.waiting) {
        const { resolve, cleanup } = this.waiting;
        this.waiting = null;
        cleanup();
        resolve(text);
      } else {
        this.queue.push(text);
      }
    });

    ws.on("error", (err: Error) => {
      const wsErr = new WebSocketError(err.message, { cause: err });
      this.connError = wsErr;
      if (this.waiting) {
        const { reject, cleanup } = this.waiting;
        this.waiting = null;
        cleanup();
        reject(wsErr);
      }
    });

    ws.on("close", (code: number, reason: Buffer) => {
      this._closed = true;
      if (this.waiting) {
        const { reject, cleanup } = this.waiting;
        this.waiting = null;
        cleanup();
        reject(
          new WebSocketError(
            `WebSocket closed unexpectedly (request-id: ${this.requestId ?? "unknown"}): ${code} ${reason.toString()}`
          )
        );
      }
    });
  }

  /** Send a JSON event to the server. */
  send(event: object): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new WebSocketError("WebSocket is not connected");
    }
    this.ws.send(JSON.stringify(event));
  }

  isOpen(): boolean {
    return !this._closed && !this.connError && this.ws?.readyState === WebSocket.OPEN;
  }

  close(): void {
    this._closed = true;
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
    this.ws = null;
  }

  private async receiveMessage(signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    if (this.connError) throw this.connError;
    if (this.queue.length > 0) return this.queue.shift()!;
    if (this._closed) throw new WebSocketError("WebSocket is closed");

    return new Promise<string>((resolve, reject) => {
      let abortHandler: (() => void) | undefined;

      const cleanup = () => {
        if (abortHandler) {
          signal?.removeEventListener("abort", abortHandler);
          abortHandler = undefined;
        }
      };

      this.waiting = { resolve, reject, cleanup };

      if (signal) {
        abortHandler = () => {
          if (this.waiting) {
            const { reject: rej, cleanup: cl } = this.waiting;
            this.waiting = null;
            cl();
            rej(new DOMException("The operation was aborted", "AbortError") as unknown as Error);
          }
        };
        signal.addEventListener("abort", abortHandler, { once: true });
      }
    });
  }

  /**
   * Async generator that yields Responses API stream events until the response
   * completes, fails, or the connection closes.
   */
  async *receiveEvents(signal?: AbortSignal): AsyncGenerator<ResponseStreamEvent> {
    for (;;) {
      const text = await this.receiveMessage(signal);
      let event: ResponseStreamEvent & { error?: { code?: string; message?: string; http_status?: number } };
      try {
        event = JSON.parse(text) as typeof event;
      } catch {
        console.warn("[ws] failed to parse Responses API message:", text.slice(0, 200));
        continue;
      }

      if (event.type === "error") {
        const e = event.error;
        const status = e?.http_status ?? 500;
        const msg = e?.message ?? "Responses API WebSocket error";
        throw new WebSocketError(`${msg} (status ${status})`, { status });
      }

      yield event;

      if (
        event.type === "response.completed" ||
        event.type === "response.failed" ||
        event.type === "response.incomplete"
      ) {
        return;
      }
    }
  }
}

// ============================================================
// Streaming event processor
// ============================================================

/**
 * Process Responses API WebSocket streaming events, calling `onChunk` for each
 * text delta and accumulating tool call arguments.
 * Returns the completed ChatResult once `response.completed` is received.
 */
export async function processResponsesStream(
  events: AsyncGenerator<ResponseStreamEvent>,
  onChunk: (delta: string) => void
): Promise<{ result: ChatResult; chunksReceived: number }> {
  let completedResponse: OpenAIResponse | null = null;
  let chunksReceived = 0;

  // Track tool call arguments by output_index
  const toolArgAcc = new Map<number, { call_id: string; name: string; arguments: string }>();

  for await (const event of events) {
    if (event.type === "response.output_text.delta") {
      const e = event as ResponseTextDeltaEvent;
      if (e.delta) {
        onChunk(e.delta);
        chunksReceived++;
      }
    } else if (event.type === "response.output_item.added") {
      const e = event as ResponseOutputItemAddedEvent;
      if (e.item.type === "function_call") {
        const fc = e.item as ResponseFunctionToolCall;
        toolArgAcc.set(e.output_index, {
          call_id: fc.call_id,
          name: fc.name,
          arguments: fc.arguments ?? "",
        });
        chunksReceived++; // tool call counts as received data
      }
    } else if (event.type === "response.function_call_arguments.delta") {
      const e = event as ResponseFunctionCallArgumentsDeltaEvent;
      const acc = toolArgAcc.get(e.output_index);
      if (acc) acc.arguments += e.delta;
    } else if (event.type === "response.completed") {
      completedResponse = (event as ResponseCompletedEvent).response;
    }
  }

  if (!completedResponse) {
    throw new WebSocketError("Responses API stream ended without response.completed event");
  }

  const result = responsesCompletedToResult(completedResponse);
  return { result, chunksReceived };
}
