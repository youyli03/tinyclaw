/**
 * AGENTS.md 类指令文件的加载与渲染（DSH `dsh-agent-instructions` 的语义移植）。
 *
 * 语义来源：本机 DSH v0.1.1-rc.2 的 `dsh-agent-instructions/lib/index.js`（实读实现体），
 * 并由探针 `tmp/probe-agents-md-loader-20260911.ts` 逐条锁定；本文件是其生产化版本。
 *
 * 完整语义（顺序即优先级）：
 *   ① 从 cwd 逐级向上探测项目根（目录内含任一 marker 即认根；找不到则退化为 cwd）
 *   ② 作用域链 = user-global → 项目根 → … → cwd（越靠后越具体，冲突时优先级更高）
 *   ③ 每个作用域按「基础候选 → local 候选」探测；同目录内 trim 后内容相同者只保留最早候选
 *   ④ 单文件超过 maxSourceBytes → 整个文件忽略（omitted 原因 "too-large"）
 *   ⑤ 字节预算分配：全量 → 丢最宽泛的前缀（保留后缀）→ 只留最具体的一个并二分截断
 *      → notice-only → 兜底截断标记行自身；maxBytes <= 0 或非有限 → 加载整体禁用
 *   ⑥ 渲染 = `<system-reminder>` 包裹（正文转义，避免文件内容撑破包裹）+ 显式预算标记行
 *   ⑦ fs 触碰后的增量协调：只重算受影响的作用域，未重算的作用域沿用上一版状态
 *
 * 硬约束：本模块**永不抛异常**。所有 fs 调用都被 try/catch 包住，读失败一律降级为
 * absent / unavailable / 上一版状态，绝不把异常抛给调用方。
 *
 * 注意：DSH 里 maxBytes 是 **required**（无默认值，由部署方给定）；64 KB 是本仓库的部署选择。
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { createLogger } from "../utils/logger.js";

const log = createLogger("instructions");

// ── 配置 ───────────────────────────────────────────────────────────────────

/** 加载器配置；字段名与 DSH `dsh-agent-instructions` 对齐 */
export interface InstructionConfig {
  /** 用户全局指令所在目录（DSH 是 `$DSH_HOME`；tinyclaw 里映射到 `~/.tinyclaw`） */
  dshHome: string;
  /** 项目根标记：目录内存在任一标记即认定为项目根 */
  projectRootMarkers: readonly string[];
  /** 基础候选文件名（按优先级依次探测） */
  instructionFileCandidates: readonly string[];
  /** local 覆盖候选文件名（与基础候选同目录，排在其后） */
  localInstructionFileCandidates: readonly string[];
  /**
   * 一次渲染的 UTF-8 字节上限。
   * DSH 里本字段是 **required**（无默认值，由部署方给）；本仓库取 64 KB。
   * <= 0 或非有限值 → 加载整体禁用（渲染结果 text 为空）。
   */
  maxBytes: number;
  /** 单文件读取上限（超过即整个文件被忽略）；DSH 实测默认 1 MB */
  maxSourceBytes: number;
}

/** 实测自 DSH `dsh-agent-instructions/lib/index.js` 的默认值（maxBytes 是部署选择） */
export const DEFAULT_INSTRUCTION_CONFIG: InstructionConfig = {
  dshHome: path.join(os.homedir(), ".tinyclaw"),
  projectRootMarkers: [".git"],
  instructionFileCandidates: ["AGENTS.md", "CLAUDE.md"],
  localInstructionFileCandidates: ["AGENTS.local.md", "CLAUDE.local.md"],
  maxBytes: 64 * 1024,
  maxSourceBytes: 1048576,
};

// ── 数据结构 ───────────────────────────────────────────────────────────────

/** 一个已定位的指令文件（还没读内容） */
export interface InstructionFile {
  absolutePath: string;
  /** 渲染时展示给模型的路径（`./AGENTS.md` / `sub/AGENTS.md` / `~/.tinyclaw/AGENTS.md`） */
  displayPath: string;
  /** 所属作用域名（`user-global` / `.` / `sub/deep`） */
  scope: string;
}

/** 已读入内存的指令文件 */
export interface LoadedInstructionFile extends InstructionFile {
  content: string;
  /** 内容 UTF-8 字节数 */
  bytes: number;
  /** 内容 SHA-1（用于变更检测） */
  digest: string;
  /** trim 后内容的 SHA-1（用于同目录去重） */
  trimmedDigest: string;
}

/** 被截断的文件记录（渲染进预算标记行） */
export interface TruncatedInstruction {
  displayPath: string;
  originalBytes: number;
  includedBytes: number;
}

/** 被丢弃的文件记录 */
export interface OmittedInstruction {
  displayPath: string;
  /** too-large = 超过 maxSourceBytes；budget = 被字节预算挤掉 */
  reason: "too-large" | "budget";
}

/** 存在但读不了的候选（权限不足 / 竞态删除等） */
export interface UnavailableInstruction {
  displayPath: string;
  error: string;
}

/** 三态探测结果 */
export type ScopeProbe =
  | { kind: "present"; file: InstructionFile; size: number }
  | { kind: "absent"; candidate: string }
  | { kind: "unavailable"; candidate: string; error: string };

/** 一个作用域（目录）及其名字 */
export interface InstructionScope {
  scope: string;
  dir: string;
}

/** 项目根探测结果 */
export interface ProjectRoot {
  root: string;
  /** 是否真的命中了 marker（false 时 root 退化为 cwd） */
  found: boolean;
}

/** 一次渲染的完整结果 */
export interface RenderedInstructionSet {
  /** 可直接注入 prompt 的文本；加载被禁用或读不到任何东西时可能是空串 */
  text: string;
  /** 真正进入渲染的文件（顺序 = 作用域顺序，越靠后越具体） */
  included: LoadedInstructionFile[];
  omitted: OmittedInstruction[];
  truncated: TruncatedInstruction[];
  unavailable: UnavailableInstruction[];
}

/** 相对上一版状态的增量变更 */
export interface AgentInstructionChange {
  action: "set" | "replace" | "remove";
  scope: string;
  path: string;
  /** remove 没有 digest */
  digest?: string;
}

/** 协调状态：key = `<scope>\u0000<basename>` */
export type WorkspaceInstructionState = Map<string, LoadedInstructionFile>;

export interface ReconcileWorkspaceInstructionsInput {
  cfg: InstructionConfig;
  cwd: string;
  /** 本轮被 fs 触碰的路径（绝对或相对均可） */
  touchedPaths: readonly string[];
  /** 上一版状态；不会被就地修改 */
  state: ReadonlyMap<string, LoadedInstructionFile>;
}

export interface ReconcileWorkspaceInstructionsResult {
  changes: AgentInstructionChange[];
  /** 新版状态（新 Map，调用方自行替换） */
  state: WorkspaceInstructionState;
  /** 本轮重算的作用域名（顺序 = 渲染顺序） */
  recomputed: string[];
}

// ── 渲染常量（进模型的文本一律英文，与 DSH 原文一致）───────────────────────

export const FRAME_OPEN = "<system-reminder>";
export const FRAME_CLOSE = "</system-reminder>";

/** 实测自 DSH lib/index.js 的原文，一字不改 */
export const WORKSPACE_CONTEXT_INTRO =
  "The following workspace instructions may be relevant to your work. Use them as guidance when " +
  "applicable. More specific instructions take precedence over broader ones. They do not " +
  "override system, developer, or direct user instructions.";

/** 预算紧张时的短 intro（DSH 原文） */
export const COMPACT_WORKSPACE_CONTEXT_INTRO =
  "Workspace instructions were omitted or truncated to fit the configured byte budget.";

interface RenderStyle {
  intro: string;
  section: (file: LoadedInstructionFile) => string;
}

const sectionText = (file: LoadedInstructionFile): string =>
  `# ${file.displayPath}\n\n${file.content.trim()}`;

const STYLE: RenderStyle = { intro: WORKSPACE_CONTEXT_INTRO, section: sectionText };
const COMPACT_STYLE: RenderStyle = { intro: COMPACT_WORKSPACE_CONTEXT_INTRO, section: sectionText };

/**
 * 转义包裹标签本身，保证文件内容无法撑破 `<system-reminder>` 框架。
 * （DSH 用 escapeInstructionFrameBody，规则未见；此处只挡标签字面量，是探针里已声明的简化。）
 */
function escapeFrameBody(body: string): string {
  return body
    .split(FRAME_OPEN)
    .join("<\\system-reminder>")
    .split(FRAME_CLOSE)
    .join("<\\/system-reminder>");
}

// ── 基础工具（全部不抛）────────────────────────────────────────────────────

const byteLength = (s: string): number => Buffer.byteLength(s, "utf-8");

const sha1 = (s: string): string => crypto.createHash("sha1").update(s, "utf-8").digest("hex");

/** 同目录去重用的指纹 */
const trimmedDigest = (s: string): string => sha1(s.trim());

/** 按 UTF-8 字节截断（不保证字符边界，残留半个字符会被 Buffer 变成替换字符） */
const truncateUtf8 = (s: string, max: number): string => {
  const buf = Buffer.from(s, "utf-8");
  if (buf.length <= max) return s;
  return buf.subarray(0, Math.max(0, Math.trunc(max))).toString("utf-8");
};

/** 从异常里取 errno code；拿不到就退化为 message / String(e) */
function errorCode(e: unknown): string {
  if (typeof e === "object" && e !== null) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return e instanceof Error ? e.message : String(e);
}

/** 归一化路径的兜底实现：输入非法时退回分隔符根，守住「本模块不抛」的约束 */
function safeResolve(input: string): string {
  try {
    return path.resolve(input);
  } catch {
    return path.sep;
  }
}

/** 存在性判断（existsSync 正常不抛，这里再兜一层统一口径） */
function safeExists(target: string): boolean {
  try {
    return fs.existsSync(target);
  } catch {
    return false;
  }
}

/** os.homedir() 在极端环境下会抛 */
function safeHome(): string | undefined {
  try {
    return os.homedir();
  } catch {
    return undefined;
  }
}

/** safeReadText 的结果：失败时带回 errno code */
type ReadResult = { ok: true; content: string } | { ok: false; error: string };

/** 读文本文件，失败时把 errno code 带回来（调用方降级为 unavailable，绝不抛） */
function safeReadText(target: string): ReadResult {
  try {
    return { ok: true, content: fs.readFileSync(target, "utf-8") };
  } catch (e) {
    return { ok: false, error: errorCode(e) };
  }
}

// ── 项目根 / 作用域链 ──────────────────────────────────────────────────────

/**
 * 从 cwd 逐级向上探测项目根：目录内存在任一 marker 即认定为根。
 * 一路走到文件系统根都没命中 → 退化为 cwd（探针里的推定行为，DSH 类型层没写）。
 */
export function discoverProjectRoot(cwd: string, markers: readonly string[]): ProjectRoot {
  const resolved = safeResolve(cwd);
  let dir = resolved;
  for (;;) {
    if (markers.some((marker) => safeExists(path.join(dir, marker)))) {
      return { root: dir, found: true };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return { root: resolved, found: false };
    dir = parent;
  }
}

/**
 * 作用域链：`user-global` 在最前，项目根 → cwd 依次在后。
 * 数组顺序 = 渲染顺序 = 预算优先级（越靠后越具体，预算紧张时越不容易被丢）。
 */
export function scopeChain(cfg: InstructionConfig, cwd: string): InstructionScope[] {
  try {
    const { root } = discoverProjectRoot(cwd, cfg.projectRootMarkers);
    const rel = path.relative(root, safeResolve(cwd));
    const parts = rel === "" ? [] : rel.split(path.sep);
    const chain: InstructionScope[] = [{ scope: "user-global", dir: cfg.dshHome }];
    for (let i = 0; i <= parts.length; i++) {
      chain.push({
        scope: i === 0 ? "." : parts.slice(0, i).join("/"),
        dir: path.join(root, ...parts.slice(0, i)),
      });
    }
    return chain;
  } catch (e) {
    log.warn("计算作用域链失败，仅保留 user-global：", errorCode(e));
    return [{ scope: "user-global", dir: cfg.dshHome }];
  }
}

/** 作用域的层级深度（`.` = 0，`a/b` = 2），用于把受影响作用域按「宽泛 → 具体」排序 */
function scopeDepth(scope: string): number {
  return scope === "." ? 0 : scope.split("/").length;
}

/** 把 root 下的绝对目录映射成作用域名 */
function scopeNameFor(root: string, dir: string): string {
  const rel = path.relative(root, dir);
  return rel === "" ? "." : rel.split(path.sep).join("/");
}

// ── 展示路径 ───────────────────────────────────────────────────────────────

/**
 * user-global 作用域的展示前缀。
 * 这里对探针做了**明确偏离**：探针把 user-global 的展示路径写死成 `"~/.dsh/AGENTS.md"`（忽略
 * 候选名与 dshHome），生产里那会把 `CLAUDE.md` 也显示成 AGENTS.md、并把不存在的路径喂给模型；
 * 因此改为把 dshHome 映射成 home 相对路径（DSH 的 dshHome 仍渲染成 `~/.dsh`，与探针一致）。
 */
function userGlobalDisplayDir(cfg: InstructionConfig): string {
  const home = safeHome();
  if (home === undefined) return cfg.dshHome;
  const resolvedHome = safeResolve(home);
  const dir = safeResolve(cfg.dshHome);
  if (dir === resolvedHome) return "~";
  if (dir.startsWith(resolvedHome + path.sep)) {
    const rel = path.relative(resolvedHome, dir).split(path.sep).join("/");
    return `~/${rel}`;
  }
  return cfg.dshHome;
}

/** 渲染时展示的路径：`~/.tinyclaw/AGENTS.md` / `./AGENTS.md` / `sub/AGENTS.md` */
function displayPathFor(cfg: InstructionConfig, scope: string, name: string): string {
  if (scope === "user-global") return `${userGlobalDisplayDir(cfg)}/${name}`;
  return scope === "." ? `./${name}` : `${scope}/${name}`;
}

// ── 三态探测 ───────────────────────────────────────────────────────────────

type StatResult =
  | { kind: "present"; size: number }
  | { kind: "absent" }
  | { kind: "unavailable"; error: string };

/** stat + 常规文件判定：ENOENT/ENOTDIR/非普通文件 → absent，其余失败 → unavailable */
function safeStat(target: string): StatResult {
  try {
    const stat = fs.statSync(target);
    if (!stat.isFile()) return { kind: "absent" };
    return { kind: "present", size: stat.size };
  } catch (e) {
    const code = errorCode(e);
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "absent" };
    return { kind: "unavailable", error: code };
  }
}

function probeCandidateCore(
  cfg: InstructionConfig,
  scope: string,
  dir: string,
  name: string
): ScopeProbe {
  const absolutePath = path.join(dir, name);
  const stat = safeStat(absolutePath);
  if (stat.kind === "absent") return { kind: "absent", candidate: name };
  if (stat.kind === "unavailable") {
    return { kind: "unavailable", candidate: name, error: stat.error };
  }
  try {
    fs.accessSync(absolutePath, fs.constants.R_OK);
  } catch (e) {
    // 文件存在但读不动（chmod 000 / ACL 等）→ unavailable，而不是 absent
    return { kind: "unavailable", candidate: name, error: errorCode(e) };
  }
  return {
    kind: "present",
    size: stat.size,
    file: { absolutePath, displayPath: displayPathFor(cfg, scope, name), scope },
  };
}

/**
 * 三态探测单个候选：present / absent（ENOENT、ENOTDIR、非普通文件）/ unavailable（存在但读不动）。
 * 任何异常都不会外泄。
 */
export function probeInstructionCandidate(
  cfg: InstructionConfig,
  scope: string,
  dir: string,
  name: string
): ScopeProbe {
  try {
    return probeCandidateCore(cfg, scope, dir, name);
  } catch (e) {
    return { kind: "unavailable", candidate: name, error: errorCode(e) };
  }
}

/** 探测一个作用域下的全部候选（基础候选在前，local 候选在后） */
export function probeInstructionScope(
  cfg: InstructionConfig,
  scope: string,
  dir: string
): ScopeProbe[] {
  return [...cfg.instructionFileCandidates, ...cfg.localInstructionFileCandidates].map((name) =>
    probeInstructionCandidate(cfg, scope, dir, name)
  );
}

// ── 收集（去重 + 单文件上限）───────────────────────────────────────────────

interface CollectedInstructionFiles {
  files: LoadedInstructionFile[];
  omitted: OmittedInstruction[];
  unavailable: UnavailableInstruction[];
}

function collectInstructionFiles(
  cfg: InstructionConfig,
  scopes: readonly InstructionScope[]
): CollectedInstructionFiles {
  const files: LoadedInstructionFile[] = [];
  const omitted: OmittedInstruction[] = [];
  const unavailable: UnavailableInstruction[] = [];

  for (const { scope, dir } of scopes) {
    // 去重集合是**每个目录**一份：同目录 trim 后内容相同者只保留最早候选（AGENTS.md 胜过 CLAUDE.md）
    const seen = new Set<string>();
    for (const probe of probeInstructionScope(cfg, scope, dir)) {
      if (probe.kind === "absent") continue;
      if (probe.kind === "unavailable") {
        unavailable.push({
          displayPath: displayPathFor(cfg, scope, probe.candidate),
          error: probe.error,
        });
        continue;
      }
      if (probe.size > cfg.maxSourceBytes) {
        omitted.push({ displayPath: probe.file.displayPath, reason: "too-large" });
        continue;
      }
      const read = safeReadText(probe.file.absolutePath);
      if (!read.ok) {
        // 探测与读取之间文件可能被删 / 改权限 → 降级为 unavailable，不让整轮渲染崩掉
        unavailable.push({ displayPath: probe.file.displayPath, error: read.error });
        continue;
      }
      const trimmed = trimmedDigest(read.content);
      if (seen.has(trimmed)) continue;
      seen.add(trimmed);
      files.push({
        ...probe.file,
        content: read.content,
        bytes: byteLength(read.content),
        digest: sha1(read.content),
        trimmedDigest: trimmed,
      });    }
  }

  return { files, omitted, unavailable };
}

// ── 渲染 ───────────────────────────────────────────────────────────────────

/** 截断明细文案：`sub/AGENTS.md from 1000 to 420 bytes`（DSH 原文格式） */
function truncationDetail(item: TruncatedInstruction): string {
  return `${item.displayPath} from ${item.originalBytes} to ${item.includedBytes} bytes`;
}

/** 预算标记行；没有任何省略/截断时返回空串（不渲染该行） */
function markerText(
  maxBytes: number,
  omitted: readonly OmittedInstruction[],
  truncated: readonly TruncatedInstruction[]
): string {
  if (omitted.length === 0 && truncated.length === 0) return "";
  const parts: string[] = [];
  if (omitted.length > 0) {
    parts.push(`omitted ${omitted.map((item) => item.displayPath).join(", ")}`);
  }
  if (truncated.length > 0) {
    parts.push(`truncated ${truncated.map(truncationDetail).join(", ")}`);
  }
  return `Workspace instruction budget ${maxBytes} bytes: ${parts.join("; ")}`;
}

/** 拼一段完整文本：`<system-reminder>` + 标记行 + intro + 各文件小节 */
function buildInstructionText(
  files: readonly LoadedInstructionFile[],
  maxBytes: number,
  omitted: readonly OmittedInstruction[],
  truncated: readonly TruncatedInstruction[],
  style: RenderStyle = STYLE
): string {
  const body = [markerText(maxBytes, omitted, truncated), style.intro, ...files.map(style.section)]
    .filter((block) => block.length > 0)
    .join("\n\n");
  return [FRAME_OPEN, escapeFrameBody(body), FRAME_CLOSE].join("\n");
}

/**
 * 二分截断：让「整段渲染（含标记行与 intro）」不超 maxBytes，而不是简单填满剩余空间。
 * 二分不命中任何值时返回空内容（交给调用方退到 notice-only）。
 */
function truncateToFit(
  file: LoadedInstructionFile,
  maxBytes: number,
  omitted: readonly OmittedInstruction[],
  style: RenderStyle
): { file: LoadedInstructionFile; truncated: TruncatedInstruction[] } {
  const originalBytes = file.bytes;
  let low = 0;
  let high = originalBytes;
  let best: LoadedInstructionFile = { ...file, content: "", bytes: 0 };
  let bestTruncated: TruncatedInstruction[] = [];

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const candidate: LoadedInstructionFile = { ...file, content: truncateUtf8(file.content, mid) };
    const includedBytes = byteLength(candidate.content);
    const truncated: TruncatedInstruction[] = [
      { displayPath: file.displayPath, originalBytes, includedBytes },
    ];
    const rendered = buildInstructionText([candidate], maxBytes, omitted, truncated, style);
    if (byteLength(rendered) <= maxBytes) {
      best = candidate;
      bestTruncated = truncated;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return { file: best, truncated: bestTruncated };
}

/**
 * 预算分配 —— 对齐 DSH `renderInstructionContext`：
 *   ①全量放得下 → 全量
 *   ②否则**从最宽泛的开始丢**、保留后缀（丢掉的记 omitted / budget）
 *   ③否则只留**最后一个（最具体）**的文件并二分截断；先试完整 intro，再试 COMPACT intro
 *   ④再不行只剩标记行（notice-only），最后兜底按字节截断标记行自身
 * ⚠️ 这与「按顺序贪心填满预算」是不同语义：预算紧张时优先保住**最近**的指令。
 */
function renderCore(
  cfg: InstructionConfig,
  scopes: readonly InstructionScope[]
): RenderedInstructionSet {
  const { files, omitted: structural, unavailable } = collectInstructionFiles(cfg, scopes);
  const atBudget = (file: LoadedInstructionFile): OmittedInstruction => ({
    displayPath: file.displayPath,
    reason: "budget",
  });

  if (cfg.maxBytes <= 0 || !Number.isFinite(cfg.maxBytes)) {
    // 预算非法 → 加载整体禁用：text 空，所有已收集文件记 budget
    return {
      text: "",
      included: [],
      omitted: [...structural, ...files.map(atBudget)],
      truncated: [],
      unavailable,
    };
  }

  // ① 全量
  const fullText = buildInstructionText(files, cfg.maxBytes, structural, []);
  if (byteLength(fullText) <= cfg.maxBytes) {
    return { text: fullText, included: files, omitted: structural, truncated: [], unavailable };
  }

  // ② 丢前缀、留后缀（越具体越优先）
  for (let start = 1; start < files.length; start++) {
    const included = files.slice(start);
    const omitted = [...structural, ...files.slice(0, start).map(atBudget)];
    const text = buildInstructionText(included, cfg.maxBytes, omitted, []);
    if (byteLength(text) <= cfg.maxBytes) {
      return { text, included, omitted, truncated: [], unavailable };
    }
  }

  // ③ 只留最具体的一个，二分截断（完整 intro 与 COMPACT intro 各试一次）
  const mostSpecific = files[files.length - 1];
  if (mostSpecific === undefined) {
    return { text: "", included: [], omitted: structural, truncated: [], unavailable };
  }
  const omitted = [...structural, ...files.slice(0, -1).map(atBudget)];
  const originalBytes = mostSpecific.bytes;
  for (const style of [STYLE, COMPACT_STYLE]) {
    const fit = truncateToFit(mostSpecific, cfg.maxBytes, omitted, style);
    const includedBytes = byteLength(fit.file.content);
    const truncated: TruncatedInstruction[] = [
      { displayPath: mostSpecific.displayPath, originalBytes, includedBytes },
    ];
    const text = buildInstructionText([fit.file], cfg.maxBytes, omitted, truncated, style);
    if (byteLength(text) <= cfg.maxBytes) {
      const included: LoadedInstructionFile[] =
        includedBytes > 0 || originalBytes === 0 ? [{ ...fit.file, bytes: includedBytes }] : [];
      return { text, included, omitted, truncated, unavailable };
    }
  }

  // ④ notice-only；最后兜底把 notice 本身按字节截断
  const truncated: TruncatedInstruction[] = [
    { displayPath: mostSpecific.displayPath, originalBytes, includedBytes: 0 },
  ];
  const notice = escapeFrameBody(markerText(cfg.maxBytes, omitted, truncated));
  const withHeading = escapeFrameBody(
    [notice, STYLE.section({ ...mostSpecific, content: "" })].join("\n\n")
  );
  if (byteLength(withHeading) <= cfg.maxBytes) {
    return { text: withHeading, included: [], omitted, truncated, unavailable };
  }
  return {
    text: byteLength(notice) <= cfg.maxBytes ? notice : truncateUtf8(notice, cfg.maxBytes),
    included: [],
    omitted,
    truncated,
    unavailable,
  };
}

/**
 * 渲染一组作用域的指令文本。
 * 注意参数顺序是 `(scopes, cfg)`；scopes 的顺序即优先级（越靠后越具体）。
 * 内部异常一律降级为「不注入任何东西」，绝不抛给调用方。
 */
export function renderWorkspaceInstructions(
  scopes: readonly InstructionScope[],
  cfg: InstructionConfig
): RenderedInstructionSet {
  try {
    return renderCore(cfg, scopes);
  } catch (e) {
    log.warn("渲染工作区指令失败，降级为不注入：", errorCode(e));
    return { text: "", included: [], omitted: [], truncated: [], unavailable: [] };
  }
}

// ── 增量协调 ───────────────────────────────────────────────────────────────

/** 状态 key：`<scope>\u0000<basename>` */
export function instructionStateKey(scope: string, fileName: string): string {
  return `${scope}\u0000${fileName}`;
}

function scopeOfStateKey(key: string): string {
  return key.split("\u0000")[0] ?? "";
}

/**
 * 把「被触碰路径」映射到受影响作用域：从触碰路径的目录逐级向上，直到项目根（含根）。
 * 因此 cwd **之下**的嵌套目录也会被重算（例如 cwd/sub/deep/inner 下新写的 AGENTS.md）。
 */
function affectedScopes(root: string, touchedPaths: readonly string[]): InstructionScope[] {
  const affected = new Map<string, string>();
  // root 为文件系统根（"/"）时 root + sep 会变成 "//"，这里统一成单分隔符前缀
  const rootPrefix = root.endsWith(path.sep) ? root : root + path.sep;
  for (const touched of touchedPaths) {
    let dir = path.dirname(safeResolve(touched));
    while (dir === root || dir.startsWith(rootPrefix)) {
      affected.set(scopeNameFor(root, dir), dir);
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  // 按「宽泛 → 具体」排序，保证渲染顺序与 scopeChain 一致（最具体的排在最后）
  return [...affected.entries()]
    .map(([scope, dir]) => ({ scope, dir }))
    .sort((a, b) => scopeDepth(a.scope) - scopeDepth(b.scope));
}

function reconcileCore(
  cfg: InstructionConfig,
  cwd: string,
  touchedPaths: readonly string[],
  prev: ReadonlyMap<string, LoadedInstructionFile>
): ReconcileWorkspaceInstructionsResult {
  const { root } = discoverProjectRoot(cwd, cfg.projectRootMarkers);
  const scopes: InstructionScope[] = [
    { scope: "user-global", dir: cfg.dshHome },
    ...affectedScopes(root, touchedPaths),
  ];
  const rendered = renderCore(cfg, scopes);
  const recomputedScopes = new Set(scopes.map((item) => item.scope));

  // 状态按作用域持久：只清掉被重算的作用域，其余沿用上一版，
  // 否则未受影响的作用域会被误报成 remove。
  const next = new Map<string, LoadedInstructionFile>(prev);
  for (const key of [...next.keys()]) {
    if (recomputedScopes.has(scopeOfStateKey(key))) next.delete(key);
  }
  for (const file of rendered.included) {
    next.set(instructionStateKey(file.scope, path.basename(file.absolutePath)), file);
  }

  // 只对「真正进了渲染」的文件下发 delta
  const represented = new Set(rendered.included.map((file) => file.absolutePath));
  const changes: AgentInstructionChange[] = [];
  for (const [key, file] of next) {
    const before = prev.get(key);
    if (before === undefined) {
      if (represented.has(file.absolutePath)) {
        changes.push({
          action: "set",
          scope: file.scope,
          path: file.displayPath,
          digest: file.digest,
        });
      }
    } else if (before.digest !== file.digest) {
      changes.push({
        action: "replace",
        scope: file.scope,
        path: file.displayPath,
        digest: file.digest,
      });
    }
  }
  for (const [key, before] of prev) {
    if (recomputedScopes.has(scopeOfStateKey(key)) && !next.has(key)) {
      changes.push({ action: "remove", scope: before.scope, path: before.displayPath });
    }
  }

  return { changes, state: next, recomputed: scopes.map((item) => item.scope) };
}

/**
 * fs 触碰后的增量协调：只重算受影响的作用域，返回相对上一版状态的 delta 与新状态。
 * `state` 不会被就地修改；内部异常时返回空 delta + 原状态副本（绝不抛）。
 */
export function reconcileWorkspaceInstructions(
  input: ReconcileWorkspaceInstructionsInput
): ReconcileWorkspaceInstructionsResult {
  const { cfg, cwd, touchedPaths, state } = input;
  try {
    return reconcileCore(cfg, cwd, touchedPaths, state);
  } catch (e) {
    log.warn("协调工作区指令失败，保留上一版状态：", errorCode(e));
    return { changes: [], state: new Map(state), recomputed: [] };
  }
}
