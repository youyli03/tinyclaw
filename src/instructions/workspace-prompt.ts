/**
 * 工作区指令（AGENTS.md / CLAUDE.md 及其 local 覆盖）—— 接线层。
 *
 * 语义实现全在 `agents-md.ts`（照 DSH `@deepseek-ai/dsh-agent-instructions` 的实测语义）。
 * 本层负责**投递与维护策略**，对齐 DSH 的实现（`lib/index.js` 的 compose + syncInbox）：
 *
 *  1. **纯追加、绝不改写已发送的历史**（前缀缓存安全）。旧基线永远留着，取代关系写在文本里。
 *  2. **身份判等**：`identity = hash(cwd + 每个文件的 scope/displayPath/digest)`，写进注入的 marker
 *     （scope 形态 `<cwd>#<identity>`）。身份没变 → **一条都不追加**（DSH `keepVisibleBaseline`）。
 *  3. **变了只发 diff**：身份变了、且上一版状态还在内存里对得上 → 只追加变化文件（new/changed/removed）。
 *  4. **基线失效才重发完整基线**：上下文里看不到基线（首次 / 刚被压缩丢掉 / 会话恢复后状态丢失 /
 *     换了工作目录）→ 下发完整基线；若此时**仍有一份旧基线可见**，用 DSH 的替换语声明"本基线取代此前所有基线"。
 *  5. **状态**：每 session 一份 `Map<cwd, {identity, state}>`（WeakMap），state 只在身份对得上时才用于 diff。
 *  6. **绝不抛异常**：任何失败都降级为"不注入"，不能因为读不到 AGENTS.md 就中断 agent。
 */

import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";

import {
  DEFAULT_INSTRUCTION_CONFIG,
  instructionStateKey,
  scopeChain,
  renderWorkspaceInstructions,
  reconcileWorkspaceInstructions,
  type AgentInstructionChange,
  type InstructionConfig,
  type LoadedInstructionFile,
  type WorkspaceInstructionState,
} from "./agents-md.js";
import { runtimeRoot } from "../tools/path-guard.js";
import { Session } from "../core/session.js";

/**
 * 一次注入的 UTF-8 字节上限。
 * 与 DSH 生产 profile 的取值一致（`dsh-base/cordis.patch.yml` 里 `agent-instructions` 配的
 * 就是 `maxBytes: 65536`），不自己发明。
 */
export const WORKSPACE_INSTRUCTION_MAX_BYTES = 65_536;

/**
 * 哪些工具算"触碰了文件"（其后需要重新协调工作区指令）。
 *
 * 对齐 DSH 的 `FILE_TOUCH_TOOL_NAMES = { read, write, edit }` —— **读也算**：
 * 读子目录里的文件可能"发现"那里新增的 AGENTS.md，只认写操作会漏掉这类变化。
 * 我们额外把 `delete_file` 纳入（DSH 没有独立的删除工具）。
 */
export const WORKSPACE_TOUCHING_TOOLS = new Set([
  "read_file",
  "write_file",
  "edit_file",
  "delete_file",
]);

/** 基线换代时的声明（DSH 原文，一字不改） */
export const REPLACEMENT_BASELINE_NOTICE =
  "This complete workspace instruction baseline replaces all earlier workspace instruction baselines.";

/** 用户全局指令文件所在目录：tinyclaw 用运行时目录（即 `~/.tinyclaw/AGENTS.md`） */
function userGlobalDir(): string {
  try {
    return runtimeRoot();
  } catch {
    return path.join(os.homedir(), ".tinyclaw");
  }
}

function instructionConfig(): InstructionConfig {
  return {
    ...DEFAULT_INSTRUCTION_CONFIG,
    dshHome: userGlobalDir(),
    maxBytes: WORKSPACE_INSTRUCTION_MAX_BYTES,
  };
}

// ── 身份与状态 ─────────────────────────────────────────────────────────────

/** 基线身份：cwd + 每个指令文件的 scope/展示路径/内容摘要（任一变化 → 身份变化） */
function baselineIdentity(cwd: string, included: readonly LoadedInstructionFile[]): string {
  const h = createHash("sha1");
  h.update(cwd);
  for (const f of included) h.update(`\n${f.scope}\u0000${f.displayPath}\u0000${f.digest}`);
  return h.digest("hex").slice(0, 12);
}

/** 注入 scope = `<cwd>#<identity>`（从 marker 里读回身份，用于判断"当前可见基线是否还是这一版"） */
const encodeScope = (cwd: string, identity: string): string => `${cwd}#${identity}`;

function decodeScope(scope: string): { cwd: string; identity?: string } {
  const i = scope.lastIndexOf("#");
  if (i < 0) return { cwd: scope };
  return { cwd: scope.slice(0, i), identity: scope.slice(i + 1) };
}

interface SessionState {
  /** cwd → 最近一次下发时的身份与状态（状态只在身份对得上时才可用于 diff） */
  scopes: Map<string, { identity: string; state: WorkspaceInstructionState }>;
}

const sessionStates = new WeakMap<Session, SessionState>();

function stateOf(session: Session): SessionState {
  let st = sessionStates.get(session);
  if (!st) {
    st = { scopes: new Map() };
    sessionStates.set(session, st);
  }
  return st;
}

/** 清空某 session 的工作区指令状态（探针/测试用；正常运行时靠 WeakMap 随 session 回收） */
export function resetWorkspaceInstructionState(session?: Session): void {
  if (session) sessionStates.delete(session);
}

// ── 渲染 ────────────────────────────────────────────────────────────────────

const sourceLine = (included: readonly LoadedInstructionFile[]): string =>
  `Sources: ${included.map((f) => f.displayPath).join(", ")}`;

/** 把当前渲染的 included 转成 state（`scope\0basename` → 文件） */
function toState(included: readonly LoadedInstructionFile[]): WorkspaceInstructionState {
  const next: WorkspaceInstructionState = new Map();
  for (const f of included) next.set(instructionStateKey(f.scope, path.basename(f.absolutePath)), f);
  return next;
}

/** 当前渲染 vs 上一版状态：给出"变了/新增/删除"的文件路径（喂给 reconcile 当 touchedPaths） */
function changedPaths(
  prev: ReadonlyMap<string, LoadedInstructionFile>,
  included: readonly LoadedInstructionFile[]
): string[] {
  const next = toState(included);
  const paths = new Set<string>();
  for (const [key, f] of next) {
    const before = prev.get(key);
    if (before === undefined || before.digest !== f.digest) paths.add(f.absolutePath);
  }
  for (const [key, f] of prev) {
    if (!next.has(key)) paths.add(f.absolutePath);
  }
  return [...paths];
}

/** 把变更渲染成给模型的增量文本（只发变了的那几个文件的新内容，对齐 DSH 的 ChangeRenderItem） */
function renderChanges(
  changes: readonly AgentInstructionChange[],
  state: WorkspaceInstructionState,
  maxBytes: number
): string {
  const head = [
    "<system-reminder>",
    "Workspace instructions changed because you touched files in these scopes. The entries below " +
      "supersede what you were given earlier for those paths; entries marked removed no longer apply.",
  ];
  const tail = ["</system-reminder>"];
  const items: string[] = [];
  const reserve = Buffer.byteLength([...head, ...tail].join("\n"), "utf-8") + 64;
  let used = 0;

  for (const ch of changes) {
    const file = state.get(instructionStateKey(ch.scope, path.basename(ch.path)));
    if (ch.action === "remove" || file === undefined) {
      items.push(`- removed: ${ch.path} (scope ${ch.scope})`);
      continue;
    }
    const label = ch.action === "set" ? "new" : "changed";
    let body = file.content.trim();
    const room = maxBytes - reserve - used;
    if (Buffer.byteLength(body, "utf-8") > room) {
      body =
        Buffer.from(body, "utf-8").subarray(0, Math.max(0, room)).toString("utf-8") + "\n…(truncated)";
    }
    used += Buffer.byteLength(body, "utf-8");
    items.push(`- ${label}: ${ch.path} (scope ${ch.scope})\n\n${body}`);
  }
  return [...head, "", ...items, ...tail].join("\n");
}

// ── 主流程 ─────────────────────────────────────────────────────────────────

export interface WorkspaceInstructionPush {
  /** 本次实际追加的消息条数（0 = 什么都没做） */
  pushed: number;
  /** 本次动作 */
  action: "none" | "baseline" | "replacement-baseline" | "delta";
  /** 本次涉及的文件数（baseline = 文件总数，delta = 变更条数） */
  files: number;
  /** 本次追加的字节数（诊断用） */
  bytes: number;
}

const NOTHING: WorkspaceInstructionPush = { pushed: 0, action: "none", files: 0, bytes: 0 };

/**
 * 协调并（必要时）追加工作区指令。**唯一入口**，另两个导出函数是它的语义化包装。
 *
 * 决策表（对齐 DSH `compose` + `syncInbox`）：
 * | 当前可见基线 | 身份 | 上一版状态 | 动作 |
 * |---|---|---|---|
 * | 无 | — | — | 完整基线 |
 * | 有 | 相同 | — | **什么都不做** |
 * | 有 | 不同 | 对得上 | **只发 diff** |
 * | 有 | 不同 | 对不上（重启/换目录） | **完整基线 + 替换语** |
 *
 * @param touchedPaths 本次被 fs 工具触碰的路径（可为空：只做身份检查 / 压缩后补发）
 */
export function syncWorkspaceInstructions(
  session: Session,
  cwd: string | undefined,
  touchedPaths: readonly string[] = []
): WorkspaceInstructionPush {
  try {
    if (!cwd) return NOTHING;
    const cfg = instructionConfig();
    const rendered = renderWorkspaceInstructions(scopeChain(cfg, cwd), cfg);
    // 一个候选文件都没有 → 不注入（DSH 会渲染只含 intro 的空基线，tinyclaw 有意不这么做）
    if (rendered.included.length === 0) return NOTHING;

    const identity = baselineIdentity(cwd, rendered.included);
    const st = stateOf(session);
    const visibleScope = session.findVisibleWorkspaceBaseline();
    const visible = visibleScope === undefined ? undefined : decodeScope(visibleScope);
    const recorded = st.scopes.get(cwd);
    const hasUsableBase =
      visible !== undefined &&
      visible.cwd === cwd &&
      recorded !== undefined &&
      recorded.identity === visible.identity;

    // ① 没有任何可用的参照（首次 / 压缩后 / 会话恢复 / 换目录 / 旧基线身份对不上）→ 完整基线。
    //    旧基线仍可见时用替换语声明取代（DSH 的 replacePreviousBaseline）。
    if (!hasUsableBase) {
      const replacing = visible !== undefined;
      const header = replacing
        ? `${REPLACEMENT_BASELINE_NOTICE}\n${sourceLine(rendered.included)}`
        : sourceLine(rendered.included);
      const text = `${header}\n\n${rendered.text}`;
      const scope = encodeScope(cwd, identity);
      const pushed = session.appendWorkspaceInstructions("baseline", scope, text);
      st.scopes.set(cwd, { identity, state: toState(rendered.included) });
      const stored = `${Session.workspaceInstructionMarker("baseline", scope)}\n${text}`;
      return {
        pushed: pushed ? 1 : 0,
        action: replacing ? "replacement-baseline" : "baseline",
        files: rendered.included.length,
        bytes: pushed ? Buffer.byteLength(stored, "utf-8") : 0,
      };
    }

    // ② 有可用参照 → 只发 diff。
    //    ⚠️ 身份没变**也必须**跑 reconcile：cwd **之下**的嵌套 AGENTS.md 不在作用域链里，
    //    只能靠被触碰的路径向上回溯发现（DSH 也是"身份不变仍 reconcile(touchedPaths)"）。
    const paths = new Set<string>(touchedPaths);
    for (const p of changedPaths(recorded!.state, rendered.included)) paths.add(p);
    if (paths.size === 0) return NOTHING;

    const result = reconcileWorkspaceInstructions({
      cfg,
      cwd,
      touchedPaths: [...paths],
      state: recorded!.state,
    });
    const baseIdentity = visible!.identity ?? identity;
    st.scopes.set(cwd, { identity: baseIdentity, state: result.state });
    if (result.changes.length === 0) return NOTHING;
    const scope = encodeScope(cwd, baseIdentity);
    const text = renderChanges(result.changes, result.state, WORKSPACE_INSTRUCTION_MAX_BYTES);
    const pushed = session.appendWorkspaceInstructions("delta", scope, text);
    const stored = `${Session.workspaceInstructionMarker("delta", scope)}\n${text}`;
    return {
      pushed: pushed ? 1 : 0,
      action: "delta",
      files: result.changes.length,
      bytes: pushed ? Buffer.byteLength(stored, "utf-8") : 0,
    };
  } catch (err) {
    console.warn(
      "[instructions] 工作区指令协调失败，本次跳过：",
      err instanceof Error ? err.message : err
    );
    return NOTHING;
  }
}

/**
 * run 起始调用（无触碰）：首次进入某 cwd、或压缩后基线丢失时补发完整基线；
 * 身份没变时一条都不追加。
 */
export function ensureWorkspaceInstructionsBaseline(
  session: Session,
  cwd: string | undefined
): WorkspaceInstructionPush {
  return syncWorkspaceInstructions(session, cwd, []);
}

/** fs 触碰后调用：身份变了只追加 diff；基线不在则补发完整基线 */
export function pushWorkspaceInstructionDeltas(
  session: Session,
  cwd: string | undefined,
  touchedPaths: readonly string[]
): { pushed: boolean; action: WorkspaceInstructionPush["action"] } {
  const push = syncWorkspaceInstructions(session, cwd, touchedPaths);
  return { pushed: push.pushed > 0, action: push.action };
}

/** 会话里当前有多少条工作区指令注入（诊断/探针用） */
export function countWorkspaceMessages(session: Session): number {
  return session.getMessages().filter((m) => Session.isWorkspaceInstruction(m)).length;
}

/** 诊断用：当前 cwd 会加载哪些指令文件（不注入、不动状态） */
export function describeWorkspaceInstructions(cwd: string): string[] {
  try {
    const cfg = instructionConfig();
    return renderWorkspaceInstructions(scopeChain(cfg, cwd), cfg).included.map((f) => f.displayPath);
  } catch {
    return [];
  }
}
