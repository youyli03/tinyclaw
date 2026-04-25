import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { ChatMessage, ContentPart, LLMChatMessage, ToolCallResult, OpenAIToolCall } from "../llm/client.js";
import { llmRegistry } from "../llm/registry.js";
import { shouldSummarize, summarizeAndCompress, shouldSummarizeCode, summarizeAndCompressCode, microCompactMessages } from "../memory/summarizer.js";
import { agentManager } from "./agent-manager.js";
import { loadConfig } from "../config/loader.js";

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

/** ask_user 交互结果 */
export type AskUserResult = {
  answer: string;
  isFreeform: boolean;
};

/** ask_user 控制柄 */
interface PendingAskUser {
  resolve: (result: AskUserResult) => void;
  reject: (err: Error) => void;
  /** 预设选项标签列表（用于数字索引映射；若为空则仅支持自由输入） */
  optionLabels: string[];
  /** 是否允许自由输入 */
  allowFreeform: boolean;
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
  /**
   * 内部消息数组。元素可能带有运行时字段 `_loopTaskRef`（loop task 文件路径），
   * 该字段仅存于内存；持久化时写为 `loop_task_ref`，传给 LLM 时通过 getMessagesForLLM() 折叠。
   */
  private messages: Array<ChatMessage & { _loopTaskRef?: string }> = [];

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
  /** 由父 Agent 预授权（code_assist 启动子 Agent 时设置），整个 Session 生命周期内跳过 MFA 检查 */
  mfaPreApproved = false;
  /** Interface A：等待用户回复 确认/取消 的控制柄 */
  pendingApproval: PendingApproval | null = null;
  /**
   * 本轮对话（runAgent 调用）中用户已授权的越界写路径集合。
   * runAgent 开头与 mfaApprovedForThisRun 一起重置，授权仅单轮有效。
   */
  approvedOutOfBoundPaths: Set<string> = new Set();

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

  /**
   * Chat 模式轮次计数，每次 addUserMessage 时递增。
   * 仅用于轻量 diary 触发的频率控制（每 N 轮触发一次），不持久化。
   */
  chatTurnCount: number = 0;

  /** Code 子模式：auto（默认，直接执行）/ plan（先规划后执行） */
  codeSubMode: "auto" | "plan" = "auto";

  /** Code 后端（当前仅 copilot，预留扩展） */
  codeBackend: "copilot" = "copilot";

  /** Code 模式用户指定的工作目录（null = 使用默认 workspace） */
  codeWorkdir: string | null = null;

  /** Plan 审批：等待用户选择操作或提供反馈的控制柄 */
  pendingPlanApproval: PendingPlanApproval | null = null;

  /** ask_user：等待用户回答问题的控制柄 */
  pendingAskUser: PendingAskUser | null = null;

  /** 最近一次 LLM 响应报告的实际 prompt token 数（0 = 尚未发送过请求） */
  lastPromptTokens = 0;

  /**
   * 最近一次传输失败请求的 X-Request-Id（由 runAgent 在捕获 LLMConnectionError 时设置）。
   * /retry 命令将此 ID 作为 turnRequestIdOverride 传给下次请求，服务端识别相同 ID 不重复计费。
   */
  lastFailedRequestId?: string;

  /**
   * 最近一次传输失败时的用户消息内容（原始字符串，含时间戳前缀）。
   * trimToLength 会回滚用户消息，/retry 需要将其重新传给 runAgent 以正确构建请求。
   */
  lastFailedUserContent?: string;

  /** 当前 runAgent() 绑定的 X-Agent-Task-Id，供 restart_tool 在重启后续接原任务使用。 */
  currentAgentTaskId?: string;

  /**
   * /retry 命令设置此字段以请求 main.ts 重新触发 runAgent。
   * main.ts 在命令执行后检查并清除此字段；若非 null 则以原始用户消息内容重新运行。
   */
  pendingRetry: { requestId?: string; userContent?: string } | null = null;

  /** 构造函数完成加载后置为 true；为 false 时不写 JSONL（避免加载历史时重复追加） */
  private _persistReady = false;

  // ── Agent Bind（父子关系）──────────────────────────────────────────────────
  /** 父 Session ID（由 code_assist / agent_fork 等创建时设置） */
  parentId?: string;
  /** 子 Session ID 列表 */
  readonly childIds: string[] = [];

  /**
   * 子 Agent 通过 ask_master 发起提问时，此字段被设置；
   * main.ts 收到用户下一条消息后将其作为答案 resolve，并清空此字段。
   */
  pendingSlaveQuestion: {
    question: string;
    resolve: (answer: string) => void;
  } | null = null;

  constructor(sessionId: string, opts: SessionOptions = {}) {
    this.sessionId = sessionId;
    this.agentId = opts.agentId ?? "default";

    // 优先检测 code 模式恢复（.code.jsonl + .code.active 同时存在 → 上次 crash 发生在 code 模式下）
    // .code.active 不存在说明用户主动切回了 chat，不做恢复
    const codeRestored = Session.loadFromJsonl(sessionId, "code");
    const codeActive = fs.existsSync(Session.getCodeActivePath(sessionId));
    if (codeRestored && codeRestored.messages.length > 0 && codeActive) {
      this.mode = "code";
      this.messages = codeRestored.messages;
      this.lastPromptTokens = codeRestored.lastPromptTokens;
      this.codeWorkdir = Session.readCodeDir(agentManager.codeDirPath(this.agentId));
      this.codeSubMode = Session.readCodeSubMode(agentManager.codeSubModePath(this.agentId));
      this._persistReady = true;
      return;
    }

    // 尝试从 chat JSONL 恢复（进程崩溃后重启）
    const restored = Session.loadFromJsonl(sessionId, "chat");
    if (restored) {
      this.messages = restored.messages;
      this.lastPromptTokens = restored.lastPromptTokens;
    } else if (opts.systemPrompt) {
      this.messages.push({ role: "system", content: opts.systemPrompt });
    }
    this._persistReady = true;
  }

  getMessages(): ChatMessage[] {
    return this.messages;
  }

  /**
   * 返回适合直接传给 LLM 的消息列表。
   * 对于带 `_loopTaskRef` 的 loop task user 消息：
   * - 最后一条：展开文件实际内容（执行时始终使用最新 task 文件）
   * - 非最后一条：折叠为单行摘要（减少 token，避免上下文膨胀）
   */
  getMessagesForLLM(): LLMChatMessage[] {
    const result: Array<LLMChatMessage> = [];
    // 找到最后一条带 _loopTaskRef 的 user 消息的索引
    let lastLoopIdx = -1;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      if (this.messages[i]!._loopTaskRef) { lastLoopIdx = i; break; }
    }
    for (let i = 0; i < this.messages.length; i++) {
      const m = this.messages[i]!;
      if (!m._loopTaskRef) {
        // 普通消息：原样透传，但 assistant+tool_calls 消息需清空 content。
        // 部分模型（如 Claude via Copilot）不允许 assistant 消息同时携带非空 content
        // 和 tool_calls（视为"prefill"），会返回 400 错误。
        // AI 在调用工具前输出的文字说明可以安全丢弃，不影响对话语义。
        const { _loopTaskRef: _ignored, ...plain } = m as ChatMessage & { _loopTaskRef?: string };
        if (
          plain.role === "assistant" &&
          (plain as { role: "assistant"; tool_calls?: unknown[] }).tool_calls?.length
        ) {
          // content 置为 null（不含 content 字段）而非 ""，
          // 避免 Copilot 的 Claude 路由在转换为 Anthropic 格式时因 content="" 丢失 tool_use block，
          // 从而导致 "unexpected tool_use_id in tool_result" 400 错误。
          const { content: _c, ...withoutContent } =
            plain as Extract<LLMChatMessage, { role: "assistant" }>;
          result.push(withoutContent);
        } else {
          result.push(plain as LLMChatMessage);
        }
      } else if (i === lastLoopIdx) {
        // 最后一条 loop task 消息：展开文件内容
        let expanded: string;
        try {
          expanded = require("node:fs").readFileSync(m._loopTaskRef, "utf-8") as string;
        } catch {
          expanded = typeof m.content === "string" ? m.content : "[loop task file not found]";
        }
        result.push({ role: "user", content: expanded });
      } else {
        // 历史 loop task 消息：折叠为单行
        const ref = m._loopTaskRef;
        result.push({ role: "user", content: `[Loop Task @ ${ref}]` });
      }
    }
    return result;
  }

  /**
   * 注入 loop task 消息（带文件路径标记）。
   * content 为 task 文件内容；_loopTaskRef 保存文件路径供 getMessagesForLLM 使用。
   */
  addLoopTaskMessage(taskFilePath: string, content: string): void {
    const msg: ChatMessage & { _loopTaskRef?: string } = { role: "user", content, _loopTaskRef: taskFilePath };
    this.messages.push(msg);
    this._appendMsgToJsonl(msg);
  }

  addUserMessage(content: string | ContentPart[]): void {
    this.messages.push({ role: "user", content });
    this._appendMsgToJsonl(this.messages[this.messages.length - 1]!);
    this.chatTurnCount++;
  }

  addAssistantMessage(content: string): void {
    this.messages.push({ role: "assistant", content });
    this._appendMsgToJsonl(this.messages[this.messages.length - 1]!);
  }

  /**
   * 添加 assistant 消息并附带 tool_calls（function calling 模式专用）。
   * 仅在 textMode=false（模型支持原生 function calling）时调用。
   */
  addAssistantWithToolCalls(content: string, calls: ToolCallResult[]): void {
    const maxArgChars = (() => {
      try { return loadConfig().tools.maxToolCallArgChars; } catch { return 4_000; }
    })();
    const tool_calls: OpenAIToolCall[] = calls.map((c) => {
      // 截断每个字符串字段值（而非截断整个 JSON 字符串），保证序列化结果始终是合法 JSON。
      // 截断整个 JSON 字符串会产生未闭合的字符串字面量，导致后续 LLM 请求返回 500 错误。
      const args = (() => {
        if (maxArgChars <= 0) return JSON.stringify(c.args);
        const truncated = Object.fromEntries(
          Object.entries(c.args as Record<string, unknown>).map(([k, v]) => {
            if (typeof v === "string" && v.length > maxArgChars) {
              return [k, v.slice(0, maxArgChars) + `...[截断，原 ${v.length} 字符]`];
            }
            return [k, v];
          }),
        );
        return JSON.stringify(truncated);
      })();
      return { id: c.callId, type: "function", function: { name: c.name, arguments: args } };
    });
    this.messages.push({ role: "assistant", content, tool_calls });
    this._appendMsgToJsonl(this.messages[this.messages.length - 1]!);
  }

  /**
   * 添加 role: "tool" 工具结果消息（function calling 模式专用）。
   * tool_call_id 必须与对应 assistant.tool_calls[].id 匹配。
   * 仅在 textMode=false 时调用；文本模型继续使用 addSystemMessage。
   */
  addToolResultMessage(toolCallId: string, content: string): void {
    this.messages.push({ role: "tool", tool_call_id: toolCallId, content });
    this._appendMsgToJsonl(this.messages[this.messages.length - 1]!);
  }

  /**
   * 原地更新已存在的 tool_result 消息内容，并全量覆写 JSONL。
   * 用于重启后将 "⏳ 正在重启..." 回填为 "✅ 重启完成"，避免注入额外用户消息。
   */
  updateToolResult(callId: string, content: string): void {
    const msg = this.messages.find(
      (m) => m.role === "tool" && (m as { role: "tool"; tool_call_id: string }).tool_call_id === callId
    ) as { role: "tool"; tool_call_id: string; content: string } | undefined;
    if (!msg) return;
    msg.content = content;
    // 全量覆写 JSONL，使磁盘与内存一致
    try {
      const mode = this.mode === "code" ? "code" : "chat";
      const filePath = Session.getJsonlPath(this.sessionId, mode);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const lines = this.messages.map((m) => Session.serializeMsgFull(m)).join("\n") + "\n";
      fs.writeFileSync(filePath, lines, "utf-8");
    } catch (err) {
      console.error("[session] updateToolResult JSONL rewrite failed:", err);
    }
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
   * 替换或新增 skill reminder system 消息。
   * 用特殊前缀标记识别上轮注入的 reminder，找到则原地替换，否则追加。
   * 这样每轮只有一条 skill reminder，不会堆积。
   */
  /**
   * 替换或新增记忆注入 system 消息。
   * 用内容第一行（如 "## 近期日记"、"## 当前活跃上下文" 等）作为 marker 识别同类注入，
   * 找到则原地替换，否则追加。每类记忆只保留最新一条，不无限堆积。
   */
  replaceOrAddMemoryContext(content: string): void {
    // 取第一行作为 marker（如 "## 近期日记"）
    const firstLine = content.split("\n")[0]?.trim() ?? "";
    const marker = firstLine ? `<!-- memory:${firstLine} -->` : "<!-- memory:context -->";
    const marked = marker + "\n" + content;
    const idx = this.messages.findIndex(
      (m) => m.role === "system" && typeof m.content === "string" && (m.content as string).startsWith(marker)
    );
    if (idx !== -1) {
      this.messages[idx] = { role: "system", content: marked };
    } else {
      this.messages.push({ role: "system", content: marked });
    }
  }

  replaceOrAddSkillReminder(content: string): void {
    const MARKER = "<!-- skill-reminder -->";
    const idx = this.messages.findIndex(
      (m) => m.role === "system" && typeof m.content === "string" && (m.content as string).startsWith(MARKER)
    );
    const marked = MARKER + "\n" + content;
    if (idx !== -1) {
      this.messages[idx] = { role: "system", content: marked };
    } else {
      this.messages.push({ role: "system", content: marked });
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
   * 清理内存中 messages[] 的非法状态，与 loadFromJsonl 的 Pass 1 + Pass 2 逻辑一致。
   * 在每次 runAgent() 开始时调用，确保上一次异常退出遗留的不完整工具调用链不会导致 400 错误。
   *
   * - Pass 1：移除孤立的 role=tool 消息（缺少对应 assistant.tool_calls[].id）
   * - Pass 2：移除末尾不完整的工具调用链（assistant+tool_calls 但缺少部分 tool result）
   */
  sanitizeMessages(): void {
    // ── Pass 1：清理孤立的 role=tool 消息 ────────────────────────────────────
    const validToolCallIds = new Set<string>();
    const sanitized: ChatMessage[] = [];
    for (const m of this.messages) {
      if (m.role === "tool") {
        if (validToolCallIds.has(m.tool_call_id)) {
          sanitized.push(m);
          validToolCallIds.delete(m.tool_call_id);
        }
        // else: 孤立 tool 消息，静默丢弃
      } else {
        sanitized.push(m);
        if (m.role === "assistant") {
          const calls = (m as { role: "assistant"; tool_calls?: Array<{ id: string }> }).tool_calls;
          if (calls) calls.forEach((c) => validToolCallIds.add(c.id));
        }
      }
    }

    // ── Pass 2：全量扫描并移除所有不完整的工具调用链 ────────────────────────
    // 与 loadFromJsonl 的算法保持一致：线性扫描，对每个 assistant+tool_calls 验证
    // 其紧跟的 tool 结果是否完整；不完整则移除该 assistant 及已有的部分 tool result。
    {
      const validated: ChatMessage[] = [];
      let i = 0;
      while (i < sanitized.length) {
        const m = sanitized[i]!;
        const calls = m.role === "assistant"
          ? (m as { role: "assistant"; tool_calls?: Array<{ id: string }> }).tool_calls
          : undefined;
        if (calls && calls.length > 0) {
          const expectedIds = new Set(calls.map((c) => c.id));
          let j = i + 1;
          const gotIds = new Set<string>();
          while (j < sanitized.length && sanitized[j]!.role === "tool") {
            gotIds.add((sanitized[j] as { role: "tool"; tool_call_id: string }).tool_call_id);
            j++;
          }
          const missingIds = [...expectedIds].filter((id) => !gotIds.has(id));
          if (missingIds.length > 0) {
            console.warn(
              `[session] sanitizeMessages: 检测到不完整工具调用链（缺少 tool result for ids: ${missingIds.join(", ")}），已丢弃该工具链`
            );
            i = j;
          } else {
            validated.push(...sanitized.slice(i, j));
            i = j;
          }
        } else {
          validated.push(m);
          i++;
        }
      }
      sanitized.length = 0;
      validated.forEach((m) => sanitized.push(m));
    }

    if (sanitized.length !== this.messages.length) {
      this.messages.length = 0;
      for (const m of sanitized) this.messages.push(m);
    }
  }

  /**
   * 工具输出截断（MicroCompact）：
   * 把「几轮前」过长的 tool 结果原地替换为占位符，不走 LLM，同步执行。
   * chat 和 code 模式均支持。截断后立即持久化到 JSONL。
   *
   * @param contextWindow  模型 context window 大小（tokens）
   * @param actualTokens   LLM 上次返回的真实 prompt token 数（0 = fallback 估算）
   * @returns true 表示已执行截断，false 表示未触发（token 不够高或无可截断内容）
   */
  microCompact(contextWindow: number, actualTokens: number): boolean {
    const result = microCompactMessages(this.messages, contextWindow, actualTokens);
    if (!result) return false;
    this.messages = result;
    // 持久化：chat → rewriteJsonl，code → rewriteCodeJsonl
    if (this.mode === "code") {
      this.rewriteCodeJsonl();
    } else {
      this.rewriteJsonl();
    }
    return true;
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

  /**
   * Code 模式滑动窗口压缩：
   * 1. 用 summarizer LLM 生成代码专属摘要（保留文件状态、命令结果、任务进度）
   * 2. this.messages 替换为 [system..., summary_assistant, 最近 N 条消息]
   * 3. 重写 .code.jsonl（压缩后状态持久化，供 crash 恢复用）
   * 返回 true 表示压缩已执行。
   */
  async compressForCode(): Promise<boolean> {
    const compressed = await summarizeAndCompressCode(this.messages);
    // 如果返回原始消息（无足够旧内容可压缩），跳过更新
    if (compressed === this.messages || compressed.length >= this.messages.length) {
      return false;
    }
    this.messages = compressed;
    this.rewriteCodeJsonl();

    // 压缩成功后，将摘要追加到当前项目的 NOTES.md
    try {
      const summaryMsg = [...compressed].reverse().find((m) => m.role === "assistant");
      const summaryText = typeof summaryMsg?.content === "string" ? summaryMsg.content.trim() : "";
      if (summaryText && this.codeWorkdir) {
        const { pathToProjectSlug } = await import("../tools/memory.js");
        const slug = pathToProjectSlug(this.codeWorkdir);
        const notesPath = agentManager.codeProjectNotesPath(this.agentId, slug);
        const now = new Date();
        const dateStr = now.toISOString().slice(0, 10);
        const timeStr = now.toTimeString().slice(0, 8);
        const entry = `\n### 压缩摘要 [${dateStr} ${timeStr}]\n\n${summaryText}\n`;
        console.log(`[compressForCode] 开始写入压缩摘要: ${notesPath}`);
        fs.mkdirSync(path.dirname(notesPath), { recursive: true });
        fs.appendFileSync(notesPath, entry, "utf-8");
        console.log("[compressForCode] 写入完成");

        // 写入后触发增量索引（fire-and-forget）
        import("../memory/qmd.js").then(({ updateStore }) => {
          updateStore("code_notes", this.agentId).catch((e) =>
            console.warn("[compressForCode] code_notes index update failed:", e)
          );
        }).catch(() => {});
      }
    } catch (e) {
      console.warn("[compressForCode] 存档失败:", e);
    }

    return true;
  }

  /**
   * Code 模式：检查是否需要滑动窗口压缩，如需要则执行。
   * @param contextWindow code 模型的上下文窗口大小（tokens）
   * @returns true 表示压缩已执行
   */
  async maybeCompressCode(contextWindow: number): Promise<boolean> {
    if (this.mode !== "code") return false;
    if (shouldSummarizeCode(this.messages, contextWindow)) {
      return await this.compressForCode();
    }
    return false;
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
      this.pendingApproval = {
        resolve: (approved) => {
          this.pendingApproval = null;
          resolve(approved);
        },
        reject: (err) => {
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
      this.pendingPlanApproval = {
        actions,
        resolve: (result) => {
          this.pendingPlanApproval = null;
          resolve(result);
        },
        reject: (err) => {
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

  // ── ask_user ──────────────────────────────────────────────────────────────

  /**
   * 挂起当前执行，等待用户回答问题。
   * - resolve({ answer, isFreeform: false }) = 用户选择了预设选项
   * - resolve({ answer, isFreeform: true })  = 用户自由输入
   * - reject = 超时或会话被中断
   */
  waitForAskUser(
    optionLabels: string[],
    allowFreeform: boolean,
  ): Promise<AskUserResult> {
    if (this.pendingAskUser) {
      this.pendingAskUser.reject(new Error("新的 ask_user 请求覆盖了未完成的请求"));
      this.pendingAskUser = null;
    }

    return new Promise<AskUserResult>((resolve, reject) => {
      this.pendingAskUser = {
        optionLabels,
        allowFreeform,
        resolve: (result) => {
          this.pendingAskUser = null;
          resolve(result);
        },
        reject: (err) => {
          this.pendingAskUser = null;
          reject(err);
        },
      };
    });
  }

  /** 中止等待中的 ask_user（用于软中断时清理） */
  abortPendingAskUser(): void {
    if (this.pendingAskUser) {
      this.pendingAskUser.reject(new Error("会话被中断，提问已取消"));
      this.pendingAskUser = null;
    }
  }

  // ── Agent Bind 操作 ────────────────────────────────────────────────────────

  /** 设置父 Session ID，并将本 Session 注册到父的 childIds */
  bindParent(parentSession: Session): void {
    this.parentId = parentSession.sessionId;
    if (!parentSession.childIds.includes(this.sessionId)) {
      parentSession.childIds.push(this.sessionId);
    }
  }

  /** 移除子 Session ID（子 Session 销毁或解绑时调用） */
  removeChild(childSessionId: string): void {
    const idx = this.childIds.indexOf(childSessionId);
    if (idx !== -1) this.childIds.splice(idx, 1);
  }

  // ── JSONL 持久化 ──────────────────────────────────────────────────────────

  /**
   * 将单条消息序列化为 JSON 字符串，完整保留所有字段：
   * - assistant 消息：保留 tool_calls（function calling 调用链的发起方）
   * - tool 消息：保留 tool_call_id（与 assistant.tool_calls[].id 配对）
   * - 其他角色：仅 role + content
   * 可附带 ts 时间戳（append 时使用，rewrite 时不带）。
   */
  private static serializeMsgFull(m: ChatMessage & { _loopTaskRef?: string }, ts?: string): string {
    if (m.role === "assistant") {
      const base: Record<string, unknown> = { role: m.role, content: m.content };
      if (m.tool_calls && m.tool_calls.length > 0) base["tool_calls"] = m.tool_calls;
      if (ts) base["ts"] = ts;
      return JSON.stringify(base);
    }
    if (m.role === "tool") {
      const base: Record<string, unknown> = { role: m.role, tool_call_id: m.tool_call_id, content: m.content };
      if (ts) base["ts"] = ts;
      return JSON.stringify(base);
    }
    // system / user
    const base: Record<string, unknown> = { role: m.role, content: m.content };
    if (m._loopTaskRef) base["loop_task_ref"] = m._loopTaskRef;
    if (ts) base["ts"] = ts;
    return JSON.stringify(base);
  }

  /**
   * 追加单条消息到 JSONL（chat/code 双模式）：
   * - chat 模式 → `<id>.jsonl`
   * - code 模式 → `<id>.code.jsonl`
   * 仅在 _persistReady 为 true 时执行（避免 loadFromJsonl 时重复追加）。
   * 两种模式均实时追加，保证进程 crash 后能恢复到最近状态。
   */
  private _appendMsgToJsonl(msg: ChatMessage): void {
    if (!this._persistReady) return;
    try {
      const mode = this.mode === "code" ? "code" : "chat";
      const filePath = Session.getJsonlPath(this.sessionId, mode);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.appendFileSync(filePath, Session.serializeMsgFull(msg, new Date().toISOString()) + "\n", "utf-8");
    } catch (err) {
      console.error("[session] JSONL incremental append failed:", err);
    }
  }

  /**
   * 追加本轮完整工具调用链到 JSONL（fire-and-forget）。
   * chat 模式写 <sessionId>.jsonl；code 模式写 <sessionId>.code.jsonl（crash 恢复用）。
   * 在 runAgent() 成功结束后调用。
   *
   * 与旧版只存 user + 最终 assistant 不同，此方法保存：
   *   user → [assistant+tool_calls → tool×N]* → assistant(最终回复)
   * 确保工具调用链完整，crash 恢复后发给 LLM API 不会因 tool_call_id 孤立而报错。
   */
  appendLastTurnToJsonl(): void {
    const msgs = this.messages;

    // 找最后一条 user 消息作为本轮起始点
    let userIdx = -1;
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i]?.role === "user") {
        userIdx = i;
        break;
      }
    }
    if (userIdx < 0) return;

    // user 之后必须至少有一条 assistant 作为最终回复，否则本轮尚未完成
    const hasAssistantAfter = msgs.slice(userIdx + 1).some((m) => m?.role === "assistant");
    if (!hasAssistantAfter) return;

    const ts = new Date().toISOString();
    // 序列化从 user 消息开始到末尾的完整工具调用链
    const lines = msgs.slice(userIdx).map((m) => Session.serializeMsgFull(m, ts)).join("\n") + "\n";

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
   * 使用 serializeMsgFull 保证 tool_calls / tool_call_id 字段不丢失。
   */
  private rewriteJsonl(): void {
    try {
      const filePath = Session.getJsonlPath(this.sessionId, this.mode);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const lines =
        this.messages
          .map((m) => Session.serializeMsgFull(m))
          .join("\n") + "\n";
      // 重写后追加 _meta:promptTokens，确保压缩后 lastPromptTokens 不丢失
      const metaLine = this.lastPromptTokens > 0
        ? JSON.stringify({ _meta: "promptTokens", value: this.lastPromptTokens, ts: new Date().toISOString() }) + "\n"
        : "";
      fs.writeFileSync(filePath, lines + metaLine, "utf-8");
    } catch (err) {
      console.error("[session] JSONL rewrite failed:", err);
    }
  }

  /**
   * Code 模式专用：将压缩后的 messages 全量覆写到 .code.jsonl（仅在滑动窗口压缩时调用）。
   * 日常每条消息的实时持久化由 _appendMsgToJsonl 完成（增量追加）。
   * 使用 serializeMsgFull 保证 tool_calls / tool_call_id 字段不丢失，
   * 确保 crash 恢复时工具调用链的完整性。
   */
  private rewriteCodeJsonl(): void {
    try {
      const filePath = Session.getJsonlPath(this.sessionId, "code");
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const lines =
        this.messages
          .map((m) => Session.serializeMsgFull(m))
          .join("\n") + "\n";
      fs.writeFileSync(filePath, lines, "utf-8");
    } catch (err) {
      console.error("[session] code JSONL rewrite failed:", err);
    }
  }

  /**
   * 从 JSONL 文件加载 messages[]（进程启动时调用，或切换模式时调用）。
   * @param sessionId 会话 ID
   * @param mode 模式（"chat" → .jsonl，"code" → .code.jsonl），默认 "chat"
   * 文件不存在返回 null。
   *
   * 完整恢复所有消息类型：
   * - system / user：role + content
   * - assistant：role + content + tool_calls（若有）
   * - tool：role + tool_call_id + content
   * tool 与 assistant+tool_calls 必须成对出现，孤立的 tool 消息（缺少对应 tool_call_id）会被跳过。
   */
  private static loadFromJsonl(sessionId: string, mode: "chat" | "code" = "chat"): { messages: ChatMessage[]; lastPromptTokens: number } | null {
    const filePath = Session.getJsonlPath(sessionId, mode);
    if (!fs.existsSync(filePath)) return null;
    try {
      const lines = fs.readFileSync(filePath, "utf-8").split("\n").filter(Boolean);
      const messages: ChatMessage[] = [];
      let lastPromptTokens = 0;
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as Record<string, unknown>;
          // _meta 行：不加入 messages，只提取元数据
          if (entry["_meta"] === "promptTokens") {
            const v = entry["value"];
            if (typeof v === "number" && v > 0) lastPromptTokens = v;
            continue;
          }
          const role = entry["role"];
          const content = entry["content"];

          if (role === "tool") {
            // tool 消息：必须有合法的 tool_call_id 和 string content
            const toolCallId = entry["tool_call_id"];
            if (typeof toolCallId === "string" && typeof content === "string") {
              messages.push({ role: "tool", tool_call_id: toolCallId, content });
            }
          } else if (role === "assistant" && (typeof content === "string" || Array.isArray(content))) {
            // assistant 消息：可选恢复 tool_calls 字段
            const rawToolCalls = entry["tool_calls"];
            const msg: ChatMessage = { role: "assistant", content: content as string | ContentPart[] };
            if (Array.isArray(rawToolCalls) && rawToolCalls.length > 0) {
              // 基本校验：每个 tool_call 需有 id / type / function.name / function.arguments
              const validCalls = (rawToolCalls as unknown[]).filter((tc): tc is OpenAIToolCall => {
                if (typeof tc !== "object" || tc === null) return false;
                const t = tc as Record<string, unknown>;
                const fn = t["function"] as Record<string, unknown> | undefined;
                return (
                  typeof t["id"] === "string" &&
                  t["type"] === "function" &&
                  typeof fn?.["name"] === "string" &&
                  typeof fn?.["arguments"] === "string"
                );
              });
              if (validCalls.length > 0) {
                (msg as { role: "assistant"; content: string | ContentPart[]; tool_calls?: OpenAIToolCall[] }).tool_calls = validCalls;
              }
            }
            messages.push(msg);
          } else if (
            (role === "system" || role === "user") &&
            (typeof content === "string" || Array.isArray(content))
          ) {
            const msgEntry: ChatMessage & { _loopTaskRef?: string } = { role, content: content as string | ContentPart[] };
            const loopTaskRef = entry["loop_task_ref"];
            if (role === "user" && typeof loopTaskRef === "string") {
              msgEntry._loopTaskRef = loopTaskRef;
            }
            messages.push(msgEntry);
          }
        } catch {
          // 跳过格式损坏的行
        }
      }
      // ── Pass 1：清理孤立的 role=tool 消息 ──────────────────────────────────
      // 当会话历史被压缩时，可能出现 tool 消息排在最前而其对应的
      // assistant+tool_calls 已被移除的情况，OpenAI API 会拒绝该序列（400 Bad Request）。
      const validToolCallIds = new Set<string>();
      const sanitized: ChatMessage[] = [];
      for (const m of messages) {
        if (m.role === "tool") {
          if (validToolCallIds.has(m.tool_call_id)) {
            sanitized.push(m);
            // 使用过的 id 无需继续保留（tool_call_id 一对一匹配）
            validToolCallIds.delete(m.tool_call_id);
          }
          // else: 孤立 tool 消息，静默丢弃
        } else {
          sanitized.push(m);
          if (m.role === "assistant") {
            const calls = (m as { role: "assistant"; tool_calls?: Array<{ id: string }> }).tool_calls;
            if (calls) calls.forEach((c) => validToolCallIds.add(c.id));
          }
        }
      }

      // ── Pass 2：全量扫描并移除所有不完整的工具调用链 ──────────────────────
      // 旧版只检测尾部最后一个 assistant+tool_calls，若中间某个链不完整（如用户新消息
      // 在工具执行前打断了当前轮），后续 assistant 消息会导致 break 提前退出，漏检该链。
      // 新版：线性扫描整个数组，对每个 assistant+tool_calls 验证其紧跟的 tool 结果是否完整；
      // 不完整则移除该 assistant 及其已有的部分 tool result，保留之后的消息。
      {
        const validated: ChatMessage[] = [];
        let i = 0;
        while (i < sanitized.length) {
          const m = sanitized[i]!;
          const calls = m.role === "assistant"
            ? (m as { role: "assistant"; tool_calls?: Array<{ id: string }> }).tool_calls
            : undefined;
          if (calls && calls.length > 0) {
            const expectedIds = new Set(calls.map((c) => c.id));
            // 收集紧跟其后的连续 tool 消息
            let j = i + 1;
            const gotIds = new Set<string>();
            while (j < sanitized.length && sanitized[j]!.role === "tool") {
              gotIds.add((sanitized[j] as { role: "tool"; tool_call_id: string }).tool_call_id);
              j++;
            }
            const missingIds = [...expectedIds].filter((id) => !gotIds.has(id));
            if (missingIds.length > 0) {
              // 不完整：丢弃该 assistant + 已有的部分 tool result，保留之后的消息
              console.warn(
                `[session] loadFromJsonl: 检测到不完整工具调用链（缺少 tool result for ids: ${missingIds.join(", ")}），已丢弃该工具链`
              );
              i = j; // 跳过 assistant + 部分 tool result
            } else {
              // 完整：保留 assistant + 所有 tool result
              validated.push(...sanitized.slice(i, j));
              i = j;
            }
          } else {
            validated.push(m);
            i++;
          }
        }
        sanitized.length = 0;
        validated.forEach((m) => sanitized.push(m));
      }

      return sanitized.length > 0 ? { messages: sanitized, lastPromptTokens } : null;
    } catch (err) {
      console.error("[session] JSONL load failed:", err);
      return null;
    }
  }

  /**
   * 将本轮实际 promptTokens 持久化到 JSONL 末尾（_meta 行）。
   * loadFromJsonl 读取时识别并恢复到 session.lastPromptTokens，供 shouldSummarize 使用。
   */
  static persistPromptTokens(sessionId: string, mode: "chat" | "code", tokens: number): void {
    if (tokens <= 0) return;
    try {
      const filePath = Session.getJsonlPath(sessionId, mode);
      if (!fs.existsSync(filePath)) return;
      const line = JSON.stringify({ _meta: "promptTokens", value: tokens, ts: new Date().toISOString() }) + "\n";
      fs.appendFileSync(filePath, line, "utf-8");
    } catch (err) {
      console.error("[session] persistPromptTokens failed:", err);
    }
  }

  static getJsonlPath(sessionId: string, mode: "chat" | "code" = "chat"): string {
    // 将 sessionId 中的 : / \ 替换为 _ 作为合法文件名
    const sanitized = sessionId.replace(/[:/\\]/g, "_");
    const suffix = mode === "code" ? ".code.jsonl" : ".jsonl";
    return path.join(os.homedir(), ".tinyclaw", "sessions", `${sanitized}${suffix}`);
  }

  /**
   * 删除当前 session 对应的 JSONL 文件（chat 模式）。
   * 供 SlaveManager 在 slave 完成后调用，防止 slave JSONL 无限堆积。
   * 若文件不存在则静默忽略。
   */
  deleteJsonl(): void {
    try {
      const filePath = Session.getJsonlPath(this.sessionId, "chat");
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
      }
    } catch (err) {
      console.error("[session] deleteJsonl failed:", err);
    }
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
    if (restored && restored.messages.length > 0) {
      this.messages = restored.messages;
      this.lastPromptTokens = restored.lastPromptTokens;
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
   * 读取 codesubmode 文件中保存的子模式（"plan" | "auto"）。
   * 文件不存在或内容非法时返回 "auto"。
   */
  static readCodeSubMode(subModeFile: string): "auto" | "plan" {
    try {
      if (!fs.existsSync(subModeFile)) return "plan"; // 默认 plan
      const val = fs.readFileSync(subModeFile, "utf-8").trim();
      if (val === "plan" || val === "auto") return val;
    } catch { /* ignore */ }
    return "plan"; // 默认 plan
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

  /**
   * 将 plan/auto 子模式持久化写入 codesubmode 文件，同时更新内存中的 codeSubMode。
   */
  saveCodeSubMode(subModeFile: string, mode: "auto" | "plan"): void {
    try {
      fs.mkdirSync(path.dirname(subModeFile), { recursive: true });
      fs.writeFileSync(subModeFile, mode, "utf-8");
      this.codeSubMode = mode;
    } catch (err) {
      console.error("[session] saveCodeSubMode failed:", err);
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
      // Count content characters
      let chars = 0;
      if (typeof m.content === "string") {
        chars = m.content.length;
      } else if (Array.isArray(m.content)) {
        chars = (m.content as Array<{ type: string; text?: string }>).reduce((cs, p) => {
          if (p.type === "text") return cs + (p.text?.length ?? 0);
          return cs + 500; // 图片以 500 字符估算
        }, 0);
      }
      // Count tool_call argument characters (critical: tool_calls typically account for
      // 50-70% of total payload but were omitted from the original estimate, causing the
      // threshold check to massively undercount tokens and skip compression when needed).
      const toolCalls = (m as { role: string; tool_calls?: Array<{ function?: { arguments?: string } }> }).tool_calls;
      if (m.role === "assistant" && toolCalls) {
        for (const tc of toolCalls) {
          chars += tc.function?.arguments?.length ?? 0;
        }
      }
      return s + chars;
    }, 0);
    return Math.ceil(total / 3.5);
  }

  /** 获取 daily LLM 的模型名（用于日志） */
  get modelName(): string {
    return llmRegistry.get("daily").model;
  }
}
