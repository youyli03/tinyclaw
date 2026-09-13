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

/**
 * 估算所需的最小消息形状。
 *
 * 用结构类型而不是 `ChatMessage`：实际传进来的有两份 —— `ChatMessage`（会话内）
 * 与 `LLMChatMessage`（`Session.getMessagesForLLM()` 的产物，assistant 的 content 可选）。
 * 只要字段形状兼容就都收，避免为了类型再复制一遍消息数组。
 */
export interface MessageLike {
  role: string;
  content?: unknown;
  tool_calls?: unknown;
  tool_call_id?: string;
}

/** 估算一条消息的字符数（content + tool_calls） */
export function approxMessageChars(m: MessageLike): number {
  let chars = 0;
  const content = m.content;
  if (typeof content === "string") {
    chars += content.length;
  } else if (Array.isArray(content)) {
    for (const p of content as { text?: string }[]) {
      chars += typeof p.text === "string" ? p.text.length : 200;
    }
  }
  const calls = m.tool_calls;
  if (Array.isArray(calls)) chars += JSON.stringify(calls).length;
  return chars;
}

/** 估算一组消息的 token 数（字符 / 3.5） */
export function estimateMessagesTokens(messages: readonly MessageLike[]): number {
  let chars = 0;
  for (const m of messages) chars += approxMessageChars(m);
  return Math.ceil(chars / 3.5);
}

/** token → 字符（同一口径的逆运算，用于按字符表达预算） */
export function tokensToChars(tokens: number): number {
  return Math.max(0, Math.floor(tokens * 3.5));
}

// ── Token 消耗来源（Dashboard「Token」页的 source 维度）───────────────────────

/**
 * LLM 消耗来源。前六种是**走 ReAct 主循环**的请求（有 prompt 构成可拆），
 * 后两种是**直连 LLM 的独立调用**（只有总量，没有消息构成）：
 * - `summarizer`：压缩成摘要 / 蒸馏（`memory/summarizer.ts`）
 * - `vision`：图片识别（`describeImageWithVisionFallback`）
 */
export type TokenSource =
  | "chat"
  | "code"
  | "cron"
  | "loop"
  | "slave"
  | "skill"
  | "summarizer"
  | "vision";

/** 来源的中文标签（前端展示用；改这里即可） */
export const TOKEN_SOURCE_LABELS: Record<TokenSource, string> = {
  chat: "对话",
  code: "Code 模式",
  cron: "定时任务",
  loop: "Loop 触发",
  slave: "子 Agent",
  skill: "Skill 子 Agent",
  summarizer: "压缩/蒸馏",
  vision: "图片识别",
};

/**
 * 判定一次 LLM 调用属于哪个来源。
 *
 * 判定依据（顺序有意为之）：
 *  - sessionId 前缀：`cron:`（含 pipeline 的 msg step）、`slave:`（agent_fork）、`skill:`（skill_run）
 *  - `origin`：loop 触发**复用绑定会话的 id**（没有专属前缀），只能靠 `AgentRunOptions.origin === "loop"` 区分；
 *    cron runner 也会传 `origin: "cron"`，与前缀双保险
 *  - 都没有则按模式兜底：code 模式 → `code`，其余 → `chat`
 *
 * ⚠️ 顺序：前缀优先于 origin（cron 里 fork 出来的 `slave:` 会话应记成子 Agent，而不是 cron）。
 */
export function classifyTokenSource(args: {
  sessionId: string;
  mode?: "chat" | "code";
  origin?: string;
}): TokenSource {
  const { sessionId, mode, origin } = args;
  if (sessionId.startsWith("cron:")) return "cron";
  if (sessionId.startsWith("slave:")) return "slave";
  if (sessionId.startsWith("skill:")) return "skill";
  if (origin === "loop") return "loop";
  if (origin === "cron") return "cron";
  if (mode === "code") return "code";
  return "chat";
}

// ── Prompt 构成细分（Dashboard「Token」页用）──────────────────────────────────
//
// ⚠️ 纪律（对齐 DSH `dsh-token-meter`）：这里的数字是**近似构成**，不是计费数据。
// 总量必须用提供方报告的 `prompt_tokens`；构成只回答"钱大概花在哪一类"。
// 分类判定只用**已存在的 marker**（不改协议、不给模型加可见内容）。

/** Prompt 构成分类 */
export type TokenCategory =
  | "system" // system 消息：内置 prompt / 技能提醒 / 格式纠错 / 压缩提示
  | "instructions" // 工作区指令注入（AGENTS.md / CLAUDE.md，user 角色）
  | "memory" // 记忆与上下文注入（<!-- memory: --> / <!-- injected: -->）
  | "summary" // 压缩摘要（历史摘要 checkpoint）
  | "tools_schema" // 工具定义本身（tools 数组的 JSON）
  | "tool_results" // 工具返回内容（role=tool）
  | "conversation"; // 其余 user/assistant 正文与 tool_calls 参数

/** 分类的中文标签（Dashboard 展示；改这里即可，前端不再各写一份） */
export const TOKEN_CATEGORY_LABELS: Record<TokenCategory, string> = {
  system: "系统提示",
  instructions: "工作区指令",
  memory: "记忆注入",
  summary: "压缩摘要",
  tools_schema: "工具定义",
  tool_results: "工具结果",
  conversation: "对话正文",
};

export interface TokenCategoryStat {
  category: TokenCategory;
  label: string;
  /** 估算 token（chars / 3.5） */
  tokens: number;
  chars: number;
  /** 该类包含多少条消息（tools_schema 恒为 1） */
  count: number;
}

export interface TokenTopItem {
  category: TokenCategory;
  label: string;
  /** 消息角色（tool_results / conversation / system …）或 "tools" */
  role: string;
  /** 归属工具名（仅 role=tool 且能从 tool_calls 反查到时） */
  tool?: string;
  /** 内容预览（前 80 字符，单行） */
  preview: string;
  tokens: number;
}

export interface TokenToolStat {
  name: string;
  tokens: number;
  /** 该工具结果条数 */
  calls: number;
}

export interface TokenBreakdown {
  /** 各分类合计（按 tokens 降序；每类各自取整） */
  items: TokenCategoryStat[];
  /** 单条消息消耗排行（按 tokens 降序，最多 topN） */
  top: TokenTopItem[];
  /** 工具归因排行（按 tokens 降序） */
  tools: TokenToolStat[];
  /** 构成合计 = `items` 求和（UI 里环形图/明细表加起来必须等于它） */
  estimatedTotal: number;
  /** 全仓口径的消息总量（chars/3.5 **一次取整**，与 `estimateMessagesTokens()` 相等） */
  messageTokens: number;
}

const WORKSPACE_MARKER = "<!-- workspace-instructions:";
const MEMORY_MARKERS = ["<!-- memory:", "<!-- injected:"];
const SUMMARY_MARKERS = ["[对话历史摘要]", "[编码会话历史摘要]"];

/** content 的纯文本形态（数组内容取 text 部分；不足 200 字符的图片/文件块按 200 计） */
function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const p of content as { type?: string; text?: string }[]) {
      if (typeof p.text === "string") parts.push(p.text);
      else if (p.type === "image_url" || p.type === "image") parts.push(" ".repeat(200));
      else if (p.type === "file") parts.push(" ".repeat(200));
    }
    return parts.join("\n");
  }
  return "";
}

/**
 * 单条消息的分类。
 *
 * ⚠️ 判定顺序有意为之：
 *  1. `role=tool` 先判 → 工具输出即使正文里恰好含 marker，也算工具结果（不回标成注入）；
 *  2. 再按 marker 判 注入类（工作区指令 / 记忆 / 摘要）——**先于 `role=system`**：
 *     压缩摘要在 chat/code 里是 assistant 消息（`summarizer.ts`），但别的路径可能用 system 注入，
 *     若让 system 优先，"压缩摘要"这一类就永远是空的；
 *  3. 最后才按角色兜底（system / conversation）。
 */
export function classifyMessage(m: MessageLike): TokenCategory {
  if (m.role === "tool") return "tool_results";
  const text = textOfContent(m.content);
  if (text.startsWith(WORKSPACE_MARKER)) return "instructions";
  if (MEMORY_MARKERS.some((p) => text.startsWith(p))) return "memory";
  if (SUMMARY_MARKERS.some((p) => text.includes(p))) return "summary";
  if (m.role === "system") return "system";
  return "conversation";
}

/** 预览：压缩空白、截断到 80 字符 */
function preview(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 80 ? `${flat.slice(0, 80)}…` : flat;
}

/**
 * 把一次请求的 messages（+ tools）拆成构成明细。
 *
 * 复杂度 O(messages + tools JSON)；每轮调用一次，纯计算、不做 IO。
 *
 * @param messages 发给模型的消息（`Session.getMessagesForLLM()` 的结果）
 * @param tools    本次请求的工具 schema 数组；不传则 tools_schema 一类省略
 * @param opts.topN 单条排行取前多少名，默认 10
 */
export function breakdownMessages(
  messages: readonly MessageLike[],
  tools?: readonly unknown[],
  opts: { topN?: number } = {}
): TokenBreakdown {
  const topN = opts.topN ?? 10;
  const acc = new Map<TokenCategory, TokenCategoryStat>();
  const bump = (category: TokenCategory, chars: number): void => {
    const cur = acc.get(category) ?? {
      category,
      label: TOKEN_CATEGORY_LABELS[category],
      tokens: 0,
      chars: 0,
      count: 0,
    };
    cur.chars += chars;
    cur.count += 1;
    acc.set(category, cur);
  };

  // tool_call_id → 工具名（用于把 role=tool 的结果归到具体工具）
  const callNames = new Map<string, string>();
  for (const m of messages) {
    const calls = (m as { tool_calls?: Array<{ id?: string; function?: { name?: string } }> })
      .tool_calls;
    if (!Array.isArray(calls)) continue;
    for (const c of calls) {
      if (c?.id && c.function?.name) callNames.set(c.id, c.function.name);
    }
  }

  const topCandidates: TokenTopItem[] = [];
  const toolAcc = new Map<string, TokenToolStat>();
  let messageChars = 0;

  for (const m of messages) {
    const chars = approxMessageChars(m);
    messageChars += chars;
    const category = classifyMessage(m);
    bump(category, chars);
    const text = textOfContent((m as { content?: unknown }).content);
    const callId = (m as { tool_call_id?: string }).tool_call_id;
    const toolName = category === "tool_results" && callId ? callNames.get(callId) : undefined;
    if (category === "tool_results") {
      const name = toolName ?? "(未知工具)";
      const cur = toolAcc.get(name) ?? { name, tokens: 0, calls: 0 };
      cur.tokens += Math.ceil(chars / 3.5);
      cur.calls += 1;
      toolAcc.set(name, cur);
    }
    topCandidates.push({
      category,
      label: TOKEN_CATEGORY_LABELS[category],
      role: m.role,
      ...(toolName ? { tool: toolName } : {}),
      preview: preview(text) || (m.role === "assistant" ? "(仅 tool_calls)" : ""),
      tokens: Math.ceil(chars / 3.5),
    });
  }

  if (tools && tools.length > 0) {
    const chars = JSON.stringify(tools).length;
    const tokens = Math.ceil(chars / 3.5);
    acc.set("tools_schema", {
      category: "tools_schema",
      label: TOKEN_CATEGORY_LABELS.tools_schema,
      tokens,
      chars,
      count: 1,
    });
    topCandidates.push({
      category: "tools_schema",
      label: TOKEN_CATEGORY_LABELS.tools_schema,
      role: "tools",
      preview: `${tools.length} 个工具定义`,
      tokens,
    });
  }

  const items = [...acc.values()]
    .map((s) => ({ ...s, tokens: Math.ceil(s.chars / 3.5) }))
    .sort((a, b) => b.tokens - a.tokens);
  const top = topCandidates.sort((a, b) => b.tokens - a.tokens).slice(0, topN);
  const toolsRank = [...toolAcc.values()].sort((a, b) => b.tokens - a.tokens);
  const messageTokens = Math.ceil(messageChars / 3.5);
  // 展示口径：分类各自取整后求和 —— UI 上的环形图/明细表加起来必须等于这个总数
  // （与 `messageTokens` 可能有 小于分类数 的取整差，那是逐项取整的固有偏差，不是 bug）
  const estimatedTotal = items.reduce((s, it) => s + it.tokens, 0);

  return {
    items,
    top,
    tools: toolsRank,
    estimatedTotal,
    messageTokens,
  };
}
