/**
 * mem-budget — MEM.md 的**预算化注入**渲染。
 *
 * 背景：MEM.md 会整篇拼进 system prompt（`buildSystemPrompt()`），而它是**长期只增**的
 * 累积文件（本机 `default` agent 已达 4 万+字符 ≈ 1 万多 token，**每一次 LLM 调用都在付**）。
 * 本模块把"注入哪一部分"变成一条确定性规则：
 *
 *   1. 章节按固定优先级排序（用户偏好 > 踩坑记录 > 当前任务 > 常用技能 > 已完成大事 > 近期变更）；
 *   2. 按原始文件顺序输出（章节顺序是 distill prompt 约束的一部分，不能打乱）；
 *   3. 预算内整段保留；放不下的段按"日志类取尾部 / 陈述类取头部"切片，并留下省略提示；
 *   4. 输出**完全由 (文件内容, 预算) 决定**，与时间/随机/环境无关 —— 同一份 MEM.md 永远渲染出同一串字节，
 *      这样 system prompt 前缀才不会因为"今天多写了一条日志"而整体抖动。
 *
 * 完整内容始终可通过 `memory_read_mem` 读取；被省略的段落不会从磁盘上消失。
 */

/**
 * MEM.md 的固定章节名（**数据键，永远不要翻译或改写**）。
 * 单一真相：`src/core/memory-maintenance.ts` 的 distill 校验也从这里取。
 */
export const MEM_SECTION_KEYS = [
  "👤 用户偏好",
  "🎯 当前任务",
  "🗂️ 常用技能与任务",
  "🐛 踩坑记录",
  "✅ 已完成大事",
  "📝 近期变更",
] as const;

/**
 * 注入优先级（越靠前越先占用预算）。
 * 不在此列的自定义章节排在最后，按文件顺序处理 —— 不会被丢弃，只会先被压缩。
 */
export const MEM_SECTION_PRIORITY: readonly string[] = [
  "👤 用户偏好",
  "🐛 踩坑记录",
  "🎯 当前任务",
  "🗂️ 常用技能与任务",
  "✅ 已完成大事",
  "📝 近期变更",
];

/** 日志型章节：条目按时间追加，**最新的在尾部**，因此预算不足时保留尾部。 */
const TAIL_KEEP_SECTIONS: readonly string[] = ["📝 近期变更", "🐛 踩坑记录", "✅ 已完成大事"];

/** 单个章节切片后至少要留这么多字符，否则宁可不切（避免只剩标题的碎片）。 */
const MIN_SLICE_CHARS = 200;

export interface MemRenderResult {
  /** 注入 system prompt 的正文（含省略提示，若有）。 */
  text: string;
  /** 是否发生了省略。 */
  truncated: boolean;
  /** 被省略的总行数（用于日志与探针）。 */
  omittedLines: number;
  /** 实际完整保留的章节标题。 */
  keptSections: string[];
}

interface MemSection {
  title: string;
  /** 标题行 + 正文行（不含结尾换行）。 */
  lines: string[];
  /** 在文件中的出现顺序。 */
  index: number;
}

function parseSections(raw: string): { preamble: string[]; sections: MemSection[] } {
  const lines = raw.replace(/\s+$/, "").split("\n");
  const preamble: string[] = [];
  const sections: MemSection[] = [];
  let current: MemSection | undefined;

  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m && m[1]) {
      current = { title: m[1], lines: [line], index: sections.length };
      sections.push(current);
      continue;
    }
    if (current) current.lines.push(line);
    else preamble.push(line);
  }
  return { preamble, sections };
}

function priorityOf(title: string): number {
  const idx = MEM_SECTION_PRIORITY.indexOf(title);
  // 未知章节排在所有已知章节之后，但仍按文件顺序处理
  return idx === -1 ? MEM_SECTION_PRIORITY.length : idx;
}

function joinLines(lines: readonly string[]): string {
  return lines.join("\n");
}

function omittedNote(lines: number): string {
  return `- … (${lines} more line(s) omitted here; call \`memory_read_mem\` for the full MEM.md)`;
}

function topNote(omittedLines: number): string {
  return (
    `> Note: this is a budgeted view of MEM.md (${omittedLines} line(s) omitted to bound context cost). ` +
    "Section order and wording are unchanged. Call `memory_read_mem` for the full file before relying on " +
    "anything that looks missing."
  );
}

/**
 * 按预算渲染 MEM.md。
 * @param raw MEM.md 原始内容
 * @param maxChars 注入正文的字符预算（<=0 或未设置时不做裁剪）
 */
export function renderMemForPrompt(raw: string, maxChars: number): MemRenderResult {
  const content = raw.replace(/\s+$/, "");
  if (!Number.isFinite(maxChars) || maxChars <= 0 || content.length <= maxChars) {
    const { sections } = parseSections(content);
    return {
      text: content,
      truncated: false,
      omittedLines: 0,
      keptSections: sections.map((s) => s.title),
    };
  }

  const { preamble, sections } = parseSections(content);
  // 没有 `## ` 章节：退化成"头部截断"，仍然给出提示
  if (sections.length === 0) {
    const note = topNote(content.split("\n").length);
    const head = content.slice(0, Math.max(0, maxChars - note.length - 2));
    const text = `${head}\n${note}`;
    return { text, truncated: true, omittedLines: content.split("\n").length, keptSections: [] };
  }

  const preambleText = joinLines(preamble);
  // 预算先扣掉：序言 + 顶部提示（按最坏情况，即全部行都被省略）+ 段落分隔符 + 一点余量。
  // 这里必须**保守**：算少了会超预算，而超预算意味着 system prompt 比承诺的更贵。
  const totalKnownLines = sections.reduce((n, s) => n + s.lines.length, 0);
  const separatorReserve = 2 * (sections.length + 2) + 8;
  const reserve = preambleText.length + 2 + topNote(totalKnownLines).length + separatorReserve;
  const budget = Math.max(0, maxChars - reserve);

  const order = [...sections].sort((a, b) => {
    const pa = priorityOf(a.title);
    const pb = priorityOf(b.title);
    return pa !== pb ? pa - pb : a.index - b.index;
  });

  const fullLen = (s: MemSection): number => joinLines(s.lines).length;
  /** 每段能用的字符数（含标题行与省略提示）。0 = 该段完全不注入（由顶部提示说明）。 */
  const allowance = new Map<number, number>();
  const SHARE_FLOOR = MIN_SLICE_CHARS + 120; // 至少能放标题 + 提示 + 一点内容

  const perSectionCeiling = Math.floor(budget / Math.max(1, sections.length));
  if (perSectionCeiling < SHARE_FLOOR) {
    // 预算小到没法让每段都露面：只保**最高优先级**那一段，其余整段省略。
    // 不硬塞每段一个标题+提示 —— 那样光是标记就比预算还长。
    for (const s of order) allowance.set(s.index, 0);
    const top = order[0];
    if (top) allowance.set(top.index, budget);
  } else {
    // Pass 1：先给每段一个**保底份额**，保证"预算不够"时也不会整段消失
    // （每个 ## 章节在注入里都必须露面，否则模型不知道那里还有东西）。
    const share = Math.max(SHARE_FLOOR, perSectionCeiling);
    let used = 0;
    for (const s of order) {
      const a = Math.min(fullLen(s), share);
      allowance.set(s.index, a);
      used += a;
    }

    // Pass 2：把余量按优先级补给"还没放满"的段（高优先级先吃饱）。
    let leftover = Math.max(0, budget - used);
    for (const s of order) {
      if (leftover <= 0) break;
      const full = fullLen(s);
      const cur = allowance.get(s.index) ?? 0;
      if (cur >= full) continue;
      const add = Math.min(leftover, full - cur);
      allowance.set(s.index, cur + add);
      leftover -= add;
    }
  }

  const included = new Set<number>();
  const slices = new Map<number, string[]>();
  let omittedLines = 0;

  for (const section of sections) {
    const full = fullLen(section);
    const cap = allowance.get(section.index) ?? 0;
    if (cap <= 0) {
      // 明确不注入该段：整段计入省略，不产出"只剩标题"的碎片
      omittedLines += section.lines.length;
      continue;
    }
    if (cap >= full) {
      included.add(section.index);
      continue;
    }
    const title = section.lines[0] ?? `## ${section.title}`;
    const body = section.lines.slice(1);
    // 省略提示本身占位，先扣掉（按"全丢"的最坏情况估算，实际只会更短）
    const marker = omittedNote(body.length);
    const bodyBudget = cap - title.length - 1 - marker.length - 1;
    if (bodyBudget < MIN_SLICE_CHARS) {
      // 连切片都放不下：保住标题 + 提示，至少让模型知道这一段存在
      slices.set(section.index, [title, marker]);
      omittedLines += body.length;
      continue;
    }
    const keepTail = TAIL_KEEP_SECTIONS.includes(section.title);
    const source = keepTail ? [...body].reverse() : body;
    const picked: string[] = [];
    let usedChars = 0;
    for (const line of source) {
      if (usedChars + line.length + 1 > bodyBudget) break;
      picked.push(line);
      usedChars += line.length + 1;
    }
    if (keepTail) picked.reverse();
    const cut = body.length - picked.length;
    slices.set(section.index, [title, ...picked, omittedNote(cut)]);
    omittedLines += cut;
  }

  const parts: string[] = [];
  if (preambleText.trim()) parts.push(preambleText);
  if (omittedLines > 0) parts.push(topNote(omittedLines));
  for (const section of sections) {
    if (included.has(section.index)) parts.push(joinLines(section.lines));
    else {
      const slice = slices.get(section.index);
      if (slice) parts.push(joinLines(slice));
    }
  }

  let text = parts.join("\n\n").replace(/\s+$/, "");
  // 兜底：分配算错也不许超预算（超了就是 system prompt 比承诺的更贵）
  if (text.length > maxChars) text = text.slice(0, maxChars);
  return {
    text,
    truncated: omittedLines > 0,
    omittedLines,
    keptSections: sections.filter((s) => included.has(s.index)).map((s) => s.title),
  };
}
