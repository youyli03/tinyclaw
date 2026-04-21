import { llmRegistry } from "../llm/registry.js";
import { loadConfig } from "../config/loader.js";
import { persistSummary } from "./store.js";
import type { ChatMessage, OpenAIToolCall } from "../llm/client.js";

const SUMMARIZE_SYSTEM = `你是一个对话摘要助手。你的任务是将给定的对话历史压缩为结构化摘要（不超过 4000 token），
以便在新的对话中无缝续接，不丢失重要的用户意图和对话脉络。

摘要须包含以下章节（若某章节无内容可跳过，不要输出空章节）：

1. 主要话题与意图：详细描述用户在此对话中的核心诉求、目标和关注点。
2. 关键结论与决策：对话中达成的重要结论、用户做出的决定、AI 给出的关键建议。
3. 用户偏好与习惯：用户明确表达或隐含的偏好、风格要求、不喜欢的做法（尤其是纠正过 AI 的地方）。
4. 待解决的问题：尚未完成或明确提出但未解决的问题、用户的疑虑。
5. 用户所有原始消息：逐条列出用户发送的所有非工具结果消息原文（保持原意，防止意图漂移）。
6. 当前话题：对话结束前正在讨论的具体内容，以及对话的当前状态。
7. 下一步（可选）：仅在有明确待续任务时填写，直接引用最近对话中的相关表述，确保不发生任务漂移。

使用中文，直接输出摘要内容，不要使用"摘要："等前缀。`;

/** Code 模式专属摘要提示词，重点保留技术上下文 */
const CODE_SUMMARIZE_SYSTEM = `你是一个代码会话摘要助手。你的任务是将给定的编码会话历史压缩为技术摘要（不超过 2000 token），
以便在新的 code session 中无缝续接，不丢失任何关键的技术上下文。

摘要须包含以下章节（若某章节无内容可跳过，不要输出空章节）：

1. 主要请求与意图：详细描述用户要求实现、修改或调试的具体内容，包括所有明确需求。
2. 关键技术概念：涉及的语言、框架、依赖、架构模式等重要技术概念。
3. 涉及的文件与代码：列举所有被读取、修改或创建的文件（含完整路径），每个文件注明：
   - 文件的作用和重要性
   - 做了哪些改动（如有）
   - 关键代码片段（函数签名、核心逻辑等）
4. 错误与修复：遇到的错误信息（越详细越好）及修复方法，以及用户纠正过的做法。
5. 问题解决过程：已解决的问题和仍在进行中的排查工作。
6. 用户所有原始消息：逐条列出用户发送的所有非工具结果消息原文（防止意图漂移）。
7. 待办任务：用户明确要求但尚未完成的任务。
8. 当前工作：压缩发生前正在进行的具体工作，包括文件名、代码片段、执行的命令及结果。
9. 下一步（可选）：仅在有明确续接任务时填写，直接引用最近对话中的相关表述。

使用中文，直接输出摘要内容，不要使用"摘要："等前缀。`;

/** Code 模式 context window 触发压缩的阈值（75%） */
const CODE_SUMMARIZE_THRESHOLD = 0.75;

/**
 * 将单条消息格式化为摘要 LLM 的可读文本。
 *
 * 关键改进：function calling 模式下 assistant 调用工具时 content 通常为空字符串，
 * 真正的工具信息（名称、参数）在 tool_calls 字段里。此函数展开 tool_calls 使摘要
 * LLM 能看到"调用了哪些工具、传入了什么参数"，而不是一行空白。
 *
 * tool 消息（工具执行结果）直接输出 content，已足够摘要使用。
 *
 * @param m 待格式化的消息
 * @returns 可读文本行，空消息返回空字符串（调用方应 filter(Boolean)）
 */
function formatMsgForSummary(m: ChatMessage): string {
  if (m.role === "assistant") {
    const calls = (m as { role: "assistant"; content: unknown; tool_calls?: OpenAIToolCall[] }).tool_calls;
    if (calls && calls.length > 0) {
      // 展开工具调用：显示工具名 + 参数摘要（单个参数值超过 200 字符时截断）
      const callsDesc = calls.map((tc) => {
        let argsStr: string;
        try {
          const parsed = JSON.parse(tc.function.arguments) as Record<string, unknown>;
          const entries = Object.entries(parsed).map(([k, v]) => {
            const vs = typeof v === "string" ? v : JSON.stringify(v);
            return `${k}: ${vs.length > 200 ? vs.slice(0, 200) + "…" : vs}`;
          });
          argsStr = entries.join(", ");
        } catch {
          argsStr = tc.function.arguments.slice(0, 200);
        }
        return `${tc.function.name}(${argsStr})`;
      }).join("; ");
      // 若 content 非空（思考链/前言文本），一并保留
      const textContent = typeof m.content === "string" ? m.content.trim() : "";
      return `[助手调用工具]：${callsDesc}${textContent ? `\n${textContent}` : ""}`;
    }
    const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    return content.trim() ? `[助手]：${content}` : "";
  }
  if (m.role === "tool") {
    const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    return `[工具结果]：${content}`;
  }
  if (m.role === "user") {
    const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    return `[用户]：${content}`;
  }
  return "";
}

/** Code 模式压缩后保留的最近完整轮次数（以 user 消息为轮次边界，与 chat 模式策略对齐） */
const CODE_KEEP_TURNS = 4;

/**
 * 对保留的消息做工具链剥离：
 * - 已完成轮次（存在无 tool_calls 的最终 assistant 回复）→ 只保留 user + final_assistant
 * - 未完成轮次（仍在工具调用链中，如当前正在执行的轮次）→ 原样保留所有消息
 *
 * 目的：避免 toKeep 因大量 tool 结果（exec_shell/read_file 输出）撑大上下文，
 * 压缩后仍超阈值导致每轮都重复触发压缩。
 *
 * 注意：此函数应在孤立 tool 消息清理后调用，且不改变 toSummarize 内容
 * （摘要 LLM 仍需完整工具调用才能生成高质量技术摘要）。
 */
function stripCompletedToolCalls(messages: ChatMessage[]): ChatMessage[] {
  if (messages.length === 0) return messages;

  const result: ChatMessage[] = [];
  let i = 0;

  // 处理开头的非 user 消息（如上一轮 assistant 最终回复移位残留）
  while (i < messages.length && messages[i]!.role !== "user") {
    result.push(messages[i]!);
    i++;
  }

  // 按 user 消息为边界逐轮处理
  while (i < messages.length) {
    // 找本轮结束位置（下一个 user 消息前，或末尾）
    let turnEnd = i + 1;
    while (turnEnd < messages.length && messages[turnEnd]!.role !== "user") {
      turnEnd++;
    }

    const turn = messages.slice(i, turnEnd);

    // 找本轮最后一条无 tool_calls 的 assistant 消息（最终回复）
    let finalAssistantIdx = -1;
    for (let k = turn.length - 1; k >= 0; k--) {
      const m = turn[k]!;
      if (m.role === "assistant") {
        const calls = (m as { role: "assistant"; tool_calls?: unknown[] }).tool_calls;
        if (!calls || calls.length === 0) {
          finalAssistantIdx = k;
          break;
        }
      }
    }

    if (finalAssistantIdx >= 0) {
      // 已完成轮次：只保留 user + 最终 assistant 回复
      result.push(turn[0]!);
      result.push(turn[finalAssistantIdx]!);
    } else {
      // 未完成轮次（当前轮仍在工具调用链中）：保留全部
      result.push(...turn);
    }

    i = turnEnd;
  }

  return result;
}

/**
 * 检查当前 messages 的 token 使用率是否超过阈值。
 * 优先使用 actualTokens（LLM 返回的真实 prompt token 数），
 * 无实际值时 fallback 到字符数估算（1 token ≈ 3.5 字符）。
 * @param messages 当前 session messages
 * @param actualTokens LLM 上次响应报告的实际 prompt token 数（0 或 undefined = 使用估算）
 */
export function shouldSummarize(messages: ChatMessage[], actualTokens?: number): boolean {
  const cfg = loadConfig();
  const contextWindow = llmRegistry.getContextWindow("daily");
  const threshold = Math.floor(contextWindow * cfg.memory.tokenThreshold);

  if (actualTokens && actualTokens > 0) {
    return actualTokens >= threshold;
  }

  // Fallback：字符数粗估（首次 run 尚无实际值时使用）
  // assistant 消息的 tool_calls 字段也占 token，须一并计入
  const totalChars = messages.reduce((sum, m) => {
    const toolCallsChars =
      m.role === "assistant" &&
      (m as { role: "assistant"; content: unknown; tool_calls?: unknown[] }).tool_calls
        ? JSON.stringify((m as { role: "assistant"; content: unknown; tool_calls?: unknown[] }).tool_calls).length
        : 0;
    if (typeof m.content === "string") return sum + m.content.length + toolCallsChars;
    if (Array.isArray(m.content)) {
      return sum + m.content.reduce((cs: number, p: unknown) => {
        const part = p as { type?: string; text?: string };
        if (part.type === "text") return cs + (part.text?.length ?? 0);
        return cs + 500;
      }, 0) + toolCallsChars;
    }
    return sum + toolCallsChars;
  }, 0);
  const estimatedTokens = Math.ceil(totalChars / 3.5);
  return estimatedTokens >= threshold;
}

/**
 * 检查 code 模式的 messages 是否需要滑动窗口压缩。
 * 阈值为 code 模型上下文窗口的 75%。
 * 优先使用 actualTokens（LLM 返回的真实 prompt token 数），
 * 无实际值时 fallback 到字符数估算。
 * @param messages 当前 session messages
 * @param contextWindow code 模型的上下文窗口大小（tokens）
 * @param actualTokens LLM 上次响应报告的实际 prompt token 数（0 或 undefined = 使用估算）
 */
export function shouldSummarizeCode(messages: ChatMessage[], contextWindow: number, actualTokens?: number): boolean {
  const threshold = Math.floor(contextWindow * CODE_SUMMARIZE_THRESHOLD);

  if (actualTokens && actualTokens > 0) {
    return actualTokens >= threshold;
  }

  // Fallback：字符数粗估（包括 tool_calls JSON，与 shouldSummarize 对齐）
  const totalChars = messages.reduce((sum, m) => {
    const toolCallsChars =
      m.role === "assistant" &&
      (m as { role: "assistant"; content: unknown; tool_calls?: unknown[] }).tool_calls
        ? JSON.stringify((m as { role: "assistant"; content: unknown; tool_calls?: unknown[] }).tool_calls).length
        : 0;
    const content = m.content;
    let contentChars = 0;
    if (typeof content === "string") {
      contentChars = content.length;
    } else if (Array.isArray(content)) {
      contentChars = content.reduce((cs, p) => {
        if (typeof p === "object" && p !== null && "text" in p) return cs + String((p as { text: string }).text).length;
        return cs + 200; // 非文本部分（图片等）估算
      }, 0);
    }
    return sum + contentChars + toolCallsChars;
  }, 0);
  const estimatedTokens = Math.ceil(totalChars / 3.5);
  return estimatedTokens >= threshold;
}

/**
 * Code 模式滑动窗口压缩：
 * 1. 用 summarizer LLM 对较旧的消息生成代码专属摘要
 * 2. 返回 [system messages..., summary_assistant, 最近 CODE_KEEP_TURNS 轮完整对话]
 * 以 user 消息为轮次边界，保留最近 4 个完整轮次（含每轮内的所有 tool_calls / tool 结果），
 * 只压缩更早的内容，实现滑动窗口效果。
 */
export async function summarizeAndCompressCode(
  messages: ChatMessage[],
): Promise<ChatMessage[]> {
  const client = llmRegistry.get("summarizer");

  // 分离 system 消息和非 system 消息
  const systemMessages = messages.filter((m) => m.role === "system");
  const nonSystemMessages = messages.filter((m) => m.role !== "system");

  // 找出最后 CODE_KEEP_TURNS 个 user 消息的起始位置，保留该位置起的全部消息
  const userIndices = nonSystemMessages
    .map((m, i) => (m.role === "user" ? i : -1))
    .filter((i) => i >= 0);
  const keepFromIdx =
    userIndices.length > CODE_KEEP_TURNS
      ? userIndices[userIndices.length - CODE_KEEP_TURNS]!
      : 0;

  const toSummarize = nonSystemMessages.slice(0, keepFromIdx);
  let toKeep = nonSystemMessages.slice(keepFromIdx);

  // 去除 toKeep 开头的孤立 role=tool 消息：
  // 当对应的 assistant+tool_calls 已被移入 toSummarize 时，tool 消息的 tool_call_id 找不到
  // 对应的 assistant，OpenAI API 会拒绝该消息序列（400 Bad Request）。
  {
    const validIds = new Set<string>();
    for (const m of toKeep) {
      if (m.role === "assistant") {
        const calls = (m as { role: "assistant"; tool_calls?: Array<{ id: string }> }).tool_calls;
        if (calls) calls.forEach((c) => validIds.add(c.id));
      }
    }
    let keepStart = 0;
    while (keepStart < toKeep.length) {
      const m = toKeep[keepStart]!;
      if (m.role === "tool" && !validIds.has((m as { role: "tool"; tool_call_id: string }).tool_call_id)) {
        keepStart++;
      } else {
        break;
      }
    }
    toKeep = toKeep.slice(keepStart);
  }

  // 已完成轮次工具链剥离：
  // 对 toKeep 中每个已完成的用户轮次（存在最终 assistant 无 tool_calls），
  // 只保留 user + final_assistant，丢弃中间所有 tool_calls/tool 结果消息。
  // 未完成轮次（当前仍在工具调用链中）原样保留，保证 API tool_call_id 引用完整。
  // 注意：此操作必须在 toSummarize.length === 0 的判断之前，否则当 session
  // 用户轮次 ≤ CODE_KEEP_TURNS 时，全部消息落入 toKeep，剥离永远不会执行。
  toKeep = stripCompletedToolCalls(toKeep as ChatMessage[]) as typeof toKeep;

  // 如果没有足够旧的内容可压缩（无需摘要），检查剥离是否有效果：
  // - 剥离减少了消息数 → 返回剥离后的版本（不加摘要）
  // - 剥离无效果 → 返回原始消息（调用方 compressForCode 会跳过更新）
  if (toSummarize.length === 0) {
    const stripped = [...systemMessages, ...toKeep];
    return stripped.length < messages.length ? stripped : messages;
  }

  // 构建待摘要的历史文本，使用 formatMsgForSummary 展开 tool_calls 字段，
  // 确保摘要 LLM 能看到工具调用的名称和参数，而非只看到空白 assistant 消息
  const historyText = toSummarize
    .map((m) => {
      const text = formatMsgForSummary(m);
      // 截断超长的单条消息（避免摘要输入过大）
      return text.length > 8000 ? text.slice(0, 8000) + "\n[内容过长，已截断]" : text;
    })
    .filter(Boolean)
    .join("\n\n");

  const result = await client.chat([
    { role: "system", content: CODE_SUMMARIZE_SYSTEM },
    { role: "user", content: historyText },
  ], { isUserInitiated: false });

  // 组装压缩后的消息：system + 摘要 + 最近 N 条原始消息
  const compressed: ChatMessage[] = [
    ...systemMessages,
    {
      role: "assistant",
      content: `[编码会话历史摘要]\n${result.content}`,
    },
    ...toKeep,
  ];

  return compressed;
}

/** Chat 模式压缩后保留的最近完整轮次数（以 user 消息为轮次边界） */
const CHAT_KEEP_TURNS = 4;

/** 轻量 diary 提炼：单轮 user+assistant 交互提炼提示词 */
const DISTILL_TURN_SYSTEM = `你是一个对话日记助手。
用 1-3 句中文提炼本轮对话的核心内容：用户的意图、AI 的主要行动或结论。
要求：简洁、精准，不要加前缀（如"本轮"、"摘要："等），直接输出内容。`;

/**
 * 将单轮 user+assistant 交互提炼为 diary 片段并持久化。
 * fire-and-forget 使用，调用方不 await，失败时只打 warn 日志。
 *
 * @param userMsg   本轮 user 消息
 * @param assistantMsg 本轮 assistant 回复（最后一条无 tool_calls 的）
 * @param agentId   agent ID，用于写入 diary 目录
 */
export async function distillTurnToDiary(
  userMsg: ChatMessage,
  assistantMsg: ChatMessage,
  agentId: string
): Promise<void> {
  const client = llmRegistry.get("summarizer");

  const userText = formatMsgForSummary(userMsg);
  const assistantText = formatMsgForSummary(assistantMsg);
  if (!userText && !assistantText) return;

  const turnText = [userText, assistantText].filter(Boolean).join("\n\n");

  const result = await client.chat([
    { role: "system", content: DISTILL_TURN_SYSTEM },
    { role: "user", content: turnText.slice(0, 4000) },
  ], { isUserInitiated: false });

  if (result.content.trim()) {
    await persistSummary(result.content.trim(), agentId);
  }
}

/**
 * 将对话历史压缩：
 * 1. 存档到 QMD
 * 2. 用 summarizer LLM 生成摘要
 * 3. 返回 system + 摘要 + 最近 CHAT_KEEP_TURNS 轮完整对话的新 messages[]
 */
export async function summarizeAndCompress(
  messages: ChatMessage[],
  agentId = "default"
): Promise<ChatMessage[]> {
  const client = llmRegistry.get("summarizer");

  // 永久性 system messages:
  // - 保留主 system prompt（不以 ## 或 <!-- memory: 开头）
  // - 保留 skill-reminder（含 <!-- skill-reminder --> marker）
  // - 保留有 <!-- memory:xxx --> marker 的记忆注入（每类只有1条）
  // - 清除旧格式无 marker 的临时记忆注入（以 ## 开头的 ## 近期日记/相关卡片等）
  const systemMessages = messages.filter((m) => {
    if (m.role !== "system") return false;
    const c = typeof m.content === "string" ? m.content : "";
    const isMain   = !c.startsWith("##") && !c.startsWith("<!-- memory:");  // 主 prompt 或 skill-reminder
    const isMarked = c.startsWith("<!-- memory:");                           // 新格式记忆注入
    return isMain || isMarked;
  });
  const nonSystemMessages = messages.filter((m) => m.role !== "system");

  // 找出最后 CHAT_KEEP_TURNS 个 user 消息的起始位置，保留该位置起的全部消息
  const userIndices = nonSystemMessages
    .map((m, i) => (m.role === "user" ? i : -1))
    .filter((i) => i >= 0);
  const keepFromIdx =
    userIndices.length > CHAT_KEEP_TURNS
      ? userIndices[userIndices.length - CHAT_KEEP_TURNS]!
      : 0;

  const toSummarize = nonSystemMessages.slice(0, keepFromIdx);
  let toKeep = nonSystemMessages.slice(keepFromIdx);

  // 如果没有足够旧的内容可压缩，直接返回原始消息
  if (toSummarize.length === 0) {
    return messages;
  }

  // 去除 toKeep 开头的孤立 role=tool 消息：
  // 当对应的 assistant+tool_calls 已被移入 toSummarize 时，tool_call_id 找不到对应 assistant，
  // OpenAI API 会拒绝该序列（400 Bad Request）
  {
    const validIds = new Set<string>();
    for (const m of toKeep) {
      if (m.role === "assistant") {
        const calls = (m as { role: "assistant"; tool_calls?: Array<{ id: string }> }).tool_calls;
        if (calls) calls.forEach((c) => validIds.add(c.id));
      }
    }
    let keepStart = 0;
    while (keepStart < toKeep.length) {
      const m = toKeep[keepStart]!;
      if (m.role === "tool" && !validIds.has((m as { role: "tool"; tool_call_id: string }).tool_call_id)) {
        keepStart++;
      } else {
        break;
      }
    }
    toKeep = toKeep.slice(keepStart);
  }

  // 构建待摘要文本，使用 formatMsgForSummary 展开 tool_calls
  const historyText = toSummarize
    .map((m) => {
      // loop task 消息折叠为占位符,避免将 K 线数据传给摘要 LLM
      const loopRef = (m as { _loopTaskRef?: string })._loopTaskRef;
      if (loopRef) return `[用户-Loop任务触发 @ ${loopRef}]`;
      const text = formatMsgForSummary(m);
      return text.length > 8000 ? text.slice(0, 8000) + "\n[内容过长,已截断]" : text;
    })
    .filter(Boolean)
    .join("\n\n");

  const result = await client.chat([
    { role: "system", content: SUMMARIZE_SYSTEM },
    { role: "user", content: historyText },
  ], { isUserInitiated: false });

  // 将摘要持久化到 QMD
  await persistSummary(result.content, agentId);

  const compressed: ChatMessage[] = [
    ...systemMessages,
    {
      role: "assistant",
      content: `[对话历史摘要]\n${result.content}`,
    },
    ...toKeep,
  ];

  return compressed;
}

// ── MicroCompact ──────────────────────────────────────────────────────────────

/**
 * 工具输出截断（MicroCompact）触发阈值：context 使用率超过此比例时触发。
 * 比全量压缩的 75% 更早介入，在上下文明显偏高时清理旧工具结果。
 */
const MICRO_COMPACT_THRESHOLD = 0.65;

/** 保留最近 N 条可截断工具结果不动（更早的才截断） */
const MICRO_COMPACT_KEEP_RECENT = 5;

/** 工具结果 content 超过此字符数才截断（太短的截断意义不大） */
const MICRO_COMPACT_MIN_LENGTH = 500;

/** 截断占位符（与 CC 保持一致） */
export const MICRO_COMPACT_CLEARED = "[Old tool result content cleared]";

/**
 * 需要截断输出的工具名集合。
 * 这些工具产生的 role:"tool" 消息往往是上下文膨胀的主要来源。
 */
const COMPACTABLE_TOOLS = new Set([
  "exec_shell",
  "read_file",
  "write_file",
  "edit_file",
  "http_request",
  "search_store",
  "mcp_enable_server",
]);

/**
 * 对 messages 做工具输出截断（MicroCompact）：
 * - 找到所有属于 COMPACTABLE_TOOLS 的 role:"tool" 消息
 * - 保留最近 MICRO_COMPACT_KEEP_RECENT 条不动
 * - 更早且 content 超过 MICRO_COMPACT_MIN_LENGTH 字符的替换为占位符
 * - token 未超阈值时直接返回 null（未触发）
 *
 * @param messages       当前 session 全量消息
 * @param contextWindow  模型 context window 大小（tokens）
 * @param actualTokens   LLM 上次返回的真实 prompt token 数（0 = fallback 估算）
 * @returns 修改后的新 messages 数组，或 null（未触发/无效果）
 */
export function microCompactMessages(
  messages: ChatMessage[],
  contextWindow: number,
  actualTokens: number,
): ChatMessage[] | null {
  if (contextWindow <= 0) return null;

  const threshold = Math.floor(contextWindow * MICRO_COMPACT_THRESHOLD);

  // token 检查：优先实测值，fallback 字符估算
  let tokens = actualTokens;
  if (!tokens || tokens <= 0) {
    const totalChars = messages.reduce((sum, m) => {
      if (typeof m.content === "string") return sum + m.content.length;
      if (Array.isArray(m.content)) {
        return sum + (m.content as Array<{ type?: string; text?: string }>).reduce((cs, p) => {
          return cs + (p.type === "text" ? (p.text?.length ?? 0) : 200);
        }, 0);
      }
      return sum;
    }, 0);
    tokens = Math.ceil(totalChars / 3.5);
  }

  if (tokens < threshold) return null;

  // 收集所有属于 COMPACTABLE_TOOLS 的 tool 消息索引，按先后顺序
  // 需要找到对应 assistant.tool_calls 里的工具名
  // 先建立 tool_call_id → tool_name 映射
  const callIdToName = new Map<string, string>();
  for (const m of messages) {
    if (m.role === "assistant") {
      const calls = (m as { role: "assistant"; tool_calls?: Array<{ id: string; function: { name: string } }> }).tool_calls;
      if (calls) {
        for (const c of calls) {
          callIdToName.set(c.id, c.function.name);
        }
      }
    }
  }

  // 收集可截断的 tool 消息索引（按出现顺序）
  const compactableIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === "tool") {
      const toolMsg = m as { role: "tool"; tool_call_id: string; content: string };
      const toolName = callIdToName.get(toolMsg.tool_call_id);
      if (toolName && COMPACTABLE_TOOLS.has(toolName)) {
        compactableIndices.push(i);
      }
    }
  }

  // 保留最近 MICRO_COMPACT_KEEP_RECENT 条，对更早的执行截断
  const toKeepSet = new Set(compactableIndices.slice(-MICRO_COMPACT_KEEP_RECENT));
  const toClearIndices = new Set(
    compactableIndices
      .filter((idx) => !toKeepSet.has(idx))
      .filter((idx) => {
        const content = (messages[idx] as { content: string }).content;
        return typeof content === "string" && content.length > MICRO_COMPACT_MIN_LENGTH;
      })
  );

  if (toClearIndices.size === 0) return null;

  // 复制 messages 并替换内容
  const result = messages.map((m, i) => {
    if (!toClearIndices.has(i)) return m;
    return { ...m, content: MICRO_COMPACT_CLEARED } as ChatMessage;
  });

  console.log(
    `[microcompact] 截断 ${toClearIndices.size} 条工具结果` +
    `（tokens: ${tokens}/${contextWindow}，阈值: ${threshold}）`
  );

  return result;
}


