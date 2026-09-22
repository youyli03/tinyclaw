/**
 * ConfigWatcher — `~/.tinyclaw/config.toml` 变更监听（自动热重载）
 *
 * 与 `mcp/watcher.ts` 同构，复用通用 `ContentWatcher`：**内容哈希判断变更**（不用 mtime）+
 * 监听父目录（写入是 `.tmp` + rename）+ 去抖。回调由 main.ts 注入（那里才有子系统重 init 与重启能力）。
 *
 * ⚠️ 安全阀：连续 N 次自动重载都失败（例如文件被编辑器写成半截内容）时**自动停用监听**并告警，
 * 避免"边写边重载"把服务拖进循环。
 */

import { CONFIG_PATH } from "./writer.js";
import { ContentWatcher } from "../utils/content-watch.js";

/** 去抖窗口（ms）：编辑器保存往往触发多个 fs 事件 */
const DEBOUNCE_MS = 800;
/** 连续失败多少次后自动停用监听 */
const MAX_CONSECUTIVE_FAILURES = 3;

class ConfigWatcher {
  private readonly inner: ContentWatcher;
  private failures = 0;
  private disabled = false;

  constructor() {
    this.inner = new ContentWatcher({
      targetPath: CONFIG_PATH,
      debounceMs: DEBOUNCE_MS,
      label: "config-watcher",
    });
  }

  /**
   * 启动监听（幂等）。
   *
   * @param onChange 变更且**内容哈希确实不同**时调用；返回值表示是否成功应用
   *                 （失败会累计，连续失败超过阈值就停用监听）
   */
  start(onChange: () => Promise<boolean> | boolean): void {
    this.inner.start(() => {
      void this.runGuarded(onChange);
    });
  }

  /** 停止监听（幂等） */
  stop(): void {
    this.inner.stop();
  }

  /** 是否已被安全阀停用 */
  isDisabled(): boolean {
    return this.disabled;
  }

  /** 供手动触发（`config reload` 的 watch 语义） */
  triggerNow(onChange: () => Promise<boolean> | boolean): boolean {
    const changed = this.inner.applyIfChanged();
    if (changed) void this.runGuarded(onChange);
    return changed;
  }

  private async runGuarded(onChange: () => Promise<boolean> | boolean): Promise<void> {
    if (this.disabled) return;
    try {
      const ok = await onChange();
      this.failures = ok ? 0 : this.failures + 1;
    } catch (err) {
      this.failures += 1;
      console.warn("[config-watcher] 重载回调抛错：", err instanceof Error ? err.message : err);
    }
    if (this.failures >= MAX_CONSECUTIVE_FAILURES) {
      this.disabled = true;
      this.inner.stop();
      console.warn(
        `[config-watcher] ⚠️ 连续 ${this.failures} 次重载失败，已停用 config.toml 自动重载（手动 tinyclaw restart 后再改）`
      );
    }
  }
}

export const configWatcher = new ConfigWatcher();
