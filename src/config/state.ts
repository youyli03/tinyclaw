/**
 * 配置状态：**上一份被证实可用的配置（LKG）+ 启动尝试计数 + 回退记录**
 *
 * 为什么需要它：`config.toml` 写坏时 `loadConfig()` 会 fail-fast 退出，服务进入崩溃循环。
 * 现有 supervisor 的 git 回退跑在**代码仓库**上（见 `main-supervisor.ts`），对配置毫无帮助 ——
 * 于是"改坏配置"= 服务永久起不来，只能人工修。这里给配置一条**文件级**的自愈路径：
 *
 * - 每次成功启动并（在 P2 起）通过健康探针后，把当前配置**提升**为 LKG（副本 `config.toml.lkg`）
 * - 子进程在**配置变更后**快速崩溃（quick-fail）→ supervisor 直接把 LKG 覆盖回 `config.toml`
 *
 * 刻意**不依赖 mtime**（本机 mtime 精度不可靠，见 `AGENTS.md` §7.4）；判定变更一律用 sha1 内容哈希。
 * 本模块只依赖 node 内置模块 —— 它会被 supervisor 直接 import，不能拖进 zod / loader 的依赖树。
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { atomicWriteText, fileStamp } from "./safe-write.js";

/** 状态文件版本（结构变更时 +1，读到旧版本按空状态处理） */
const STATE_VERSION = 1;

export interface ConfigStamp {
  /** sha1 内容哈希 */
  hash: string;
  /** ISO 时间 */
  at: string;
}

export interface ConfigRollbackRecord {
  at: string;
  /** 从哪个 hash 回退 */
  fromHash: string;
  /** 恢复到哪个 hash */
  toHash: string;
  /** 使用的 LKG 副本路径 */
  lkgPath: string;
  /** 人类可读原因 */
  reason: string;
  /** 回退前把坏配置留证的路径（可能为空） */
  rejectedPath?: string;
}

export interface ConfigState {
  version: number;
  /** 当前磁盘上的配置（最近一次记录） */
  current: ConfigStamp | null;
  /** 被证实可用过的配置（成功启动 + 健康） */
  lastGood: (ConfigStamp & { backup: string }) | null;
  /** 待确认的配置（写盘后标记；提升为 LKG 时清空） */
  pending: (ConfigStamp & { bootAttempts: number }) | null;
  /** 最近一次自动回退 */
  lastRollback: ConfigRollbackRecord | null;
}

export interface ConfigStatePaths {
  dir: string;
  statePath: string;
  configPath: string;
  lkgPath: string;
  notifyPath: string;
  logPath: string;
}

/** 解析各文件路径（`dir` 仅测试注入，默认 `~/.tinyclaw`） */
export function configStatePaths(dir?: string): ConfigStatePaths {
  const d = dir ?? path.join(os.homedir(), ".tinyclaw");
  return {
    dir: d,
    statePath: path.join(d, ".config-state.json"),
    configPath: path.join(d, "config.toml"),
    lkgPath: path.join(d, "config.toml.lkg"),
    notifyPath: path.join(d, ".rollback_notify.json"),
    logPath: path.join(d, "logs", "config-rollback.log"),
  };
}

/** 配置文本的内容哈希（sha1；文件不存在传 null 得空串哈希） */
export function configDigest(text: string): string {
  return crypto.createHash("sha1").update(text, "utf-8").digest("hex");
}

/** 读状态文件（缺失/损坏/版本不符 → 空状态，绝不抛错） */
export function readConfigState(dir?: string): ConfigState {
  const { statePath } = configStatePaths(dir);
  const empty: ConfigState = {
    version: STATE_VERSION,
    current: null,
    lastGood: null,
    pending: null,
    lastRollback: null,
  };
  try {
    const raw = JSON.parse(fs.readFileSync(statePath, "utf-8")) as Partial<ConfigState>;
    if (raw.version !== STATE_VERSION) return empty;
    return {
      version: STATE_VERSION,
      current: raw.current ?? null,
      lastGood: raw.lastGood ?? null,
      pending: raw.pending ?? null,
      lastRollback: raw.lastRollback ?? null,
    };
  } catch {
    return empty;
  }
}

/** 写状态文件（原子 + 0600；失败只告警，不影响主流程） */
export function writeConfigState(state: ConfigState, dir?: string): void {
  const { statePath } = configStatePaths(dir);
  try {
    atomicWriteText(statePath, JSON.stringify(state, null, 2), 0o600);
  } catch (err) {
    console.warn(`[config-state] 写入状态失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 记录"磁盘上的配置变了"（写盘后调用；同时标记 pending 待确认） */
export function noteConfigWritten(text: string, dir?: string): ConfigState {
  const state = readConfigState(dir);
  const stamp: ConfigStamp = { hash: configDigest(text), at: new Date().toISOString() };
  state.current = stamp;
  state.pending = { ...stamp, bootAttempts: 0 };
  writeConfigState(state, dir);
  return state;
}

/** 启动尝试 +1（supervisor 每次拉起子进程前调用），返回当前次数 */
export function bumpBootAttempt(dir?: string): number {
  const state = readConfigState(dir);
  if (state.pending === null) return 0;
  state.pending.bootAttempts += 1;
  writeConfigState(state, dir);
  return state.pending.bootAttempts;
}

/** 把当前配置提升为 LKG（成功启动 + 健康后调用） */
export function promoteConfig(text: string, dir?: string): void {
  const paths = configStatePaths(dir);
  const state = readConfigState(dir);
  const stamp: ConfigStamp = { hash: configDigest(text), at: new Date().toISOString() };
  if (state.lastGood?.hash === stamp.hash) {
    // 内容未变，只清 pending（避免每次启动都写盘）
    if (state.pending !== null) {
      state.pending = null;
      state.current = stamp;
      writeConfigState(state, dir);
    }
    return;
  }
  let backup = paths.lkgPath;
  try {
    fs.mkdirSync(paths.dir, { recursive: true, mode: 0o700 });
    atomicWriteText(paths.lkgPath, text, 0o600);
  } catch (err) {
    console.warn(`[config-state] 保存 LKG 失败：${err instanceof Error ? err.message : String(err)}`);
    backup = "";
  }
  state.current = stamp;
  state.lastGood = { ...stamp, backup };
  state.pending = null;
  writeConfigState(state, dir);
}

/** 当前磁盘配置的哈希（文件不存在返回 null） */
export function currentConfigDigest(dir?: string): string | null {
  const { configPath } = configStatePaths(dir);
  try {
    return configDigest(fs.readFileSync(configPath, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * 是否值得自动回退：磁盘配置与 LKG **内容不同**，且 LKG 存在可读。
 *
 * 用内容哈希而不是"有没有 pending 标记"：手改 `config.toml`（不经写入器）同样要被兜住。
 */
export function shouldRollbackConfig(dir?: string): boolean {
  const paths = configStatePaths(dir);
  const state = readConfigState(dir);
  if (state.lastGood === null) return false;
  if (!fs.existsSync(paths.lkgPath)) return false;
  const cur = currentConfigDigest(dir);
  if (cur === null) return false;
  return cur !== state.lastGood.hash;
}

/**
 * 执行回退：把 LKG 覆盖回 `config.toml`，坏配置留证，记录 lastRollback，并写通知文件。
 *
 * @returns 回退详情；不可回退时 `ok:false` + reason
 */
export function restoreLastGoodConfig(
  reason: string,
  dir?: string
): { ok: boolean; reason?: string; record?: ConfigRollbackRecord } {
  const paths = configStatePaths(dir);
  const state = readConfigState(dir);
  if (state.lastGood === null) return { ok: false, reason: "没有 LKG（从未成功启动过）" };
  if (!fs.existsSync(paths.lkgPath)) return { ok: false, reason: `LKG 副本不存在：${paths.lkgPath}` };

  let lkgText: string;
  try {
    lkgText = fs.readFileSync(paths.lkgPath, "utf-8");
  } catch (err) {
    return { ok: false, reason: `读取 LKG 失败：${err instanceof Error ? err.message : String(err)}` };
  }

  const fromHash = currentConfigDigest(dir) ?? "";
  // 坏配置留证（不进 git：submitter 的 DENY 里有 .rejected-）
  let rejectedPath: string | undefined;
  try {
    const cur = fs.readFileSync(paths.configPath, "utf-8");
    rejectedPath = `${paths.configPath}.rejected-${fileStamp()}`;
    fs.writeFileSync(rejectedPath, cur, { encoding: "utf-8", mode: 0o600 });
  } catch {
    rejectedPath = undefined;
  }

  try {
    atomicWriteText(paths.configPath, lkgText, 0o600);
  } catch (err) {
    return { ok: false, reason: `写回 LKG 失败：${err instanceof Error ? err.message : String(err)}` };
  }

  const record: ConfigRollbackRecord = {
    at: new Date().toISOString(),
    fromHash,
    toHash: state.lastGood.hash,
    lkgPath: paths.lkgPath,
    reason,
    ...(rejectedPath !== undefined ? { rejectedPath } : {}),
  };
  state.lastRollback = record;
  state.current = { hash: state.lastGood.hash, at: record.at };
  state.pending = { hash: state.lastGood.hash, at: record.at, bootAttempts: 0 };
  writeConfigState(state, dir);
  writeRollbackNotice(record, dir);
  return { ok: true, record };
}

/** 写回退通知（供 `main.ts` 读后推 QQ；同时落一份日志，connector 不在也看得见） */
export function writeRollbackNotice(record: ConfigRollbackRecord, dir?: string): void {
  const paths = configStatePaths(dir);
  try {
    fs.writeFileSync(
      paths.notifyPath,
      JSON.stringify(
        {
          kind: "config",
          fromHash: record.fromHash,
          toHash: record.toHash,
          reason: record.reason,
          rollbackAt: record.at,
          rejectedPath: record.rejectedPath ?? "",
        },
        null,
        2
      ),
      { encoding: "utf-8", mode: 0o600 }
    );
  } catch {
    /* 通知失败不影响回退本身 */
  }
  try {
    fs.mkdirSync(path.dirname(paths.logPath), { recursive: true, mode: 0o700 });
    fs.appendFileSync(
      paths.logPath,
      `[${record.at}] 自动回退配置：${record.fromHash.slice(0, 8)} → ${record.toHash.slice(0, 8)}` +
        `（${record.reason}）${record.rejectedPath ? ` 坏配置留证：${record.rejectedPath}` : ""}\n`,
      "utf-8"
    );
  } catch {
    /* ignore */
  }
}
