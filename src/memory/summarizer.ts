import { llmRegistry } from "../llm/registry.js";
import { loadConfig } from "../config/loader.js";
import { persistSummary } from "./store.js";
import type { ChatMessage, OpenAIToolCall } from "../llm/client.js";

const SUMMARIZE_SYSTEM = `你是一个对话摘要助手。
将给定的对话历史压缩为简洁的摘要（不超过 400 token），保留：
- 用户的关键需求、偏好、结论
- 已完成的重要操作及结果
- 未解决的待办事项
使用中文，第三人称描述用户，不要使用"摘要："等前缀，直接输出内容。`;

/** Code 模式专属摘要提示词，重点保留技术上下文 */
const CODE_SUMMARIZE_SYSTEM = `你是一个代码会话摘要助手。
将给定的编码会话历史压缩为技术摘要（不超过 600 token），必须保留以下信息：
- 当前任务目标（用户要求实现/修改/调试什么）
- 已修改或创建的文件列表（含路径）
- 执行过的关键命令及其结果（错误信息尤为重要）
- 当前进度：已完成的步骤、正在进行的步骤
- 待解决的问题、错误或 TODO
- 项目的关键技术信息（语言、框架、依赖等）
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

/** Code 模式压缩后保留的最近消息数（除 system 以外）*/
const CODE_KEEP_RECENT_MESSAGES = 8;

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

  // Fallback：字符数粗估
  const totalChars = messages.reduce((sum, m) => {
    const content = m.content;
    if (typeof content === "string") return sum + content.length;
    if (Array.isArray(content)) {
      return sum + content.reduce((cs, p) => {
        if (typeof p === "object" && p !== null && "text" in p) return cs + String((p as { text: string }).text).length;
        return cs + 200; // 非文本部分（图片等）估算
      }, 0);
    }
    return sum;
  }, 0);
  const estimatedTokens = Math.ceil(totalChars / 3.5);
  return estimatedTokens >= threshold;
}

/**
 * Code 模式滑动窗口压缩：
 * 1. 用 summarizer LLM 对较旧的消息生成代码专属摘要
 * 2. 返回 [system messages..., summary_assistant, 最近 N 条非 system 消息]
 * 与 chat 模式不同：保留最近 CODE_KEEP_RECENT_MESSAGES 条消息保持详细上下文，
 * 只压缩更早的内容，实现滑动窗口效果。
 */
export async function summarizeAndCompressCode(
  messages: ChatMessage[],
): Promise<ChatMessage[]> {
  const client = llmRegistry.get("summarizer");

  // 分离 system 消息和非 system 消息
  const systemMessages = messages.filter((m) => m.role === "system");
  const nonSystemMessages = messages.filter((m) => m.role !== "system");

  // 保留最新的 N 条消息，对更早的部分做摘要
  const keepCount = Math.min(CODE_KEEP_RECENT_MESSAGES, nonSystemMessages.length);
  const toSummarize = nonSystemMessages.slice(0, nonSystemMessages.length - keepCount);
  let toKeep = nonSystemMessages.slice(nonSystemMessages.length - keepCount);

  // 如果没有足够旧的内容可压缩，直接返回原始消息
  if (toSummarize.length === 0) {
    return messages;
  }

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
  ]);

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

/**
 * 将对话历史压缩：
 * 1. 存档到 QMD
 * 2. 用 summarizer LLM 生成摘要
 * 3. 返回只含 system + 摘要消息的新 messages[]，对用户无感
 */
export async function summarizeAndCompress(
  messages: ChatMessage[],
  agentId = "default"
): Promise<ChatMessage[]> {
  // 1. 生成摘要
  const client = llmRegistry.get("summarizer");
  // 使用 formatMsgForSummary 展开 tool_calls，确保工具调用名称/参数进入摘要
  const historyText = messages
    .filter((m) => m.role !== "system")
    .map(formatMsgForSummary)
    .filter(Boolean)
    .join("\n\n");

  const result = await client.chat([
    { role: "system", content: SUMMARIZE_SYSTEM },
    { role: "user", content: historyText },
  ]);

  // 2. 将摘要持久化到 QMD（仅摘要内容，不再逐轮写入）
  persistSummary(result.content);

  // 3. 保留永久性 system messages（BUILTIN_SYSTEM、SYSTEM.md），
  //    过滤掉 QMD 召回注入的临时 system messages
  const systemMessages = messages.filter(
    (m) => m.role === "system" && (typeof m.content === "string" ? !m.content.startsWith("## 相关历史记忆") : true)
  );
  const compressed: ChatMessage[] = [
    ...systemMessages,
    {
      role: "assistant",
      content: `[对话历史摘要]\n${result.content}`,
    },
  ];

  return compressed;
}


