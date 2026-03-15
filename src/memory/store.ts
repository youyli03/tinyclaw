import * as fs from "node:fs";
import * as path from "node:path";
import { getDataPath } from "../config/loader.js";
import { updateMemoryIndex } from "./qmd.js";

/**
 * 将压缩摘要追加写入当日的 Markdown 文件，然后异步触发 QMD 增量索引。
 *
 * 文件路径：~/.tinyclaw/memory/YYYY-MM-DD.md
 * 仅在 summarizeAndCompress() 触发时调用，而不是每轮对话都写。
 */
export function persistSummary(summaryText: string): void {
  const memoryDir = getDataPath("memory");
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const filePath = path.join(memoryDir, `${date}.md`);

  const timestamp = new Date().toISOString();
  const chunk = `\n## ${timestamp}\n\n${summaryText}\n`;

  fs.appendFileSync(filePath, chunk, "utf-8");

  // 异步更新索引，不阻塞响应
  updateMemoryIndex().catch((err) => {
    console.error("[memory/store] QMD index update failed:", err);
  });
}
