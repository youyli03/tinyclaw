/**
 * journal — 会话原文账本（append-only，只追加、永不覆写）
 *
 * 为什么需要它：`session.jsonl` 是**视图 + 恢复源**二合一，压缩（`Session.compress()`）、
 * 剪枝（`pruneToolResults()`）、sanitize 都会**覆写**它。一旦覆写，原始对话就永久消失了，
 * 事后再想查"三个月前那句话"只剩 LLM 生成的摘要。
 *
 * 本模块把"原文"单独记一份账：
 *   - 写入点在 `Session._appendMsgToJsonl()`（每条消息落盘时同写一行）+
 *     `Session.updateToolResult()`（原地回填时补一条 patch 记录）；
 *   - 文件与 session JSONL 同目录同名，只多一个 `.journal` 段：
 *     `<sanitized>.jsonl` → `<sanitized>.journal.jsonl`；
 *   - 只追加、不重写、不删除（会话被删除时随之删除，见 `Session.deleteJsonl()`）。
 *
 * 设计约束（与 `docs/architecture/agent-loop.md` 的"前缀稳定"原则一致）：
 *   1. 每条记录带**单调 seq**，跨进程重启可从文件尾部续号；
 *   2. 记录内容在**写入时固化**：loop task 注入的 `<file>` 载荷会被展开后存下来，
 *      否则 TASK 文件被改写后，"当时发给模型的内容"就丢了；
 *   3. 任何失败都**不阻塞主流程**（best-effort），但会打 warning —— 原文不丢是本模块的唯一职责。
 *
 * 消费方：`memory_expand`（按 seq 区间取回原文）、`memory_recall`（词法检索）。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createLogger } from "../utils/logger.js";

/** 账本记录格式版本；结构变更时递增，读取端按版本兼容。 */
export const JOURNAL_VERSION = 1;

/** 账本相关的失败都必须可见：原文不丢是本模块的唯一职责，静默失败等于功能失效。 */
const log = createLogger("memory/journal");

/** 账本文件名后缀（插在 `.jsonl` 之前）。 */
export const JOURNAL_SUFFIX = ".journal.jsonl";

/** 一条消息记录：消息**首次落盘时**的原文快照。 */
export interface JournalMsgRecord {
  v: number;
  seq: number;
  kind: "msg";
  ts: string;
  role: string;
  msg: Record<string, unknown>;
}

/** 一次原地更新记录（`updateToolResult` 的回填：重启完成后把"正在重启"换成结果）。 */
export interface JournalPatchRecord {
  v: number;
  seq: number;
  kind: "patch";
  ts: string;
  callId: string;
  content: string;
}

export type JournalRecord = JournalMsgRecord | JournalPatchRecord;

/** 由 session JSONL 路径推导账本路径。 */
export function journalPathFor(jsonlPath: string): string {
  return jsonlPath.endsWith(".jsonl")
    ? `${jsonlPath.slice(0, -".jsonl".length)}${JOURNAL_SUFFIX}`
    : `${jsonlPath}${JOURNAL_SUFFIX}`;
}

// ── seq 分配 ─────────────────────────────────────────────────────────────────

/** path → 已分配到的最大 seq（进程内缓存；跨进程由文件尾部续号）。 */
const seqByPath = new Map<string, number>();

/** 从文件尾部（最多 64KB）找最后一条记录的 seq；文件不存在或读不到返回 0。 */
function lastSeqOnDisk(filePath: string): number {
  let fd: number | undefined;
  try {
    if (!fs.existsSync(filePath)) return 0; // 首次写入前的正常情况，不是错误
    const st = fs.statSync(filePath);
    const readBytes = Math.min(st.size, 64 * 1024);
    if (readBytes <= 0) return 0;
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(readBytes);
    fs.readSync(fd, buf, 0, readBytes, st.size - readBytes);
    const lines = buf.toString("utf-8").split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]?.trim();
      if (!line) continue;
      try {
        const rec = JSON.parse(line) as { seq?: unknown };
        if (typeof rec.seq === "number" && Number.isFinite(rec.seq)) return rec.seq;
      } catch {
        // 尾部可能是半行（进程被杀时截断），继续往前找上一条完整记录
      }
    }
  } catch (err) {
    log.warn("读取账本尾部失败", err);
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // close 失败无需处理（fd 会随进程回收）
      }
    }
  }
  return 0;
}

function nextSeq(filePath: string): number {
  const cached = seqByPath.get(filePath);
  const base = cached ?? lastSeqOnDisk(filePath);
  const next = base + 1;
  seqByPath.set(filePath, next);
  return next;
}

/** 首次写入时创建账本文件（0600：账本永久保留原文，比 JSONL 更值得收紧权限）。 */
function ensureJournalFile(filePath: string): void {
  if (fs.existsSync(filePath)) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "", { encoding: "utf-8", mode: 0o600 });
}

// ── 写入 ─────────────────────────────────────────────────────────────────────

/**
 * 把消息整理成账本快照：
 * - `_loopTaskRef` 是**文件路径**（`Session.addLoopTaskMessage()` 的语义），
 *   账本要存当时展开后的内容，否则 TASK 文件一改，历史 tick 的载荷就变了；
 * - 其余字段原样保留（tool_calls / reasoning_content / ContentPart[] 等）。
 */
function serializeForJournal(msg: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(msg)) {
    if (key === "_loopTaskRef") continue;
    out[key] = value;
  }
  const ref = msg["_loopTaskRef"];
  if (typeof ref === "string") {
    out["loop_task_ref"] = ref;
    try {
      out["content"] = fs.readFileSync(ref, "utf-8");
    } catch (err) {
      log.warn(`loop task 载荷展开失败（${ref}）`, err);
    }
  }
  return out;
}

/** 追加一条消息原文记录（best-effort，不抛异常）。 */
export function appendJournalMsg(jsonlPath: string, msg: Record<string, unknown>): void {
  try {
    const filePath = journalPathFor(jsonlPath);
    const record: JournalMsgRecord = {
      v: JOURNAL_VERSION,
      seq: nextSeq(filePath),
      kind: "msg",
      ts: new Date().toISOString(),
      role: typeof msg["role"] === "string" ? msg["role"] : "unknown",
      msg: serializeForJournal(msg),
    };
    ensureJournalFile(filePath);
    fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf-8");
  } catch (err) {
    log.warn("追加失败（本条原文未记账）", err);
  }
}

/** 追加一条"原地更新"记录（同一 callId 后来被补写内容时用）。 */
export function appendJournalPatch(jsonlPath: string, callId: string, content: string): void {
  try {
    const filePath = journalPathFor(jsonlPath);
    const record: JournalPatchRecord = {
      v: JOURNAL_VERSION,
      seq: nextSeq(filePath),
      kind: "patch",
      ts: new Date().toISOString(),
      callId,
      content,
    };
    ensureJournalFile(filePath);
    fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf-8");
  } catch (err) {
    log.warn("patch 追加失败", err);
  }
}

// ── 读取 ─────────────────────────────────────────────────────────────────────

/** 解析一行账本记录；非法行返回 undefined（旧版本残留 / 半行）。 */
export function parseJournalLine(line: string): JournalRecord | undefined {
  const trimmed = line.trim();
  if (!trimmed) return undefined;
  try {
    const rec = JSON.parse(trimmed) as Partial<JournalRecord> & { seq?: unknown };
    if (typeof rec.seq !== "number" || !Number.isFinite(rec.seq)) return undefined;
    if (rec.kind === "msg") {
      const msg = (rec as { msg?: unknown }).msg;
      if (msg === null || typeof msg !== "object") return undefined;
      return rec as JournalMsgRecord;
    }
    if (rec.kind === "patch") {
      if (typeof (rec as { callId?: unknown }).callId !== "string") return undefined;
      if (typeof (rec as { content?: unknown }).content !== "string") return undefined;
      return rec as JournalPatchRecord;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * 读取账本记录。
 * @param jsonlPath session JSONL 路径（内部换算成账本路径）
 * @param opts.maxBytes 只从文件尾部读这么多字节（默认 8MB，防止超大账本拖垮检索）
 */
export function readJournal(jsonlPath: string, opts: { maxBytes?: number } = {}): JournalRecord[] {
  return readJournalFile(journalPathFor(jsonlPath), opts);
}

/**
 * 直接按账本文件路径读取（`memory_recall` 跨会话扫描时已经拿到账本文件名）。
 * @param opts.maxBytes 只从文件尾部读这么多字节（默认 8MB，防止超大账本拖垮检索）
 */
export function readJournalFile(
  filePath: string,
  opts: { maxBytes?: number } = {}
): JournalRecord[] {
  const maxBytes = opts.maxBytes ?? 8 * 1024 * 1024;
  let fd: number | undefined;
  try {
    if (!fs.existsSync(filePath)) return [];
    const st = fs.statSync(filePath);
    if (st.size <= 0) return [];
    const start = Math.max(0, st.size - maxBytes);
    const len = st.size - start;
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    let text = buf.toString("utf-8");
    if (start > 0) {
      // 从中间读起时，首行可能是半行 → 丢掉
      const nl = text.indexOf("\n");
      text = nl >= 0 ? text.slice(nl + 1) : "";
    }
    const out: JournalRecord[] = [];
    for (const line of text.split("\n")) {
      const rec = parseJournalLine(line);
      if (rec) out.push(rec);
    }
    return out;
  } catch (err) {
    log.warn("读取失败", err);
    return [];
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // 同上：close 失败无需处理
      }
    }
  }
}

// ── 纯函数：文本化 / 匹配 / 摘录（供 memory_recall 复用，便于探针断言） ──────

/** 把一条记录摊平成可检索文本（patch 只含内容，msg 含 content + tool_calls 参数）。 */
export function journalRecordText(rec: JournalRecord): string {
  if (rec.kind === "patch") return rec.content;
  const msg = rec.msg;
  const parts: string[] = [];
  const content = msg["content"];
  if (typeof content === "string") parts.push(content);
  else if (Array.isArray(content)) {
    for (const p of content) {
      if (p !== null && typeof p === "object" && typeof (p as { text?: unknown }).text === "string") {
        parts.push((p as { text: string }).text);
      }
    }
  }
  const toolCalls = msg["tool_calls"];
  if (Array.isArray(toolCalls)) {
    for (const tc of toolCalls) {
      const fn = tc !== null && typeof tc === "object" ? (tc as { function?: unknown }).function : undefined;
      const args =
        fn !== null && typeof fn === "object" ? (fn as { arguments?: unknown }).arguments : undefined;
      if (typeof args === "string") parts.push(args);
    }
  }
  const reasoning = msg["reasoning_content"];
  if (typeof reasoning === "string") parts.push(reasoning);
  return parts.join("\n");
}

/** 全部关键词（空白分隔，大小写不敏感）都命中才算匹配；空关键词表返回 false。 */
export function matchesAllTerms(text: string, terms: readonly string[]): boolean {
  if (terms.length === 0) return false;
  const haystack = text.toLowerCase();
  return terms.every((t) => haystack.includes(t));
}

/** 把查询切成关键词（小写、去空）。 */
export function splitTerms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/** 取首个命中词周围的摘录窗口。 */
export function excerptAround(text: string, terms: readonly string[], width: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  if (oneLine.length <= width) return oneLine;
  const lower = oneLine.toLowerCase();
  let at = -1;
  for (const t of terms) {
    const idx = lower.indexOf(t);
    if (idx >= 0 && (at === -1 || idx < at)) at = idx;
  }
  if (at === -1) return `${oneLine.slice(0, width)}…`;
  const half = Math.floor(width / 2);
  const start = Math.max(0, at - half);
  const end = Math.min(oneLine.length, start + width);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < oneLine.length ? "…" : "";
  return `${prefix}${oneLine.slice(start, end)}${suffix}`;
}
