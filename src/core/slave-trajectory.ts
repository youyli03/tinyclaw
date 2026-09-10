/**
 * slave 轨迹归档
 *
 * 子 Agent（slave）结束时会删除自己的 session JSONL，导致完整轨迹丢失。
 * 本模块在完成时把整份 JSONL **移动**到按日期分层的归档目录，并同时写出
 * meta.json 与 result.md（result 全文，任何环节都不截断）。
 *
 * 目录布局：
 *   ~/.tinyclaw/slaves/<YYYY-MM>/<YYYY-MM-DD>-<uniqueId>/
 *       trajectory.jsonl   原 session JSONL（逐字节原样移入）
 *       meta.json          结构化元信息（pretty-printed）
 *       result.md          最终结果全文
 *
 * 所有磁盘写入都是 best-effort：失败只记日志（模块前缀 [slave-trace]），不向调用方抛出。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createLogger } from "../utils/logger.js";

const log = createLogger("slave-trace");

/** 轨迹文件名（归档目录内） */
const TRAJECTORY_FILE = "trajectory.jsonl";
/** 元信息文件名 */
const META_FILE = "meta.json";
/** 结果文件名 */
const RESULT_FILE = "result.md";

/** listSlaveTrajectories 未传 limit 时的默认返回条数 */
const DEFAULT_LIST_LIMIT = 20;

/** 目录名里不安全的字符 → 下划线 */
const UNSAFE_NAME_CHARS = /[^A-Za-z0-9._-]/g;
/** 已带日期前缀的 uniqueId（避免目录名里日期重复两遍） */
const DATE_PREFIX = /^\d{4}-\d{2}-\d{2}[-_]?/;

export interface SlaveTrajectoryMeta {
  slaveId: string;
  task: string;
  agentId: string;
  masterSessionId: string;
  status: "done" | "error" | "aborted";
  startedAt: string; // ISO
  finishedAt: string; // ISO
  toolsUsed: string[];
  /** 原 session JSONL 的字节数（归档前） */
  trajectoryBytes?: number;
  /** 消息条数（归档前，若能数出） */
  messageCount?: number;
  /** 归档原因：正常完成 / 进程重启后清理遗留 */
  reason?: "completed" | "orphan";
}

export interface ArchiveSlaveResult {
  dir: string; // 归档目录绝对路径
  trajectoryPath: string; // trajectory.jsonl 绝对路径
  resultPath: string; // result.md 绝对路径
  metaPath: string;
}

/* ------------------------------------------------------------------ */
/* 小工具                                                              */
/* ------------------------------------------------------------------ */

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** 本地时间 → { month: "YYYY-MM", date: "YYYY-MM-DD" } */
function localDateParts(d: Date): { month: string; date: string } {
  const date = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  return { month: date.slice(0, 7), date };
}

/** 错误对象 → 一行可读描述（不吞异常信息） */
function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

/** 取 errno code（如 EXDEV），取不到返回 undefined */
function errorCode(err: unknown): string | undefined {
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

/**
 * 读取目录项所属的父目录。
 * Node 20.11 起为 parentPath（新名），旧版本只有 path（已废弃）——两者都要兜住。
 */
function direntBaseDir(dirent: fs.Dirent, fallback: string): string {
  const d = dirent as { parentPath?: string; path?: string };
  const base = d.parentPath ?? d.path;
  return base !== undefined && base.length > 0 ? base : fallback;
}

/** 目录是否存在（不存在/无权限都按“不是目录”处理） */
function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch (err) {
    // 路径不存在或无权限访问属于预期情况，按“不是目录”处理，仅 debug 记录
    log.debug(`stat 失败，视为非目录: ${p}`, describeError(err));
    return false;
  }
}

/**
 * slaveId → 安全目录名片段。
 * - 替换 [^A-Za-z0-9._-] 为下划线
 * - slaveId 自带 YYYY-MM-DD 前缀时剥掉，避免目录名出现两遍日期
 * - 结果为空时退化使用 "slave"，保证可确定复现
 */
function sanitizeUniqueId(raw: string): string {
  let id = raw.replace(UNSAFE_NAME_CHARS, "_").replace(DATE_PREFIX, "");
  // 去掉首尾的点/横线，避免产生 "."、".." 之类特殊目录名
  id = id.replace(/^[.-]+/, "").replace(/[.-]+$/, "");
  return id.length > 0 ? id : "slave";
}

/** 统计 JSONL 消息条数（非空行数） */
function countJsonlMessages(text: string): number {
  let n = 0;
  for (const line of text.split("\n")) {
    if (line.trim().length > 0) n++;
  }
  return n;
}

/** 在 monthDir 下分配一个不存在的目录路径（同名则追加 -2、-3 …），绝不覆盖 */
function allocateArchiveDir(monthDir: string, baseName: string): string {
  for (let n = 1; n < 1000; n++) {
    const name = n === 1 ? baseName : `${baseName}-${n}`;
    const dir = path.join(monthDir, name);
    if (!fs.existsSync(dir)) return dir;
  }
  // 同名目录过多（极端情况）：退化为带时间戳的名字，保证仍然不覆盖
  log.warn(`同名归档目录过多，退化为时间戳命名: ${baseName}`);
  return path.join(monthDir, `${baseName}-${Date.now()}`);
}

/**
 * 把源 JSONL 移动到归档目录：先 renameSync，跨设备（EXDEV）时退化为 copy + unlink。
 * 失败只记日志，不抛出——调用方仍会拿到“预期路径”。
 */
function moveTrajectoryFile(src: string, dest: string, slaveId: string): void {
  try {
    fs.renameSync(src, dest);
    return;
  } catch (err) {
    if (errorCode(err) === "EXDEV") {
      // 源与归档目录不在同一挂载点，rename 不可用 → 复制后删除源文件
      try {
        fs.copyFileSync(src, dest);
        fs.unlinkSync(src);
        return;
      } catch (copyErr) {
        log.error(
          `轨迹复制失败 slave=${slaveId}: ${src} -> ${dest}`,
          describeError(copyErr)
        );
        return;
      }
    }
    log.error(`轨迹移动失败 slave=${slaveId}: ${src} -> ${dest}`, describeError(err));
  }
}

/** 解析 meta.json；文件缺失或解析失败/结构不合法时返回 null */
function readMetaFile(metaPath: string): SlaveTrajectoryMeta | null {
  try {
    const raw = fs.readFileSync(metaPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return isSlaveTrajectoryMeta(parsed) ? parsed : null;
  } catch (err) {
    log.warn(`meta.json 读取或解析失败: ${metaPath}`, describeError(err));
    return null;
  }
}

/** meta.json → SlaveTrajectoryMeta 的类型守卫（禁止 any） */
function isSlaveTrajectoryMeta(v: unknown): v is SlaveTrajectoryMeta {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (typeof o["slaveId"] !== "string") return false;
  if (typeof o["task"] !== "string") return false;
  if (typeof o["agentId"] !== "string") return false;
  if (typeof o["masterSessionId"] !== "string") return false;
  const status = o["status"];
  if (status !== "done" && status !== "error" && status !== "aborted") return false;
  if (typeof o["startedAt"] !== "string") return false;
  if (typeof o["finishedAt"] !== "string") return false;
  const tools = o["toolsUsed"];
  if (!Array.isArray(tools) || !tools.every((t) => typeof t === "string")) return false;
  return true;
}

/** 在归档根下定位一个归档目录："YYYY-MM-DD-xxx" 目录名或完整路径均可 */
function locateArchiveDir(idOrPath: string): string | null {
  const raw = idOrPath.trim();
  if (raw.length === 0) return null;

  // 完整路径：绝对路径或含分隔符
  if (path.isAbsolute(raw) || raw.includes("/") || raw.includes("\\")) {
    const resolved = path.resolve(raw);
    return isDirectory(resolved) ? resolved : null;
  }

  const root = slaveTrajectoryRoot();
  // 目录名以 YYYY-MM-DD- 开头 → 可直接推出月份目录
  const month = raw.slice(0, 7);
  if (/^\d{4}-\d{2}$/.test(month)) {
    const direct = path.join(root, month, raw);
    if (isDirectory(direct)) return direct;
  }

  // 回退：按月份倒序扫描（兼容非标准日期的目录名）
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    log.warn(`归档根目录不可读: ${root}`, describeError(err));
    return null;
  }
  const months = entries
    .filter((e) => e.isDirectory() && /^\d{4}-\d{2}$/.test(e.name))
    .map((e) => e.name)
    .sort()
    .reverse();
  for (const m of months) {
    const candidate = path.join(root, m, raw);
    if (isDirectory(candidate)) return candidate;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 对外 API                                                            */
/* ------------------------------------------------------------------ */

/** 归档根目录（供工具层展示） */
export function slaveTrajectoryRoot(): string {
  return path.join(os.homedir(), ".tinyclaw", "slaves");
}

/**
 * 归档一个 slave 的轨迹：把 sessionJsonlPath 移动到归档目录，
 * 写出 meta.json 与 result.md（result 全文，不截断）。
 * sessionJsonlPath 不存在时不抛错：只写 meta.json 与 result.md，并在 meta 里记录。
 *
 * 说明：reason 为可选入参（"completed" 正常完成 / "orphan" 进程重启后清理遗留），
 * 会原样写入 meta.json；不传时 meta 中不含该字段。
 */
export function archiveSlaveTrajectory(opts: {
  slaveId: string;
  agentId: string;
  task: string;
  masterSessionId: string;
  status: "done" | "error" | "aborted";
  startedAt: string;
  finishedAt: string;
  toolsUsed: string[];
  result: string;
  sessionJsonlPath: string;
  reason?: "completed" | "orphan";
}): ArchiveSlaveResult {
  const { month, date } = localDateParts(new Date());
  const monthDir = path.join(slaveTrajectoryRoot(), month);
  const baseName = `${date}-${sanitizeUniqueId(opts.slaveId)}`;
  const dir = allocateArchiveDir(monthDir, baseName);

  const trajectoryPath = path.join(dir, TRAJECTORY_FILE);
  const metaPath = path.join(dir, META_FILE);
  const resultPath = path.join(dir, RESULT_FILE);

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    log.error(`归档目录创建失败: ${dir}`, describeError(err));
  }

  let trajectoryBytes: number | undefined;
  let messageCount: number | undefined;

  if (fs.existsSync(opts.sessionJsonlPath)) {
    try {
      trajectoryBytes = fs.statSync(opts.sessionJsonlPath).size;
      const text = fs.readFileSync(opts.sessionJsonlPath, "utf8");
      messageCount = countJsonlMessages(text);
    } catch (err) {
      log.error(`读取源 session JSONL 失败: ${opts.sessionJsonlPath}`, describeError(err));
    }
    moveTrajectoryFile(opts.sessionJsonlPath, trajectoryPath, opts.slaveId);
  } else {
    // 源 JSONL 已不存在：只写 meta 与 result。meta 中缺省 trajectoryBytes / messageCount
    // 即为“轨迹缺失”的记录；此处额外打日志便于排查。
    log.warn(`源 session JSONL 不存在，跳过轨迹搬运: ${opts.sessionJsonlPath}`);
  }

  const meta: SlaveTrajectoryMeta = {
    slaveId: opts.slaveId,
    task: opts.task,
    agentId: opts.agentId,
    masterSessionId: opts.masterSessionId,
    status: opts.status,
    startedAt: opts.startedAt,
    finishedAt: opts.finishedAt,
    toolsUsed: [...opts.toolsUsed],
    ...(trajectoryBytes !== undefined ? { trajectoryBytes } : {}),
    ...(messageCount !== undefined ? { messageCount } : {}),
    ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
  };

  try {
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf8");
  } catch (err) {
    log.error(`meta.json 写入失败: ${metaPath}`, describeError(err));
  }

  try {
    // result 全文写入，不做任何截断
    fs.writeFileSync(resultPath, opts.result, "utf8");
  } catch (err) {
    log.error(`result.md 写入失败: ${resultPath}`, describeError(err));
  }

  log.info(`轨迹已归档 slave=${opts.slaveId} -> ${dir}`);
  return { dir, trajectoryPath, resultPath, metaPath };
}

/** 列出最近归档的轨迹（按归档目录名倒序），最多 limit 条。 */
export function listSlaveTrajectories(limit?: number): Array<{
  dir: string;
  date: string; // YYYY-MM-DD
  month: string; // YYYY-MM
  slaveId: string;
  meta: SlaveTrajectoryMeta | null; // meta.json 解析失败时为 null
}> {
  const max =
    limit !== undefined && Number.isFinite(limit) && limit > 0
      ? Math.floor(limit)
      : DEFAULT_LIST_LIMIT;

  const root = slaveTrajectoryRoot();
  let monthDirents: fs.Dirent[] = [];
  try {
    monthDirents = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    // 归档根目录可能尚未创建（首次归档之前）→ 空列表，不抛错
    log.warn(`归档根目录不可读: ${root}`, describeError(err));
    return [];
  }

  const found: Array<{ dir: string; name: string; month: string }> = [];
  for (const monthDirent of monthDirents) {
    if (!monthDirent.isDirectory()) continue;
    const month = monthDirent.name;
    if (!/^\d{4}-\d{2}$/.test(month)) continue;

    const monthDir = path.join(direntBaseDir(monthDirent, root), month);
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(monthDir, { withFileTypes: true });
    } catch (err) {
      log.warn(`月份归档目录不可读: ${monthDir}`, describeError(err));
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (!/^\d{4}-\d{2}-\d{2}-.+/.test(entry.name)) continue;
      found.push({ dir: path.join(monthDir, entry.name), name: entry.name, month });
    }
  }

  // 目录名以 YYYY-MM-DD 开头 → 直接按名字倒序即为时间倒序
  found.sort((a, b) =>
    a.name === b.name ? b.month.localeCompare(a.month) : b.name.localeCompare(a.name)
  );

  return found.slice(0, max).map((item) => {
    const meta = readMetaFile(path.join(item.dir, META_FILE));
    return {
      dir: item.dir,
      date: item.name.slice(0, 10),
      month: item.month,
      slaveId: meta?.slaveId ?? item.name.slice(11),
      meta,
    };
  });
}

/**
 * 读取某个归档的全文轨迹。
 * - 传目录名（如 "2026-09-10-a1b2c3d4"）或完整目录路径均可
 * - 找不到时返回 null
 * - includeResult=false 时只返回 trajectory.jsonl 内容
 */
export function readSlaveTrajectory(
  idOrPath: string,
  opts?: { includeResult?: boolean }
): { dir: string; trajectory: string; result: string } | null {
  const dir = locateArchiveDir(idOrPath);
  if (dir === null) {
    log.warn(`归档目录不存在: ${idOrPath}`);
    return null;
  }

  const includeResult = opts?.includeResult !== false;

  let trajectory = "";
  try {
    // 全文读取，不做任何截断
    trajectory = fs.readFileSync(path.join(dir, TRAJECTORY_FILE), "utf8");
  } catch (err) {
    log.warn(`轨迹读取失败: ${dir}`, describeError(err));
  }

  let result = "";
  if (includeResult) {
    try {
      // 全文读取，不做任何截断
      result = fs.readFileSync(path.join(dir, RESULT_FILE), "utf8");
    } catch (err) {
      log.warn(`result.md 读取失败: ${dir}`, describeError(err));
    }
  }

  return { dir, trajectory, result };
}
