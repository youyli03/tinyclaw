import * as fs from "node:fs";
import * as path from "node:path";
import { getDataPath } from "../config/loader.js";
import { updateMemoryIndex } from "./qmd.js";
import type { ChatMessage } from "../llm/client.js";

/**
 * 将一轮完整对话（user + assistant）追加写入当日的 Markdown 文件，
 * 然后触发 QMD 增量索引。
 *
 * 文件路径：~/.tinyclaw/memory/sessions/YYYY-MM-DD.md
 */
export async function persistTurn(
  userContent: string,
  assistantContent: string
): Promise<void> {
  const sessionsDir = getDataPath("memory", "sessions");
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const filePath = path.join(sessionsDir, `${date}.md`);

  const timestamp = new Date().toISOString();
  const chunk =
    `\n## ${timestamp}\n\n` +
    `**User:** ${userContent}\n\n` +
    `**Assistant:** ${assistantContent}\n`;

  fs.appendFileSync(filePath, chunk, "utf-8");

  // 异步更新索引，不阻塞响应
  updateMemoryIndex().catch((err) => {
    console.error("[memory/store] QMD index update failed:", err);
  });
}

/**
 * 从 messages 中提取所有 user/assistant 轮次，批量写入（用于摘要后存档）。
 */
export async function persistMessages(messages: ChatMessage[]): Promise<void> {
  const pairs: Array<{ user: string; assistant: string }> = [];
  for (let i = 0; i < messages.length - 1; i++) {
    const cur = messages[i];
    const next = messages[i + 1];
    if (cur?.role === "user" && next?.role === "assistant") {
      pairs.push({ user: cur.content, assistant: next.content });
      i++;
    }
  }

  for (const pair of pairs) {
    await persistTurn(pair.user, pair.assistant);
  }
}
