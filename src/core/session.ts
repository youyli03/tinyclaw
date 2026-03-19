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

  // ── 会话摘要 ──────────────────────────────────────────────────────────────
  /** 最近一次 compress() 生成的摘要文本（由 fork() 注入给 slave 作为历史背景） */
  lastSummary?: string;

  // ── 会话模式 ──────────────────────────────────────────────────────────────
  /**
   * 会话模式：
   * - `"chat"` — 默认聊天模式，历史记录持久化到 `.jsonl`，支持摘要压缩和 QMD 记忆。
   * - `"code"` — 代码专注模式，历史记录持久化到 `.code.jsonl`（crash 恢复），跳过摘要压缩和记忆搜索。
   */
  mode: "chat" | "code" = "chat";

  /** 最近一次 LLM 响应报告的实际 prompt token 数（0 = 尚未发送过请求） */
  lastPromptTokens = 0;


  constructor(sessionId: string, opts: SessionOptions = {}) {
    this.sessionId = sessionId;
    this.agentId = opts.agentId ?? "default";

    // 优先检测 code 模式恢复（.code.jsonl 存在 → 上次 crash 发生在 code 模式下）
    const codeRestored = Session.loadFromJsonl(sessionId, "code");
    if (codeRestored && codeRestored.length > 0) {
      this.mode = "code";
      this.messages = codeRestored;
      return;
    }

    // 尝试从 chat JSONL 恢复（进程崩溃后重启）
    const restored = Session.loadFromJsonl(sessionId, "chat");
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
   * 批量导入消息（深拷贝），用于 auto-fork continuation slave 克隆 Master 全量上下文。
   * 保留原始结构（含 tool_call / tool_result），不做任何内容提取或角色过滤。
   */
  importMessages(messages: ChatMessage[]): void {
    for (const msg of messages) {
      this.messages.push(structuredClone(msg));
    }
  }

  /**
   * 将 messages 截断至 length 条（从末尾删除）。
   * 用于 runAgent() 失败时回滚本次注入的 memory / user 消息，避免 session 状态损坏。
   */
  trimToLength(length: number): void {
    if (length >= 0 && length < this.messages.length) {
      this.messages.length = length;
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
    this.lastSummary = summary;
    return summary;
  }

  /**
   * 检查是否需要压缩，如需要则执行摘要并替换 messages[]，
   * 同时重写 JSONL（压缩后只保留 system + 摘要）。
   * code 模式下跳过（无长期历史积累）。
   * 返回摘要文本（已压缩）或 undefined（未触发）。
   */
  async maybeCompress(): Promise<string | undefined> {
    if (this.mode === "code") return undefined;
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
   * chat 模式写 <sessionId>.jsonl；code 模式写 <sessionId>.code.jsonl（crash 恢复用）。
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
      const filePath = Session.getJsonlPath(this.sessionId, this.mode);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.appendFileSync(filePath, lines, "utf-8");
    } catch (err) {
      console.error("[session] JSONL append failed:", err);
    }
  }

  /**
   * 整体覆盖写入 JSONL，仅保留当前 messages[]（压缩后调用）。
   * 保留 system messages + 摘要，丢弃原始 user/assistant 记录。
   * 仅在 chat 模式下使用（code 模式不做摘要压缩）。
   */
  private rewriteJsonl(): void {
    try {
      const filePath = Session.getJsonlPath(this.sessionId, this.mode);
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
   * 从 JSONL 文件加载 messages[]（进程启动时调用，或切换模式时调用）。
   * @param sessionId 会话 ID
   * @param mode 模式（"chat" → .jsonl，"code" → .code.jsonl），默认 "chat"
   * 文件不存在返回 null。
   */
  private static loadFromJsonl(sessionId: string, mode: "chat" | "code" = "chat"): ChatMessage[] | null {
    const filePath = Session.getJsonlPath(sessionId, mode);
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

  private static getJsonlPath(sessionId: string, mode: "chat" | "code" = "chat"): string {
    // 将 sessionId 中的 : / \ 替换为 _ 作为合法文件名
    const sanitized = sessionId.replace(/[:/\\]/g, "_");
    const suffix = mode === "code" ? ".code.jsonl" : ".jsonl";
    return path.join(os.homedir(), ".tinyclaw", "sessions", `${sanitized}${suffix}`);
  }

  // ─────────────────────────────────────────────────────────────────────────

  /**
   * 清空当前 messages[]，同时删除当前模式对应的 JSONL 文件（重置持久化状态）。
   * 用于 /code 和 /chat 命令切换模式时清理上下文。
   */
  clearMessages(): void {
    this.messages = [];
    this.lastPromptTokens = 0;
    try {
      const filePath = Session.getJsonlPath(this.sessionId, this.mode);
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (err) {
      console.error("[session] clearMessages: failed to delete JSONL:", err);
    }
  }

  /**
   * 从磁盘加载指定模式的 JSONL 历史到 messages[]。
   * 用于 /code 和 /chat 命令切换模式时恢复上下文。
   * - 切换到 "chat" 时：删除 .code.jsonl（避免下次 crash 恢复错误地进入 code 模式）
   * @param targetMode 要恢复的模式（从对应 JSONL 文件加载）
   * @returns 是否成功加载了历史消息
   */
  reloadFromDisk(targetMode: "chat" | "code"): boolean {
    if (targetMode === "chat") {
      // 切换到 chat 模式时清理 code JSONL，防止下次重启误判模式
      try {
        const codePath = Session.getJsonlPath(this.sessionId, "code");
        if (fs.existsSync(codePath)) {
          fs.unlinkSync(codePath);
        }
      } catch (err) {
        console.error("[session] reloadFromDisk: failed to clean up code JSONL:", err);
      }
    }
    const restored = Session.loadFromJsonl(this.sessionId, targetMode);
    if (restored && restored.length > 0) {
      this.messages = restored;
      return true;
    }
    this.messages = [];
    return false;
  }

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
