/**
 * McpWatcher — `~/.tinyclaw/mcp.toml` 变更监听
 *
 * 实现在通用的 `ContentWatcher`（`src/utils/content-watch.ts`）：**内容哈希判断变更**（不用 mtime）+
 * 监听父目录（写入是 `.tmp` + rename，watch 文件会丢事件）+ 去抖。
 *
 * 只在**主进程**装监听；cron worker 是独立进程，由主进程通过 IPC（`{ type: "mcp_changed" }`）通知它自行重载。
 */

import { mcpConfigPath } from "../config/loader.js";
import { ContentWatcher, contentDigest, digestOfContent } from "../utils/content-watch.js";
import { mcpManager } from "./client.js";

/** 去抖窗口（ms）：一次保存可能触发多个 fs 事件 */
const DEBOUNCE_MS = 700;

/** 这个文件名是否触发重载（只认正式文件：`.tmp` 中间态与 `.bak-*` 备份都不算变更） */
export function isMcpConfigFileName(name: string, base = "mcp.toml"): boolean {
  return name === base;
}

/** 内容哈希（保留导出：mcp 侧的测试/工具直接用） */
export const mcpTomlDigest = contentDigest;
export { digestOfContent };

class McpWatcher {
  private readonly inner: ContentWatcher;
  /** 变更回调（主进程用它通知 cron worker） */
  private onChanged: (() => void) | null = null;

  constructor() {
    this.inner = new ContentWatcher({
      targetPath: mcpConfigPath(),
      debounceMs: DEBOUNCE_MS,
      label: "mcp-watcher",
    });
  }

  /**
   * 启动监听（幂等）。
   *
   * @param onChange 本进程 reload 完成后的额外回调（如通知 cron worker）
   */
  async start(onChange?: () => void): Promise<void> {
    this.onChanged = onChange ?? null;
    this.inner.start(() => {
      void this.reloadNow();
    });
  }

  /** 停止监听（幂等） */
  stop(): void {
    this.inner.stop();
  }

  /** 供手动触发：内容真变了才重载 */
  async applyIfChanged(): Promise<boolean> {
    const changed = this.inner.applyIfChanged();
    return changed;
  }

  /** 重载（由 watcher 回调触发） */
  private async reloadNow(): Promise<void> {
    try {
      const summary = await mcpManager.reload("watch");
      console.log(`[mcp-watcher] ${summary}`);
    } catch (err) {
      console.warn("[mcp-watcher] 重载失败：", err instanceof Error ? err.message : err);
    }
    try {
      this.onChanged?.();
    } catch (err) {
      console.warn("[mcp-watcher] 通知 cron worker 失败：", err instanceof Error ? err.message : err);
    }
  }
}

export const mcpWatcher = new McpWatcher();
