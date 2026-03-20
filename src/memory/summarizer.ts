import { llmRegistry } from "../llm/registry.js";
import { loadConfig } from "../config/loader.js";
import { persistSummary } from "./store.js";
import type { ChatMessage } from "../llm/client.js";

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

/** Code 模式压缩后保留的最近消息数（除 system 以外）*/
const CODE_KEEP_RECENT_MESSAGES = 8;

/**
 * 检查当前 messages 的 token 使用率是否超过阈值。
 * 使用简单的字符数估算（1 token ≈ 3 中文字符 / 4 英文字符）。
 */
export function shouldSummarize(messages: ChatMessage[]): boolean {
  const cfg = loadConfig();
  const totalChars = messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
  // 粗估：平均 3.5 字符/token
  const estimatedTokens = Math.ceil(totalChars / 3.5);
  // 优先使用 registry 中的模型上下文窗口（Copilot 后端由模型元数据决定）
  const contextWindow = llmRegistry.getContextWindow("daily");
  const threshold = Math.floor(contextWindow * cfg.memory.tokenThreshold);
  return estimatedTokens >= threshold;
}

/**
 * 检查 code 模式的 messages 是否需要滑动窗口压缩。
 * 阈值为 code 模型上下文窗口的 75%。
 * @param messages 当前 session messages
 * @param contextWindow code 模型的上下文窗口大小（tokens）
 */
export function shouldSummarizeCode(messages: ChatMessage[], contextWindow: number): boolean {
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
  const threshold = Math.floor(contextWindow * CODE_SUMMARIZE_THRESHOLD);
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
  const toKeep = nonSystemMessages.slice(nonSystemMessages.length - keepCount);

  // 如果没有足够旧的内容可压缩，直接返回原始消息
  if (toSummarize.length === 0) {
    return messages;
  }

  // 构建待摘要的历史文本
  const historyText = toSummarize
    .map((m) => {
      const role = m.role === "user" ? "用户" : m.role === "assistant" ? "助手" : "系统";
      const content = typeof m.content === "string" ? m.content : JSON.stringify(m.content);
      // 截断超长的单条消息（避免摘要输入过大）
      const truncated = content.length > 8000 ? content.slice(0, 8000) + "\n[内容过长，已截断]" : content;
      return `[${role}]：${truncated}`;
    })
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
  const historyText = messages
    .filter((m) => m.role !== "system")
    .map((m) => `${m.role === "user" ? "用户" : "助手"}：${m.content}`)
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


