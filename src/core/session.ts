import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { ChatMessage, ContentPart } from "../llm/client.js";
import { llmRegistry } from "../llm/registry.js";
import { shouldSummarize, summarizeAndCompress } from "../memory/summarizer.js";
import { agentManager } from "./agent-manager.js";

/** Plan 模式审批结果 */
export type PlanApprovalResult = {
  approved: boolean;
  /** 用户选择的操作（"autopilot" | "interactive" | "exit_only" | 自定义） */
  selectedAction?: string;
  /** 用户输入的自由文字反馈（AI 将据此修改计划） */
  feedback?: string;
};

/** Interface A MFA：等待用户回复的 Promise 控制柄 */
interface PendingApproval {
  resolve: (approved: boolean) => void;
  reject: (err: Error) => void;
}

/** Plan 审批控制柄 */
interface PendingPlanApproval {
  resolve: (result: PlanApprovalResult) => void;
  reject: (err: Error) => void;
  /** 当前展示给用户的操作列表（用于数字索引映射） */
  actions: string[];
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

  /** Code 子模式：auto（默认，直接执行）/ plan（先规划后执行） */
  codeSubMode: "auto" | "plan" = "auto";

  /** Code 后端（当前仅 copilot，预留扩展） */
  codeBackend: "copilot" = "copilot";

  /** Code 模式用户指定的工作目录（null = 使用默认 workspace） */
  codeWorkdir: string | null = null;

  /** Plan 审批：等待用户选择操作或提供反馈的控制柄 */
  pendingPlanApproval: PendingPlanApproval | null = null;

  /** 最近一次 LLM 响应报告的实际 prompt token 数（0 = 尚未发送过请求） */
  lastPromptTokens = 0;

  constructor(sessionId: string, opts: SessionOptions = {}) {
    this.sessionId = sessionId;
    this.agentId = opts.agentId ?? "default";

    // 优先检测 code 模式恢复（.code.jsonl + .code.active 同时存在 → 上次 crash 发生在 code 模式下）
    // .code.active 不存在说明用户主动切回了 chat，不做恢复
    const codeRestored = Session.loadFromJsonl(sessionId, "code");
    const codeActive = fs.existsSync(Session.getCodeActivePath(sessionId));
    if (codeRestored && codeRestored.length > 0 && codeActive) {
      this.mode = "code";
      this.messages = codeRestored;
      this.codeWorkdir = Session.readCodeDir(agentManager.codeDirPath(this.agentId));
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

  // ── Plan 审批 ─────────────────────────────────────────────────────────────

  /**
   * 挂起当前执行，等待用户选择操作或输入反馈。
   * - resolve({ approved: true, selectedAction }) = 用户批准
   * - resolve({ approved: false, feedback }) = 用户拒绝 / 提供反馈
   * - reject = 超时
   */
  waitForPlanApproval(timeoutSecs: number, actions: string[]): Promise<PlanApprovalResult> {
    if (this.pendingPlanApproval) {
      this.pendingPlanApproval.reject(new Error("新的 Plan 审批请求覆盖了未完成的请求"));
      this.pendingPlanApproval = null;
    }

    return new Promise<PlanApprovalResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingPlanApproval = null;
        reject(new Error("Plan 审批超时，操作已取消"));
      }, timeoutSecs * 1000);

      this.pendingPlanApproval = {
        actions,
        resolve: (result) => {
          clearTimeout(timer);
          this.pendingPlanApproval = null;
          resolve(result);
        },
        reject: (err) => {
          clearTimeout(timer);
          this.pendingPlanApproval = null;
          reject(err);
        },
      };
    });
  }

  /** 中止等待中的 Plan 审批（用于软中断时清理） */
  abortPendingPlanApproval(): void {
    if (this.pendingPlanApproval) {
      this.pendingPlanApproval.reject(new Error("会话被中断，Plan 审批已取消"));
      this.pendingPlanApproval = null;
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

  /** `.code.active` 标记文件路径（存在表示当前 session 正处于 code 模式，用于区分 crash 和主动切换） */
  static getCodeActivePath(sessionId: string): string {
    const sanitized = sessionId.replace(/[:/\\]/g, "_");
    return path.join(os.homedir(), ".tinyclaw", "sessions", `${sanitized}.code.active`);
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
    // code 模式下同时删除 .code.active 标记（/new 后不再被 crash 恢复误判）
    if (this.mode === "code") {
      try {
        const activePath = Session.getCodeActivePath(this.sessionId);
        if (fs.existsSync(activePath)) {
          fs.unlinkSync(activePath);
        }
      } catch (err) {
        console.error("[session] clearMessages: failed to delete .code.active:", err);
      }
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
      // 切换到 chat 模式时删除 .code.active 标记（保留 .code.jsonl 以便之后恢复）
      // 不删 .code.jsonl，防止下次 /code 时丢失上下文
      try {
        const activePath = Session.getCodeActivePath(this.sessionId);
        if (fs.existsSync(activePath)) {
          fs.unlinkSync(activePath);
        }
      } catch (err) {
        console.error("[session] reloadFromDisk: failed to clean up .code.active:", err);
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

  // ── Code 工作目录持久化 ───────────────────────────────────────────────────

  /**
   * 读取 codedir 文件中保存的工作目录路径。
   * 文件不存在、路径不合法或目录不存在时返回 null。
   */
  static readCodeDir(codeDirFile: string): string | null {
    try {
      if (!fs.existsSync(codeDirFile)) return null;
      const dir = fs.readFileSync(codeDirFile, "utf-8").trim();
      if (dir && fs.existsSync(dir) && fs.statSync(dir).isDirectory()) return dir;
    } catch { /* ignore */ }
    return null;
  }

  /**
   * 将工作目录持久化写入 codedir 文件，同时更新内存中的 codeWorkdir。
   * dir 为 null 时删除持久化文件并清空内存值。
   */
  saveCodeDir(codeDirFile: string, dir: string | null): void {
    try {
      if (dir === null) {
        if (fs.existsSync(codeDirFile)) fs.unlinkSync(codeDirFile);
        this.codeWorkdir = null;
      } else {
        fs.mkdirSync(path.dirname(codeDirFile), { recursive: true });
        fs.writeFileSync(codeDirFile, dir, "utf-8");
        this.codeWorkdir = dir;
      }
    } catch (err) {
      console.error("[session] saveCodeDir failed:", err);
    }
  }

  /** 创建 `.code.active` 标记，表示当前 session 处于 code 模式（防止主动 /chat 后的 JSONL 被误判为 crash） */
  activateCodeMode(): void {
    try {
      const activePath = Session.getCodeActivePath(this.sessionId);
      fs.mkdirSync(path.dirname(activePath), { recursive: true });
      fs.writeFileSync(activePath, "", "utf-8");
    } catch (err) {
      console.error("[session] activateCodeMode failed:", err);
    }
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
