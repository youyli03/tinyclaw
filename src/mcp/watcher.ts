/**
 * McpWatcher — `~/.tinyclaw/mcp.toml` 变更监听
 *
 * 只在**主进程**装监听（与 `skills/watcher.ts` 同构）；cron worker 是独立进程，
 * 由主进程通过 IPC（`{ type: "mcp_changed" }`）通知它自己 `reload()`。
 *
 * 两个刻意的设计：
 * - **用内容哈希判断"变了没有"，不用 mtime**：本机（RK3588 / SMB 共享）实测同一文件连续两次写入
 *   mtime 完全相同（见 `AGENTS.md` §7.4），靠 mtime 的缓存会漏掉更新。
 * - 监听**父目录**而不是文件本身：编辑器/写入器的"写临时文件再 rename"会替换 inode，
 *   直接 watch 文件会丢掉后续事件（`config-writer.ts` 正是这么写的）。
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { mcpConfigPath } from "../config/loader.js";
import { mcpManager } from "./client.js";

/** 去抖窗口（ms）：一次保存可能触发多个 fs 事件 */
const DEBOUNCE_MS = 700;

/** 这个文件名是否触发重载（只认正式文件：`.tmp` 中间态与 `.bak-*` 备份都不算变更） */
export function isMcpConfigFileName(name: string, base = "mcp.toml"): boolean {
  return name === base;
}

/** 内容哈希（空串也算稳定值） */
export function mcpTomlDigest(text: string): string {
  return crypto.createHash("sha1").update(text, "utf-8").digest("hex");
}

/** 文本 → 哈希；文件不存在（null）保持 null */
export function digestOfContent(text: string | null): string | null {
  return text === null ? null : mcpTomlDigest(text);
}

/** 读盘并算哈希；文件不存在返回 null */
function digestOfFile(p: string): string | null {
  try {
    return mcpTomlDigest(fs.readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

class McpWatcher {
  private watcher: fs.FSWatcher | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastDigest: string | null = null;
  private starting = false;
  /** 变更回调（主进程用它通知 cron worker） */
  private onChange: (() => void) | null = null;

  /**
   * 启动监听（幂等）。
   *
   * @param onChange 本进程 reload 完成后的额外回调（如通知 cron worker）
   */
  async start(onChange?: () => void): Promise<void> {
    if (this.watcher !== null || this.starting) return;
    this.starting = true;
    try {
      this.onChange = onChange ?? null;
      const target = mcpConfigPath();
      const dir = path.dirname(target);
      const base = path.basename(target);
      this.lastDigest = digestOfFile(target);
      if (!fs.existsSync(dir)) {
        // ~/.tinyclaw 还不存在：没有可监听的目标，下次启动再装
        return;
      }
      this.watcher = fs.watch(dir, (_event, filename) => {
        const name = filename === null ? base : String(filename);
        if (!isMcpConfigFileName(name, base)) return;
        this.schedule();
      });
      // watcher 自身出错时不要让进程崩（fs.watch 在部分文件系统上会抛 error）
      this.watcher.on("error", (err) => {
        console.warn("[mcp-watcher] 监听失败，已停用文件监听：", err.message);
        this.stop();
      });
      console.log(`[mcp-watcher] watching ${target}`);
    } finally {
      this.starting = false;
    }
  }

  /** 停止监听（幂等） */
  stop(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.watcher !== null) {
      try {
        this.watcher.close();
      } catch {
        /* ignore */
      }
      this.watcher = null;
    }
  }

  /** 去抖后按内容哈希判断是否需要重载 */
  private schedule(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.applyIfChanged();
    }, DEBOUNCE_MS);
  }

  /** 供测试/手动触发：立即检查并重载 */
  async applyIfChanged(target: string = mcpConfigPath()): Promise<boolean> {
    const digest = digestOfFile(target);
    if (digest === this.lastDigest) return false; // 内容没变（如 touch / 备份轮转）→ 不重载
    this.lastDigest = digest;
    try {
      const summary = await mcpManager.reload("watch");
      console.log(`[mcp-watcher] ${summary}`);
    } catch (err) {
      console.warn("[mcp-watcher] 重载失败：", err instanceof Error ? err.message : err);
    }
    try {
      this.onChange?.();
    } catch (err) {
      console.warn("[mcp-watcher] 通知 cron worker 失败：", err instanceof Error ? err.message : err);
    }
    return true;
  }
}

export const mcpWatcher = new McpWatcher();
