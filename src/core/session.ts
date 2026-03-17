import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { ChatMessage, ContentPart } from "../llm/client.js";
import { llmRegistry } from "../llm/registry.js";
import { shouldSummarize, summarizeAndCompress } from "../memory/summarizer.js";

/** Interface A MFA：等待用户回复的 Promise 控制柄 */
interface PendingApproval {
  resolve: (approved: boolean) => void;
  reject: (err: Error) => void;
}

export interface SessionOptions {
  systemPrompt?: string;
  agentId?: string;
}

/**
 * 单个对话会话。维护 messages[]，负责 token 计数、摘要触发、JSONL 持久化。
 */
export class Session {
  readonly sessionId: string;
  /** 当前会话绑定的 Agent ID（未绑定时为 "default"） */
  readonly agentId: string;
  private messages: ChatMessage[] = [];

  // ── 并发控制 ──────────────────────────────────────────────────────────────
  /** 当前是否有 runAgent() 正在运行 */
  running = false;
  /** 软中断标记：新消息到达时设为 true，工具执行完后检测 */
  abortRequested = false;
  /** 当前 runAgent() 持有的 LLM HTTP 请求 AbortController */
  llmAbortController: AbortController | null = null;
  /** 当前 runAgent() 的 Promise（用于等待其自然结束） */
  currentRunPromise: Promise<unknown> | null = null;

  // ── MFA 状态 ──────────────────────────────────────────────────────────────
  /** 同一次 runAgent() 中，MFA 一旦通过即设为 true，后续工具跳过验证 */
  mfaApprovedForThisRun = false;
  /** Interface A：等待用户回复 确认/取消 的控制柄 */
  pendingApproval: PendingApproval | null = null;

  constructor(sessionId: string, opts: SessionOptions = {}) {
    this.sessionId = sessionId;
    this.agentId = opts.agentId ?? "default";

    // 尝试从 JSONL 恢复（进程崩溃后重启）
    const restored = Session.loadFromJsonl(sessionId);
    if (restored) {
      this.messages = restored;
    } else if (opts.systemPrompt) {
      this.messages.push({ role: "system", content: opts.systemPrompt });
    }
  }

  getMessages(): ChatMessage[] {
    return this.messages;
  }

  addUserMessage(content: string | ContentPart[]): void {
    this.messages.push({ role: "user", content });
  }

  addAssistantMessage(content: string): void {
    this.messages.push({ role: "assistant", content });
  }

  addSystemMessage(content: string): void {
    this.messages.push({ role: "system", content });
  }

  /** 将 system 消息插到 messages[0]（适用于恢复的 session，确保指令优先级最高） */
  prependSystemMessage(content: string): void {
    this.messages.unshift({ role: "system", content });
  }

  /** 替换 messages[0] 处的 system 消息；若第一条不是 system 则 prepend */
  replaceOrPrependSystemMessage(content: string): void {
    if (this.messages.length > 0 && this.messages[0]?.role === "system") {
      this.messages[0] = { role: "system", content };
    } else {
      this.messages.unshift({ role: "system", content });
    }
  }

  /**
   * 执行摘要压缩：
   * 1. LLM 生成摘要 + persistSummary（写 memory/YYYY-MM/YYYY-MM-DD.md + QMD 索引）
   * 2. this.messages 替换为压缩后的 [system..., summary_assistant]
   * 3. rewriteJsonl()：JSONL 覆写为压缩后内容，摘要作为下次启动的上下文
   * 返回摘要文本，供调用方通知用户。
   */
  async compress(): Promise<string> {
    const compressed = await summarizeAndCompress(this.messages, this.agentId);
    this.messages = compressed;
    this.rewriteJsonl();
    // 摘要内容在最后一条 assistant 消息中
    const summaryMsg = [...compressed].reverse().find((m) => m.role === "assistant");
    const summary = (typeof summaryMsg?.content === "string"
      ? summaryMsg.content.replace(/^\[对话历史摘要\]\n/, "")
      : "") ?? "";
    return summary;
  }

  /**
   * 检查是否需要压缩，如需要则执行摘要并替换 messages[]，
   * 同时重写 JSONL（压缩后只保留 system + 摘要）。
   * 返回摘要文本（已压缩）或 undefined（未触发）。
   */
  async maybeCompress(): Promise<string | undefined> {
    if (shouldSummarize(this.messages)) {
      return await this.compress();
    }
    return undefined;
  }

  // ── Interface A MFA ───────────────────────────────────────────────────────

  /**
   * 挂起当前执行，等待用户回复 确认/取消。
   * resolve(true) = 确认，resolve(false) = 取消，reject = 超时。
   */
  waitForApproval(timeoutSecs: number): Promise<boolean> {
    // 清除上一个未完成的 pendingApproval（理论上不应存在）
    if (this.pendingApproval) {
      this.pendingApproval.reject(new Error("新的 MFA 请求覆盖了未完成的请求"));
      this.pendingApproval = null;
    }

    return new Promise<boolean>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingApproval = null;
        reject(new Error("MFA 确认超时，操作已取消"));
      }, timeoutSecs * 1000);

      this.pendingApproval = {
        resolve: (approved) => {
          clearTimeout(timer);
          this.pendingApproval = null;
          resolve(approved);
        },
        reject: (err) => {
          clearTimeout(timer);
          this.pendingApproval = null;
          reject(err);
        },
      };
    });
  }

  /** 中止等待中的 MFA 确认（用于 runAgent() 被打断时清理） */
  abortPendingApproval(): void {
    if (this.pendingApproval) {
      this.pendingApproval.reject(new Error("会话被中断，MFA 操作已取消"));
      this.pendingApproval = null;
    }
  }

  // ── JSONL 持久化 ──────────────────────────────────────────────────────────

  /**
   * 异步追加最后一轮 user/assistant 对话到 JSONL（fire-and-forget）。
   * 在 runAgent() 成功结束后调用。
   */
  appendLastTurnToJsonl(): void {
    const msgs = this.messages;
    // 找最后一条 assistant 消息（即最终回复）
    let assistantIdx = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i]?.role === "assistant") {
        assistantIdx = i;
        break;
      }
    }
    if (assistantIdx < 0) return;

    // 往前找最近的一条 user 消息（不要求与 assistant 相邻）
    let userIdx = -1;
    for (let i = assistantIdx - 1; i >= 0; i--) {
      if (msgs[i]?.role === "user") {
        userIdx = i;
        break;
      }
    }
    if (userIdx < 0) return;

    const ts = new Date().toISOString();
    const lines =
      JSON.stringify({ role: "user", content: msgs[userIdx]!.content, ts }) +
      "\n" +
      JSON.stringify({ role: "assistant", content: msgs[assistantIdx]!.content, ts }) +
      "\n";
    try {
      const filePath = Session.getJsonlPath(this.sessionId);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.appendFileSync(filePath, lines, "utf-8");
    } catch (err) {
      console.error("[session] JSONL append failed:", err);
    }
  }

  /**
   * 整体覆盖写入 JSONL，仅保留当前 messages[]（压缩后调用）。
   * 保留 system messages + 摘要，丢弃原始 user/assistant 记录。
   */
  private rewriteJsonl(): void {
    try {
      const filePath = Session.getJsonlPath(this.sessionId);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const lines =
        this.messages
          .map((m) => JSON.stringify({ role: m.role, content: m.content }))
          .join("\n") + "\n";
      fs.writeFileSync(filePath, lines, "utf-8");
    } catch (err) {
      console.error("[session] JSONL rewrite failed:", err);
    }
  }

  /**
   * 从 JSONL 文件加载 messages[]（进程启动时调用）。
   * 文件不存在返回 null。
   */
  private static loadFromJsonl(sessionId: string): ChatMessage[] | null {
    const filePath = Session.getJsonlPath(sessionId);
    if (!fs.existsSync(filePath)) return null;
    try {
      const lines = fs.readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
      const messages: ChatMessage[] = [];
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as Record<string, unknown>;
          const role = entry["role"];
          const content = entry["content"];
          if (
            (role === "system" || role === "user" || role === "assistant") &&
            (typeof content === "string" || Array.isArray(content))
          ) {
            messages.push({ role, content: content as string | ContentPart[] });
          }
        } catch {
          // 跳过格式损坏的行
        }
      }
      return messages.length > 0 ? messages : null;
    } catch (err) {
      console.error("[session] JSONL load failed:", err);
      return null;
    }
  }

  private static getJsonlPath(sessionId: string): string {
    // 将 sessionId 中的 : / \ 替换为 _ 作为合法文件名
    const sanitized = sessionId.replace(/[:/\\]/g, "_");
    return path.join(os.homedir(), ".tinyclaw", "sessions", `${sanitized}.jsonl`);
  }

  // ─────────────────────────────────────────────────────────────────────────

  /** 估算当前 token 数（粗算） */
  estimatedTokens(): number {
    const total = this.messages.reduce((s, m) => {
      if (typeof m.content === "string") return s + m.content.length;
      return s + m.content.reduce((cs, p) => {
        if (p.type === "text") return cs + p.text.length;
        return cs + 500; // 图片以 500 字符估算
      }, 0);
    }, 0);
    return Math.ceil(total / 3.5);
  }

  /** 获取 daily LLM 的模型名（用于日志） */
  get modelName(): string {
    return llmRegistry.get("daily").model;
  }
}
