/**
 * MEMORY.md 条目时间衰减评分引擎。
 *
 * 从 Project 记忆(MEMORY.md)中解析条目,按衰减公式计算分数,返回 Top-N。
 * 公式: score = stability / 10 × 2^(-daysSinceCreation / halfLife)
 *
 * 条目格式: - [YYYY-MM-DD] [s:N] 摘要 → topic.md
 *   - [s:N] 为可选的稳定性标注,缺失时按 topic 默认值
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

// ── Types ────────────────────────────────────────────────────────────────────

export interface ScoredEntry {
  /** 原始行 */
  line: string;
  /** 稳定性(1-10) */
  stability: number;
  /** 创建日期距今天数 */
  daysSince: number;
  /** 衰减分数 */
  score: number;
}

// ── Regex ────────────────────────────────────────────────────────────────────

/**
 * 匹配 MEMORY.md 条目:
 * - [YYYY-MM-DD] [s:N] 摘要 → topic.md
 * - [YYYY-MM-DD] 摘要 → topic.md  (无 stability 标注)
 * - [YYYY-MM-DD] [s:N] 摘要       (无 topic 指向)
 */
const ENTRY_RE =
  /^- \[(\d{4}-\d{2}-\d{2})\]\s*(?:\[s:(\d+)\]\s*)?(.+?)(?:\s*→\s*(\S+\.md))?$/gm;

// ── Topic 推断 ──────────────────────────────────────────────────────────────

/** 从条目摘要或 topic 文件名推断 topic 类型 */
function inferTopic(line: string, topicFile?: string): string {
  if (topicFile) {
    const base = topicFile.replace(/\.md$/, "").toLowerCase();
    if (TOPIC_HALF_LIFE[base] !== undefined) return base;
  }

  // 从分区标题/关键词推断
  const lower = line.toLowerCase();
  if (lower.includes("约束") || lower.includes("constraint")) return "constraints";
  if (lower.includes("架构") || lower.includes("architect")) return "architecture";
  if (lower.includes("决策") || lower.includes("decision")) return "decisions";
  if (lower.includes("bug") || lower.includes("问题")) return "bugs";
  if (lower.includes("进度") || lower.includes("progress")) return "progress";

  return "*";
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * 解析 MEMORY.md 全文,为每个条目计算衰减分数。
 */
export function scoreEntries(memoryContent: string, now: Date = new Date()): ScoredEntry[] {
  const entries: ScoredEntry[] = [];
  const regex = new RegExp(ENTRY_RE.source, "gm");

  let match: RegExpExecArray | null;
  while ((match = regex.exec(memoryContent)) !== null) {
    const dateStr = match[1]!;
    const stabilityStr = match[2];
    const summary = match[3]!;
    const topicFile = match[4];

    // 解析日期
    const ts = new Date(dateStr);
    if (isNaN(ts.getTime())) continue;
    const daysSince = Math.max(0, (now.getTime() - ts.getTime()) / (1000 * 60 * 60 * 24));

    // 解析 stability
    let stability: number;
    if (stabilityStr) {
      stability = Math.min(10, Math.max(1, parseInt(stabilityStr, 10) || DEFAULT_STABILITY));
    } else {
      const topic = inferTopic(summary, topicFile);
      stability = TOPIC_DEFAULT_STABILITY[topic] ?? DEFAULT_STABILITY;
    }

    // 查半衰期
    const topic = inferTopic(summary, topicFile);
    const halfLife = TOPIC_HALF_LIFE[topic] ?? DEFAULT_HALF_LIFE;

    // 计算分数
    const decay = Math.pow(2, -daysSince / halfLife);
    const score = (stability / 10) * decay;

    entries.push({
      line: match[0].trim(),
      stability,
      daysSince,
      score,
    });
  }

  return entries;
}

/**
 * 对 MEMORY.md 内容做评分+截断,返回 Top-N 的条目文本。
 * 保持原分区结构:先按分区拆分,每个分区内条目独立评分排序,最后拼接。
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

  // 按 score 排序,取 Top-N
  entries.sort((a, b) => b.score - a.score);
  const topLines = new Set(entries.slice(0, maxEntries).map((e) => e.line));

  // 保持原结构和分区标题
  const lines = memoryContent.split("\n");
  const result: string[] = [];
  let kept = 0;
  let truncated = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    // 分区标题(## xxx) 或空行保留
    if (trimmed.startsWith("## ") || trimmed === "") {
      result.push(line);
      continue;
    }
    // 条目行:检查是否在 Top-N
    if (trimmed.startsWith("- [20")) {
      if (topLines.has(trimmed)) {
        result.push(line);
        kept++;
      } else {
        truncated++;
        continue;
      }
    } else {
      // 非条目行(如注释、说明)保留
      result.push(line);
    }
  }

  if (truncated > 0) {
    result.push(
      "",
      `<!-- ${truncated} 条低分记忆未注入(可通过 code_note_search/code_note_read 检索) -->`
    );
  }

  return result.join("\n");
}
