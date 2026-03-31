/**
 * feedback-writer — 向 feedback.md 追加一条用户反馈记录
 *
 * chat 模式：~/.tinyclaw/agents/<id>/feedback.md
 * code 模式：~/.tinyclaw/agents/<id>/code/feedback.md
 *
 * 格式：`- [YYYY-MM-DD] 反馈内容`
 * 只增不删，跨 session 永久有效。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { agentManager } from "./agent-manager.js";

/**
 * 向对应模式的 feedback.md 追加一条反馈记录。
 * 自动创建父目录，幂等安全（appendFileSync）。
 */
export function appendFeedback(
  agentId: string,
  mode: "chat" | "code",
  content: string,
): void {
  const feedbackPath = agentManager.feedbackPath(agentId, mode);
  fs.mkdirSync(path.dirname(feedbackPath), { recursive: true });

  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const line = `- [${date}] ${content.trim()}\n`;

  fs.appendFileSync(feedbackPath, line, "utf-8");
}

/**
 * 读取指定模式的 feedback.md 内容。
 * 文件不存在时返回 null。
 */
export function readFeedback(
  agentId: string,
  mode: "chat" | "code",
): string | null {
  const feedbackPath = agentManager.feedbackPath(agentId, mode);
  if (!fs.existsSync(feedbackPath)) return null;
  const content = fs.readFileSync(feedbackPath, "utf-8").trim();
  return content.length > 0 ? content : null;
}
