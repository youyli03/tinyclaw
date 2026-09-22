/**
 * 通用"内容哈希文件监听器"
 *
 * 两个刻意的设计（`mcp.toml` 与 `config.toml` 都需要，抽出来共用）：
 * - **用 sha1 内容哈希判断"变了没有"，不用 mtime**：本机（RK3588 / SMB 共享）实测同一文件连续两次写入
 *   mtime 完全相同（见 `AGENTS.md` §7.4），靠 mtime 的缓存会漏掉更新；`touch` / 备份轮转也不该触发重载
 * - 监听**父目录**而不是文件本身：写入器走"写 `.tmp` 再 rename"，会替换 inode，直接 watch 文件会丢掉后续事件
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

/** 内容哈希（空串也算稳定值） */
export function contentDigest(text: string): string {
  return crypto.createHash("sha1").update(text, "utf-8").digest("hex");
}

/** 文本 → 哈希；文件不存在（null）保持 null */
export function digestOfContent(text: string | null): string | null {
  return text === null ? null : contentDigest(text);
}

/** 该文件名是否是要监听的目标（`.tmp` 中间态与 `.bak-*` 备份都不算变更） */
export function isTargetFileName(name: string, base: string): boolean {
  return name === base;
}

export interface ContentWatcherOptions {
  /** 被监听文件的绝对路径 */
  targetPath: string;
  /** 去抖窗口（ms），默认 700 */
  debounceMs?: number;
  /** 日志前缀 */
  label?: string;
}

/**
 * 监听一个文件的**内容**变化。
 *
 * 用法：`new ContentWatcher({targetPath}).start(() => {...})`；`stop()` 关闭。
 * `onChange` 在被调用时，文件内容**确实**变了（哈希不同）。
 */
export class ContentWatcher {
  private readonly targetPath: string;
  private readonly base: string;
  private readonly debounceMs: number;
  private readonly label: string;
  private watcher: fs.FSWatcher | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastDigest: string | null = null;
  private starting = false;
  private onChange: (() => void) | null = null;

  constructor(opts: ContentWatcherOptions) {
    this.targetPath = opts.targetPath;
    this.base = path.basename(opts.targetPath);
    this.debounceMs = opts.debounceMs ?? 700;
    this.label = opts.label ?? "content-watch";
  }

  /** 启动监听（幂等）；`~/.tinyclaw` 还不存在时不装监听 */
  start(onChange: () => void): void {
    if (this.watcher !== null || this.starting) return;
    this.starting = true;
    try {
      this.onChange = onChange;
      const dir = path.dirname(this.targetPath);
      this.lastDigest = this.readDigest();
      if (!fs.existsSync(dir)) return;
      this.watcher = fs.watch(dir, (_event, filename) => {
        const name = filename === null ? this.base : String(filename);
        if (!isTargetFileName(name, this.base)) return;
        this.schedule();
      });
      this.watcher.on("error", (err) => {
        console.warn(`[${this.label}] 监听失败，已停用文件监听：`, err.message);
        this.stop();
      });
      console.log(`[${this.label}] watching ${this.targetPath}`);
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

  /** 供测试/手动触发：立刻比对内容哈希，真变了就回调，返回是否触发 */
  applyIfChanged(): boolean {
    const digest = this.readDigest();
    if (digest === this.lastDigest) return false;
    this.lastDigest = digest;
    try {
      this.onChange?.();
    } catch (err) {
      console.warn(`[${this.label}] 变更回调失败：`, err instanceof Error ? err.message : err);
    }
    return true;
  }

  private readDigest(): string | null {
    try {
      return contentDigest(fs.readFileSync(this.targetPath, "utf-8"));
    } catch {
      return null;
    }
  }

  private schedule(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.applyIfChanged();
    }, this.debounceMs);
  }
}
