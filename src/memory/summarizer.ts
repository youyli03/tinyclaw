import { llmRegistry } from "../llm/registry.js";
import { loadConfig } from "../config/loader.js";
import { persistSummary } from "./store.js";
import type { ChatMessage, OpenAIToolCall, ChatResult } from "../llm/client.js";
import type { AnyLLMClient } from "../llm/registry.js";
import { insertMetric, isMetricKeyAllowed, addMetricKey } from "../web/backend/db.js";
import { pathToProjectSlug, upsertMemSection } from "../tools/memory.js";
import { agentManager } from "../core/agent-manager.js";
import { readExistingCards, parseCardJson, saveCards, sortCardsByScore } from "./cards.js";
import type { MemoryCard } from "./cards.js";
import { estimateMessagesTokens } from "./token-estimate.js";
import {
  mkdirSync,
  appendFileSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { dirname, basename, join } from "node:path";

/**
 * 记录 summarizer LLM 调用的 output token 增量到 dashboard DB。
 * 仅非 copilot（按次计费）后端才写入。
 */
function recordSummarizerTokens(result: ChatResult, client: AnyLLMClient): void {
  try {
    const isNotCopilot = !("isCopilot" in client) || !(client as { isCopilot?: boolean }).isCopilot;
    const inputTok = result.usage?.promptTokens ?? 0;
    const outputTok = result.usage?.completionTokens ?? 0;
    const cacheTok =
      (result.usage?.cacheReadTokens ?? 0) + (result.usage?.cacheCreationTokens ?? 0);
    if (isNotCopilot && (outputTok > 0 || inputTok > 0)) {
      const CAT = "llm";
      const entries = [
        { key: "token/summarizer/input", value: inputTok, desc: "summarizer input token 增量" },
        { key: "token/summarizer/output", value: outputTok, desc: "summarizer output token 增量" },
        { key: "token/summarizer/cache", value: cacheTok, desc: "summarizer cache token 增量" },
      ];
      for (const e of entries) {
        if (e.value <= 0) continue;
        if (!isMetricKeyAllowed(CAT, e.key)) addMetricKey(CAT, e.key, e.desc, "bar");
        insertMetric({ category: CAT, key: e.key, value: e.value, note: client.model });
      }
    }
  } catch {
    /* 写 db 失败不影响主流程 */
  }
}

const SUMMARIZE_SYSTEM = `You are a conversation compression engine. Compress the given conversation history into a structured checkpoint so that another model can continue the work with zero loss.

Output strictly in the following Markdown structure: **keep every section, in the same order**; write "(none)" for a section with no content — never drop a section. Use short bullet points, not prose paragraphs.

## Primary Requests and Intent
- The user's original goal and how it evolved; quote verbatim when the wording matters

## Key Technical Concepts
- Technologies, frameworks, patterns, and conventions involved

## Files and Code Involved
- Exact paths: why they matter, key changes or code snippets

## Errors and Fixes
- Error messages: how they were resolved, plus related user feedback

## Pending Tasks
- Work the user explicitly asked for that is not finished yet

## Current Work
- The exact work in progress at the moment of compression

## Next Step
- The single immediate action to take next, or "(none)"

## Key Context
- Decisions and their rationale, constraints, user preferences, open questions, and data needed to continue

## Original User Messages
- List verbatim every non-tool-result message the user sent (guards against intent drift)

Rules:
- Write the checkpoint in the user's own language, using concise engineering prose; **preserve exactly** file paths, commands, error strings, identifiers, numbers, function signatures, and code fragments
- Record user feedback and explicit instructions faithfully, especially corrections
- Do not mention this summarization request, and do not mention that the context was compressed
- Output only the checkpoint body; do not call any tools
- If the conversation already contains a <compacted-summary> block, it is a **prior checkpoint**: do not copy it verbatim; keep the facts that still hold, drop the outdated ones, and merge new information into the same structure`;

/** Code 模式专属摘要提示词，结构同上但强化技术上下文与命令/结果 */
const CODE_SUMMARIZE_SYSTEM = `You are a coding session compression engine. Compress the given coding session history into a structured checkpoint so that another model can continue the coding work with zero loss.

Output strictly in the following Markdown structure: **keep every section, in the same order**; write "(none)" for a section with no content. Use short bullet points.

## Primary Requests and Intent
- What the user asked to implement / modify / debug, including every explicit requirement; quote verbatim when the wording matters

## Key Technical Concepts
- Languages, frameworks, dependencies, architectural patterns, and conventions

## Files and Code Involved
- Exact paths: role of the file, what was changed, key code snippets (function signatures / core logic)

## Errors and Fixes
- Error messages (the more detail the better), how they were fixed, and approaches the user corrected

## Problem-Solving Process
- Problems already solved and work still under investigation

## Pending Tasks
- Tasks the user explicitly asked for that are not finished yet

## Current Work
- The exact work in progress at the moment of compression: file names, code snippets, commands run and their results

## Next Step
- The single immediate action to take next, or "(none)"

## Key Context
- Decisions and rationale, constraints, facts such as environment / ports / paths, open questions

## Original User Messages
- List verbatim every non-tool-result message the user sent (guards against intent drift)

Rules:
- Write the checkpoint in the user's own language, using concise engineering prose; **preserve exactly** file paths, commands, error strings, identifiers, numbers, function signatures, and code fragments
- Record user feedback and explicit instructions faithfully, especially corrections
- Do not mention this summarization request, and do not mention that the context was compressed
- Output only the checkpoint body; do not call any tools
- If the session already contains a <compacted-summary> block, it is a **prior checkpoint**: do not copy it verbatim; keep the facts that still hold, drop the outdated ones, and merge new information`;

/** Code 模式 context window 触发压缩的阈值（75%） */
const CODE_SUMMARIZE_THRESHOLD = 0.6;

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
    .replace(/<file\b[^>]*\bname="([^"]*)"[^>]*\/?>/gi, "[附件: $1（已发送）]")
    .replace(/<file\b[^>]*\/?>/gi, "[附件（已发送）]")
    .replace(/<img\b[^>]*\/?>/gi, "[图片（已发送）]")
    .replace(/<audio\b[^>]*\/?>/gi, "[音频（已发送）]")
    .replace(/<video\b[^>]*\/?>/gi, "[视频（已发送）]");
}

function formatMsgForSummary(m: ChatMessage): string {
  if (m.role === "assistant") {
    const calls = (m as { role: "assistant"; content: unknown; tool_calls?: OpenAIToolCall[] })
      .tool_calls;
    if (calls && calls.length > 0) {
      // 展开工具调用:显示工具名 + 参数摘要(单个参数值超过 200 字符时截断)
      const callsDesc = calls
        .map((tc) => {
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
        })
        .join("; ");
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
export function shouldSummarize(
  messages: ChatMessage[],
  actualTokens?: number,
  lastResponseAt?: number
): boolean {
  const cfg = loadConfig();
  const contextWindow = llmRegistry.getContextWindow("daily", lastResponseAt);
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
        ? JSON.stringify(
            (m as { role: "assistant"; content: unknown; tool_calls?: unknown[] }).tool_calls
          ).length
        : 0;
    if (typeof m.content === "string") return sum + m.content.length + toolCallsChars;
    if (Array.isArray(m.content)) {
      return (
        sum +
        m.content.reduce((cs: number, p: unknown) => {
          const part = p as { type?: string; text?: string };
          if (part.type === "text") return cs + (part.text?.length ?? 0);
          return cs + 500;
        }, 0) +
        toolCallsChars
      );
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
export function shouldSummarizeCode(
  messages: ChatMessage[],
  contextWindow: number,
  actualTokens?: number
): boolean {
  const threshold = Math.floor(contextWindow * CODE_SUMMARIZE_THRESHOLD);

  if (actualTokens && actualTokens > 0) {
    return actualTokens >= threshold;
  }

  // Fallback：字符数粗估（包括 tool_calls JSON，与 shouldSummarize 对齐）
  const totalChars = messages.reduce((sum, m) => {
    const toolCallsChars =
      m.role === "assistant" &&
      (m as { role: "assistant"; content: unknown; tool_calls?: unknown[] }).tool_calls
        ? JSON.stringify(
            (m as { role: "assistant"; content: unknown; tool_calls?: unknown[] }).tool_calls
          ).length
        : 0;
    const content = m.content;
    let contentChars = 0;
    if (typeof content === "string") {
      contentChars = content.length;
    } else if (Array.isArray(content)) {
      contentChars = content.reduce((cs, p) => {
        if (typeof p === "object" && p !== null && "text" in p)
          return cs + String((p as { text: string }).text).length;
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
  projectSlug?: string
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
      userIndices.length > keepTurns ? userIndices[userIndices.length - keepTurns]! : 0;

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
        if (
          m.role === "tool" &&
          !validIds.has((m as { role: "tool"; tool_call_id: string }).tool_call_id)
        ) {
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
        if (toKeep[k]!.role === "user") {
          lastUserStart = k;
          break;
        }
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
        console.log(
          `[summarizeAndCompressCode] strip-only 无效果，尝试紧急压缩（keepTurns ${keepTurns} → ${keepTurns - 1}）`
        );
        continue;
      }
      // keepTurns 已降至 1 仍无可压缩内容:强制从前往后截断 tool 结果，目标 40% 原始体积
      {
        const estimateCharsForce = (msgs: ChatMessage[]): number =>
          msgs.reduce((sum, m) => {
            const c = m.content;
            if (typeof c === "string") return sum + c.length;
            if (Array.isArray(c))
              return (
                sum +
                (c as { text?: string }[]).reduce(
                  (cs, p) => cs + (typeof p.text === "string" ? p.text.length : 200),
                  0
                )
              );
            return sum;
          }, 0);
        const originalTotalChars = estimateCharsForce(messages);
        const target = Math.floor(originalTotalChars * 0.4);
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
                allNonSys[ti] = {
                  ...m,
                  content: orig.slice(0, orig.length - trimAmt) + "\n[工具结果已强制截断]",
                };
                overBudget -= trimAmt;
              }
            }
          }
          const afterChars = estimateCharsForce(allNonSys);
          if (afterChars < beforeChars) {
            console.log(
              `[summarizeAndCompressCode] 强制截断单轮超大上下文: ${beforeChars} → ${afterChars} chars (target ${targetKeepChars})`
            );
            return [...systemMessages, ...allNonSys];
          }
        }
      }
      // 真正无法压缩（无 tool 结果可截断）
      return messages;
    }

    // 有可压缩的旧内容：调用 LLM 生成摘要
    if (keepTurns < CODE_KEEP_TURNS) {
      console.log(
        `[summarizeAndCompressCode] 紧急压缩模式（keepTurns=${keepTurns}），压缩 ${toSummarize.length} 条旧消息`
      );
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

    const result = await client.chat(
      [
        { role: "system", content: CODE_SUMMARIZE_SYSTEM },
        { role: "user", content: historyText },
      ],
      { isUserInitiated: false }
    );
    recordSummarizerTokens(result, client);

    // fire-and-forget 蒸馏笔记（不阻塞压缩）
    if (agentId && toSummarize.length > 0) {
      if (projectSlug) {
        // project session:LLM 自主维护项目记忆(MEMORY.md + topic 文件)
        distillProjectCompression(toSummarize as ChatMessage[], agentId, projectSlug).catch((err) =>
          console.warn(
            "[summarizeAndCompressCode] project 蒸馏失败:",
            err instanceof Error ? err.message : err
          )
        );
      } else {
        // 普通 code session:多项目散射到 NOTES.md
        distillCompressionNotes(toSummarize as ChatMessage[], agentId).catch((err) =>
          console.warn(
            "[summarizeAndCompressCode] 蒸馏失败:",
            err instanceof Error ? err.message : err
          )
        );
      }
    }

    // 组装压缩后的消息:system + 摘要 + 最近 keepTurns 轮原始消息
    const compressedKeep: ChatMessage[] = [...toKeep];

    // 第二阶段:若 LLM 摘要 + toKeep 之和仍超过原始的 40%,
    // 找最后一个 user 轮次，只截断该轮次里的 role=tool 消息（从最老到最新），直到达到目标大小。
    {
      const estimateChars2 = (msgs: ChatMessage[]): number =>
        msgs.reduce((sum, m) => {
          const c = m.content;
          if (typeof c === "string") return sum + c.length;
          if (Array.isArray(c))
            return (
              sum +
              (c as { text?: string }[]).reduce(
                (cs, p) => cs + (typeof p.text === "string" ? p.text.length : 200),
                0
              )
            );
          return sum;
        }, 0);

      const originalTotalChars = estimateChars2(messages);
      const target = Math.floor(originalTotalChars * 0.4);
      const systemChars = estimateChars2(systemMessages);
      const summaryChars = result.content.length + 20;
      const targetKeepChars = Math.max(target - systemChars - summaryChars, 200);

      const currentKeepChars = estimateChars2(compressedKeep);
      if (currentKeepChars > targetKeepChars) {
        // 找最后一个 user 轮次的起始位置，只截断该轮次里的 tool 消息
        let lastUserStart = -1;
        for (let k = compressedKeep.length - 1; k >= 0; k--) {
          if (compressedKeep[k]!.role === "user") {
            lastUserStart = k;
            break;
          }
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
              compressedKeep[ti] = {
                ...m,
                content: orig.slice(0, orig.length - trimAmt) + "\n[工具结果已截断]",
              };
              overBudget -= trimAmt;
            }
          }
        }
        console.log(
          `[summarizeAndCompressCode] 二阶段截断(最后一轮 tool 消息): ${currentKeepChars} → ${estimateChars2(compressedKeep)} chars (target ${targetKeepChars})`
        );
      }
    }

    const compressed: ChatMessage[] = [
      ...systemMessages,
      {
        role: "assistant",
        content: `[编码会话历史摘要]\n<compacted-summary>\n${result.content}\n</compacted-summary>`,
      },
      ...compressedKeep,
    ];

    return compressed;
  }

  // 理论上不会到达（循环内已处理所有退出路径），保留作为安全兜底
  return messages;
}

/**
 * Chat 压缩时逐字保留的近期尾部预算，占上下文窗口的比例
 * （对齐 DSH `dsh-compaction-basic` 的 `retainRatio` 默认值 0.16）。
 * 由调用方 `Session.compress()` 按实际 contextWindow 换算成绝对 token 预算传入。
 */
export const CHAT_RETAIN_RATIO = 0.16;

/** 调用方未传预算时的兜底值（约 20k token） */
const DEFAULT_CHAT_RETAIN_TOKENS = 20_000;

/**
 * 按 token 预算选出需要逐字保留的近期尾部（对齐 DSH 的 `retainTokens` 语义）。
 *
 * - 从尾部向前累计估算 token 直到达到预算（**至少包含最后一条消息**）；
 * - **边界对齐**：起点若落在 `role:"tool"` 上，向前扩展，避免以孤立的 tool 消息开头
 *   （对应的 assistant 必须一起保留，否则 OpenAI API 会 400）。
 *
 * 不强制"保留最后一整轮"：工具密集的长尾会因此超出预算；用户的意图由摘要检查点承载。
 *
 * @returns 保留区在 nonSystemMessages 中的起始下标
 */
export function selectRetainedFromIndex(
  nonSystemMessages: ChatMessage[],
  retainTokens: number
): number {
  const total = nonSystemMessages.length;
  if (total === 0) return 0;

  let used = 0;
  let idx = total;
  for (let i = total - 1; i >= 0; i--) {
    const t = estimateMessagesTokens([nonSystemMessages[i]!]);
    // 第一条总是保留；之后超出预算即停
    if (idx !== total && used + t > retainTokens) break;
    used += t;
    idx = i;
  }

  // 边界对齐：不要以孤立的 tool 消息开头
  while (idx > 0 && nonSystemMessages[idx]!.role === "tool") idx--;

  return idx;
}

/** 轻量 diary 提炼：单轮 user+assistant 交互提炼提示词 */
const DISTILL_TURN_SYSTEM = `You are a conversation diary assistant.
Distill the core of this turn in 1-3 sentences: the user's intent, and the AI's main actions or conclusions.
Requirements: concise and precise; add no prefix (such as "This turn", "Summary:"), just output the content in the user's own language.`;

/**
 * 压缩时蒸馏系统 prompt（模板）。
 * 调用前调用方应注入已知 project 清单到 prompt 末尾。
 */
function buildCompressDistillPrompt(
  knownProjects: string,
  envKeys?: string,
  feedbackKeys?: string
): string {
  const envSection = envKeys
    ? `\n⚠️ The following environment keys already exist in ENV.md — do not output them again:\n${envKeys}`
    : "";
  const fbSection = feedbackKeys
    ? `\n⚠️ The following behavior constraints are already recorded in feedback.md — do not output them again:\n  - ${feedbackKeys}`
    : "";
  return `[⚠️BLOCKED:zh_you_are]。
You are distilling a batch of old conversation messages that were compressed away (they contain user messages and the AI's tool calls / replies).
Extract the points worth writing into the long-term memory of each project.
Focus on: milestone progress, key constraints discovered, non-obvious root causes, and important completed changes.
If the whole batch contains nothing worth recording, output {"projects":[],"notes":[]}.

Write all extracted content in the user's own language.

You must output valid JSON in the following format:
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

⚠️ behavior_corrections constraint: record only cross-project behavior corrections (rules that apply to every project).
Do not record rules that belong to a single project (such as "in tinyclaw do not edit YAML"). Leave the array empty if there is nothing new.

Path format rules (important):
- Local paths: /home/lyy/xxx or ~/xxx (always output the absolute form /home/lyy/xxx)
- Windows MCP paths: F:/Github/xxx etc., output as win:F:/Github/xxx
- SSH remote paths: m1saka.cc:/opt/app etc.
- Analytical content that cannot be attributed to a specific project: set the project field to the literal
  string "分析" — **copy it exactly as written here, do NOT translate it** (the value is matched literally
  by the code that files the note)

${knownProjects}${envSection}${fbSection}

Output JSON only, nothing else. Make sure the JSON is valid (escape quotes and newlines inside strings).`;
}
/** 单轮蒸馏（保留兼容，用于 distillCodeTurnToNotes） */
const CODE_DISTILL_SYSTEM = `[⚠️BLOCKED:zh_you_are]。
Based on the latest turn of a coding session below (user message + AI reply), extract the points worth writing into the project's long-term memory.
Focus on: milestone progress, key constraints discovered, non-obvious root causes, and important completed changes.
If this turn has nothing worth recording (for example small talk, a question, or an unfinished operation), output an empty string (output nothing at all).
If there is content, write 1-5 short lines in the user's own language (phrases are fine), one point per line, output directly without prefixes or headings.
⚠️ Important: each line must start by naming the project path actually modified/involved (an absolute path or the ~/xxx form), for example [~/pin-hunter-bot] or [~/tinyclaw/src].
  - The path must come from files the AI actually touched, or from read_file/exec_shell paths in the reply; never substitute the current working directory (codeWorkdir)
  - If this turn touched several projects, write one line per project, each labeled with its own path
  - If the AI modified no files this turn (analysis/explanation only), label the line with the [分析] prefix instead of a project path
  - Do not treat the workdir as a changed path, and do not omit the real project path
  - Local paths may use the ~/xxx shorthand; SSH remote paths must use the absolute host:/path or user@host:/path form, never ~`;

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

    const lines: string[] = ["Known project slugs (reuse them; do not create new ones):"];
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
  projectSlug?: string
): boolean {
  try {
    let jsonStr = raw.trim();
    // 剥离 markdown code fence(```json ... ```),兼容各种换行格式
    jsonStr = jsonStr.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
    // 若 LLM 没有用 code fence,尝试从第一个 { 开始提取(处理前缀文本)
    if (!jsonStr.startsWith("{") && !jsonStr.startsWith("[")) {
      const firstBrace = jsonStr.indexOf("{");
      const firstBracket = jsonStr.indexOf("[");
      const start = firstBrace >= 0 && (firstBrace < firstBracket || firstBracket < 0) ? firstBrace : firstBracket;
      if (start >= 0) jsonStr = jsonStr.slice(start);
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
          let existing: Record<string, Record<string, string>> = {
            projects: {},
            tools: {},
            services: {},
          };
          try {
            if (existsSync(envPath)) {
              const rawEnv = readFileSync(envPath, "utf-8");
              const me = rawEnv.match(/```json\n([\s\S]*?)\n```/);
              if (me) existing = JSON.parse(me[1]!);
            }
          } catch {
            /* ignore */
          }
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
          console.warn(
            "[distillProjectCompression] ENV.md 写入失败:",
            e instanceof Error ? e.message : e
          );
        }
      }
      // behavior_corrections
      if (data.behavior_corrections && Array.isArray(data.behavior_corrections)) {
        try {
          const fbPath = agentManager.feedbackPath(agentId, "code");
          const existingContents = new Set<string>();
          try {
            if (existsSync(fbPath)) {
              const rawFb = readFileSync(fbPath, "utf-8");
              for (const line of rawFb.split("\n")) {
                const m = line.match(/^- \[[\d-]+\] (.+)$/);
                if (m) existingContents.add(m[1]!.trim());
              }
            }
          } catch {
            /* ignore */
          }
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
          console.warn(
            "[distillProjectCompression] feedback.md 写入失败:",
            e instanceof Error ? e.message : e
          );
        }
      }

      return wroteAny;
    }

    const projects: Array<{ path: string; slug: string }> = data.projects || [];
    const notes: Array<{ project: string; items: string[] }> = data.notes || [];

    if (notes.length === 0) return false;

    const pathToSlug = new Map<string, string>();
    for (const p of projects) {
      const slug = p.slug || pathToProjectSlug(p.path);
      pathToSlug.set(p.path, slug);
    }

    const resolveSlug = (project: string): string | null => {
      // 「无法归到某个项目」的分析类条目：prompt 要求字面输出「分析」，但模型可能译成
      // analysis/general，这里宽容一点，避免落到下面凭空生成一个垃圾项目目录。
      if (/^(分析|analysis|general|misc)$/i.test(project.trim())) return null;
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
        let existing: Record<string, Record<string, string>> = {
          projects: {},
          tools: {},
          services: {},
        };
        try {
          if (existsSync(envPath)) {
            const rawEnv = readFileSync(envPath, "utf-8");
            const me = rawEnv.match(/```json\n([\s\S]*?)\n```/);
            if (me) existing = JSON.parse(me[1]!);
          }
        } catch {
          /* ENV.md 不存在或格式异常,使用空对象 */
        }

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
        const existingContents = new Set<string>();
        try {
          if (existsSync(fbPath)) {
            const rawFb = readFileSync(fbPath, "utf-8");
            for (const line of rawFb.split("\n")) {
              const m = line.match(/^- \[[\d-]+\] (.+)$/);
              if (m) existingContents.add(m[1]!.trim());
            }
          }
        } catch {
          /* feedback.md 不存在或格式异常,使用空集合 */
        }

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
        console.warn(
          "[distillCompression] feedback.md 写入失败:",
          e instanceof Error ? e.message : e
        );
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
  projectSlug: string
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
        .filter(
          (d) =>
            d.isFile() && d.name.endsWith(".md") && d.name !== "MEMORY.md" && d.name !== "NOTES.md"
        )
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
    const topicSection =
      topicList.length > 0
        ? topicList
            .map((t) => {
              const body = topicContents[t]!;
              const truncated =
                body.length > 3000
                  ? body.slice(0, 3000) + "\n...(截断,完整内容在 topic 文件中)"
                  : body;
              return `### ${t}.md\n\`\`\`\n${truncated}\n\`\`\``;
            })
            .join("\n\n")
        : "(尚无 topic 文件)";

    const memTruncated =
      memoryContent.length > 3000
        ? memoryContent.slice(0, 3000) + "\n...(截断)"
        : memoryContent || "(MEMORY.md 不存在)";

    const curatorPrompt = `[⚠️BLOCKED:zh_you_are]。
You are the memory curator for the project "${projectSlug}". Your job is to maintain the project memory on your own, based on the compressed old conversation messages.

## Current Project Memory

### MEMORY.md (index file; each line is a summary plus a pointer to a topic file)
\`\`\`
${memTruncated}
\`\`\`

### topic files (details)
${topicSection}

## Old Conversation Messages to Distill

Below is the compressed old conversation history (already formatted by turn). Extract the project memory worth keeping:

\`\`\`
${historyText.slice(0, 12000)}
\`\`\`

## Your Task

Update the project memory based on these messages. You may:
- Add / modify / delete / merge summary lines in MEMORY.md (keep the date-partition format)
- Add / rewrite / remove content in topic files
- Create new topic files (for a new subject area, such as dedicated documentation for an important module)
- Delete outdated or already-resolved entries
- Merge duplicate or similar entries
- Reorganize the memory structure
- If no change is needed, output an empty files object

**Important constraints:**
- Every file value you output must be the **complete new content** of that file (not a diff)
- Files that need no change must not appear in files
- Keep MEMORY.md lightweight (each summary line ≤ 150 characters); put details in topic files
- Continue the existing date-partition format; do not perform aggressive restructuring
- Do not delete or rewrite existing correct information; make incremental updates only
- **MEMORY.md entry format**: partitions by date (\`### YYYY-MM-DD\`), and under each partition the entry format is \`- [type] [s:N] summary\`, with topic references indented on the next line as \`  → topic.md\`
  - s is stability (1-10); it controls how long the memory survives in the prompt
  - s:9-10 = permanent constraints / hard rules ("never kill a process on your own")
  - s:7-8 = long-lived architectural understanding / core facts
  - s:5-6 = current matter / medium stability
  - s:3-4 = temporary information / fast-changing progress
  - s:1-2 = short-term active / about to become outdated
  - When the same fact appears several times, raise its s value (reinforcement mechanism)
  - If an existing entry still needs high stability, keep its higher s value

You must output valid JSON in the following format:
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
Write all file contents in the user's own language.
Output JSON only, nothing else.`;

    // 4. 调用 summarizer LLM
    const client = llmRegistry.get("summarizer");
    const result = await client.chat([{ role: "user", content: curatorPrompt }], {
      isUserInitiated: false,
    });
    recordSummarizerTokens(result, client);

    const raw = result.content.trim();
    if (!raw || raw === '{"files":{}}') return;

    // 5. 解析输出并写入文件
    const wrote = parseAndWriteDistillJson(raw, agentId, new Set(), projectSlug);
    if (wrote) {
      // 同时处理 env_updates / behavior_corrections (parseAndWriteDistillJson 内部处理)
      import("../memory/qmd.js")
        .then(({ updateStore }) => {
          updateStore("code_notes", agentId).catch(() =>
            console.warn("[distillProjectCompression] code_notes index update failed:")
          );
        })
        .catch(() => {});
    }
  } catch (e) {
    console.warn("[distillProjectCompression] 蒸馏失败:", e instanceof Error ? e.message : e);
  }
}

/**
 * 压缩时蒸馏：将待压缩的旧消息批量提炼为多项目要点。
 * fire-and-forget，失败时只打 warn 日志。
 */
async function distillCompressionNotes(toSummarize: ChatMessage[], agentId: string): Promise<void> {
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
    const result = await client.chat(
      [
        { role: "system", content: prompt },
        { role: "user", content: historyText.slice(0, 20000) },
      ],
      { isUserInitiated: false }
    );

    recordSummarizerTokens(result, client);

    const raw = result.content.trim();
    if (!raw || raw === '{"projects":[],"notes":[]}') return;

    const wrote = parseAndWriteDistillJson(raw, agentId, knownSlugs);
    if (wrote) {
      import("../memory/qmd.js")
        .then(({ updateStore }) => {
          updateStore("code_notes", agentId).catch((e) =>
            console.warn("[distillCompression] code_notes index update failed:", e)
          );
          updateStore("code_sessions", agentId).catch((e) =>
            console.warn("[distillCompression] code_sessions index update failed:", e)
          );
        })
        .catch(() => {});
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
  turnMessages?: ChatMessage[]
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

  const result = await client.chat(
    [
      { role: "system", content: CODE_DISTILL_SYSTEM },
      { role: "user", content: turnText.slice(0, 10000) },
    ],
    { isUserInitiated: false }
  );

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

    // 1. 写到 projects/slug/NOTES.md（按项目归档）
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

  const result = await client.chat(
    [
      { role: "system", content: DISTILL_TURN_SYSTEM },
      { role: "user", content: turnText.slice(0, 4000) },
    ],
    { isUserInitiated: false }
  );

  recordSummarizerTokens(result, client);
  if (result.content.trim()) {
    await persistSummary(result.content.trim(), agentId);
  }
}

/**
 * 将对话历史压缩：
 * 1. 存档到 QMD
 * 2. 用 summarizer LLM 生成结构化检查点
 * 3. 返回 system + 检查点 + **按 token 预算**逐字保留的近期尾部
 *
 * @param retainTokens 逐字保留的近期尾部 token 预算（默认 DEFAULT_CHAT_RETAIN_TOKENS）
 */
export async function summarizeAndCompress(
  messages: ChatMessage[],
  agentId = "default",
  retainTokens = DEFAULT_CHAT_RETAIN_TOKENS
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
    const isMain = !c.startsWith("##") && !c.startsWith("<!-- memory:"); // 主 prompt 或 skill-reminder
    const isMarked = c.startsWith("<!-- memory:"); // 新格式记忆注入
    return isMain || isMarked;
  });
  const nonSystemMessages = messages.filter((m) => m.role !== "system");

  // 按 token 预算选取逐字保留的近期尾部（边界对齐 + 至少保留最后一轮），
  // 替代旧的"保留最近 N 轮"——后者在一轮里塞入大工具结果时仍会超预算。
  const keepFromIdx = selectRetainedFromIndex(nonSystemMessages, retainTokens);

  const toSummarize = nonSystemMessages.slice(0, keepFromIdx);
  const toKeep = nonSystemMessages.slice(keepFromIdx);

  // 如果没有足够旧的内容可压缩，直接返回原始消息
  if (toSummarize.length === 0) {
    return messages;
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

  const result = await client.chat(
    [
      { role: "system", content: SUMMARIZE_SYSTEM },
      { role: "user", content: historyText },
    ],
    { isUserInitiated: false }
  );

  recordSummarizerTokens(result, client);
  // 将摘要持久化到 QMD
  await persistSummary(result.content, agentId);

  const compressed: ChatMessage[] = [
    ...systemMessages,
    {
      role: "assistant",
      content: `[对话历史摘要]\n<compacted-summary>\n${result.content}\n</compacted-summary>`,
    },
    ...toKeep,
  ];

  // ── Chat 蒸馏:fire-and-forget 提炼 cards + 更新 MEM.md ──
  if (agentId && toSummarize.length > 0) {
    distillChatCompression(toSummarize as ChatMessage[], agentId).catch((err) =>
      console.warn(
        "[summarizeAndCompress] chat 蒸馏失败:",
        err instanceof Error ? err.message : err
      )
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
        sections.push({
          heading: currentHeading,
          count: currentItems.length,
          samples: currentItems.slice(0, 3),
        });
      }
      currentHeading = line.slice(3).trim();
      currentItems = [];
    } else if (line.startsWith("- ") && currentHeading) {
      const text = line.slice(2).trim();
      if (text && !text.startsWith("[")) currentItems.push(text.slice(0, 80));
    }
  }
  if (currentHeading && currentItems.length > 0) {
    sections.push({
      heading: currentHeading,
      count: currentItems.length,
      samples: currentItems.slice(0, 3),
    });
  }

  if (sections.length === 0) return "(MEM.md 为空)";

  return (
    sections
      .map((s) => {
        const sampleStr =
          s.samples.length > 0 ? `\n  示例: ${s.samples.map((x) => `"${x}"`).join("; ")}` : "";
        return `- ${s.heading}: ${s.count} 条${sampleStr}`;
      })
      .join("\n") + `\n(共 ${sections.reduce((a, s) => a + s.count, 0)} 条)`
  );
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
        sections.push({
          heading: currentHeading,
          count: currentItems.length,
          samples: currentItems.slice(0, 3),
        });
      }
      currentHeading = line.slice(3).trim();
      currentItems = [];
    } else if (line.startsWith("- ") && currentHeading) {
      const text = line.slice(2).trim();
      if (text && !text.startsWith("[")) currentItems.push(text.slice(0, 80));
    }
  }
  if (currentHeading && currentItems.length > 0) {
    sections.push({
      heading: currentHeading,
      count: currentItems.length,
      samples: currentItems.slice(0, 3),
    });
  }

  if (sections.length === 0) return "(ACTIVE.md 为空)";

  return (
    sections
      .map((s) => {
        const sampleStr =
          s.samples.length > 0 ? `\n  示例: ${s.samples.map((x) => `"${x}"`).join("; ")}` : "";
        return `- ${s.heading}: ${s.count} 条${sampleStr}`;
      })
      .join("\n") + `\n(共 ${sections.reduce((a, s) => a + s.count, 0)} 条)`
  );
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
You are a conversation memory extraction assistant.
From the compressed old conversation history, extract the new content worth writing into persistent memory.

The current MEM.md already contains:
{{mem_summary}}

The current Cards already contain:
{{card_inventory}}

Your task:
1. Check whether the conversation introduced new preferences / constraints / decisions / routines / open loops / trackable items
2. **Output only genuinely new content** (not already present in MEM.md or Cards)
3. If the conversation contains a semantically identical but more precise version, overwrite with the new version (deduplicated via supersedes)
4. If there is nothing new, output {"cards":[],"mem_updates":{}}

Write everything you output in the user's own language.

Card output format (MemoryCard JSON):
- type: preference/constraint/decision/routine/open_loop/life_event/project_fact/relationship/task_state
- scope: scope (general/project:stock/project:tinyclaw etc.)
- facet: classification dimension (cards of the same kind merge into the same facet)
- importance: 0-1 importance (also controls how long the memory survives; see the guidance below)
- title: short title (≤30 characters)
- summary: full description (1-3 sentences)
- supersedes: array of old card ids to replace (optional)
- Do not set id/ts/status (generated automatically by the system)

importance guidance (controls how long the memory is retained):
- 0.8-1.0: core preferences / hard constraints (such as "never sudo rm"), half-life 180 days, practically never expires
- 0.5-0.7: important habits / decisions / facts, half-life 60-90 days, fades naturally after months
- 0.3-0.4: ordinary matters / temporary memory, half-life 14-45 days, fades after a few weeks
- 0.1-0.2: short-term active information, expires quickly
⚠️ When the same fact appears several times (for example the user restates a preference), raise its importance step by step (reinforcement mechanism)

MEM.md update format (by section):
{
  "mem_updates": {
    "👤 用户偏好": ["- 新偏好1", "- 新偏好2"],
    "🐛 踩坑记录": ["- 新踩坑描述"],
    "🎯 当前任务": ["- 新任务"],
    "✅ 已完成大事": ["- 已完成事项"],
    "📅 近期变更": ["- [日期] 变更描述"]
  }
}
Keep the section keys exactly as given above (they are the actual MEM.md section headings).
Each item must start with "- ", consistent with the existing MEM.md format.

⚠️ Card deduplication rules:
- preference/constraint cards with the same facet + the same scope count as duplicates; do not output them twice
- Cards with identical or highly similar titles count as duplicates
- If an old card needs updating (a more precise wording), reference the old card id in supersedes

⚠️ MEM.md deduplication rules:
- If a new entry is semantically identical to an existing one (just rephrased), do not output it
- If a new entry is a refined version of an existing one, it may still be output (the program merges it)

Output valid JSON only, nothing else.`;

/**
 * 应用 MEM.md 章节补丁:对每个章节执行 append 模式,带基本去重。
 */
function applyMemPatches(memUpdates: Record<string, string[]>, agentId: string): number {
  const memPath = agentManager.memPath(agentId);
  let applied = 0;

  // 读取当前 MEM.md 用于去重
  let existingContent = "";
  const existingLines = new Set<string>();
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
  } catch {
    /* 忽略 */
  }

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
        if (
          existing.includes(normalized.slice(0, 30)) ||
          normalized.includes(existing.slice(0, 30))
        ) {
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

    // 按时间衰减分数排序,取 Top-N(默认 50,可通过 config 调整)
    const cfg = loadConfig();
    const maxCards = cfg.memory.cardInjectionMax ?? 50;
    const now = new Date();
    const topCards = sortCardsByScore(active, maxCards, 0.15, now);

    // 按 type 分组(topCards 已按 score 排序)
    const byType = new Map<string, typeof topCards>();
    for (const c of topCards) {
      const list = byType.get(c.type) || [];
      list.push(c);
      byType.set(c.type, list);
    }

    // 生成索引条目
    const indexLines: string[] = [];

    // preference: 合并同类 facet
    const prefs = byType.get("preference") || [];
    if (prefs.length > 0) {
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

    // constraint: 单独列出
    const constraints = byType.get("constraint") || [];
    for (const c of constraints) {
      const path = `${c.ts.slice(0, 7)}/${c.id}.md`;
      indexLines.push(`- **${c.title.slice(0, 50)}** → cards/${path}`);
    }

    // decision
    for (const c of byType.get("decision") || []) {
      const path = `${c.ts.slice(0, 7)}/${c.id}.md`;
      indexLines.push(`- **${c.title.slice(0, 50)}** → cards/${path}`);
    }

    // open_loop
    for (const c of byType.get("open_loop") || []) {
      const path = `${c.ts.slice(0, 7)}/${c.id}.md`;
      indexLines.push(`- **${c.title.slice(0, 50)}** → cards/${path}`);
    }

    // routine: 合并摘要
    const routines = byType.get("routine") || [];
    if (routines.length > 0) {
      const titles = routines.map((c) => c.title.slice(0, 30)).join("; ");
      indexLines.push(`- 例行: ${titles}`);
    }

    // 其他类型
    const otherTypes = ["relationship", "life_event", "project_fact", "task_state"];
    const otherCards: MemoryCard[] = [];
    for (const t of otherTypes) {
      const items = byType.get(t);
      if (items) otherCards.push(...items);
    }
    for (const c of otherCards) {
      const path = `${c.ts.slice(0, 7)}/${c.id}.md`;
      indexLines.push(`- **${c.title.slice(0, 50)}** → cards/${path}`);
    }

    // 被截断的卡片数
    const truncated = active.length - topCards.length;

    const indexContent = indexLines.join("\n");
    upsertMemSection(
      agentManager.memPath(agentId),
      "🗂️ 记忆卡片索引",
      indexContent,
      "upsert",
      agentId
    );
    console.log(
      `[distillChat] 卡片索引已刷新: ${active.length} active → ${indexLines.length} 条目` +
        (truncated > 0 ? ` (${truncated} 条低分卡片未注入,可通过 memory_search 检索)` : "")
    );
  } catch (e) {
    console.warn("[distillChat] 卡片索引生成失败:", e);
  }
}

/**
 * 压缩时蒸馏:将待压缩的旧消息提炼为 chat cards + MEM.md 章节更新。
 * fire-and-forget,失败时只打 warn 日志。
 */
async function distillChatCompression(toSummarize: ChatMessage[], agentId: string): Promise<void> {
  if (toSummarize.length === 0) return;

  try {
    const historyText = toSummarize
      .map((m) => formatMsgForSummary(m))
      .filter(Boolean)
      .join("\n\n");

    if (!historyText.trim()) return;

    const memSummary = summarizeMemSections(agentId);
    const cardInventory = summarizeCardInventory(agentId);

    const prompt = CHAT_DISTILL_PROMPT.replace("{{mem_summary}}", memSummary).replace(
      "{{card_inventory}}",
      cardInventory
    );

    const client = llmRegistry.get("summarizer");
    const result = await client.chat(
      [
        { role: "system", content: prompt },
        { role: "user", content: historyText.slice(0, 15000) },
      ],
      { isUserInitiated: false }
    );

    recordSummarizerTokens(result, client);
    const raw = result.content.trim();
    if (!raw || raw === '{"cards":[],"mem_updates":{}}') return;

    // 解析 JSON
    let data: { cards?: unknown[]; mem_updates?: Record<string, string[]> };
    try {
      let jsonStr = raw;
      // 剥离 markdown code fence,兼容各种换行格式
      jsonStr = jsonStr.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "");
      // 若 LLM 没有用 code fence,尝试从第一个 { 开始提取
      if (!jsonStr.startsWith("{") && !jsonStr.startsWith("[")) {
        const firstBrace = jsonStr.indexOf("{");
        const firstBracket = jsonStr.indexOf("[");
        const start =
          firstBrace >= 0 && (firstBrace < firstBracket || firstBracket < 0)
            ? firstBrace
            : firstBracket;
        if (start >= 0) jsonStr = jsonStr.slice(start);
      }
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
      import("../memory/qmd.js")
        .then(({ updateStore }) => {
          updateStore("cards", agentId).catch((e) =>
            console.warn("[distillChat] cards index update failed:", e)
          );
          updateStore("memory", agentId).catch((e) =>
            console.warn("[distillChat] memory index update failed:", e)
          );
        })
        .catch(() => {});
    }
  } catch (e) {
    console.warn("[distillChat] 蒸馏失败:", e instanceof Error ? e.message : e);
  }
}