import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { updateMemoryIndex } from "./qmd.js";

/**
 * 将压缩摘要追加写入对应 Agent 的当日 Markdown 文件，然后异步触发 QMD 增量索引。
 *
 * 文件路径：~/.tinyclaw/agents/<agentId>/memory/YYYY-MM/YYYY-MM-DD.md
 * 同一天多次触发时增量追加到同一文件，仅在 compress() 触发时调用。
 */
export function persistSummary(summaryText: string, agentId = "default"): void {
  const now = new Date();
  const month = now.toISOString().slice(0, 7);  // YYYY-MM
  const date  = now.toISOString().slice(0, 10); // YYYY-MM-DD
  const monthDir = path.join(os.homedir(), ".tinyclaw", "agents", agentId, "memory", month);
  fs.mkdirSync(monthDir, { recursive: true });

  const filePath = path.join(monthDir, `${date}.md`);

  const timestamp = now.toISOString();
  const chunk = `\n## ${timestamp}\n\n${summaryText}\n`;

  fs.appendFileSync(filePath, chunk, "utf-8");

  // 异步更新索引，不阻塞响应
  updateMemoryIndex(agentId).catch((err) => {
    console.error("[memory/store] QMD index update failed:", err);
  });
}
