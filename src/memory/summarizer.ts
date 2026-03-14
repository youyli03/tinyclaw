import { llmRegistry } from "../llm/registry.js";
import { loadConfig } from "../config/loader.js";
import { persistMessages } from "./store.js";
import type { ChatMessage } from "../llm/client.js";

const SUMMARIZE_SYSTEM = `你是一个对话摘要助手。
将给定的对话历史压缩为简洁的摘要（不超过 400 token），保留：
- 用户的关键需求、偏好、结论
- 已完成的重要操作及结果
- 未解决的待办事项
使用中文，第三人称描述用户，不要使用"摘要："等前缀，直接输出内容。`;

/**
 * 检查当前 messages 的 token 使用率是否超过阈值。
 * 使用简单的字符数估算（1 token ≈ 3 中文字符 / 4 英文字符）。
 */
export function shouldSummarize(messages: ChatMessage[]): boolean {
  const cfg = loadConfig();
  const totalChars = messages.reduce((sum, m) => sum + m.content.length, 0);
  // 粗估：平均 3.5 字符/token
  const estimatedTokens = Math.ceil(totalChars / 3.5);
  // 优先使用 registry 中的模型上下文窗口（Copilot 后端由模型元数据决定）
  const contextWindow = llmRegistry.getContextWindow("daily");
  const threshold = Math.floor(contextWindow * cfg.memory.tokenThreshold);
  return estimatedTokens >= threshold;
}

/**
 * 将对话历史压缩：
 * 1. 存档到 QMD
 * 2. 用 summarizer LLM 生成摘要
 * 3. 返回只含 system + 摘要消息的新 messages[]，对用户无感
 */
export async function summarizeAndCompress(
  messages: ChatMessage[]
): Promise<ChatMessage[]> {
  // 1. 存档原始对话到 QMD
  await persistMessages(messages);

  // 2. 生成摘要
  const client = llmRegistry.get("summarizer");
  const historyText = messages
    .filter((m) => m.role !== "system")
    .map((m) => `${m.role === "user" ? "用户" : "助手"}：${m.content}`)
    .join("\n\n");

  const result = await client.chat([
    { role: "system", content: SUMMARIZE_SYSTEM },
    { role: "user", content: historyText },
  ]);

  // 3. 保留原始 system message（如有），注入摘要作为新起点
  const systemMessages = messages.filter((m) => m.role === "system");
  const compressed: ChatMessage[] = [
    ...systemMessages,
    {
      role: "assistant",
      content: `[对话历史摘要]\n${result.content}`,
    },
  ];

  return compressed;
}
