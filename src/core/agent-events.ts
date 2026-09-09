/**
 * Agent 运行事件流(事件流化重构 · 提交 1)
 *
 * 设计原则:
 * 1. 事件 = 循环内部单向可观测事实;回调 = 双向 I/O 通道(如 onMFARequest 需要 await 返回值)。
 *    二者不混:onChunk/onToolCall/onToolResult/onCompress/onHeartbeat/onMFAPrompt 等
 *    单向通知统一为 AgentEvent,供订阅方消费(onEvent)。
 * 2. 事件发射不阻塞循环:AgentEventBus.emit 内部 try/catch + fire-and-forget,
 *    异步 sink 不 await —— 事件消费失败绝不拖垮 ReAct 热路径。
 * 3. 事件不含敏感信息:MFA 验证码、$SECRET 等不进事件。
 */

export type AgentStage =
  | "prepare"
  | "preamble"
  | "loop"
  | "tool"
  | "finalize"
  | "run";

export type AgentEvent =
  // ── 生命周期 ──────────────────────────────────────────────
  | {
      type: "agent:start";
      sessionId: string;
      mode: "chat" | "code";
      userContent: string;
      provider: string;
      model: string;
    }
  | {
      type: "agent:end";
      sessionId: string;
      mode: "chat" | "code";
      result: { content: string; toolsUsed: string[] };
      stats: {
        durationMs: number;
        promptTokens: number;
        completionTokens: number;
        cacheReadTokens: number;
        cacheCreationTokens: number;
        /** 缓存命中率 = cacheReadTokens / promptTokens（0 = 无数据或后端不上报） */
        cacheHitRate: number;
        visionPromptTokens: number;
        visionCompletionTokens: number;
      };
    }
  | {
      type: "agent:error";
      sessionId: string;
      mode: "chat" | "code";
      stage: AgentStage;
      error: { name: string; message: string };
    }
  // ── Preamble 阶段 ─────────────────────────────────────────
  | {
      type: "preamble:system-prompt";
      provider: string;
      vision: boolean;
      /** 本轮对 system prompt 采取的动作（unchanged = 前缀稳定，缓存友好） */
      action: "unchanged" | "prepended" | "appended";
    }
  | { type: "preamble:memory-search"; found: boolean; chars: number }
  | { type: "preamble:skill-reminder"; skills: number }
  | { type: "preamble:compress"; before: number; after: number }
  // ── Turn 循环 ─────────────────────────────────────────────
  | { type: "turn:start"; round: number }
  | { type: "turn:chunk"; delta: string }
  | {
      type: "turn:usage";
      promptTokens: number;
      completionTokens: number;
      cacheReadTokens: number;
      cacheCreationTokens: number;
    }
  | { type: "turn:assistant"; content: string; hasToolCalls: boolean }
  | {
      type: "turn:compress";
      reason:
        | "pre-round-chat"
        | "pre-round-code"
        | "post-call-code-95"
        | "post-call-code-75";
      usageRatio: number;
      msgCount: number;
    }
  | { type: "turn:format-retry"; reason: string }
  | { type: "turn:canary"; ok: boolean }
  // ── 工具执行 ──────────────────────────────────────────────
  | {
      type: "tool:call";
      name: string;
      args: Record<string, unknown>;
      summary: string;
      round: number;
    }
  | {
      type: "tool:result";
      name: string;
      durationMs: number;
      truncated: boolean;
    }
  | { type: "tool:batch"; mode: "sequential" | "parallel"; names: string[] }
  | {
      type: "tool:serial";
      name: string;
      reason: "mfa" | "ask_user" | "fork" | "restart" | "limit";
    }
  | {
      type: "tool:blocked";
      name: string;
      reason: "unknown" | "max-calls" | "interrupted";
    }
  // ── 交互/外部 ─────────────────────────────────────────────
  | { type: "mfa:prompt"; message: string }
  | { type: "mfa:approved" }
  | { type: "mfa:denied" }
  | { type: "mfa:timeout" }
  | { type: "user:interrupt" }
  | { type: "heartbeat"; elapsedSec: number }
  // ── 收尾 ──────────────────────────────────────────────────
  | { type: "finalize:diary"; ok: boolean }
  | { type: "finalize:plan-log"; path?: string }
  | { type: "finalize:dashboard"; entries: number };

/** 事件订阅者:返回 Promise 时 fire-and-forget,不阻塞循环 */
export type AgentEventSink = (event: AgentEvent) => void | Promise<void>;

/**
 * 轻量事件总线(零依赖,~30 行)。
 * - subscribe 返回退订函数
 * - emit 同步调用所有 sink;异步 sink 不 await;任何 sink 抛错仅 console.warn
 */
export class AgentEventBus {
  private sinks = new Set<AgentEventSink>();

  subscribe(sink: AgentEventSink): () => void {
    this.sinks.add(sink);
    return () => {
      this.sinks.delete(sink);
    };
  }

  /** 当前订阅者数量(调试/测试用) */
  get size(): number {
    return this.sinks.size;
  }

  emit(event: AgentEvent): void {
    if (this.sinks.size === 0) return;
    for (const sink of this.sinks) {
      try {
        void sink(event);
      } catch (err) {
        console.warn(
          "[agent-events] sink error:",
          err instanceof Error ? err.message : err
        );
      }
    }
  }

  clear(): void {
    this.sinks.clear();
  }
}

/**
 * 便捷工厂:runAgent 内部统一从 opts.onEvent 得到总线。
 * - 传入 AgentEventBus:直接复用(调用方负责订阅/生命周期)
 * - 传入单个 sink:包装为单订阅总线
 * - 未传:返回空总线(emit 为 no-op)
 */
export function resolveEventBus(
  onEvent?: AgentEventSink | AgentEventBus
): AgentEventBus {
  if (!onEvent) return new AgentEventBus();
  if (onEvent instanceof AgentEventBus) return onEvent;
  const bus = new AgentEventBus();
  bus.subscribe(onEvent);
  return bus;
}
