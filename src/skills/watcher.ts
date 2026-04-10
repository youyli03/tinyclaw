/**
 * SkillWatcher — 文件监听层
 *
 * 监听 SKILLS.md 变更，触发 skillRegistry.refresh()。
 * 仅在主进程中初始化，cron worker 不装 watcher（只接收 IPC 失效通知）。
 *
 * 使用 Node.js 原生 fs.watch（无需额外依赖）。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { skillRegistry } from "./registry.js";

const AGENTS_ROOT = path.join(os.homedir(), ".tinyclaw", "agents");

// ── SkillWatcher ──────────────────────────────────────────────────────────────

class SkillWatcher {
  private started = false;
  private watchers: fs.FSWatcher[] = [];
  /** 变更时的额外回调（供主进程通知 cron worker） */
  private onChangeFns: Array<(agentId: string) => void> = [];

  /**
   * 启动文件监听。
   * @param agentIds 要监听的 agentId 列表
   * @param onSkillsChanged 文件变更时触发的额外回调（如 IPC 通知 cron worker）
   */
  async start(agentIds: string[], onSkillsChanged?: (agentId: string) => void): Promise<void> {
    if (this.started) return;
    this.started = true;

    if (onSkillsChanged) {
      this.onChangeFns.push(onSkillsChanged);
    }

    for (const agentId of agentIds) {
      this._watchAgent(agentId);
    }
  }

  /** 注册额外的变更回调 */
  onChanged(fn: (agentId: string) => void): void {
    this.onChangeFns.push(fn);
  }

  /** 停止所有监听 */
  stop(): void {
    for (const w of this.watchers) {
      try { w.close(); } catch { /* ignore */ }
    }
    this.watchers = [];
    this.started = false;
  }

  // ── 内部 ────────────────────────────────────────────────────────────────────

  private _watchAgent(agentId: string): void {
    const skillsPath = path.join(AGENTS_ROOT, agentId, "SKILLS.md");
    const skillsDir = path.join(AGENTS_ROOT, agentId, "skills");

    // 监听 SKILLS.md（稳定存在时直接 watch 文件）
    this._watchFile(skillsPath, agentId);

    // 监听 skills/ 目录（目录内有任何 SKILL.md 变更都刷新）
    if (fs.existsSync(skillsDir)) {
      this._watchDir(skillsDir, agentId);
    }

    console.log(`[skills] watching agent="${agentId}"`);
  }

  private _watchFile(filePath: string, agentId: string): void {
    // 即使文件不存在也 watch 父目录，等文件出现时触发
    const dir = path.dirname(filePath);
    const fileName = path.basename(filePath);

    if (!fs.existsSync(dir)) return;

    let debounceTimer: ReturnType<typeof setTimeout> | undefined;

    const watcher = fs.watch(dir, { persistent: false }, (event, name) => {
      if (name !== fileName) return;
      // 防抖：250ms 内多次变更只触发一次
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        console.log(`[skills] ${filePath} changed (${event}), refreshing agent="${agentId}"`);
        skillRegistry.refresh(agentId);
        for (const fn of this.onChangeFns) {
          try { fn(agentId); } catch { /* ignore */ }
        }
      }, 250);
    });

    this.watchers.push(watcher);
  }

  private _watchDir(dirPath: string, agentId: string): void {
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;

    const watcher = fs.watch(dirPath, { persistent: false, recursive: true }, (event, name) => {
      if (!name?.endsWith("SKILL.md")) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        console.log(`[skills] ${dirPath}/${name} changed (${event}), refreshing agent="${agentId}"`);
        skillRegistry.refresh(agentId);
        for (const fn of this.onChangeFns) {
          try { fn(agentId); } catch { /* ignore */ }
        }
      }, 250);
    });

    this.watchers.push(watcher);
  }
}

// ── 进程级单例 ────────────────────────────────────────────────────────────────

export const skillWatcher = new SkillWatcher();
