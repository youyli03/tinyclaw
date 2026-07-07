/**
 * MEMORY.md 条目时间衰减评分引擎。
 *
 * 从 Project 记忆(MEMORY.md)中解析条目,按衰减公式计算分数,返回 Top-N。
 * 公式: score = stability / 10 × 2^(-daysSinceCreation / halfLife)
 *
 * MEMORY.md 实际格式(2026-07 架构迁移后):
 *   ### 2026-07-06
 *   - [决策] [s:9] 摘要
 *     → decisions.md
 *   - [进度] [s:5] 摘要
 *     → progress.md
 *
 * 日期在 ##/### 标题中,类型在 [类型] 括号中,topic 在缩进续行中。
 */

// ── 按 topic 差异化的半衰期(天) ────────────────────────────────────────────

const TOPIC_HALF_LIFE: Record<string, number> = {
  constraints: 180,    // 项目约束,高度稳定
  architecture: 90,    // 架构理解
  decisions: 60,       // 设计决策
  bugs: 30,            // bug 跟踪
  progress: 14,        // 进度更新,快速迭代
};

/** 未知 topic 的默认半衰期 */
const DEFAULT_HALF_LIFE = 45;

// ── 按 topic 默认 stability(无 [s:N] 标注时) ──────────────────────────────

const TOPIC_DEFAULT_STABILITY: Record<string, number> = {
  constraints: 9,
  architecture: 7,
  decisions: 6,
  bugs: 5,
  progress: 4,
};

const DEFAULT_STABILITY = 5;

// ── 类型标记 → topic 映射 ──────────────────────────────────────────────────

/** [类型] 方括号中的中文标签到标准 topic 名的映射 */
const TYPE_TO_TOPIC: Record<string, string> = {
  "决策": "decisions",
  "进度": "progress",
  "问题": "bugs",
  "探讨": "decisions",
  "约束": "constraints",
  "架构": "architecture",
  "decision": "decisions",
  "progress": "progress",
  "bug": "bugs",
  "constraint": "constraints",
};

// ── Types ────────────────────────────────────────────────────────────────────

export interface ScoredEntry {
  /** 原始行(条目首行) */
  line: string;
  /** 稳定性(1-10) */
  stability: number;
  /** 创建日期距今天数 */
  daysSince: number;
  /** 衰减分数 */
  score: number;
}

/** 解析过程中的原始条目(未评分) */
interface RawEntry {
  dateStr: string;
  typeTag: string;
  stabilityStr?: string | undefined;
  summary: string;
  topicFile?: string | undefined;
  firstLine: string;
}

// ── Regex ────────────────────────────────────────────────────────────────────

/** 匹配日期分区标题: "### 2026-07-06" 或 "### 2026-07" */
const DATE_HEADING_RE = /^#{2,3}\s+(\d{4}-\d{2}(?:-\d{2})?)\s*$/;

/** 匹配条目首行: "- [类型] [s:N] 摘要" */
const ENTRY_LINE_RE = /^- \[(\S+?)\]\s*(?:\[s:(\d+)\]\s*)?(.+)$/;

/** 匹配续行: "  → topic.md" 或 "  → topic.md (注释)" */
const CONTINUATION_RE = /^\s+→\s+(\S+\.md)/;

// ── Topic 推断 ──────────────────────────────────────────────────────────────

/**
 * 从类型标签、摘要文本、topic 文件名推断标准 topic 名。
 * 优先级: topicFile basename > typeTag 映射 > 摘要关键词
 */
function inferTopic(typeTag: string, summary: string, topicFile?: string): string {
  // 1. topic 文件名直接映射
  if (topicFile) {
    const base = topicFile.replace(/\.md$/, "").toLowerCase();
    if (TOPIC_HALF_LIFE[base] !== undefined) return base;
  }

  // 2. 类型标签直接映射
  if (typeTag) {
    const mapped = TYPE_TO_TOPIC[typeTag];
    if (mapped && TOPIC_HALF_LIFE[mapped] !== undefined) return mapped;
  }

  // 3. 摘要关键词 fallback
  const lower = summary.toLowerCase();
  if (lower.includes("约束") || lower.includes("constraint")) return "constraints";
  if (lower.includes("架构") || lower.includes("architect")) return "architecture";
  if (lower.includes("决策") || lower.includes("decision")) return "decisions";
  if (lower.includes("bug") || lower.includes("问题")) return "bugs";
  if (lower.includes("进度") || lower.includes("progress")) return "progress";

  return "*";
}

// ── 逐行解析 ────────────────────────────────────────────────────────────────

/**
 * 从 MEMORY.md 文本逐行解析出原始条目列表(不评分)。
 * 日期从 `### YYYY-MM-DD` 标题读取,条目首行 `- [类型] [s:N] 摘要`,
 * 续行 `  → topic.md`。
 */
function parseRawEntries(memoryContent: string): RawEntry[] {
  const lines = memoryContent.split("\n");
  const entries: RawEntry[] = [];
  let currentDate = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();

    // 日期标题
    const dateMatch = trimmed.match(DATE_HEADING_RE);
    if (dateMatch) {
      currentDate = dateMatch[1]!;
      // 若只有 YYYY-MM,补齐为当月 1 号
      if (currentDate.length === 7) {
        currentDate += "-01";
      }
      continue;
    }

    // 跳过空日期区段(文件开头的分区占位符 `## ⛔ 约束` 不包含日期)
    if (!currentDate) continue;

    // 条目首行: "- [类型] [s:N] 摘要"
    const entryMatch = trimmed.match(ENTRY_LINE_RE);
    if (entryMatch) {
      const typeTag = entryMatch[1]!;
      const stabilityStr = entryMatch[2];
      const summary = entryMatch[3]!.trim();

      // 检查下一行是否为续行
      let topicFile: string | undefined;
      if (i + 1 < lines.length) {
        const nextLine = lines[i + 1]!;
        const contMatch = nextLine.match(CONTINUATION_RE);
        if (contMatch) {
          topicFile = contMatch[1];
        }
      }

      entries.push({
        dateStr: currentDate,
        typeTag,
        stabilityStr,
        summary,
        topicFile,
        firstLine: trimmed,
      });
    }
  }

  return entries;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * 解析 MEMORY.md 全文,为每个条目计算衰减分数。
 */
export function scoreEntries(memoryContent: string, now: Date = new Date()): ScoredEntry[] {
  const rawEntries = parseRawEntries(memoryContent);
  const scored: ScoredEntry[] = [];

  for (const raw of rawEntries) {
    // 解析日期
    const ts = new Date(raw.dateStr);
    if (isNaN(ts.getTime())) continue;
    const daysSince = Math.max(0, (now.getTime() - ts.getTime()) / (1000 * 60 * 60 * 24));

    // 推断 topic
    const topic = inferTopic(raw.typeTag, raw.summary, raw.topicFile);

    // 解析 stability
    let stability: number;
    if (raw.stabilityStr) {
      stability = Math.min(10, Math.max(1, parseInt(raw.stabilityStr, 10) || DEFAULT_STABILITY));
    } else {
      stability = TOPIC_DEFAULT_STABILITY[topic] ?? DEFAULT_STABILITY;
    }

    // 查半衰期
    const halfLife = TOPIC_HALF_LIFE[topic] ?? DEFAULT_HALF_LIFE;

    // 计算分数
    const decay = Math.pow(2, -daysSince / halfLife);
    const score = (stability / 10) * decay;

    scored.push({
      line: raw.firstLine,
      stability,
      daysSince,
      score,
    });
  }

  return scored;
}

/**
 * 对 MEMORY.md 内容做评分+截断,返回 Top-N 的条目文本。
 * 保持原分区结构:日期标题 + 分区标题保留,低分条目行被移除。
 * 被保留条目的续行(→ topic.md)一并保留,被移除条目的续行一并移除。
 */
export function injectScoredEntries(
  memoryContent: string,
  maxEntries: number,
  now?: Date
): string {
  const entries = scoreEntries(memoryContent, now);

  if (entries.length <= maxEntries) {
    return memoryContent; // 无需截断
  }

  // 按 score 降序,取 Top-N
  entries.sort((a, b) => b.score - a.score);
  const topLines = new Set(entries.slice(0, maxEntries).map((e) => e.line));

  // 重建输出,保持原结构
  const lines = memoryContent.split("\n");
  const result: string[] = [];
  let truncated = 0;
  let inKeptEntry = false; // 当前是否在保留条目的续行区域

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();

    // ── 日期标题(### YYYY-MM-DD) —— 必须优先于泛用 ## 检查 ──
    if (DATE_HEADING_RE.test(trimmed)) {
      result.push(line);
      inKeptEntry = false;
      continue;
    }

    // ── 分区标题 / 注释 / 空行 / 引用 —— 无条件保留 ──
    if (
      trimmed.startsWith("##") ||
      trimmed.startsWith("<!--") ||
      trimmed === "" ||
      trimmed.startsWith("> ")
    ) {
      result.push(line);
      inKeptEntry = false;
      continue;
    }

    // ── 条目首行: "- [类型] [s:N] 摘要" ──
    const entryMatch = trimmed.match(ENTRY_LINE_RE);
    if (entryMatch) {
      if (topLines.has(trimmed)) {
        result.push(line);
        inKeptEntry = true;
      } else {
        truncated++;
        inKeptEntry = false;
      }
      continue;
    }

    // ── 续行: "  → topic.md" (用原始行检查,trimmed 会去掉前导空格) ──
    if (CONTINUATION_RE.test(line)) {
      if (inKeptEntry) {
        result.push(line);
      }
      // 被截断条目的续行静默跳过
      continue;
    }

    // ── 其他行(文件头注释等)保留 ──
    result.push(line);
  }

  if (truncated > 0) {
    result.push(
      "",
      `<!-- ${truncated} 条低分记忆未注入(可通过 code_note_search/code_note_read 检索) -->`
    );
  }

  return result.join("\n");
}
