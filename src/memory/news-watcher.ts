/**
 * news-watcher.ts
 *
 * 监听 ~/.tinyclaw/news/.update-pending 标记文件。
 * 当 news MCP server（fetch_and_store）写入标记后，立即触发增量索引，
 * 替代之前在 search_store 工具里懒触发的逻辑。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const NEWS_DIR = path.join(os.homedir(), ".tinyclaw", "news");
const PENDING_MARKER = path.join(NEWS_DIR, ".update-pending");

let watcher: fs.FSWatcher | null = null;

/**
 * 处理 .update-pending 标记文件：读取内容、触发索引、删除标记。
 */
async function flushPending(agentId: string): Promise<void> {
  if (!fs.existsSync(PENDING_MARKER)) return;

  let names: string[] = [];
  try {
    const content = fs.readFileSync(PENDING_MARKER, "utf-8").trim();
    names = content.split(",").map((s) => s.trim()).filter(Boolean);
  } catch { /* ignore */ }

  if (names.length === 0) names = ["news"];

  try {
    fs.unlinkSync(PENDING_MARKER);
  } catch { /* ignore */ }

  const { updateStore } = await import("./qmd.js");
  for (const name of names) {
    try {
      console.log(`[news-watcher] 触发增量索引: ${name}`);
      await updateStore(name, agentId);
      console.log(`[news-watcher] 索引完成: ${name}`);
    } catch (e) {
      console.warn(`[news-watcher] updateStore(${name}) 失败:`, e);
    }
  }
}

/**
 * 启动 news 目录 watcher。
 * 主进程启动时调用一次即可。
 */
export function startNewsWatcher(agentId = "default"): void {
  // 确保 news 目录存在
  try {
    fs.mkdirSync(NEWS_DIR, { recursive: true });
  } catch { /* ignore */ }

  // 启动时处理残留标记（上次未处理的）
  flushPending(agentId).catch((e) =>
    console.warn("[news-watcher] 启动时 flush 失败:", e)
  );

  if (watcher) return; // 已启动

  watcher = fs.watch(NEWS_DIR, (eventType, filename) => {
    if (filename === ".update-pending" && eventType === "rename") {
      // rename 事件包括文件创建和删除，只在文件存在时处理
      if (fs.existsSync(PENDING_MARKER)) {
        flushPending(agentId).catch((e) =>
          console.warn("[news-watcher] flush 失败:", e)
        );
      }
    }
  });

  watcher.on("error", (e) => {
    console.warn("[news-watcher] watcher 错误:", e);
  });

  console.log(`[news-watcher] 已启动监听: ${NEWS_DIR}`);
}

export function stopNewsWatcher(): void {
  if (watcher) {
    watcher.close();
    watcher = null;
    console.log("[news-watcher] 已停止");
  }
}
