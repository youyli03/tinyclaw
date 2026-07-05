/**
 * ProjectRouter — 项目路由与 session 锁
 *
 * 管理 QQ Bot session ↔ 项目 的绑定关系:
 *   sessions/<id>.code.project  — 跳板文件,存 slug
 *   projects/<slug>/session.lock — 项目级 session 锁
 *
 * 从 project-memory.ts 分离,独立维护路由和锁逻辑。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ── 类型 ────────────────────────────────────────────────────────────────────

export interface SessionLock {
  holder: string; // sessionId
  acquiredAt: string; // ISO 8601
}

// ── 路径方法 ────────────────────────────────────────────────────────────────

/**
 * `.code.project` 跳板文件路径。
 * sessions/<sanitized>.code.project
 */
export function projectBindingPath(sessionId: string): string {
  const sanitized = sessionId.replace(/[:/\\]/g, "_");
  return path.join(os.homedir(), ".tinyclaw", "sessions", `${sanitized}.code.project`);
}

/**
 * session 锁文件路径。
 * projects/<slug>/session.lock
 */
export function sessionLockPath(agentId: string, slug: string): string {
  return path.join(
    os.homedir(),
    ".tinyclaw",
    "agents",
    agentId,
    "code",
    "projects",
    slug,
    "session.lock"
  );
}

/**
 * 项目 session.jsonl 路径。
 * projects/<slug>/session.jsonl
 */
export function projectSessionPath(agentId: string, slug: string): string {
  return path.join(
    os.homedir(),
    ".tinyclaw",
    "agents",
    agentId,
    "code",
    "projects",
    slug,
    "session.jsonl"
  );
}

// ── 跳板文件读写 ────────────────────────────────────────────────────────────

/**
 * 读取 session 当前绑定的项目 slug。
 * 文件不存在返回 null。
 */
export function getProjectBinding(sessionId: string): string | null {
  const p = projectBindingPath(sessionId);
  try {
    if (!fs.existsSync(p)) return null;
    return fs.readFileSync(p, "utf-8").trim();
  } catch {
    return null;
  }
}

/**
 * 写入 session → 项目的绑定关系。
 * slug 为 null 时删除跳板文件（解绑）。
 */
export function setProjectBinding(sessionId: string, slug: string | null): void {
  const p = projectBindingPath(sessionId);
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    if (slug === null) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } else {
      fs.writeFileSync(p, slug, "utf-8");
    }
  } catch (err) {
    console.error("[project-router] setProjectBinding failed:", err);
  }
}

// ── Session 锁 ──────────────────────────────────────────────────────────────

/**
 * 尝试获取项目 session 锁。
 * 原子操作：先写 tmp 再 rename，确保并发安全。
 * @returns true 表示获取成功,false 表示已被其他 session 占用
 */
export function acquireLock(agentId: string, slug: string, sessionId: string): boolean {
  const lockPath = sessionLockPath(agentId, slug);
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });

    // 检查是否已被锁定
    if (fs.existsSync(lockPath)) {
      const content = fs.readFileSync(lockPath, "utf-8");
      try {
        const existing: SessionLock = JSON.parse(content);
        if (existing.holder === sessionId) return true; // 同 session 重入
      } catch {}
      return false;
    }

    // 原子写入: 先写 tmp 文件,再 rename
    const tmpPath = lockPath + ".tmp." + sessionId.replace(/[:/\\]/g, "_");
    const lock: SessionLock = {
      holder: sessionId,
      acquiredAt: new Date().toISOString(),
    };
    fs.writeFileSync(tmpPath, JSON.stringify(lock), "utf-8");
    fs.renameSync(tmpPath, lockPath);
    return true;
  } catch (err) {
    console.error("[project-router] acquireLock failed:", err);
    return false;
  }
}

/**
 * 释放项目 session 锁。
 * 校验 holder 是否匹配，防止误释放他人持有的锁。
 * @returns true 表示释放成功,false 表示锁不存在或持有者不匹配
 */
export function releaseLock(agentId: string, slug: string, sessionId: string): boolean {
  const lockPath = sessionLockPath(agentId, slug);
  try {
    if (!fs.existsSync(lockPath)) return true; // 已释放

    const content = fs.readFileSync(lockPath, "utf-8");
    const lock: SessionLock = JSON.parse(content);

    if (lock.holder !== sessionId) {
      console.warn(
        `[project-router] releaseLock: holder mismatch (expected ${sessionId}, got ${lock.holder})`
      );
      return false;
    }

    fs.unlinkSync(lockPath);
    return true;
  } catch (err) {
    console.error("[project-router] releaseLock failed:", err);
    return false;
  }
}

/**
 * 强制释放锁（兜底用）。
 * 不校验 holder，仅 session 结束时确保清理。
 */
export function forceReleaseLock(agentId: string, slug: string): void {
  const lockPath = sessionLockPath(agentId, slug);
  try {
    if (fs.existsSync(lockPath)) {
      fs.unlinkSync(lockPath);
    }
  } catch (err) {
    console.error("[project-router] forceReleaseLock failed:", err);
  }
}

/**
 * 读取当前锁持有者信息。
 * @returns 锁信息,无锁时返回 null
 */
export function readLock(agentId: string, slug: string): SessionLock | null {
  const lockPath = sessionLockPath(agentId, slug);
  try {
    if (!fs.existsSync(lockPath)) return null;
    const content = fs.readFileSync(lockPath, "utf-8");
    return JSON.parse(content) as SessionLock;
  } catch {
    return null;
  }
}

// ── Slug 工具 ───────────────────────────────────────────────────────────────

/**
 * 本地绝对路径 → slug。
 * /home/lyy/tinyclaw → _home_lyy_tinyclaw
 */
export function workdirToSlug(workdir: string): string {
  const normalized = path.resolve(workdir).replace(/\/$/, "");
  return normalized.replace(/\//g, "_");
}

/**
 * slug → 本地 workdir（仅 local 类型有效,SSH 返回 null）。
 * _home_lyy_tinyclaw → /home/lyy/tinyclaw
 */
export function slugToWorkdir(slug: string): string | null {
  if (!slug.startsWith("_")) return null;
  try {
    const candidate = "/" + slug.slice(1).replace(/_/g, "/");
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      return candidate;
    }
  } catch {
    // ignore
  }
  return null;
}

// ── 工具函数 ────────────────────────────────────────────────────────────────

/**
 * 检查指定 project 目录是否有效（metadata.json 存在）。
 * 遍历目录发现项目时使用。
 */
export function isValidProject(agentId: string, slug: string): boolean {
  const metaPath = path.join(
    os.homedir(),
    ".tinyclaw",
    "agents",
    agentId,
    "code",
    "projects",
    slug,
    "metadata.json"
  );
  return fs.existsSync(metaPath);
}

/**
 * 列出所有已注册的项目 slug（扫描目录）。
 */
export function listAllProjects(agentId: string): string[] {
  const projectsDir = path.join(os.homedir(), ".tinyclaw", "agents", agentId, "code", "projects");
  if (!fs.existsSync(projectsDir)) return [];
  return fs
    .readdirSync(projectsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}
