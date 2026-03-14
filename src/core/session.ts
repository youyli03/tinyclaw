import type { ChatMessage } from "../llm/client.js";
import { llmRegistry } from "../llm/registry.js";
import { shouldSummarize, summarizeAndCompress } from "../memory/summarizer.js";
import { persistTurn } from "../memory/store.js";

export interface SessionOptions {
  systemPrompt?: string;
}

/**
 * 单个对话会话。维护 messages[]，负责 token 计数和摘要触发。
 */
export class Session {
  private messages: ChatMessage[] = [];

  constructor(opts: SessionOptions = {}) {
    if (opts.systemPrompt) {
      this.messages.push({ role: "system", content: opts.systemPrompt });
    }
  }

  getMessages(): ChatMessage[] {
    return this.messages;
  }

  addUserMessage(content: string): void {
    this.messages.push({ role: "user", content });
  }

  addAssistantMessage(content: string): void {
    this.messages.push({ role: "assistant", content });
  }

  addSystemMessage(content: string): void {
    this.messages.push({ role: "system", content });
  }

  /**
   * 检查是否需要压缩，如需要则执行摘要并替换 messages[]。
   * 在 addAssistantMessage 之后调用。
   */
  async maybeCompress(): Promise<void> {
    if (shouldSummarize(this.messages)) {
      this.messages = await summarizeAndCompress(this.messages);
    }
  }

  /**
   * 持久化最后一轮 user/assistant 对话到 QMD 记忆文件。
   */
  async persistLastTurn(): Promise<void> {
    const msgs = this.messages;
    // 从末尾往前找最后一对 assistant / user
    for (let i = msgs.length - 1; i >= 1; i--) {
      if (msgs[i]?.role === "assistant" && msgs[i - 1]?.role === "user") {
        await persistTurn(msgs[i - 1]!.content, msgs[i]!.content);
        break;
      }
    }
  }

  /** 估算当前 token 数（粗算） */
  estimatedTokens(): number {
    const total = this.messages.reduce((s, m) => s + m.content.length, 0);
    return Math.ceil(total / 3.5);
  }

  /** 获取 daily LLM 的模型名（用于日志） */
  get modelName(): string {
    return llmRegistry.get("daily").model;
  }
}
