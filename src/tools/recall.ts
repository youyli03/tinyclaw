/**
 * 原文检索工具：`memory_expand`（按 seq 区间取回原文）+ `memory_recall`（词法检索历史原文）。
 *
 * 这两个工具消费 `src/memory/journal.ts` 写下的**原文账本**：`session.jsonl` 会被压缩/剪枝
 * 覆写，账本不会 —— 所以"三个月前那句话"仍然可以按序号取回、或按关键词搜到。
 *
 * 设计取舍：
 * - **只用词法匹配**（大小写不敏感、多关键词 AND），不依赖 embedding：
 *   `[memory].enabled` 默认 false，且向量检索对"原话定位"并不比词法准；纯词法也保证了
 *   同一输入永远同一输出（前缀缓存友好、可被探针断言）。
 * - **有界**：扫描文件数、总字节数、单文件读取窗口、返回条数都有硬上限，
 *   不会因为历史太长把一次工具调用拖死。
 * - 命中后只回**摘录**，模型需要全文时再 `memory_expand`（两段式，避免一次灌满上下文）。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { registerTool, type ToolContext } from "./registry.js";
import { checkReadPath } from "./path-guard.js";
import { Session } from "../core/session.js";
import { createLogger } from "../utils/logger.js";
import {
  JOURNAL_SUFFIX,
  excerptAround,
  journalPathFor,
  journalRecordText,
  matchesAllTerms,
  readJournalFile,
  splitTerms,
  type JournalRecord,
} from "../memory/journal.js";

/** 一次 recall 最多扫描的账本文件数。 */
const MAX_SCAN_FILES = 300;
/** 一次 recall 最多读取的总字节数（按文件顺序累计）。 */
const MAX_SCAN_BYTES = 24 * 1024 * 1024;
/** 单文件读取窗口：只读尾部这么多字节。 */
const PER_FILE_BYTES = 4 * 1024 * 1024;
/** 返回条数上限。 */
const MAX_HITS = 20;
/** 摘录宽度上限。 */
const MAX_EXCERPT_CHARS = 400;

/** 检索失败/降级要可见：这两个工具是"原文不丢"的出口，静默失效等于功能不存在。 */
const log = createLogger("tools/recall");

interface JournalFileRef {
  /** 直接给用户看的会话标签。 */
  label: string;
  filePath: string;
}

/**
 * readdir 的安全包装。
 * @param quiet true 时按 debug 记录：用于"该目录本来就可能不存在"的场景（例如 agent 没有 code 项目）
 */
function listDir(dir: string, label: string, quiet = false): string[] {
  try {
    return fs.readdirSync(dir);
  } catch (err) {
    if (quiet) log.debug(`${label}（预期可能不存在）: ${dir}`);
    else log.warn(`${label}读取失败: ${dir}`, err);
    return [];
  }
}

function listProjectJournalFiles(): JournalFileRef[] {
  const out: JournalFileRef[] = [];
  const agentsDir = path.join(os.homedir(), ".tinyclaw", "agents");
  for (const agentId of listDir(agentsDir, "agents 目录")) {
    const projectsDir = path.join(agentsDir, agentId, "code", "projects");
    for (const slug of listDir(projectsDir, "code 项目目录", true)) {
      const file = path.join(projectsDir, slug, `session${JOURNAL_SUFFIX}`);
      if (fs.existsSync(file)) out.push({ label: `${agentId}/${slug}`, filePath: file });
    }
  }
  return out;
}

/** 列出可检索的账本文件（当前会话优先，其余按 mtime 新的在前）。 */
function listJournalFiles(currentFile?: string): JournalFileRef[] {
  const refs: JournalFileRef[] = [];
  if (currentFile && fs.existsSync(currentFile)) {
    refs.push({ label: "当前会话", filePath: currentFile });
  }
  const sessionsDir = path.join(os.homedir(), ".tinyclaw", "sessions");
  for (const name of listDir(sessionsDir, "sessions 目录")) {
    if (!name.endsWith(JOURNAL_SUFFIX)) continue;
    const filePath = path.join(sessionsDir, name);
    if (filePath === currentFile) continue;
    refs.push({ label: name.slice(0, -JOURNAL_SUFFIX.length), filePath });
  }
  for (const ref of listProjectJournalFiles()) {
    if (ref.filePath !== currentFile) refs.push(ref);
  }
  // 当前会话永远排第一；其余按修改时间新的在前（只用于"超出预算时优先扫谁"，
  // 不参与任何正确性判断 —— 本机 mtime 精度不可靠，见 AGENTS.md §7.4）
  const head = refs[0]?.label === "当前会话" ? refs.shift() : undefined;
  const rest = refs
    .map((r) => {
      let mtime = 0; // stat 失败按最旧处理，不影响命中正确性
      try {
        mtime = fs.statSync(r.filePath).mtimeMs;
      } catch {
        log.debug(`stat 失败（按最旧排序）: ${r.filePath}`);
      }
      return { ref: r, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime)
    .map((x) => x.ref);
  return head ? [head, ...rest] : rest;
}

/** 解析当前会话的账本路径：优先用运行期注入的 JSONL 路径，其次按 sessionId 推导。 */
function resolveCurrentJournalPath(ctx?: ToolContext): string | undefined {
  if (ctx?.sessionJsonlPath) return journalPathFor(ctx.sessionJsonlPath);
  if (!ctx?.sessionId) return undefined;
  const mode = ctx.mode === "code" ? "code" : "chat";
  return journalPathFor(Session.getJsonlPath(ctx.sessionId, mode));
}

function recordLine(rec: JournalRecord): string {
  const ts = typeof rec.ts === "string" ? rec.ts : "";
  if (rec.kind === "patch") return `[seq ${rec.seq} · ${ts} · patch:${rec.callId}]`;
  return `[seq ${rec.seq} · ${ts} · ${rec.role}]`;
}

// ── memory_expand ────────────────────────────────────────────────────────────

function readNumber(args: Record<string, unknown>, key: string): number | undefined {
  const raw = args[key];
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string" && raw.trim() !== "") {
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

function readString(args: Record<string, unknown>, key: string): string | undefined {
  const raw = args[key];
  return typeof raw === "string" && raw.trim() !== "" ? raw.trim() : undefined;
}

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "memory_expand",
      description:
        "Read the ORIGINAL transcript of a session from the append-only journal, by message seq range. " +
        "Use this when a summary, a pruned tool result, or a compacted history range is not enough and you " +
        "need the verbatim text (or the exact tool output) from earlier. Seq numbers are visible in " +
        "memory_recall hits; without a range it returns the most recent records. " +
        "Prefer a narrow range: this reads raw text and can be large.",
      parameters: {
        type: "object",
        properties: {
          session: {
            type: "string",
            description:
              "Session id to expand. Omit for the current session. Other sessions are listed by memory_recall.",
          },
          from_seq: { type: "number", description: "First seq to include (default: latest records)." },
          to_seq: { type: "number", description: "Last seq to include." },
          limit: {
            type: "number",
            description: "Max records when no range is given (default 40, max 200).",
          },
          max_chars: {
            type: "number",
            description: "Output character budget (default 8000, max 40000).",
          },
        },
        required: [],
      },
    },
  },
  execute: async (args: Record<string, unknown>, ctx?: ToolContext): Promise<string> => {
    const sessionArg = readString(args, "session");
    let journalPath: string | undefined;
    if (sessionArg) {
      journalPath = journalPathFor(Session.getJsonlPath(sessionArg, "chat"));
      if (!fs.existsSync(journalPath)) {
        journalPath = journalPathFor(Session.getJsonlPath(sessionArg, "code"));
      }
    } else {
      journalPath = resolveCurrentJournalPath(ctx);
    }
    if (!journalPath) {
      return "错误：无法定位当前会话（缺少 sessionId）";
    }
    const guard = checkReadPath(journalPath);
    if (!guard.allow) return `已拒绝：${guard.reason}`;
    if (!fs.existsSync(journalPath)) {
      return (
        `该会话没有原文账本：${journalPath}\n` +
        "（账本随 [memory].journalEnabled 开启后才开始记录；开启前的历史只有 JSONL 视图）"
      );
    }

    const maxChars = Math.min(Math.max(readNumber(args, "max_chars") ?? 8000, 500), 40000);
    const limit = Math.min(Math.max(readNumber(args, "limit") ?? 40, 1), 200);
    const fromSeq = readNumber(args, "from_seq");
    const toSeq = readNumber(args, "to_seq");

    // 注意：这里已经是**账本文件**路径，必须用 readJournalFile；
    // 再用 readJournal（会二次拼接 .journal 后缀）会读不到任何记录
    const records = readJournalFile(journalPath);
    if (records.length === 0) return "账本为空（该会话还没有新消息写入）。";

    let picked: JournalRecord[];
    if (fromSeq !== undefined || toSeq !== undefined) {
      const lo = fromSeq ?? 0;
      const hi = toSeq ?? Number.POSITIVE_INFINITY;
      picked = records.filter((r) => r.seq >= lo && r.seq <= hi).slice(0, limit);
    } else {
      picked = records.slice(-limit);
    }
    if (picked.length === 0) return "该区间没有记录。";

    const header =
      `原文账本 ${journalPath}\n` +
      `区间 seq ${picked[0]!.seq}..${picked[picked.length - 1]!.seq}（共 ${picked.length} 条，` +
      `文件内 ${records.length} 条）\n`;
    const out: string[] = [header];
    let used = header.length;
    let cutAt: number | undefined;
    for (const rec of picked) {
      const body = rec.kind === "patch" ? rec.content : journalRecordText(rec);
      const block = `${recordLine(rec)}\n${body}\n`;
      if (used + block.length > maxChars) {
        cutAt = rec.seq;
        break;
      }
      out.push(block);
      used += block.length;
    }
    if (cutAt !== undefined) {
      out.push(
        `… 输出已达预算（${maxChars} 字符），seq ${cutAt} 起的记录未展开；` +
          `可用 from_seq=${cutAt} 继续读取。`
      );
    }
    return out.join("\n");
  },
});

// ── memory_recall ────────────────────────────────────────────────────────────

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "memory_recall",
      description:
        "Search the VERBATIM history of past conversations (append-only journals), keyword-based with " +
        "case-insensitive AND semantics. Complements `memory_search` (which searches distilled notes and " +
        "MEMORY files): use this when you need the actual words someone said, an exact past tool output, " +
        "or something that happened before the history was compacted. Returns excerpts with `seq` numbers; " +
        "pass them to `memory_expand` for the full text.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Keywords, whitespace separated. Every term must appear (case-insensitive).",
          },
          scope: {
            type: "string",
            enum: ["session", "all"],
            description:
              "'session' = current conversation only (default); 'all' = also scan other sessions of this machine.",
          },
          session: {
            type: "string",
            description: "Explicit session id to search instead of the current one.",
          },
          limit: { type: "number", description: "Max hits (default 5, max 20)." },
          excerpt_chars: { type: "number", description: "Excerpt width (default 160, max 400)." },
          since: { type: "string", description: "Only records at/after this ISO date-time." },
          until: { type: "string", description: "Only records at/before this ISO date-time." },
        },
        required: ["query"],
      },
    },
  },
  execute: async (args: Record<string, unknown>, ctx?: ToolContext): Promise<string> => {
    const query = readString(args, "query");
    if (!query) return "错误：query 不能为空";
    const terms = splitTerms(query);
    if (terms.length === 0) return "错误：query 不能为空";
    const limit = Math.min(Math.max(readNumber(args, "limit") ?? 5, 1), MAX_HITS);
    const excerptChars = Math.min(
      Math.max(readNumber(args, "excerpt_chars") ?? 160, 40),
      MAX_EXCERPT_CHARS
    );
    const since = readString(args, "since");
    const until = readString(args, "until");
    const scope = readString(args, "scope") === "all" ? "all" : "session";
    const sessionArg = readString(args, "session");

    let currentJournal: string | undefined;
    if (sessionArg) {
      currentJournal = journalPathFor(Session.getJsonlPath(sessionArg, "chat"));
      if (!fs.existsSync(currentJournal)) {
        currentJournal = journalPathFor(Session.getJsonlPath(sessionArg, "code"));
      }
    } else {
      currentJournal = resolveCurrentJournalPath(ctx);
    }

    if (scope === "session") {
      if (!currentJournal) return "错误：无法定位当前会话（缺少 sessionId）";
      const guard = checkReadPath(currentJournal);
      if (!guard.allow) return `已拒绝：${guard.reason}`;
      if (!fs.existsSync(currentJournal)) {
        return (
          `当前会话没有原文账本：${currentJournal}\n` +
          "（账本随 [memory] journalEnabled 开启后才开始记录；开启前的历史只有 JSONL 视图）"
        );
      }
    }

    const files =
      scope === "session"
        ? [{ label: "当前会话", filePath: currentJournal! }]
        : listJournalFiles(currentJournal);

    const hits: string[] = [];
    let scannedFiles = 0;
    let scannedBytes = 0;
    for (const ref of files) {
      if (hits.length >= limit) break;
      if (scannedFiles >= MAX_SCAN_FILES || scannedBytes >= MAX_SCAN_BYTES) break;
      const guard = checkReadPath(ref.filePath);
      if (!guard.allow) continue;
      const records = readJournalFile(ref.filePath, { maxBytes: PER_FILE_BYTES });
      scannedFiles += 1;
      try {
        scannedBytes += fs.statSync(ref.filePath).size;
      } catch {
        log.debug(`stat 失败（预算统计跳过）: ${ref.filePath}`);
      }
      for (const rec of records) {
        if (hits.length >= limit) break;
        if (since && rec.ts < since) continue;
        if (until && rec.ts > until) continue;
        const text = journalRecordText(rec);
        if (!matchesAllTerms(text, terms)) continue;
        hits.push(
          `${hits.length + 1}. ${recordLine(rec)} · ${ref.label}\n   ${excerptAround(text, terms, excerptChars)}`
        );
      }
    }

    const head =
      `原文检索「${query}」（范围：${scope === "all" ? "本机全部会话" : "当前会话"}；` +
      `扫描 ${scannedFiles} 个账本 ≈ ${(scannedBytes / 1024 / 1024).toFixed(1)}MB）\n`;
    if (hits.length === 0) {
      return (
        `${head}没有命中。\n` +
        "（可换关键词；账本只覆盖开启 journal 之后的消息。若已装了向量记忆，也可用 memory_search 找蒸馏后的笔记。）"
      );
    }
    return (
      `${head}命中 ${hits.length} 条：\n\n${hits.join("\n\n")}\n\n` +
      "需要完整原文时用 `memory_expand`（带 session + from_seq/to_seq）。"
    );
  },
});
