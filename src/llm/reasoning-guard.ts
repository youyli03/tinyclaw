/**
 * Reasoning（思考过程）**退化检测** —— 纯函数，便于探针断言。
 *
 * 背景（2026-09-13 实测）：flash 级模型在 340k+ token 的超长会话里，被要求
 * "下载 PDF + 说明"时把输出预算全用在思考里，并退化成同一句短话的无限重复：
 *
 * ```
 * 下载成功（2.2MB，15页）… 好。写。好。发送。好。写回复。好。好。写。好。…
 * ```
 *
 * 最终 `content` 为空 → 主循环把它当成最终回复 → 用户只收到兜底文案 `✅ 已完成`。
 * 检测到退化后的措施见 `core/agent.ts` 的**空回复守卫**（日志点名 + 注入提示重试一次）
 * 与 `main.ts` 的诚实兜底文案。
 */

export interface RepetitionVerdict {
  /** 是否判定为病态重复 */
  degenerate: boolean;
  /** 重复次数最多的那个单元（退化时的元凶） */
  repeatedLine: string;
  /** 该单元出现的次数 */
  repeats: number;
  /** 单元总数 / 去重后的单元数（用于日志观测） */
  units: number;
  uniqueUnits: number;
}

/** 单元最大长度：比它长的"重复"不算病态（长段落重复是另一回事，不做判定） */
const MAX_UNIT_LEN = 24;
/** 触发判定所需的最小重复次数（实测退化样本里同一句出现了上百次，12 是很保守的门槛） */
const MIN_REPEATS = 12;

/**
 * 同一轮 run 里允许为**连续空回复**重试的次数（2026-09-24 起由"只救一次"改为可连续重试）。
 * 实测（金融会话，254k 上下文）一次 run 里会连着空两三轮：第一轮空被救回后模型接着又空，
 * 而"只救一次"会让第二次空正文 + 循环思考直接落库，下一轮当成范例照抄。
 */
export const MAX_EMPTY_REPLY_RETRIES = 3;

/**
 * 把 reasoning 切成"单元"：优先按行；行太长时按中英文句末标点切，
 * 这样 `好。好。好。好。` 这种**同一行内**的重复也能被抓住。
 */
export function splitReasoningUnits(text: string): string[] {
  const units: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.length <= MAX_UNIT_LEN) {
      units.push(line);
      continue;
    }
    for (const part of line.split(/(?<=[。！？!?；;])\s*/)) {
      const p = part.trim();
      if (p && p.length <= MAX_UNIT_LEN) units.push(p);
    }
  }
  return units;
}

/** 检测 reasoning 是否退化成重复（纯函数，无副作用、无 IO） */
export function detectReasoningRepetition(text: string): RepetitionVerdict {
  const units = splitReasoningUnits(text);
  const counts = new Map<string, number>();
  for (const u of units) counts.set(u, (counts.get(u) ?? 0) + 1);
  let repeatedLine = "";
  let repeats = 0;
  for (const [u, c] of counts) {
    if (c > repeats) {
      repeats = c;
      repeatedLine = u;
    }
  }
  return {
    degenerate: repeats >= MIN_REPEATS,
    repeatedLine,
    repeats,
    units: units.length,
    uniqueUnits: counts.size,
  };
}

/** 注入给模型的纠偏提示（英文，见 AGENTS.md §6 语言约定：面向模型的文本用英文） */
export function emptyReplyNudge(kind: "length" | "degenerate" | "silent"): string {
  const head =
    "[empty reply] Your previous turn produced no visible content, so the user saw nothing. ";
  if (kind === "length") {
    return (
      `${head}Its output was cut off by the length limit. Reply now with the final answer only, ` +
      "in a few short sentences; do not restate your plan and do not repeat yourself."
    );
  }
  if (kind === "degenerate") {
    return (
      `${head}Your reasoning looped on the same short phrase instead of writing the answer. ` +
      "Stop planning and answer now: give the user the concrete result in a few short sentences."
    );
  }
  return (
    `${head}Reply now with the concrete result for the user (a few short sentences). ` +
    "If a tool already delivered the result, just say what was delivered."
  );
}

/** 落库前的 reasoning 净化结果 */
export interface StorageReasoning {
  /** 实际落库的值（退化时为截断后的前缀；原文为空时 undefined） */
  value: string | undefined;
  /** 是否检测到重复退化 */
  degenerate: boolean;
  /** 退化时的重复单元（未退化时为空串） */
  repeatedLine: string;
  /** 该单元的重复次数 */
  repeats: number;
}

/**
 * 截到重复单元**第一次**出现为止（至少保留该单元本身，保证结果非空）。
 * 纯函数，便于探针断言。
 */
export function trimAtFirstRepeat(text: string, unit: string): string {
  if (!unit) return text;
  const first = text.indexOf(unit);
  if (first < 0) return text;
  const head = text.slice(0, first + unit.length).trim();
  return head || unit;
}

/**
 * 落库前净化 reasoning：退化 → 只留重复开始前的前缀。
 *
 * ⚠️ **不能整条丢弃**：DeepSeek 思考模式下只要请求带 `tools`，后续所有请求都必须完整回传
 * 历史轮次的 `reasoning_content`，缺失会直接 400（官方《思考模式》文档「工具调用」节）。
 * 所以这里保留"重复开始之前"的合法前缀，而不是删掉整个字段。
 * 纯函数，无副作用、无 IO。
 */
export function sanitizeReasoningForStorage(reasoning: string | undefined): StorageReasoning {
  if (!reasoning || !reasoning.trim()) {
    return { value: undefined, degenerate: false, repeatedLine: "", repeats: 0 };
  }
  const verdict = detectReasoningRepetition(reasoning);
  if (!verdict.degenerate) {
    return { value: reasoning, degenerate: false, repeatedLine: "", repeats: 0 };
  }
  return {
    value: trimAtFirstRepeat(reasoning, verdict.repeatedLine),
    degenerate: true,
    repeatedLine: verdict.repeatedLine,
    repeats: verdict.repeats,
  };
}

/** reasoning 退化被截断后注入的纠偏提示（英文，见 AGENTS.md §6 语言约定：面向模型的文本用英文） */
export function reasoningLoopNudge(): string {
  return (
    "[reasoning loop] Your previous reasoning degenerated into repeating the same short phrase; " +
    "it has been trimmed from the conversation. Do not restate the plan — go straight to the " +
    "concrete next step, or write the final answer now."
  );
}
