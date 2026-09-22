/**
 * 配置文件安全写入（`config.toml` / `mcp.toml` 共用）
 *
 * 三件事，都只做文件层的事、不关心内容语义：
 * 1. `atomicWriteText` —— 写 `.tmp` 再 `rename`（避免半截文件），权限 0600
 * 2. `backupFile` —— `<name>.bak-<YYYYMMDD-HHmmss>`，只保留最近 N 份
 * 3. `quarantineRejected` —— 被校验拒绝的内容留证 `<name>.rejected-<ts>`（0600，供事后诊断）
 *
 * 「校验后再写」的策略在各自模块里（`config/writer.ts` / `mcp/config-writer.ts`），
 * 这里只提供不会把用户文件写坏的底层动作。
 */

import * as fs from "node:fs";
import * as path from "node:path";

/** 默认保留的备份份数 */
export const DEFAULT_BACKUP_KEEP = 5;

/** 时间戳：`YYYYMMDD-HHmmss`（与既有 `mcp.toml.bak-20260923-002346` 命名一致） */
export function fileStamp(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/** 目录下该文件的全部备份（按名字排序 = 按时间排序） */
export function listBackups(target: string): string[] {
  const dir = path.dirname(target);
  const base = path.basename(target);
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.startsWith(`${base}.bak-`))
      .sort();
  } catch {
    return [];
  }
}

/** 只保留最近 keep 份备份（更旧的删除） */
export function pruneBackups(target: string, keep: number = DEFAULT_BACKUP_KEEP): void {
  const dir = path.dirname(target);
  const backups = listBackups(target);
  for (const old of backups.slice(0, Math.max(0, backups.length - keep))) {
    try {
      fs.unlinkSync(path.join(dir, old));
    } catch {
      /* 清理失败不影响本次写入 */
    }
  }
}

/**
 * 备份目标文件。
 * @returns 备份路径；目标不存在时返回 null（首次创建无备份可做）
 */
export function backupFile(target: string, keep: number = DEFAULT_BACKUP_KEEP): string | null {
  if (!fs.existsSync(target)) return null;
  const dir = path.dirname(target);
  let dest = path.join(dir, `${path.basename(target)}.bak-${fileStamp()}`);
  for (let n = 2; fs.existsSync(dest); n++) {
    dest = path.join(dir, `${path.basename(target)}.bak-${fileStamp()}-${n}`);
  }
  fs.copyFileSync(target, dest);
  try {
    fs.chmodSync(dest, 0o600);
  } catch {
    /* 某些文件系统不支持 chmod */
  }
  pruneBackups(target, keep);
  return dest;
}

/** 原子写入：`.tmp` + rename；权限默认 0600（这些文件可能含密钥） */
export function atomicWriteText(target: string, text: string, mode = 0o600): void {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const tmp = `${target}.tmp`;
  fs.writeFileSync(tmp, text, { encoding: "utf-8", mode });
  fs.renameSync(tmp, target);
  try {
    fs.chmodSync(target, mode);
  } catch {
    /* 某些文件系统不支持 chmod */
  }
}

/**
 * 把被拒绝的内容留证（不进 git：submitter 的 DENY 名单里有 `.rejected`）。
 * @returns 留证文件路径
 */
export function quarantineRejected(target: string, text: string): string {
  const dir = path.dirname(target);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  let dest = `${target}.rejected-${fileStamp()}`;
  for (let n = 2; fs.existsSync(dest); n++) {
    dest = `${target}.rejected-${fileStamp()}-${n}`;
  }
  fs.writeFileSync(dest, text, { encoding: "utf-8", mode: 0o600 });
  return dest;
}
