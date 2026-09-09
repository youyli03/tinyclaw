/**
 * 工具结果剪枝（cache 友好版）
 *
 * 参考 DSH `@deepseek-ai/dsh-compaction-tool-result-pruner`：
 *  1. **不调用模型**：纯语法保留头部 + 固定标记 + 尾部；
 *  2. **有界且幂等**：输出长度严格小于输入，且已含标记的结果不再处理 → 第二次扫描不会改写；
 *  3. **只在 token 压力触发时执行**（由调用方判断），不是每轮都剪。
 *
 * 与已废弃的 microCompact 的区别：旧版在 0.45 阈值每轮触发、反复原地改写头部历史，
 * 前缀缓存每次全失效（见 agent.ts 中的禁用说明）；本版把"改写前缀"收敛成
 * 一次性的、有界的动作。
 *
 * 对 KV cache 的影响：替换较早的工具结果会使从第一个改变的 token 起的复用失效，
 * 该位置之前的前缀仍可复用——因此只在压力触发时做一次。
 */

import type { ChatMessage } from "../llm/client.js";

/** 被剪掉的中段替换成的固定标记 */
export const PRUNE_MARKER = "\n\n[... 工具结果中间部分已剪枝 ...]\n\n";

export interface PruneOptions {
  /** 超过该字符数的工具结果才剪枝 */
  thresholdChars: number;
  /** 保留的头部字符数 */
  headChars: number;
  /** 保留的尾部字符数 */
  tailChars: number;
}

/** 默认参数（对齐 DSH 的 thresholdChars/headChars/tailChars 默认值） */
export const DEFAULT_PRUNE_OPTIONS: PruneOptions = {
  thresholdChars: 8192,
  headChars: 4096,
  tailChars: 1024,
};

/**
 * 剪枝单段文本。
 * @returns 剪枝后的文本；不需要剪（未超阈值 / 已剪过 / 剪了不会更短）时返回 null
 */
export function pruneText(text: string, opts: PruneOptions = DEFAULT_PRUNE_OPTIONS): string | null {
  if (text.length <= opts.thresholdChars) return null;
  if (text.includes(PRUNE_MARKER)) return null; // 幂等：已剪过
  const head = text.slice(0, opts.headChars);
  const tail = opts.tailChars > 0 ? text.slice(text.length - opts.tailChars) : "";
  const pruned = head + PRUNE_MARKER + tail;
  // 必须严格更短，否则不替换（保证不会越剪越大 / 反复触发）
  return pruned.length < text.length ? pruned : null;
}

export interface PruneResult {
  /** 剪枝后的消息数组（无改动时返回原数组） */
  messages: ChatMessage[];
  /** 被剪枝的消息条数 */
  prunedCount: number;
  /** 节省的字符数 */
  savedChars: number;
}

/**
 * 剪枝历史中所有超阈值的 `role: "tool"` 消息。
 * 只处理 content 为字符串的工具结果；assistant / user 消息不受影响。
 */
export function pruneToolResults(
  messages: ChatMessage[],
  opts: PruneOptions = DEFAULT_PRUNE_OPTIONS
): PruneResult {
  let prunedCount = 0;
  let savedChars = 0;
  const out = messages.map((m) => {
    if (m.role !== "tool" || typeof m.content !== "string") return m;
    const pruned = pruneText(m.content, opts);
    if (pruned === null) return m;
    prunedCount++;
    savedChars += m.content.length - pruned.length;
    return { ...m, content: pruned };
  });
  return prunedCount > 0 ? { messages: out, prunedCount, savedChars } : { messages, prunedCount: 0, savedChars: 0 };
}
