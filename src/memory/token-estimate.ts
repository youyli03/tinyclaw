/**
 * Token 估算 —— 全仓统一口径
 *
 * 为什么单独成一个模块：原先 `memory/summarizer.ts` 里有一份私有实现，
 * 现在 `core/slave-manager.ts` 的继承预算也要用同一口径。
 * 两处各写一份必然漂移（压缩阈值与继承预算对不上），故提取为唯一实现。
 *
 * 口径：字符数 / 3.5（中文为主的会话经验值），并计入 `tool_calls` 的 JSON 长度。
 * 这是**估算**，不是 tokenizer；用途是比较与预算，不是精确计费。
 */

import type { ChatMessage } from "../llm/client.js";

/** 估算一条消息的字符数（content + tool_calls） */
export function approxMessageChars(m: ChatMessage): number {
  let chars = 0;
  const content = (m as { content?: unknown }).content;
  if (typeof content === "string") {
    chars += content.length;
  } else if (Array.isArray(content)) {
    for (const p of content as { text?: string }[]) {
      chars += typeof p.text === "string" ? p.text.length : 200;
    }
  }
  const calls = (m as { tool_calls?: unknown[] }).tool_calls;
  if (Array.isArray(calls)) chars += JSON.stringify(calls).length;
  return chars;
}

/** 估算一组消息的 token 数（字符 / 3.5） */
export function estimateMessagesTokens(messages: ChatMessage[]): number {
  let chars = 0;
  for (const m of messages) chars += approxMessageChars(m);
  return Math.ceil(chars / 3.5);
}

/** token → 字符（同一口径的逆运算，用于按字符表达预算） */
export function tokensToChars(tokens: number): number {
  return Math.max(0, Math.floor(tokens * 3.5));
}
