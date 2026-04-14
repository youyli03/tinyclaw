/**
 * SkillWatcher — 文件监听层
 *
 * 监听 SKILLS.md 变更以及 skills/ 子目录内容变化，触发 skillRegistry.refresh()。
 * 仅在主进程中初始化，cron worker 不装 watcher（只接收 IPC 失效通知）。
 *
 * 策略：
 * - SKILLS.md：fs.watch 监听父目录（精确文件名匹配，稳定可靠）
 * - skills/ 目录：轮询（每 POLL_INTERVAL_MS 扫一次），对比每个子目录的 mtime
 *   原因：Linux 的 fs.watch recursive 对新增子目录不可靠（inotify 限制）
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { skillRegistry } from "./registry.js";

const AGENTS_ROOT = path.join(os.homedir(), ".tinyclaw", "agents");

/** 轮询间隔（ms）*/
const POLL_INTERVAL_MS = 5_000;

// ── SkillWatcher ──────────────────────────────────────────────────────────────

class SkillWatcher {
  private started = false;
  private watchers: fs.FSWatcher[] = [];
  private pollTimers: ReturnType<typeof setInterval>[] = [];
  /** 变更时的额外回调(供主进程通知 cron worker) */
  private onChangeFns: Array<(agentId: string) => void> = [];

  /**
   * 启动文件监听。
   * @param agentIds 要监听的 agentId 列表
   * @param onSkillsChanged 文件变更时触发的额外回调(如 IPC 通知 cron worker)
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
    for (const t of this.pollTimers) {
      clearInterval(t);
    }
    this.watchers = [];
    this.pollTimers = [];
    this.started = false;
  }

  // ── 内部 ────────────────────────────────────────────────────────────────────

  private _watchAgent(agentId: string): void {
    const skillsPath = path.join(AGENTS_ROOT, agentId, "SKILLS.md");
    const skillsDir = path.join(AGENTS_ROOT, agentId, "skills");

    // 监听 SKILLS.md（稳定存在时直接 watch 文件）
    this._watchFile(skillsPath, agentId);

    // 监听 skills/ 目录 —— 使用轮询（Linux recursive fs.watch 不可靠）
    this._pollSkillsDir(skillsDir, agentId);

    console.log(`[skills] watching agent="${agentId}" (SKILLS.md=fswatch, skills/=poll ${POLL_INTERVAL_MS}ms)`);
  }

  private _watchFile(filePath: string, agentId: string): void {
    const dir = path.dirname(filePath);
    const fileName = path.basename(filePath);

    if (!fs.existsSync(dir)) return;

    let debounceTimer: ReturnType<typeof setTimeout> | undefined;

    const watcher = fs.watch(dir, { persistent: false }, (event, name) => {
      if (name !== fileName) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        console.log(`[skills] ${filePath} changed (${event}), refreshing agent="${agentId}"`);
        this._doRefresh(agentId);
      }, 250);
    });

    this.watchers.push(watcher);
  }

  /**
   * 轮询 skills/ 目录。
   * 记录每个子目录（及其 SKILL.md / README.md）的 mtime，变化时触发 refresh。
   * 同时检测子目录新增/删除。
   */
  private _pollSkillsDir(skillsDir: string, agentId: string): void {
    /** key = 文件路径, value = mtime */
    const snapshot = new Map<string, number>();

    const scan = (): Map<string, number> => {
      const cur = new Map<string, number>();
      if (!fs.existsSync(skillsDir)) return cur;

      let subdirs: string[];
      try {
        subdirs = fs.readdirSync(skillsDir, { withFileTypes: true })
          .filter((d) => d.isDirectory())
          .map((d) => d.name);
      } catch {
        return cur;
      }

      for (const sub of subdirs) {
        const subDir = path.join(skillsDir, sub);
        // 记录子目录本身的 mtime（子目录新增/删除文件时 mtime 会变）
        try {
          cur.set(subDir, fs.statSync(subDir).mtimeMs);
        } catch { /* ignore */ }
        // 记录 SKILL.md / README.md 的 mtime
        for (const docName of ["SKILL.md", "README.md"]) {
          const docPath = path.join(subDir, docName);
          try {
            if (fs.existsSync(docPath)) {
              cur.set(docPath, fs.statSync(docPath).mtimeMs);
            }
          } catch { /* ignore */ }
        }
      }
      return cur;
    };

    // 初始快照
    const initial = scan();
    for (const [k, v] of initial) snapshot.set(k, v);

    const timer = setInterval(() => {
      const cur = scan();

      let changed = false;

      // 检测新增或 mtime 变化
      for (const [k, v] of cur) {
        if (snapshot.get(k) !== v) {
          changed = true;
          break;
        }
      }

      // 检测删除
      if (!changed) {
        for (const k of snapshot.keys()) {
          if (!cur.has(k)) {
            changed = true;
            break;
          }
        }
      }

      if (changed) {
        console.log(`[skills] skills/ dir changed for agent="${agentId}", refreshing registry`);
        // 更新快照
        snapshot.clear();
        for (const [k, v] of cur) snapshot.set(k, v);
        this._doRefresh(agentId);
      }
    }, POLL_INTERVAL_MS);

    // unref：不阻止进程退出
    timer.unref();
    this.pollTimers.push(timer);
  }

  private _doRefresh(agentId: string): void {
    skillRegistry.refresh(agentId);
    for (const fn of this.onChangeFns) {
      try { fn(agentId); } catch { /* ignore */ }
    }
  }
}

// ── 进程级单例 ────────────────────────────────────────────────────────────────

export const skillWatcher = new SkillWatcher();
