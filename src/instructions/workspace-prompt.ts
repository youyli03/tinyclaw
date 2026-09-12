/**
 * 工作区指令（AGENTS.md / CLAUDE.md 及其 local 覆盖）—— 接线层。
 *
 * 语义实现全在 `agents-md.ts`（照 DSH `@deepseek-ai/dsh-agent-instructions` 的实测语义：
 * 向上找项目根、同目录多候选、local 覆盖、trim 去重、字节预算与二分截断、三态探测、增量协调）。
 *
 * 本层做四件事（对齐 DSH 的投递方式，**不走 system prompt**）：
 *  1. **baseline**：某会话首次进入某个工作目录时，渲染一次完整指令，作为 **user 角色** 的注入消息
 *     落到会话里（`Session.appendWorkspaceInstructions("baseline", …)`）；
 *  2. **delta**：`write_file` / `edit_file` / `delete_file` 这类"触碰文件"的工具成功后，
 *     调 `reconcileWorkspaceInstructions()` 只重算受影响作用域，把 set/replace/remove 作为
 *     **增量注入**追加进去 —— 等价于 DSH 的 "instructions into the inbox"；
 *  3. **状态**：每个 session 一份 `Map<cwd, state>`（WeakMap，随 session 回收）；会话恢复后
 *     state 为空 → 下一次 run 会重新下发一份 baseline（自愈，符合 DSH 的 baselineIdentity 意图）；
 *  4. **绝不抛异常**：任何失败都降级为"不注入 / 不下发 delta"，不能因为读不到 AGENTS.md 就中断 agent。
 *
 * 为什么不用 system prompt（本层最早的实现是那样）：指令是仓库内容、且需要中途可更新；
 * 写进 system prompt 会让"内容一变就整份 system prompt 被追加成一条消息"（`session.ts` 的
 * `applySystemPrompt`），既重又不支持增量。
 */

import * as os from "node:os";
import * as path from "node:path";

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

/** 哪些工具算"触碰了文件"（其后需要重新协调工作区指令）——对齐 DSH 的 "successful fs tool touches" */
export const WORKSPACE_TOUCHING_TOOLS = new Set(["write_file", "edit_file", "delete_file"]);

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

// ── 每 session 的状态（reconcile 需要「上一版」才能算 delta）─────────────────

interface SessionState {
  /** cwd → 该作用域链上次渲染后的状态 */
  scopes: Map<string, WorkspaceInstructionState>;
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

/** 清空某 session 的工作区指令状态（探针用；正常运行时靠 WeakMap 随 session 回收） */
export function resetWorkspaceInstructionState(session?: Session): void {
  if (session) sessionStates.delete(session);
}

// ── 渲染 ────────────────────────────────────────────────────────────────────

/** 把 included 列表压成"这段指令有哪些文件"的一句话（便于模型知道来源与边界） */
function sourceLine(included: readonly LoadedInstructionFile[]): string {
  const paths = included.map((f) => f.displayPath).join(", ");
  return `Sources: ${paths}`;
}

export interface WorkspaceInstructionPush {
  /** 是否真的写进会话 */
  pushed: boolean;
  /** 本次涉及的文件数 / 字节数（诊断用） */
  files: number;
  bytes: number;
}

/**
 * 确保本会话对这个 cwd 已经下发过 baseline；没有则渲染并注入。
 * 重复调用且内容未变时 `Session.appendWorkspaceInstructions` 会自行去重（返回 false）。
 */
export function ensureWorkspaceInstructionsBaseline(
  session: Session,
  cwd: string | undefined
): WorkspaceInstructionPush {
  const empty: WorkspaceInstructionPush = { pushed: false, files: 0, bytes: 0 };
  try {
    if (!cwd) return empty;
    const cfg = instructionConfig();
    const scopes = scopeChain(cfg, cwd);
    const rendered = renderWorkspaceInstructions(scopes, cfg);
    // 一个候选文件都没有 → 不注入（DSH 会渲染只含 intro 的空基线，tinyclaw 有意不这么做）
    if (rendered.included.length === 0) return empty;

    const text = `${sourceLine(rendered.included)}\n\n${rendered.text}`;
    const pushed = session.appendWorkspaceInstructions("baseline", cwd, text);
    // 无论是否真的追加，都把状态记下来（后续 delta 以它为准）
    const st = stateOf(session);
    const next: WorkspaceInstructionState = new Map();
    for (const f of rendered.included) next.set(`${f.scope}\u0000${path.basename(f.absolutePath)}`, f);
    st.scopes.set(cwd, next);
    // 字节数按"真正落到会话里的那条消息"算（含 marker），否则统计值会比实际偏小
    const stored = `${Session.workspaceInstructionMarker("baseline", cwd)}\n${text}`;
    return { pushed, files: rendered.included.length, bytes: Buffer.byteLength(stored, "utf-8") };
  } catch (err) {
    console.warn(
      "[instructions] baseline 注入失败，本次跳过：",
      err instanceof Error ? err.message : err
    );
    return empty;
  }
}

/**
 * 把变更渲染成给模型的增量文本。
 *
 * `reconcileWorkspaceInstructions()` 只返回**变更元数据**（action/scope/path/digest，对齐 DSH 的
 * `AgentInstructionChange`），变更文件的新内容在返回的 state 里 —— 所以这里按 `scope + 文件名`
 * 去 state 取内容，只发"变了的那几个文件"，而不是重发整份指令（对齐 DSH 的 `ChangeRenderItem`）。
 * 总量仍受预算约束：超了就截断正文并显式标注。
 */
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
      body = Buffer.from(body, "utf-8").subarray(0, Math.max(0, room)).toString("utf-8") + "\n…(truncated)";
    }
    used += Buffer.byteLength(body, "utf-8");
    items.push(`- ${label}: ${ch.path} (scope ${ch.scope})\n\n${body}`);
  }
  return [...head, "", ...items, ...tail].join("\n");
}

/**
 * fs 触碰后重新协调：只重算受影响作用域，把变更作为 delta 注入会话（下一轮 LLM 请求即可见）。
 *
 * @param touchedPaths 本次成功写/改/删的文件绝对路径
 */
export function pushWorkspaceInstructionDeltas(
  session: Session,
  cwd: string | undefined,
  touchedPaths: readonly string[]
): { changes: AgentInstructionChange[]; pushed: boolean } {
  try {
    if (!cwd || touchedPaths.length === 0) return { changes: [], pushed: false };
    const cfg = instructionConfig();
    const st = stateOf(session);
    const prev = st.scopes.get(cwd) ?? new Map();
    const first = prev.size === 0;

    // 之前没下发过 baseline（例如会话刚恢复）→ 先补一份完整基线，避免只发 delta 让模型缺上下文
    if (first) {
      const b = ensureWorkspaceInstructionsBaseline(session, cwd);
      if (b.files === 0) return { changes: [], pushed: false };
      return { changes: [], pushed: b.pushed };
    }

    const result = reconcileWorkspaceInstructions({ cfg, cwd, touchedPaths, state: prev });
    st.scopes.set(cwd, result.state);
    if (result.changes.length === 0) return { changes: result.changes, pushed: false };

    const pushed = session.appendWorkspaceInstructions(
      "delta",
      cwd,
      renderChanges(result.changes, result.state, WORKSPACE_INSTRUCTION_MAX_BYTES)
    );
    return { changes: result.changes, pushed };
  } catch (err) {
    console.warn(
      "[instructions] delta 协调失败，本次跳过：",
      err instanceof Error ? err.message : err
    );
    return { changes: [], pushed: false };
  }
}

/** 诊断用：当前 cwd 的指令文件清单（不注入、不动状态） */
export function describeWorkspaceInstructions(cwd: string): string[] {
  try {
    const cfg = instructionConfig();
    return renderWorkspaceInstructions(scopeChain(cfg, cwd), cfg).included.map((f) => f.displayPath);
  } catch {
    return [];
  }
}
