import { llmRegistry } from "../llm/registry.js";
import { loadConfig } from "../config/loader.js";
import { persistSummary } from "./store.js";
import type { ChatMessage, OpenAIToolCall, ChatResult } from "../llm/client.js";
import type { AnyLLMClient } from "../llm/registry.js";
import { insertMetric, isMetricKeyAllowed, addMetricKey } from "../web/backend/db.js";
import { pathToProjectSlug, upsertMemSection } from "../tools/memory.js";
import { agentManager } from "../core/agent-manager.js";
import { readExistingCards, parseCardJson, saveCards } from "./cards.js";
import { mkdirSync, appendFileSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, basename, join } from "node:path";

/**
 * 记录 summarizer LLM 调用的 output token 增量到 dashboard DB。
 * 仅非 copilot（按次计费）后端才写入。
 */
function recordSummarizerTokens(result: ChatResult, client: AnyLLMClient): void {
  try {
    const isNotCopilot = !('isCopilot' in client) || !(client as { isCopilot?: boolean }).isCopilot;
    const inputTok  = result.usage?.promptTokens ?? 0;
    const outputTok = result.usage?.completionTokens ?? 0;
    const cacheTok  = (result.usage?.cacheReadTokens ?? 0) + (result.usage?.cacheCreationTokens ?? 0);
    if (isNotCopilot && (outputTok > 0 || inputTok > 0)) {
      const CAT = "llm";
      const entries = [
        { key: "token/summarizer/input",  value: inputTok,  desc: "summarizer input token 增量" },
        { key: "token/summarizer/output", value: outputTok, desc: "summarizer output token 增量" },
        { key: "token/summarizer/cache",  value: cacheTok,  desc: "summarizer cache token 增量" },
      ];
      for (const e of entries) {
        if (e.value <= 0) continue;
        if (!isMetricKeyAllowed(CAT, e.key)) addMetricKey(CAT, e.key, e.desc, "bar");
        insertMetric({ category: CAT, key: e.key, value: e.value, note: client.model });
      }
    }
  } catch { /* 写 db 失败不影响主流程 */ }
}

const SUMMARIZE_SYSTEM = `你是一个对话摘要助手。你的任务是将给定的对话历史压缩为结构化摘要（不超过 20000 token），
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
const CODE_SUMMARIZE_SYSTEM = `你是一个代码会话摘要助手。你的任务是将给定的编码会话历史压缩为技术摘要（不超过 20000 token），
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
const CODE_SUMMARIZE_THRESHOLD = 0.60;

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
/**
 * 将消息文本中的媒体标签替换为纯文本描述,避免摘要注入后 LLM 重复触发发送。
 * 例如 <file src="..." name="foo.pdf"/> → [附件: foo.pdf（已发送）]
 */
function stripMediaTags(text: string): string {
  return text
    .replace(/<file\b[^>]*\bname="([^"]*)"[^>]*\/?>/gi, '[附件: $1（已发送）]')
    .replace(/<file\b[^>]*\/?>/gi, '[附件（已发送）]')
    .replace(/<img\b[^>]*\/?>/gi, '[图片（已发送）]')
    .replace(/<audio\b[^>]*\/?>/gi, '[音频（已发送）]')
    .replace(/<video\b[^>]*\/?>/gi, '[视频（已发送）]');
}

function formatMsgForSummary(m: ChatMessage): string {
  if (m.role === "assistant") {
    const calls = (m as { role: "assistant"; content: unknown; tool_calls?: OpenAIToolCall[] }).tool_calls;
    if (calls && calls.length > 0) {
      // 展开工具调用:显示工具名 + 参数摘要(单个参数值超过 200 字符时截断)
      const callsDesc = calls.map((tc) => {
        let argsStr: string;
        try {
          const parsed = JSON.parse(tc.function.arguments) as Record<string, unknown>;
          const entries = Object.entries(parsed).map(([k, v]) => {
            const vs = typeof v === "string" ? v : JSON.stringify(v);
            return `${k}: ${vs.length > 200 ? vs.slice(0, 200) + "..." : vs}`;
          });
          argsStr = entries.join(", ");
        } catch {
          argsStr = tc.function.arguments.slice(0, 200);
        }
        return `${tc.function.name}(${argsStr})`;
      }).join("; ");
      // 若 content 非空(思考链/前言文本),一并保留并剥离媒体标签
      const textContent = stripMediaTags(typeof m.content === "string" ? m.content.trim() : "");
      return `[助手调用工具]:${callsDesc}${textContent ? `\n${textContent}` : ""}`;
    }
    const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    return content.trim() ? `[助手]:${stripMediaTags(content)}` : "";
  }
  if (m.role === "tool") {
    const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    return `[工具结果]:${stripMediaTags(content)}`;
  }
  if (m.role === "user") {
    const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
    return `[用户]:${stripMediaTags(content)}`;
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
 * 2. 返回 [system messages..., summary_assistant, 最近 keepTurns 轮完整对话]
 * 以 user 消息为轮次边界，默认保留最近 CODE_KEEP_TURNS 个完整轮次（含每轮内的所有
 * tool_calls / tool 结果），只压缩更早的内容，实现滑动窗口效果。
 *
 * 迭代回退：若当前 keepTurns 下没有可压缩的旧内容（toSummarize 为空）且 strip-only
 * 也无效，则将 keepTurns 减 1 继续尝试，直到找到可压缩内容或 keepTurns 降至 1 为止。
 * 这解决了"首次压缩后恰好剩余 CODE_KEEP_TURNS 轮导致后续压缩永远无效"的边界问题。
 */
export async function summarizeAndCompressCode(
  messages: ChatMessage[],
  agentId?: string,
  projectSlug?: string,
): Promise<ChatMessage[]> {
  const client = llmRegistry.get("summarizer");

  // 分离 system 消息和非 system 消息（两者在所有迭代中保持不变）
  const systemMessages = messages.filter((m) => m.role === "system");
  const nonSystemMessages = messages.filter((m) => m.role !== "system");

  const userIndices = nonSystemMessages
    .map((m, i) => (m.role === "user" ? i : -1))
    .filter((i) => i >= 0);

  // 从 CODE_KEEP_TURNS 开始，逐步减小保留轮次，直到找到可压缩的旧内容
  for (let keepTurns = CODE_KEEP_TURNS; keepTurns >= 1; keepTurns--) {
    const keepFromIdx =
      userIndices.length > keepTurns
        ? userIndices[userIndices.length - keepTurns]!
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
    // 只对旧轮次（除最后一个 user 轮次）做 strip；最后一个 user 轮次无论是否完成都完整保留，
    // 保证 AI 能看到最近的工具调用上下文（含中断情况下未完成的工具链）。
    {
      // 找最后一个 user 消息的起始位置
      let lastUserStart = -1;
      for (let k = toKeep.length - 1; k >= 0; k--) {
        if (toKeep[k]!.role === "user") { lastUserStart = k; break; }
      }
      if (lastUserStart <= 0) {
        // 只有一个（或零个）user 轮次，直接保留全部，不做 strip
      } else {
        const olderTurns = toKeep.slice(0, lastUserStart);
        const lastTurn = toKeep.slice(lastUserStart);
        const strippedOlder = stripCompletedToolCalls(olderTurns as ChatMessage[]) as typeof toKeep;
        toKeep = [...strippedOlder, ...lastTurn];
      }
    }

    if (toSummarize.length === 0) {
      const stripped = [...systemMessages, ...toKeep];
      // strip-only 有效果：直接返回，无需 LLM 调用
      if (stripped.length < messages.length) return stripped;
      // strip-only 无效果：尝试用更少的保留轮次（紧急回退）
      if (keepTurns > 1) {
        console.log(`[summarizeAndCompressCode] strip-only 无效果，尝试紧急压缩（keepTurns ${keepTurns} → ${keepTurns - 1}）`);
        continue;
      }
      // keepTurns 已降至 1 仍无可压缩内容:强制从前往后截断 tool 结果，目标 40% 原始体积
      {
        const estimateCharsForce = (msgs: ChatMessage[]): number =>
          msgs.reduce((sum, m) => {
            const c = m.content;
            if (typeof c === "string") return sum + c.length;
            if (Array.isArray(c)) return sum + (c as { text?: string }[]).reduce((cs, p) => cs + (typeof p.text === "string" ? p.text.length : 200), 0);
            return sum;
          }, 0);
        const originalTotalChars = estimateCharsForce(messages);
        const target = Math.floor(originalTotalChars * 0.40);
        const systemChars = estimateCharsForce(systemMessages);
        const targetKeepChars = Math.max(target - systemChars, 200);
        const allNonSys: ChatMessage[] = [...toKeep];
        const beforeChars = estimateCharsForce(allNonSys);
        if (beforeChars > targetKeepChars) {
          let overBudget = beforeChars - targetKeepChars;
          const MIN_TOOL_RESULT = 80;
          for (let ti = 0; ti < allNonSys.length && overBudget > 0; ti++) {
            const m = allNonSys[ti]!;
            if (m.role === "tool" && typeof m.content === "string") {
              const orig = m.content;
              const canTrim = Math.max(0, orig.length - MIN_TOOL_RESULT);
              if (canTrim > 0) {
                const trimAmt = Math.min(canTrim, overBudget);
                allNonSys[ti] = { ...m, content: orig.slice(0, orig.length - trimAmt) + "\n[工具结果已强制截断]" };
                overBudget -= trimAmt;
              }
            }
          }
          const afterChars = estimateCharsForce(allNonSys);
          if (afterChars < beforeChars) {
            console.log(`[summarizeAndCompressCode] 强制截断单轮超大上下文: ${beforeChars} → ${afterChars} chars (target ${targetKeepChars})`);
            return [...systemMessages, ...allNonSys];
          }
        }
      }
      // 真正无法压缩（无 tool 结果可截断）
      return messages;
    }

    // 有可压缩的旧内容：调用 LLM 生成摘要
    if (keepTurns < CODE_KEEP_TURNS) {
      console.log(`[summarizeAndCompressCode] 紧急压缩模式（keepTurns=${keepTurns}），压缩 ${toSummarize.length} 条旧消息`);
    }

    // 构建待摘要的历史文本，使用 formatMsgForSummary 展开 tool_calls 字段，
    // 确保摘要 LLM 能看到工具调用的名称和参数，而非只看到空白 assistant 消息
    const historyText = toSummarize
      .map((m) => {
        const text = formatMsgForSummary(m);

        return text;
      })
      .filter(Boolean)
      .join("\n\n");

    const result = await client.chat([
      { role: "system", content: CODE_SUMMARIZE_SYSTEM },
      { role: "user", content: historyText },
    ], { isUserInitiated: false });
    recordSummarizerTokens(result, client);

    // fire-and-forget 蒸馏笔记（不阻塞压缩）
    if (agentId && toSummarize.length > 0) {
      if (projectSlug) {
        // project session:LLM 自主维护项目记忆(MEMORY.md + topic 文件)
        distillProjectCompression(toSummarize as ChatMessage[], agentId, projectSlug).catch((err) =>
          console.warn("[summarizeAndCompressCode] project 蒸馏失败:", err instanceof Error ? err.message : err)
        );
      } else {
        // 普通 code session:多项目散射到 NOTES.md
        distillCompressionNotes(toSummarize as ChatMessage[], agentId).catch((err) =>
          console.warn("[summarizeAndCompressCode] 蒸馏失败:", err instanceof Error ? err.message : err)
        );
      }
    }

    // 组装压缩后的消息:system + 摘要 + 最近 keepTurns 轮原始消息
    let compressedKeep: ChatMessage[] = [...toKeep];

    // 第二阶段:若 LLM 摘要 + toKeep 之和仍超过原始的 40%,
    // 找最后一个 user 轮次，只截断该轮次里的 role=tool 消息（从最老到最新），直到达到目标大小。
    {
      const estimateChars2 = (msgs: ChatMessage[]): number =>
        msgs.reduce((sum, m) => {
          const c = m.content;
          if (typeof c === "string") return sum + c.length;
          if (Array.isArray(c)) return sum + (c as { text?: string }[]).reduce((cs, p) => cs + (typeof p.text === "string" ? p.text.length : 200), 0);
          return sum;
        }, 0);

      const originalTotalChars = estimateChars2(messages);
      const target = Math.floor(originalTotalChars * 0.40);
      const systemChars = estimateChars2(systemMessages);
      const summaryChars = result.content.length + 20;
      const targetKeepChars = Math.max(target - systemChars - summaryChars, 200);

      const currentKeepChars = estimateChars2(compressedKeep);
      if (currentKeepChars > targetKeepChars) {
        // 找最后一个 user 轮次的起始位置，只截断该轮次里的 tool 消息
        let lastUserStart = -1;
        for (let k = compressedKeep.length - 1; k >= 0; k--) {
          if (compressedKeep[k]!.role === "user") { lastUserStart = k; break; }
        }
        const truncateFrom = lastUserStart >= 0 ? lastUserStart : 0;
        let overBudget = currentKeepChars - targetKeepChars;
        const MIN_TOOL_RESULT = 80;
        for (let ti = truncateFrom; ti < compressedKeep.length && overBudget > 0; ti++) {
          const m = compressedKeep[ti]!;
          if (m.role === "tool" && typeof m.content === "string") {
            const orig = m.content;
            const canTrim = Math.max(0, orig.length - MIN_TOOL_RESULT);
            if (canTrim > 0) {
              const trimAmt = Math.min(canTrim, overBudget);
              compressedKeep[ti] = { ...m, content: orig.slice(0, orig.length - trimAmt) + "\n[工具结果已截断]" };
              overBudget -= trimAmt;
            }
          }
        }
        console.log(`[summarizeAndCompressCode] 二阶段截断(最后一轮 tool 消息): ${currentKeepChars} → ${estimateChars2(compressedKeep)} chars (target ${targetKeepChars})`);
      }
    }

    const compressed: ChatMessage[] = [
      ...systemMessages,
      {
        role: "assistant",
        content: `[编码会话历史摘要]\n${result.content}`,
      },
      ...compressedKeep,
    ];

    return compressed;
  }

  // 理论上不会到达（循环内已处理所有退出路径），保留作为安全兜底
  return messages;
}

/** Chat 模式压缩后保留的最近完整轮次数（以 user 消息为轮次边界） */
const CHAT_KEEP_TURNS = 4;

/** 轻量 diary 提炼：单轮 user+assistant 交互提炼提示词 */
const DISTILL_TURN_SYSTEM = `你是一个对话日记助手。
用 1-3 句中文提炼本轮对话的核心内容：用户的意图、AI 的主要行动或结论。
要求：简洁、精准，不要加前缀（如"本轮"、"摘要："等），直接输出内容。`;

/**
 * 压缩时蒸馏系统 prompt（模板）。
 * 调用前调用方应注入已知 project 清单到 prompt 末尾。
 */
function buildCompressDistillPrompt(knownProjects: string, envKeys?: string, feedbackKeys?: string): string {
  const envSection = envKeys ? `\n⚠️ 以下环境 key 已存在 ENV.md,请勿重复输出:\n${envKeys}` : "";
  const fbSection = feedbackKeys ? `\n⚠️ 以下行为约束已记录在 feedback.md,请勿重复输出:\n  - ${feedbackKeys}` : "";
  return `[⚠️BLOCKED:zh_you_are]。
你看到的是一批被压缩掉的旧对话消息（包含用户消息和 AI 的工具调用/回复）。
从这些消息中提炼出值得写入各项目长期记忆的要点。
重点关注：里程碑进度、发现的关键约束、非显然的根因、完成的重要改动。
如果整批消息都没有值得记录的内容，输出 {"projects":[],"notes":[]}。

你必须输出合法 JSON，格式如下：
{
  "projects": [
    {"path": "win:F:/Github/fpgallm", "slug": "ssh_win_F_Github_fpgallm"},
    {"path": "/home/lyy/fpgallm", "slug": "_home_lyy_fpgallm"}
  ],
  "notes": [
    {"project": "win:F:/Github/fpgallm", "items": ["要点1", "要点2"]},
    {"project": "/home/lyy/fpgallm", "items": ["要点3"]},
    {"project": "分析", "items": ["跨项目分析要点"]}
  ],
  "env_updates": [
    {"category": "projects", "key": "my-project", "value": "/home/lyy/my-project"},
    {"category": "tools", "key": "vivado", "value": "C:/Xilinx/Vivado/2023.1/bin/vivado"},
    {"category": "services", "key": "MCSManager", "value": "HTTP API,daemon port 24444"}
  ],
  "behavior_corrections": [
    {"content": "排查网络问题前先确认目标机器"},
    {"content": "不要自行执行 force push,须先告知风险"}
  ]
}

⚠️ behavior_corrections 约束:只记跨项目通用的行为纠正(适用于所有项目)。
不记专属于单一项目的规则(如"tinyclaw 中不要改 YAML")。若无新增则留空数组。

路径格式规则(重要):
- 本地路径:/home/lyy/xxx 或 ~/xxx(输出时统一用绝对路径 /home/lyy/xxx)
- Windows MCP 路径:F:/Github/xxx 等,输出时写成 win:F:/Github/xxx
- SSH 远程路径:m1saka.cc:/opt/app 等
- 无法归属到具体项目的分析性内容:project 字段填 "分析"

${knownProjects}${envSection}${fbSection}

只输出 JSON，不要输出其他内容。确保 JSON 合法（注意字符串中的引号和换行要转义）。`;
}
/** 单轮蒸馏（保留兼容，用于 distillCodeTurnToNotes） */
const CODE_DISTILL_SYSTEM = `[⚠️BLOCKED:zh_you_are]。
根据以下代码会话的最新一轮交互（用户消息 + AI 回复），提炼出值得写入项目长期记忆的要点。
重点关注：里程碑进度、发现的关键约束、非显然的根因、完成的重要改动。
如果本轮没有值得记录的内容（如只是闲聊、询问、未完成操作），直接输出空字符串（不要输出任何内容）。
若有内容，用 1-5 句中文要点（可以是短语），每行一条，直接输出，不要加前缀和标题。
⚠️ 重要：每条要点开头必须注明实际被修改/涉及的项目路径（绝对路径或 ~/xxx 形式），例如 [~/pin-hunter-bot] 或 [~/tinyclaw/src]。
  - 路径必须来自 AI 回复中实际操作或 read_file/exec_shell 的文件路径，不能用当前工作目录（codeWorkdir）替代
  - 若同一轮改动涉及多个项目，每个项目分别写一行并各自标注路径
  - 若 AI 本轮未修改任何文件（只有分析/解释），标注为 [分析] 前缀而非项目路径
  - 不要把 workdir 当成改动路径，也不要省略实际项目路径
  - 本地路径可用 ~/xxx 缩写；SSH 远程路径必须用 host:/path 或 user@host:/path 绝对格式，不能写 ~`;



/**
 * 扫描 code/projects/ 目录，生成已知 project slug 清单，
 * 注入到 distill prompt 中供 LLM 参考。
 */
function injectKnownProjects(agentId: string): string {
  try {
    const projectsDir = agentManager.codeProjectsDir(agentId);
    const dirs = readdirSync(projectsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    
    if (dirs.length === 0) return "";
    
    const lines: string[] = ["已知项目 slug（请复用，不要新建）："];
    for (const slug of dirs) {
      if (slug.startsWith("ssh_win_")) {
        const rest = slug.slice("ssh_win_".length);
        const parts = rest.split("_");
        if (parts.length >= 2) {
          const drive = parts[0] + ":/";
          const winRest = parts.slice(1).join("/");
          lines.push(`  ${slug}  →  [win:${drive}${winRest}]`);
        } else {
          lines.push(`  ${slug}  →  [win:${rest}]`);
        }
      } else if (slug.startsWith("ssh_")) {
        const rest = slug.slice(4);
        const firstUnderscore = rest.indexOf("_");
        if (firstUnderscore > 0) {
          const host = rest.slice(0, firstUnderscore).replace(/_/g, ".");
          const path = rest.slice(firstUnderscore + 1);
          if (path) {
            lines.push(`  ${slug}  →  [${host}:${path.replace(/_/g, "/")}]`);
          } else {
            lines.push(`  ${slug}  →  [${host}]`);
          }
        } else {
          lines.push(`  ${slug}  →  [${rest.replace(/_/g, "/")}]`);
        }
      } else if (slug.startsWith("_home_lyy_")) {
        const rest = slug.slice("_home_lyy_".length);
        lines.push(`  ${slug}  →  [home:/home/lyy/${rest.replace(/_/g, "/")}]`);
      } else {
        lines.push(`  ${slug}  →  [${slug.replace(/_/g, "/")}]`);
      }
    }
    return lines.join("\n");
  } catch {
    return "";
  }
}

/**
 * 解析 distill LLM 输出的 JSON，写入各项目 NOTES.md。
 * @returns true 表示成功写入至少一条笔记
 */

/**
 * 读取 ENV.md,提取已有 key 清单(仅 category::key,不传 value),
 * 用于注入蒸馏 prompt 避免 LLM 重复输出。
 * @returns 逗号分隔的 key 清单字符串,如 "projects::tinyclaw, tools::aria2c"
 */
function loadEnvKeys(agentId: string): string {
  try {
    const envPath = agentManager.codeEnvPath(agentId);
    if (!existsSync(envPath)) return "";
    const raw = readFileSync(envPath, "utf-8");
    const m = raw.match(/```json\n([\s\S]*?)\n```/);
    if (!m) return "";
    const data = JSON.parse(m[1]!);
    const keys: string[] = [];
    for (const cat of ["projects", "tools", "services"]) {
      const obj = data[cat];
      if (obj && typeof obj === "object") {
        for (const k of Object.keys(obj)) {
          keys.push(`${cat}::${k}`);
        }
      }
    }
    return keys.join(", ");
  } catch {
    return "";
  }
}

/**
 * 读取 feedback.md,提取已有内容清单(去掉日期前缀),
 * 用于注入蒸馏 prompt 避免 LLM 重复输出。
 * @returns 换行分隔的内容清单,如 "排查网络问题前先确认目标机器\n  - 不要自行 force push"
 */
function loadFeedbackKeys(agentId: string): string {
  try {
    const fbPath = agentManager.feedbackPath(agentId, "code");
    if (!existsSync(fbPath)) return "";
    const raw = readFileSync(fbPath, "utf-8");
    const contents: string[] = [];
    for (const line of raw.split("\n")) {
      const m = line.match(/^- \[[\d-]+\] (.+)$/);
      if (m) contents.push(m[1]!.trim());
    }
    return contents.join("\n  - ");
  } catch {
    return "";
  }
}

function parseAndWriteDistillJson(
  raw: string,
  agentId: string,
  knownSlugs: Set<string>,
  projectSlug?: string,
): boolean {
  try {
    let jsonStr = raw.trim();
    const codeBlockMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (codeBlockMatch) {
      jsonStr = codeBlockMatch[1]!.trim();
    }
    
    const data = JSON.parse(jsonStr);
    if (!data || typeof data !== "object") return false;
    
    // ── project session:LLM curator 输出 files 键,overwrite 模式 ──
    if (projectSlug && data.files && typeof data.files === "object") {
      const projectsDir = agentManager.codeProjectsDir(agentId);
      const projDir = join(projectsDir, projectSlug);
      mkdirSync(projDir, { recursive: true });
      
      let wroteAny = false;
      for (const [filename, fileContent] of Object.entries(data.files)) {
        if (typeof fileContent !== "string" || !fileContent.trim()) continue;
        // 安全检查:文件名必须是 .md 且在项目目录下
        const safeName = String(filename).replace(/[^a-zA-Z0-9_\-.一-鿿]/g, "");
        if (!safeName.endsWith(".md") || safeName.includes("..")) continue;
        
        const filePath = join(projDir, safeName);
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, fileContent, "utf-8");
        console.log(`[distillProjectCompression] 写入: ${safeName} (${fileContent.length} 字节)`);
        wroteAny = true;
      }
      
      // 仍处理 env_updates / behavior_corrections(逻辑与原有相同)
      // env_updates
      if (data.env_updates && Array.isArray(data.env_updates)) {
        try {
          const envPath = agentManager.codeEnvPath(agentId);
          let existing: Record<string, Record<string, string>> = { projects: {}, tools: {}, services: {} };
          try {
            if (existsSync(envPath)) {
              const rawEnv = readFileSync(envPath, "utf-8");
              const me = rawEnv.match(/```json\n([\s\S]*?)\n```/);
              if (me) existing = JSON.parse(me[1]!);
            }
          } catch { /* ignore */ }
          let changed = false;
          for (const e of data.env_updates) {
            const cat: string = e.category;
            if (!cat || !["projects", "tools", "services"].includes(cat)) continue;
            if (!existing[cat]) existing[cat] = {};
            if (!(e.key in existing[cat]!)) {
              existing[cat]![e.key] = e.value;
              changed = true;
            }
          }
          if (changed) {
            const body = "```json\n" + JSON.stringify(existing, null, 2) + "\n```";
            const md = "# 本机环境上下文\n\n" + body + "\n";
            mkdirSync(dirname(envPath), { recursive: true });
            writeFileSync(envPath, md, "utf-8");
            console.log("[distillProjectCompression] ENV.md 已更新");
          }
        } catch (e) {
          console.warn("[distillProjectCompression] ENV.md 写入失败:", e instanceof Error ? e.message : e);
        }
      }
      // behavior_corrections
      if (data.behavior_corrections && Array.isArray(data.behavior_corrections)) {
        try {
          const fbPath = agentManager.feedbackPath(agentId, "code");
          let existingContents = new Set<string>();
          try {
            if (existsSync(fbPath)) {
              const rawFb = readFileSync(fbPath, "utf-8");
              for (const line of rawFb.split("\n")) {
                const m = line.match(/^- \[[\d-]+\] (.+)$/);
                if (m) existingContents.add(m[1]!.trim());
              }
            }
          } catch { /* ignore */ }
          const today = new Date().toISOString().slice(0, 10);
          const newLines: string[] = [];
          for (const bc of data.behavior_corrections) {
            const c = typeof bc.content === "string" ? bc.content.trim() : "";
            if (!c) continue;
            if (existingContents.has(c)) continue;
            newLines.push(`- [${today}] ${c}`);
            existingContents.add(c);
          }
          if (newLines.length > 0) {
            mkdirSync(dirname(fbPath), { recursive: true });
            appendFileSync(fbPath, newLines.join("\n") + "\n", "utf-8");
            console.log(`[distillProjectCompression] feedback.md 追加 ${newLines.length} 条`);
          }
        } catch (e) {
          console.warn("[distillProjectCompression] feedback.md 写入失败:", e instanceof Error ? e.message : e);
        }
      }
      
      return wroteAny;
    }
    
    const projects: Array<{ path: string; slug: string }> = data.projects || [];
    const notes: Array<{ project: string; items: string[] }> = data.notes || [];
    
    if (notes.length === 0) return false;
    
    const pathToSlug = new Map<string, string>();
    for (const p of projects) {
      let slug = p.slug || pathToProjectSlug(p.path);
      pathToSlug.set(p.path, slug);
    }
    
    const resolveSlug = (project: string): string | null => {
      if (project === "分析") return null;
      if (pathToSlug.has(project)) return pathToSlug.get(project)!;
      
      const slug = pathToProjectSlug(project);
      
      // 尾段模糊匹配
      const tail = project.replace(/^.*[\\\/]/, "").toLowerCase();
      for (const ks of knownSlugs) {
        if (ks.toLowerCase().endsWith(tail) || (tail && ks.toLowerCase().includes(tail))) {
          return ks;
        }
      }
      
      return slug;
    };
    
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toTimeString().slice(0, 8);
    
    let wroteAny = false;
    
    for (const note of notes) {
      if (!note.items || note.items.length === 0) continue;
      
      const itemsText = note.items.join("\n");
      const header = `### ${dateStr} ${timeStr}  [压缩蒸馏]`;
      const entry = `\n${header}\n\n${itemsText}\n`;
      
      const resolvedSlug = resolveSlug(note.project);
      
      if (resolvedSlug) {
        const notesPath = agentManager.codeProjectNotesPath(agentId, resolvedSlug);
        mkdirSync(dirname(notesPath), { recursive: true });
        appendFileSync(notesPath, entry, "utf-8");
        console.log(`[distillCompression] 项目归档: ${resolvedSlug} → ${notesPath}`);
      }
      
      const sessionDailyPath = agentManager.codeSessionDailyPath(agentId);
      mkdirSync(dirname(sessionDailyPath), { recursive: true });
      const dailyEntry = resolvedSlug
        ? `\n${header} [${resolvedSlug}]\n\n${itemsText}\n`
        : `\n${header} [分析]\n\n${itemsText}\n`;
      appendFileSync(sessionDailyPath, dailyEntry, "utf-8");
      
      wroteAny = true;
    }
    
    // 处理 env_updates:写入 ENV.md
    if (data.env_updates && Array.isArray(data.env_updates)) {
      try {
        const envPath = agentManager.codeEnvPath(agentId);
        let existing: Record<string, Record<string, string>> = { projects: {}, tools: {}, services: {} };
        try {
          if (existsSync(envPath)) {
            const rawEnv = readFileSync(envPath, "utf-8");
            const me = rawEnv.match(/```json\n([\s\S]*?)\n```/);
            if (me) existing = JSON.parse(me[1]!);
          }
        } catch { /* ENV.md 不存在或格式异常,使用空对象 */ }

        let changed = false;
        for (const e of data.env_updates) {
          const cat: string = e.category;
          if (!cat || !["projects", "tools", "services"].includes(cat)) continue;
          if (!existing[cat]) existing[cat] = {};
          if (!(e.key in existing[cat]!)) {
            existing[cat]![e.key] = e.value;
            changed = true;
          }
        }

        if (changed) {
          const body = "```json\n" + JSON.stringify(existing, null, 2) + "\n```";
          const md = "# 本机环境上下文\n\n" + body + "\n";
          mkdirSync(dirname(envPath), { recursive: true });
          writeFileSync(envPath, md, "utf-8");
          console.log("[distillCompression] ENV.md 已更新");
        }
      } catch (e) {
        console.warn("[distillCompression] ENV.md 写入失败:", e instanceof Error ? e.message : e);
      }
    }

    // 处理 behavior_corrections:写入 feedback.md
    if (data.behavior_corrections && Array.isArray(data.behavior_corrections)) {
      try {
        const fbPath = agentManager.feedbackPath(agentId, "code");
        let existingContents = new Set<string>();
        try {
          if (existsSync(fbPath)) {
            const rawFb = readFileSync(fbPath, "utf-8");
            for (const line of rawFb.split("\n")) {
              const m = line.match(/^- \[[\d-]+\] (.+)$/);
              if (m) existingContents.add(m[1]!.trim());
            }
          }
        } catch { /* feedback.md 不存在或格式异常,使用空集合 */ }

        const today = new Date().toISOString().slice(0, 10);
        const newLines: string[] = [];
        for (const bc of data.behavior_corrections) {
          const content = typeof bc.content === "string" ? bc.content.trim() : "";
          if (!content) continue;
          if (existingContents.has(content)) continue;
          newLines.push(`- [${today}] ${content}`);
          existingContents.add(content);
        }

        if (newLines.length > 0) {
          mkdirSync(dirname(fbPath), { recursive: true });
          appendFileSync(fbPath, newLines.join("\n") + "\n", "utf-8");
          console.log(`[distillCompression] feedback.md 追加 ${newLines.length} 条`);
        }
      } catch (e) {
        console.warn("[distillCompression] feedback.md 写入失败:", e instanceof Error ? e.message : e);
      }
    }

    return wroteAny;
  } catch (e) {
    console.warn("[distillCompression] JSON 解析失败:", e instanceof Error ? e.message : e);
    return false;
  }
}

/**
 * Project session 专用蒸馏:LLM 作为 memory curator,
 * 接收当前 MEMORY.md + topic 文件全文,自主决定如何更新项目记忆。
 * fire-and-forget,失败时只打 warn 日志。
 */
async function distillProjectCompression(
  toSummarize: ChatMessage[],
  agentId: string,
  projectSlug: string,
): Promise<void> {
  if (toSummarize.length === 0) return;

  try {
    // 1. 加载当前项目记忆全文
    const projectsDir = agentManager.codeProjectsDir(agentId);
    const projDir = join(projectsDir, projectSlug);
    const memPath = join(projDir, "MEMORY.md");

    // 加载 MEMORY.md
    const memoryContent = existsSync(memPath) ? readFileSync(memPath, "utf-8") : "";

    // 加载所有 topic 文件
    const topicContents: Record<string, string> = {};
    if (existsSync(projDir)) {
      const topicPaths = readdirSync(projDir, { withFileTypes: true })
        .filter((d) => d.isFile() && d.name.endsWith(".md") && d.name !== "MEMORY.md" && d.name !== "NOTES.md")
        .sort()
        .map((d) => join(projDir, d.name));

      for (const tp of topicPaths) {
        const name = basename(tp, ".md");
        topicContents[name] = readFileSync(tp, "utf-8");
      }
    }

    // 2. 格式化待蒸馏消息
    const historyText = toSummarize
      .map((m) => formatMsgForSummary(m))
      .filter(Boolean)
      .join("\n\n");

    if (!historyText.trim()) return;

    // 3. 构建蒸馏 prompt
    const topicList = Object.keys(topicContents).sort();
    const topicSection = topicList.length > 0
      ? topicList.map((t) => {
          const body = topicContents[t]!;
          const truncated = body.length > 3000 ? body.slice(0, 3000) + "\n...(截断,完整内容在 topic 文件中)" : body;
          return `### ${t}.md\n\`\`\`\n${truncated}\n\`\`\``;
        }).join("\n\n")
      : "(尚无 topic 文件)";

    const memTruncated = memoryContent.length > 3000
      ? memoryContent.slice(0, 3000) + "\n...(截断)"
      : memoryContent || "(MEMORY.md 不存在)";

    const curatorPrompt = `[⚠️BLOCKED:zh_you_are]。
你是项目「${projectSlug}」的记忆管理员(memory curator)。你的任务是根据被压缩的旧对话消息,自主维护项目记忆。

## 当前项目记忆

### MEMORY.md(索引文件,每行是一条摘要 + 指向 topic 文件)
\`\`\`
${memTruncated}
\`\`\`

### topic 文件(详情)
${topicSection}

## 待蒸馏的旧对话消息

以下是被压缩掉的旧对话历史(已按轮次格式化)。请从中提炼值得保留的项目记忆:

\`\`\`
${historyText.slice(0, 12000)}
\`\`\`

## 你的任务

请根据这些消息更新项目记忆。你可以:
- 在 MEMORY.md 中新增/修改/删除/合并摘要行(保持日期分区格式)
- 在 topic 文件中新增/重写/删除内容
- 创建新的 topic 文件(适合新主题领域,如某个重要模块的专门文档)
- 删除过时或已解决的问题条目
- 合并重复或相似的条目
- 重新组织记忆结构
- 若无需任何修改,输出空的 files 对象

**重要约束:**
- 你输出的每个文件值必须是该文件的**完整新内容**(不是 diff)
- 不需要修改的文件不要出现在 files 中
- MEMORY.md 保持轻量(每行摘要 ≤ 150 字),详情放 topic 文件
- 延续现有的日期分区格式,不要做激进的重构
- 对已有的正确信息不要删除或重写,只做增量更新

必须输出合法 JSON,格式:
{
  "files": {
    "MEMORY.md": "完整新内容...",
    "progress.md": "完整新内容...",
    "bugs.md": "完整新内容..."
  },
  "env_updates": [
    {"category": "projects", "key": "my-project", "value": "/home/lyy/my-project"}
  ],
  "behavior_corrections": [
    {"content": "跨项目通用的行为纠正"}
  ]
}
只输出 JSON,不要输出其他内容。`;

    // 4. 调用 summarizer LLM
    const client = llmRegistry.get("summarizer");
    const result = await client.chat([
      { role: "user", content: curatorPrompt },
    ], { isUserInitiated: false });
    recordSummarizerTokens(result, client);

    const raw = result.content.trim();
    if (!raw || raw === '{"files":{}}') return;

    // 5. 解析输出并写入文件
    const wrote = parseAndWriteDistillJson(raw, agentId, new Set(), projectSlug);
    if (wrote) {
      // 同时处理 env_updates / behavior_corrections (parseAndWriteDistillJson 内部处理)
      import("../memory/qmd.js").then(({ updateStore }) => {
        updateStore("code_notes", agentId).catch(() =>
          console.warn("[distillProjectCompression] code_notes index update failed:")
        );
      }).catch(() => {});
    }
  } catch (e) {
    console.warn("[distillProjectCompression] 蒸馏失败:", e instanceof Error ? e.message : e);
  }
}

/**
 * 压缩时蒸馏：将待压缩的旧消息批量提炼为多项目要点。
 * fire-and-forget，失败时只打 warn 日志。
 */
async function distillCompressionNotes(
  toSummarize: ChatMessage[],
  agentId: string,
): Promise<void> {
  if (toSummarize.length === 0) return;
  
  try {
    const historyText = toSummarize
      .map((m) => formatMsgForSummary(m))
      .filter(Boolean)
      .join("\n\n");
    
    if (!historyText.trim()) return;
    
    const knownProjects = injectKnownProjects(agentId);
    
    const knownSlugs = new Set<string>();
    try {
      const projectsDir = agentManager.codeProjectsDir(agentId);
      const dirs = readdirSync(projectsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
      for (const d of dirs) knownSlugs.add(d);
    } catch {}
    
    const envKeys = loadEnvKeys(agentId);
    const feedbackKeys = loadFeedbackKeys(agentId);
    const prompt = buildCompressDistillPrompt(knownProjects, envKeys, feedbackKeys);
    
    const client = llmRegistry.get("summarizer");
    const result = await client.chat([
      { role: "system", content: prompt },
      { role: "user", content: historyText.slice(0, 20000) },
    ], { isUserInitiated: false });
    
    recordSummarizerTokens(result, client);
    
    const raw = result.content.trim();
    if (!raw || raw === '{"projects":[],"notes":[]}') return;
    
    const wrote = parseAndWriteDistillJson(raw, agentId, knownSlugs);
    if (wrote) {
      import("../memory/qmd.js").then(({ updateStore }) => {
        updateStore("code_notes", agentId).catch((e) =>
          console.warn("[distillCompression] code_notes index update failed:", e)
        );
        updateStore("code_sessions", agentId).catch((e) =>
          console.warn("[distillCompression] code_sessions index update failed:", e)
        );
      }).catch(() => {});
    }
  } catch (e) {
    console.warn("[distillCompression] 蒸馏失败:", e instanceof Error ? e.message : e);
  }
}


/**
 * Code 模式:将单轮交互提炼为项目 NOTES.md 要点，fire-and-forget。
 * @param userMsg    本轮 user 消息
 * @param assistantMsg 本轮 assistant 回复
 * @param agentId    agent ID
 * @param codeWorkdir 当前代码工作目录（用于生成 project slug）
 */
export async function distillCodeTurnToNotes(
  userMsg: ChatMessage,
  assistantMsg: ChatMessage,
  agentId: string,
  codeWorkdir: string,
  /** 从 userMsg 到 assistantMsg 之间的完整工具调用链消息(含中间 assistant + tool 消息) */
  turnMessages?: ChatMessage[],
): Promise<void> {
  const client = llmRegistry.get("summarizer");

  // 若传入完整消息链则展开(让 summarizer 看到真实文件路径),否则退化为只看首尾
  let turnText: string;
  if (turnMessages && turnMessages.length > 0) {
    const parts = turnMessages.map(formatMsgForSummary).filter(Boolean);
    turnText = parts.join("\n\n");
  } else {
    const userText = formatMsgForSummary(userMsg);
    const assistantText = formatMsgForSummary(assistantMsg);
    if (!userText && !assistantText) return;
    turnText = [userText, assistantText].filter(Boolean).join("\n\n");
  }
  if (!turnText.trim()) return;

  const result = await client.chat([
    { role: "system", content: CODE_DISTILL_SYSTEM },
    { role: "user", content: turnText.slice(0, 10000) },
  ], { isUserInitiated: false });

  recordSummarizerTokens(result, client);
  const notes = result.content.trim();
  if (!notes) return; // LLM 认为本轮无值得记录的内容

  console.log("[distillCodeTurnToNotes] 开始写入 code notes...");
  try {
    const { pathToProjectSlug } = await import("../tools/memory.js");
    const { agentManager } = await import("../core/agent-manager.js");
    const { mkdirSync, appendFileSync } = await import("node:fs");
    const { dirname } = await import("node:path");
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toTimeString().slice(0, 8); // HH:MM:SS
    const header = `### ${dateStr} ${timeStr}  [workdir: ${codeWorkdir}]`;
    const entry = `\n${header}\n\n${notes}\n`;

    // 1. 写到 projects/slug/YYYY-MM.md（按项目归档）
    const slug = pathToProjectSlug(codeWorkdir);
    const notesPath = agentManager.codeProjectNotesPath(agentId, slug);
    mkdirSync(dirname(notesPath), { recursive: true });
    appendFileSync(notesPath, entry, "utf-8");
    console.log(`[distillCodeTurnToNotes] 项目归档写入: ${notesPath}`);

    // 2. 写到 sessions/YYYY-MM/YYYY-MM-DD.md（按日期归档，不依赖 workdir）
    const sessionDailyPath = agentManager.codeSessionDailyPath(agentId);
    mkdirSync(dirname(sessionDailyPath), { recursive: true });
    appendFileSync(sessionDailyPath, entry, "utf-8");
    console.log(`[distillCodeTurnToNotes] 按日归档写入: ${sessionDailyPath}`);

    // 写入后立即触发增量索引（fire-and-forget）
    const { updateStore } = await import("../memory/qmd.js");
    updateStore("code_notes", agentId).catch((e) =>
      console.warn("[distillCodeTurnToNotes] code_notes index update failed:", e)
    );
    updateStore("code_sessions", agentId).catch((e) =>
      console.warn("[distillCodeTurnToNotes] code_sessions index update failed:", e)
    );
  } catch (e) {
    console.warn("[distillCodeTurnToNotes] 存档失败:", e);
  }
}


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

  recordSummarizerTokens(result, client);
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
      return text;
    })
    .filter(Boolean)
    .join("\n\n");

  const result = await client.chat([
    { role: "system", content: SUMMARIZE_SYSTEM },
    { role: "user", content: historyText },
  ], { isUserInitiated: false });

  recordSummarizerTokens(result, client);
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

  // ── Chat 蒸馏:fire-and-forget 提炼 cards + 更新 MEM.md ──
  if (agentId && toSummarize.length > 0) {
    distillChatCompression(toSummarize as ChatMessage[], agentId).catch((err) =>
      console.warn("[summarizeAndCompress] chat 蒸馏失败:", err instanceof Error ? err.message : err)
    );
  }

  return compressed;
}

// ── Chat 压缩蒸馏 ─────────────────────────────────────────────────────────────

/**
 * 生成当前 MEM.md 章节摘要供 LLM 去重参考。
 * 只输出章节名 + 前 3 条代表性条目,不送全文节省 token。
 */
export function summarizeMemSections(agentId: string): string {
  const memPath = agentManager.memPath(agentId);
  if (!existsSync(memPath)) return "(MEM.md 尚不存在)";

  const content = readFileSync(memPath, "utf-8");
  const sections: Array<{ heading: string; count: number; samples: string[] }> = [];
  const lines = content.split("\n");
  let currentHeading = "";
  let currentItems: string[] = [];

  for (const line of lines) {
    if (line.startsWith("## ")) {
      if (currentHeading && currentItems.length > 0) {
        sections.push({ heading: currentHeading, count: currentItems.length, samples: currentItems.slice(0, 3) });
      }
      currentHeading = line.slice(3).trim();
      currentItems = [];
    } else if (line.startsWith("- ") && currentHeading) {
      const text = line.slice(2).trim();
      if (text && !text.startsWith("[")) currentItems.push(text.slice(0, 80));
    }
  }
  if (currentHeading && currentItems.length > 0) {
    sections.push({ heading: currentHeading, count: currentItems.length, samples: currentItems.slice(0, 3) });
  }

  if (sections.length === 0) return "(MEM.md 为空)";

  return sections.map((s) => {
    const sampleStr = s.samples.length > 0 ? `\n  示例: ${s.samples.map((x) => `"${x}"`).join("; ")}` : "";
    return `- ${s.heading}: ${s.count} 条${sampleStr}`;
  }).join("\n") + `\n(共 ${sections.reduce((a, s) => a + s.count, 0)} 条)`;
}

/** 对 ACTIVE.md 做同样的章节摘要,供 distillActive 使用 */
export function summarizeActiveSections(agentId: string): string {
  const activePath = agentManager.activePath(agentId);
  if (!existsSync(activePath)) return "(ACTIVE.md 尚不存在)";

  const content = readFileSync(activePath, "utf-8");
  const sections: Array<{ heading: string; count: number; samples: string[] }> = [];
  const lines = content.split("\n");
  let currentHeading = "";
  let currentItems: string[] = [];

  for (const line of lines) {
    if (line.startsWith("## ")) {
      if (currentHeading && currentItems.length > 0) {
        sections.push({ heading: currentHeading, count: currentItems.length, samples: currentItems.slice(0, 3) });
      }
      currentHeading = line.slice(3).trim();
      currentItems = [];
    } else if (line.startsWith("- ") && currentHeading) {
      const text = line.slice(2).trim();
      if (text && !text.startsWith("[")) currentItems.push(text.slice(0, 80));
    }
  }
  if (currentHeading && currentItems.length > 0) {
    sections.push({ heading: currentHeading, count: currentItems.length, samples: currentItems.slice(0, 3) });
  }

  if (sections.length === 0) return "(ACTIVE.md 为空)";

  return sections.map((s) => {
    const sampleStr = s.samples.length > 0 ? `\n  示例: ${s.samples.map((x) => `"${x}"`).join("; ")}` : "";
    return `- ${s.heading}: ${s.count} 条${sampleStr}`;
  }).join("\n") + `\n(共 ${sections.reduce((a, s) => a + s.count, 0)} 条)`;
}

/**
 * 生成当前 active cards 清单供 LLM 去重参考。
 */
function summarizeCardInventory(agentId: string): string {
  try {
    const cards = readExistingCards(agentId);
    const active = cards.filter((c) => c.status === "active");
    const byType = new Map<string, string[]>();
    for (const c of active) {
      const list = byType.get(c.type) || [];
      list.push(c.title.slice(0, 60));
      byType.set(c.type, list);
    }
    if (byType.size === 0) return "(无 active cards)";
    return Array.from(byType.entries())
      .map(([type, titles]) => `- ${type}: ${titles.length} 张 (${titles.join("; ")})`)
      .join("\n");
  } catch {
    return "(无法读取 cards)";
  }
}

const CHAT_DISTILL_PROMPT = `[⚠️BLOCKED:zh_you_are]。
你是一个对话记忆萃取助手。
从被压缩的旧对话历史中,提炼出值得写入持久记忆的新内容。

当前 MEM.md 已包含:
{{mem_summary}}

当前 Cards 已有:
{{card_inventory}}

你的任务:
1. 检查对话中是否出现了新的偏好/约束/决策/例行事务/待跟踪事项
2. **只输出真正新的内容**(当前 MEM.md 和 Cards 中没有的)
3. 若对话中有语义相同但表述更精确的版本,用新版本覆盖(通过 supersedes 去重)
4. 若无新增内容,输出 {"cards":[],"mem_updates":{}}

Cards 输出格式(MemoryCard JSON):
- type: preference/constraint/decision/routine/open_loop/life_event/project_fact/relationship/task_state
- scope: 范围(general/project:stock/project:tinyclaw 等)
- facet: 分类维度(同类 cards 合并到同一 facet)
- importance: 0-1 重要性
- title: 简短标题(≤30字)
- summary: 完整说明(1-3 句)
- supersedes: 要替换的旧 card id 数组(可选)
- 不填 id/ts/status(由系统自动生成)

MEM.md 更新格式(按章节):
{
  "mem_updates": {
    "👤 用户偏好": ["- 新偏好1", "- 新偏好2"],
    "🐛 踩坑记录": ["- 新踩坑描述"],
    "🎯 当前任务": ["- 新任务"],
    "✅ 已完成大事": ["- 已完成事项"],
    "📅 近期变更": ["- [日期] 变更描述"]
  }
}
每条 item 以 "- " 开头,与 MEM.md 现有格式保持一致。

⚠️ Cards 去重规则:
- 同一 facet + 同一 scope 的 preference/constraint 视为重复,不要重复输出
- 标题相同或高度相似的 card 视为重复
- 如果旧 card 内容需要更新(更精确的表述),在 supersedes 中引用旧 card id

⚠️ MEM.md 去重规则:
- 若新条目与已有条目语义相同(只是换个说法),不要输出
- 若新条目是已有条目的精炼版,仍可输出(由程序合并)

只输出合法 JSON,不要输出其他内容。`;

/**
 * 应用 MEM.md 章节补丁:对每个章节执行 append 模式,带基本去重。
 */
function applyMemPatches(memUpdates: Record<string, string[]>, agentId: string): number {
  const memPath = agentManager.memPath(agentId);
  let applied = 0;

  // 读取当前 MEM.md 用于去重
  let existingContent = "";
  let existingLines = new Set<string>();
  try {
    if (existsSync(memPath)) {
      existingContent = readFileSync(memPath, "utf-8");
      // 提取所有现有的 - 开头行,归一化后用于去重
      for (const line of existingContent.split("\n")) {
        const trimmed = line.trim();
        if (trimmed.startsWith("- ")) {
          existingLines.add(trimmed.slice(2).trim().toLowerCase());
        }
      }
    }
  } catch { /* 忽略 */ }

  for (const [section, items] of Object.entries(memUpdates)) {
    if (!Array.isArray(items) || items.length === 0) continue;

    // 去重:过滤掉与已有条目高度相似的新条目
    const newItems: string[] = [];
    for (const item of items) {
      const text = item.startsWith("- ") ? item.slice(2).trim() : item.trim();
      if (!text) continue;
      const normalized = text.toLowerCase();
      // 检查是否与已有条目重复
      let isDuplicate = false;
      for (const existing of existingLines) {
        if (existing.includes(normalized.slice(0, 30)) || normalized.includes(existing.slice(0, 30))) {
          isDuplicate = true;
          break;
        }
      }
      if (!isDuplicate) {
        newItems.push(`- ${text}`);
        existingLines.add(normalized);
      }
    }

    if (newItems.length === 0) continue;

    const content = newItems.join("\n");
    try {
      upsertMemSection(memPath, section, content, "append", agentId);
      applied += newItems.length;
    } catch (e) {
      console.warn(`[distillChat] 写入 MEM.md 章节"${section}"失败:`, e);
    }
  }

  return applied;
}

/**
 * 扫描所有 active cards,生成卡片索引,写入 MEM.md。
 */
function regenerateCardIndex(agentId: string): void {
  try {
    const cards = readExistingCards(agentId);
    const active = cards.filter((c) => c.status === "active");
    if (active.length === 0) return;

    // 按 type 分组
    const byType = new Map<string, typeof active>();
    for (const c of active) {
      const list = byType.get(c.type) || [];
      list.push(c);
      byType.set(c.type, list);
    }

    // 生成索引条目
    const indexLines: string[] = [];

    // preference: 全收,合并同类 facet
    const prefs = (byType.get("preference") || []).sort((a, b) => b.importance - a.importance);
    if (prefs.length > 0) {
      // 按 facet 合并
      const byFacet = new Map<string, typeof prefs>();
      for (const p of prefs) {
        const list = byFacet.get(p.facet) || [];
        list.push(p);
        byFacet.set(p.facet, list);
      }
      for (const [, group] of byFacet) {
        const titles = group.map((c) => c.title.slice(0, 40)).join("; ");
        const topCard = group[0]!;
        const path = `${topCard.ts.slice(0, 7)}/${topCard.id}.md`;
        indexLines.push(`- **${titles}** → cards/${path}`);
      }
    }

    // constraint: 全收
    const constraints = (byType.get("constraint") || []).sort((a, b) => b.importance - a.importance);
    for (const c of constraints) {
      const path = `${c.ts.slice(0, 7)}/${c.id}.md`;
      indexLines.push(`- **${c.title.slice(0, 50)}** → cards/${path}`);
    }

    // decision: 最近 5 条
    const decisions = (byType.get("decision") || []).sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 5);
    for (const c of decisions) {
      const path = `${c.ts.slice(0, 7)}/${c.id}.md`;
      indexLines.push(`- **${c.title.slice(0, 50)}** → cards/${path}`);
    }

    // open_loop: 最近 5 条
    const openLoops = (byType.get("open_loop") || []).sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 5);
    for (const c of openLoops) {
      const path = `${c.ts.slice(0, 7)}/${c.id}.md`;
      indexLines.push(`- **${c.title.slice(0, 50)}** → cards/${path}`);
    }

    // routine: 合并摘要
    const routines = (byType.get("routine") || []);
    if (routines.length > 0) {
      const titles = routines.map((c) => c.title.slice(0, 30)).join("; ");
      indexLines.push(`- 例行: ${titles}`);
    }

    // 其他类型:合并为摘要,提示用 memory_search 检索
    const otherTypes = ["relationship", "life_event", "project_fact", "task_state", "pattern", "profile"];
    let hasOther = false;
    for (const t of otherTypes) {
      const items = byType.get(t);
      if (items && items.length > 0) {
        hasOther = true;
        break;
      }
    }
    if (hasOther) {
      indexLines.push("- 其他记忆(账户/事件/事实/关系) → 使用 memory_search 按需检索");
    }

    const indexContent = indexLines.join("\n");
    upsertMemSection(agentManager.memPath(agentId), "🗂️ 记忆卡片索引", indexContent, "upsert", agentId);
    console.log(`[distillChat] 卡片索引已刷新: ${active.length} active → ${indexLines.length} 条目`);
  } catch (e) {
    console.warn("[distillChat] 卡片索引生成失败:", e);
  }
}

/**
 * 压缩时蒸馏:将待压缩的旧消息提炼为 chat cards + MEM.md 章节更新。
 * fire-and-forget,失败时只打 warn 日志。
 */
async function distillChatCompression(
  toSummarize: ChatMessage[],
  agentId: string,
): Promise<void> {
  if (toSummarize.length === 0) return;

  try {
    const historyText = toSummarize
      .map((m) => formatMsgForSummary(m))
      .filter(Boolean)
      .join("\n\n");

    if (!historyText.trim()) return;

    const memSummary = summarizeMemSections(agentId);
    const cardInventory = summarizeCardInventory(agentId);

    const prompt = CHAT_DISTILL_PROMPT
      .replace("{{mem_summary}}", memSummary)
      .replace("{{card_inventory}}", cardInventory);

    const client = llmRegistry.get("summarizer");
    const result = await client.chat([
      { role: "system", content: prompt },
      { role: "user", content: historyText.slice(0, 15000) },
    ], { isUserInitiated: false });

    recordSummarizerTokens(result, client);
    const raw = result.content.trim();
    if (!raw || raw === '{"cards":[],"mem_updates":{}}') return;

    // 解析 JSON
    let data: { cards?: unknown[]; mem_updates?: Record<string, string[]> };
    try {
      let jsonStr = raw;
      const codeBlockMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
      if (codeBlockMatch) jsonStr = codeBlockMatch[1]!.trim();
      data = JSON.parse(jsonStr);
    } catch {
      console.warn("[distillChat] JSON 解析失败:", raw.slice(0, 200));
      return;
    }

    let cardCount = 0;
    let memCount = 0;

    // 处理 cards
    if (Array.isArray(data.cards) && data.cards.length > 0) {
      const parsed = parseCardJson(JSON.stringify(data.cards));
      if (parsed.length > 0) {
        const { saved } = saveCards(parsed, agentId);
        cardCount = saved;
      }
    }

    // 处理 mem_updates
    if (data.mem_updates && typeof data.mem_updates === "object") {
      memCount = applyMemPatches(data.mem_updates, agentId);
    }

    if (cardCount > 0 || memCount > 0) {
      console.log(`[distillChat] 蒸馏完成: ${cardCount} cards + ${memCount} mem 条目`);

      // 刷新卡片索引
      regenerateCardIndex(agentId);

      // 更新向量索引
      import("../memory/qmd.js").then(({ updateStore }) => {
        updateStore("cards", agentId).catch((e) =>
          console.warn("[distillChat] cards index update failed:", e)
        );
        updateStore("memory", agentId).catch((e) =>
          console.warn("[distillChat] memory index update failed:", e)
        );
      }).catch(() => {});
    }
  } catch (e) {
    console.warn("[distillChat] 蒸馏失败:", e instanceof Error ? e.message : e);
  }
}

// ── MicroCompact ──────────────────────────────────────────────────────────────

/**
 * 工具输出截断（MicroCompact）触发阈值：context 使用率超过此比例时触发。
 * 比全量压缩的 75% 更早介入，在上下文明显偏高时清理旧工具结果。
 */
const MICRO_COMPACT_THRESHOLD = 0.45;

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


