/**
 * edit_file 纯函数核心层:字符串定位/容错/诊断,无 fs/path/MFA 依赖,可单测。
 *
 * 容错链:精确匹配 → 全角/半角标点归一化 + U+2026 省略号展开 → 首尾空白 trim → 失败诊断。
 */

/** 全角标点 -> 半角(1:1 码元映射,长度不变),用于 edit_file 容错定位 */
export const FULL_TO_HALF_PUNCT: Record<string, string> = {
  "（": "(", // U+FF08
  "）": ")", // U+FF09
  "，": ",", // U+FF0C
  "。": ".",
  "；": ";", // U+FF1B
  "：": ":", // U+FF1A
  "！": "!", // U+FF01
  "？": "?", // U+FF1F
  "、": ",",
  "　": " ", // U+3000 全角空格
  "“": '"', // U+201C
  "”": '"', // U+201D
  "‘": "'", // U+2018
  "’": "'", // U+2019
  "—": "-", // U+2014 em dash(1:1)
  "–": "-", // U+2013 en dash(1:1)
  // 注意:...(U+2026) 为 1 个码元,展开为 "..." 会改变长度,不能放进 1:1 映射表,
  // 由 expandEllipsis 在归一化匹配路径单独处理
};

/** 省略号展开:U+2026 → "..."(长度 1→3,仅用于归一化匹配,命中后偏移需 unexpandPos 换算) */
function expandEllipsis(s: string): string {
  return s.replace(/\u2026/g, "...");
}

/**
 * 把"展开省略号后文本"中的位置映射回原文本位置。
 * 原文本中每个 U+2026 展开后占 3 字符,故展开坐标 = 原坐标 + 2×前缀省略号数。
 */
function unexpandPos(orig: string, expandedPos: number): number {
  let len = 0;
  for (let i = 0; i < orig.length; i++) {
    const w = orig.charCodeAt(i) === 0x2026 ? 3 : 1;
    if (len + w > expandedPos) return i; // 落在 U+2026 展开的中间,返回其起始
    len += w;
    if (len === expandedPos) return i + 1;
  }
  return orig.length;
}

/** 全角标点 → 半角(1:1,长度不变);未知字符原样保留 */
export function normalizePunct(s: string): string {
  let out = "";
  for (const ch of s) out += FULL_TO_HALF_PUNCT[ch] ?? ch;
  return out;
}

/** 返回 needle 在 content 中的所有出现位置 */
function findAllPositions(content: string, needle: string): number[] {
  const positions: number[] = [];
  let idx = content.indexOf(needle);
  while (idx !== -1) {
    positions.push(idx);
    idx = content.indexOf(needle, idx + 1);
  }
  return positions;
}

export type EditResult =
  | { status: "ok"; content: string; note?: string }
  | { status: "ambiguous"; message: string }
  | { status: "notfound"; message: string };

/** 精确替换:needle 唯一命中则替换,多处命中返回 ambiguous,零命中返回 null */
function tryReplace(content: string, needle: string, newStr: string, note: string): EditResult | null {
  const positions = findAllPositions(content, needle);
  if (positions.length === 1) {
    const pos = positions[0] as number;
    return {
      status: "ok",
      content: content.slice(0, pos) + newStr + content.slice(pos + needle.length),
      note,
    };
  }
  if (positions.length > 1) {
    return {
      status: "ambiguous",
      message: `错误:old_str 在文件中出现 ${positions.length} 次(按归一化匹配),必须唯一才能安全替换。请提供更多上下文使其唯一`,
    };
  }
  return null;
}

/** 归一化替换:needle 为归一化文本,命中后把展开坐标换算回原文本坐标再替换 */
function tryReplaceNorm(
  content: string,
  normContent: string,
  normNeedle: string,
  newStr: string,
  note: string,
): EditResult | null {
  const positions = findAllPositions(normContent, normNeedle);
  if (positions.length === 1) {
    const startExp = positions[0] as number;
    const endExp = startExp + normNeedle.length;
    const start = unexpandPos(content, startExp);
    const end = unexpandPos(content, endExp);
    return {
      status: "ok",
      content: content.slice(0, start) + newStr + content.slice(end),
      note,
    };
  }
  if (positions.length > 1) {
    return {
      status: "ambiguous",
      message: `错误:old_str 在文件中出现 ${positions.length} 次(按归一化匹配),必须唯一才能安全替换。请提供更多上下文使其唯一`,
    };
  }
  return null;
}

/**
 * 未匹配时的诊断:在(归一化)文件中找与 oldStr 最相似的片段,报告位置与首个差异字符。
 *
 * 锚点选择:跳过前导空白,用第一个非空白字符定位候选——
 * 代码/日志文件中空格出现过于频繁,用 oldStr[0] 作锚会在 500 候选限制内找不到真实位置,
 * 导致诊断指向无关行(历史上多次误导排查)。比较从锚点对齐开始,前导空白差异不计入 diff。
 */
export function closestMatchDiagnostic(normContent: string, normOld: string): string {
  const len = normOld.length;
  if (!len || !normContent.length) return "";
  let anchor = 0;
  while (anchor < len && /\s/.test(normOld[anchor] ?? "")) anchor++;
  if (anchor >= len) anchor = 0; // 全空白:fallback 从头开始
  // 多字符锚延伸:单字符锚在 content 中太频繁(>200 候选)时逐步加长,
  // 避免 500 候选限制内找不到真实位置(如 'c' 在 2000 行文件中出现数千次)
  let anchorLen = 1;
  while (anchorLen < Math.min(8, len - anchor)) {
    const probe = normOld.slice(anchor, anchor + anchorLen);
    let count = 0;
    let i = normContent.indexOf(probe);
    while (i !== -1 && count <= 200) {
      count++;
      i = normContent.indexOf(probe, i + 1);
    }
    if (count <= 200) break;
    anchorLen++;
  }
  const first = normOld.slice(anchor, anchor + anchorLen);
  let bestPos = -1;
  let bestDiff = Infinity;
  let idx = normContent.indexOf(first);
  let candidates = 0;
  while (idx !== -1 && candidates < 500) {
    candidates++;
    let diff = 0;
    // 从锚尾开始比较(锚部分已由 indexOf 保证一致),前导空白差异不计入 diff
    for (let j = anchor + anchorLen; j < len && idx + (j - anchor) < normContent.length; j++) {
      if (normContent[idx + (j - anchor)] !== normOld[j]) diff++;
      if (diff >= bestDiff) break;
    }
    if (diff < bestDiff) {
      bestDiff = diff;
      bestPos = Math.max(0, idx - anchor); // 回退到 oldStr 开头对齐位置(含前导空白)
    }
    idx = normContent.indexOf(first, idx + 1);
  }
  if (bestPos < 0) return "";
  const bp = bestPos;
  const lineNo = normContent.slice(0, bp).split("\n").length;
  const snippet = normContent.slice(bp, bp + Math.min(len, 60)).replace(/\n/g, "\\n");
  let detail = "";
  for (let j = anchor; j < len && bp + j < normContent.length; j++) {
    const fc = normContent[bp + j] ?? "";
    const sc = normOld[j] ?? "";
    if (fc !== sc) {
      const fcHex = fc.codePointAt(0)?.toString(16).toUpperCase() ?? "?";
      const scHex = sc.codePointAt(0)?.toString(16).toUpperCase() ?? "?";
      detail = `;首个差异字符(第${j + 1}位):文件中是「${fc}」(U+${fcHex}),你提供的是「${sc}」(U+${scHex})`;
      break;
    }
  }
  return `文件中与之最接近的片段在第 ${lineNo} 行附近:"${snippet}"${detail}`;
}

/** 失败消息 + `\n` JSON 转义陷阱提示 */
function buildNotFoundMessage(oldStr: string, diag: string): string {
  let msg = `错误:old_str 在文件中未找到(已尝试全角/半角标点归一化匹配)。${diag}\n请检查是否完全匹配(含空格、换行、全角/半角标点)`;
  if (oldStr.includes("\n")) {
    msg += `\n提示:old_str 包含真实换行符。若你的目标文本是字符串常量里的字面 \\n(反斜杠+n 两字符),请把 old_str 中的换行改为反斜杠+n 两字符`;
  }
  if (oldStr.includes("\\n")) {
    msg += `\n提示:old_str 包含字面 \\n 两字符。若你想表达真实换行,请直接在 old_str 中输出换行符`;
  }
  return msg;
}

/**
 * trim 容错替换:oldStr 首尾空白与文件有差异时也能定位。
 * 替换范围向两侧扩展 min(oldStr 被 trim 的空白数, 文件对应空白数),
 * 使 newStr 顶掉相同数量的空白——避免"文件 2 空格缩进 + newStr 2 空格 = 4 空格"式叠加。
 */
function tryReplaceTrimmed(
  content: string,
  oldStr: string,
  trimmed: string,
  newStr: string,
  note: string,
): EditResult | null {
  const positions = findAllPositions(content, trimmed);
  if (positions.length !== 1) {
    if (positions.length > 1) {
      return {
        status: "ambiguous",
        message: `错误:old_str 在文件中出现 ${positions.length} 次(按归一化匹配),必须唯一才能安全替换。请提供更多上下文使其唯一`,
      };
    }
    return null;
  }
  const pos = positions[0] as number;
  const oldLead = oldStr.length - oldStr.trimStart().length;
  const oldTrail = oldStr.length - oldStr.trimEnd().length;
  let lead = 0;
  for (let i = pos - 1; i >= 0 && /\s/.test(content[i] ?? ""); i--) lead++;
  let trail = 0;
  for (let i = pos + trimmed.length; i < content.length && /\s/.test(content[i] ?? ""); i++) trail++;
  const start = pos - Math.min(oldLead, lead);
  const end = pos + trimmed.length + Math.min(oldTrail, trail);
  return { status: "ok", content: content.slice(0, start) + newStr + content.slice(end), note };
}

/**
 * 核心编排:在 content 中定位 oldStr 并替换为 newStr(纯函数,不碰文件系统)。
 *
 * 匹配链:精确 → 归一化(全角/半角 + 省略号) → trim 首尾空白 → trim+归一化 → 失败诊断。
 */
export function locateAndReplace(content: string, oldStr: string, newStr: string): EditResult {
  // 1) 精确匹配
  const exact = tryReplace(content, oldStr, newStr, "");
  if (exact) return exact;

  // 2) 归一化匹配(全角/半角标点 + U+2026 省略号)
  const normOld = normalizePunct(expandEllipsis(oldStr));
  const normContent = normalizePunct(expandEllipsis(content));
  if (normOld !== oldStr || normContent !== content) {
    const norm = tryReplaceNorm(content, normContent, normOld, newStr, "已按全角/半角标点或省略号归一化匹配定位");
    if (norm) return norm;
  }

  // 3) 首尾空白差异重试(AI 常多复制/漏复制末尾换行或空格)
  const trimmed = oldStr.trim();
  if (trimmed && trimmed !== oldStr) {
    const t = tryReplaceTrimmed(content, oldStr, trimmed, newStr, "已去除 old_str 首尾空白差异");
    if (t) return t;
    const normTrimmed = normalizePunct(expandEllipsis(trimmed));
    if (normTrimmed !== trimmed) {
      const tn = tryReplaceNorm(content, normContent, normTrimmed, newStr, "已去除首尾空白并按归一化匹配定位");
      if (tn) return tn;
    }
  }

  // 4) 失败诊断(基于归一化文本,行号与原始一致)
  const diag = closestMatchDiagnostic(normContent, normOld);
  return { status: "notfound", message: buildNotFoundMessage(oldStr, diag) };
}
