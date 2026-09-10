/**
 * SlaveManager — Master-Slave Agent Fork
 *
 * Master agent 可 fork 一个 Slave，Slave 在后台运行完整 runAgent() loop：
 * - fork()             创建独立 Session，按**轮数**继承 Master 上下文，后台运行任务
 * - forkContinuation() 克隆 Master 全量上下文（auto-fork 续跑）
 * - status()           查询 Slave 进度（phase / lastTool / toolsUsed / partialOutput）
 * - abort()            软中断 Slave
 * - 完成后轨迹**全文归档**到 ~/.tinyclaw/slaves/YYYY-MM/YYYY-MM-DD-<slaveId>/
 *
 * 注意：SlaveRunFn 故意不从 agent.ts 导入，以避免循环依赖。
 * 调用方（agent-fork.ts）通过 ToolContext.slaveRunFn 注入 runAgent 引用。
 */

import { Session } from "./session.js";
import type { ChatMessage } from "../llm/client.js";
import { archiveSlaveTrajectory, type SlaveTrajectoryMeta } from "./slave-trajectory.js";
import { createLogger } from "../utils/logger.js";
import { loadConfig } from "../config/loader.js";
import { llmRegistry } from "../llm/registry.js";
import { agentManager } from "./agent-manager.js";
import { approxMessageChars, tokensToChars } from "../memory/token-estimate.js";
import { searchMemory } from "../memory/qmd.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const log = createLogger("slave");

// ── 类型定义 ──────────────────────────────────────────────────────────────────

export interface SlaveProgress {
  round: number;
  toolsUsed: string[];
  /** 最新输出片段（截断 500 字符，运行中为实时更新） */
  partialOutput: string;
  /**
   * 当前阶段的语义化描述：最近一轮助手输出开头的 120 字。
   * 用于进度汇报回答「推进到哪一步」，而非仅「调了哪些工具」。
   */
  phase?: string;
  /** 最近一次调用的工具名 */
  lastTool?: string;
  /** 已发生的工具调用总次数（含重复调用） */
  toolCallCount?: number;
  /** 进度最后一次更新的时间（ISO） */
  updatedAt?: string;
}

export interface SlaveState {
  slaveId: string;
  task: string;
  status: "running" | "done" | "error" | "aborted";
  progress: SlaveProgress;
  result?: string;
  /** 轨迹归档目录（完成后填入，见 core/slave-trajectory.ts） */
  tracePath?: string;
  /** 上下文继承统计（fork 时填入，供 agent_status / meta.json 展示） */
  context?: {
    mode: SlaveContextMode;
    /** 本次继承的 token 预算（上下文窗口 × 比例 − 预留） */
    budgetTokens: number;
    /** 实际占用（估算） */
    usedTokens: number;
    inheritedRounds: number;
    inheritedMessages: number;
    droppedRounds: number;
    inheritedChars: number;
    summaryInjected: boolean;
    /** 召回层结果（_run 启动时填入）：ACTIVE.md 是否注入 + 语义检索字符数 */
    recall?: { activeMd: boolean; memoryChars: number };
  };
  agentId?: string;
  startedAt: string;
  finishedAt?: string;
  masterSessionId: string;
  /**
   * 结果交付模式：
   * - `"inject"`（默认）：Slave 完成后自动注入 Master session，触发新一轮 LLM 推理
   * - `"wait"`：Slave 完成后静默，Master 需主动调用 agent_wait(slave_id) 拉取结果
   */
  resultMode: "inject" | "wait";
}

export interface SlaveNotification {
  slaveId: string;
  task: string;
  status: "done" | "error" | "aborted";
  result: string;
  masterSessionId: string;
}

/** Slave 定期进度推送回调 */
export type SlaveProgressNotifyFn = (slaveId: string, state: SlaveState) => Promise<void>;

/**
 * Slave 运行函数签名（由 agent.ts 的 runAgent 实现，通过 ToolContext.slaveRunFn 注入）。
 * 使用独立签名避免从 agent.ts 直接导入（防循环依赖）。
 */
export type SlaveRunFn = (
  session: Session,
  content: string,
  opts?: {
    systemPrompt?: string;
    systemPromptSuffix?: string;
    skipPreamble?: boolean;
    onToolCall?: (name: string, args: Record<string, unknown>) => void;
    onToolResult?: (name: string, result: string) => void;
    onChunk?: (delta: string) => void;
  }
) => Promise<{ content: string; toolsUsed: string[] }>;

/**
 * fork() 透传给 runFn 的附加选项。
 * `onToolCall` / `onChunk` 由 SlaveManager 自己注入，用于实时更新 SlaveProgress，
 * 调用方不应覆盖（调用方传入的同名回调会被忽略）。
 */
export interface SlaveRunExtraOpts {
  systemPromptSuffix?: string;
  skipPreamble?: boolean;
}

/**
 * agent_wait 的返回：区分「Slave 真的结束了」与「只是本次等待超时」。
 *
 * 超时**不再改写 Slave 状态**（旧实现把仍在运行的 Slave 标成 error，
 * 之后又在其真正完成时被静默改回 done，见 A3）。
 */
export interface SlaveWaitResult {
  state: SlaveState;
  /** 本次等待超时；为 true 时 state.status 仍可能是 "running" */
  timedOut: boolean;
}

export interface SlaveWaitAllResult {
  states: Map<string, SlaveState>;
  timedOut: boolean;
  /** 超时时仍在运行的 Slave id 列表 */
  stillRunningIds: string[];
}

// ── 常量 ──────────────────────────────────────────────────────────────────────

const MAX_PARTIAL_LEN = 500;
const MAX_PHASE_LEN = 120;

/** 召回层：ACTIVE.md 注入上限（字符） */
const ACTIVE_INJECT_MAX_CHARS = 4_000;
/** 召回层：QMD 检索结果注入上限（字符） */
const RECALL_INJECT_MAX_CHARS = 1_500;
/**
 * 召回层的整体时间上限（ms）。
 *
 * 召回层位于 `runFn` 之前，它的耗时**直接叠加到 Slave 的启动延迟**上。
 * 而 `searchMemory` 内部包含 embed 服务探活（超时 5s）、sqlite 加载失败回退等路径，
 * 在服务异常或环境不完整时可能明显变慢。超时即放弃召回（只记日志），
 * 绝不让"锦上添花"的记忆召回拖住 Slave 开工。
 */
const RECALL_TIMEOUT_MS = 3_000;

const SLAVE_SYSTEM_PROMPT = `## ⚠️ 你正在以【Sub-Agent / Slave】身份运行（后台异步执行）

以下规则必须严格遵守：

### 执行规范
1. **直接执行**：消息中包含你的具体任务，立即执行，不要询问用户确认或追问细节
2. **无人值守**：没有用户在线，所有决策须自主完成，不依赖人工介入
3. **简洁输出**：仅输出最终结果和关键信息，不要描述执行步骤
4. **禁止嵌套 fork**：不得调用 agent_fork 工具（禁止嵌套 Slave）

### 上下文说明
- 若有"Master 对话历史摘要"system 消息，是 Master 历史对话的压缩摘要（只读背景）
- "## 以下为 Master 的历史对话"之后的 user / assistant / tool / system 消息，
  是 Master 最近若干轮的完整对话记录（只读），**包含工具调用与其返回结果**
- **最后一条 user 消息是你的具体任务**，请直接执行

### 轨迹说明
- 你的完整执行轨迹（含每次工具调用与结果）会被归档留档，可被 Master 通过 agent_trace 检索`;

// ── 上下文继承（两条 fork 路径共用） ──────────────────────────────────────────

/** Slave 继承模式（对应 config.memory.slaveContextMode，可被 agent_fork 的 context_mode 覆盖） */
export type SlaveContextMode = "task-only" | "minimal" | "standard" | "full";

/**
 * 继承预算里必须给 Slave 自己留出的部分（token）：
 * 它自己的 system prompt + task + 工具往返 + 最终输出。
 * 作用是把预算**上界**压在 `窗口 − 预留`，而不是从比例里做减法
 * （做减法会在小窗口下把预算减成负数）。
 */
const SLAVE_CONTEXT_RESERVE_TOKENS = 8_000;
/**
 * 继承预算的绝对下限（token）。
 * `窗口 × ratio` 在小窗口下会小得没用（128k × 0.05 = 6400），
 * 因此预算取 `clamp(窗口 × ratio, 下限, 窗口 − 预留)`。
 */
const SLAVE_CONTEXT_MIN_TOKENS = 8_000;

/** `minimal` 模式的轮数上限 */
const MINIMAL_ROUNDS = 6;

/** buildSlaveContext 的返回：便于在日志与 meta 中记录继承了哪些内容 */
export interface SlaveContextStats {
  mode: SlaveContextMode;
  /** 本次继承的 token 预算（由上下文窗口 × 比例得出） */
  budgetTokens: number;
  /** 实际占用（估算） */
  usedTokens: number;
  inheritedMessages: number;
  inheritedRounds: number;
  /** 是否注入了 Master 压缩摘要 */
  summaryInjected: boolean;
  /** 因预算不足而未纳入的轮数 */
  droppedRounds: number;
  /** 实际继承的字符数（近似值，用于观测） */
  inheritedChars: number;
}

/**
 * 给 Promise 加超时。超时抛错（由调用方决定是放弃还是降级），
 * 不会取消底层操作（JS 无取消语义），但保证调用方不被无限期挂住。
 */
function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  if (ms <= 0) return p;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}超时（>${ms}ms）`)), ms);
    timer.unref?.();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    );
  });
}

/**
 * 构建 Slave 的初始上下文（**结构化继承**）。
 *
 * 设计要点：
 * - 两条 fork 路径共用本函数，避免 `fork()` 与 `forkContinuation()` 的继承质量不一致
 * - 保留 `tool_calls` 与 `role:"tool"` 的原始结构（旧实现用 extractText 降级为纯文本，
 *   且没有 `role:"tool"` 分支，导致 Slave 完全看不到工具证据）
 * - **只取最近**：从最新一轮向前累计直到用满预算即停（而不是"取一批再从最旧砍"——
 *   那样会先把远期拉进来、再砍掉近因边缘，顺序是反的）
 * - 按轮对齐：起点必须落在 `role:"user"`，绝不以孤立的 `role:"tool"` 开头
 * - 预算按**模型上下文窗口 × 比例**得出，不是一个固定字符数（窗口在不同后端差异极大）
 * - 继承内容同步写入 Slave 的 JSONL，使其轨迹自包含（见 core/slave-trajectory.ts）
 * - 剥掉继承消息上的 `_loopTaskRef`，避免 Slave 侧被 Master 的 loop 任务文件顶掉载荷
 *
 * **场景前提（重要）**：本 claw 的 chat 模式是「智能管家」型的长会话。
 * 继承的职责是提供**近因**（最近一段聊了什么），不是"起因"（最早那条消息可能来自几个月前）。
 * 远期由三处承担：system prompt 里的 MEM.md（长期偏好）、本函数注入的 Master 压缩检查点
 * （本会话中段）、以及 `_run` 里的召回层（ACTIVE.md + QMD 检索）。
 *
 * @param opts.mode   继承模式；`task-only` 不继承任何历史
 * @param opts.rounds 调用方显式给的轮数上限（与 mode 取更严格者）
 */
function buildSlaveContext(
  slaveSession: Session,
  masterSession: Session,
  opts: { mode: SlaveContextMode; rounds?: number }
): SlaveContextStats {
  const all = masterSession.getMessages();

  // ── 预算：clamp(窗口 × 比例, 下限, 窗口 − 预留) ──────────────────────────
  const cfg = loadConfig();
  const ratio = cfg.memory.slaveContextRatio;
  const ctxWindow = llmRegistry.getContextWindow("daily", masterSession.lastResponseAt);
  const upper = Math.max(
    SLAVE_CONTEXT_MIN_TOKENS,
    ctxWindow - SLAVE_CONTEXT_RESERVE_TOKENS
  );
  const budgetTokens = Math.min(
    upper,
    Math.max(SLAVE_CONTEXT_MIN_TOKENS, Math.floor(ctxWindow * ratio))
  );
  const budgetChars = tokensToChars(budgetTokens);

  // ── task-only：完全不继承（system prompt 里的 MEM.md / SKILLS.md 仍然在） ──
  // 必须早返回：否则下面 `userIdx[len - 0]` 会越界取到 undefined，
  // 而 `Array.slice(undefined)` 等于**全量切片**（曾经因此把 12 轮全继承进来）。
  if (opts.mode === "task-only") {
    return {
      mode: opts.mode,
      budgetTokens,
      usedTokens: 0,
      inheritedMessages: 0,
      inheritedRounds: 0,
      summaryInjected: false,
      droppedRounds: all.filter((m) => m.role === "user").length,
      inheritedChars: 0,
    };
  }

  // 轮数上限：mode 与调用方给的值取更严格者
  const modeRoundCap = opts.mode === "minimal" ? MINIMAL_ROUNDS : undefined;
  const roundCap =
    modeRoundCap === undefined
      ? opts.rounds && opts.rounds > 0
        ? opts.rounds
        : undefined
      : opts.rounds && opts.rounds > 0
        ? Math.min(modeRoundCap, opts.rounds)
        : modeRoundCap;

  // ── 只取最近：定位"最后 roundCap 轮"的起点（若给了上限） ────────────────
  let startIdx = 0;
  if (roundCap !== undefined) {
    const userIdx: number[] = [];
    for (let i = 0; i < all.length; i++) {
      if (all[i]!.role === "user") userIdx.push(i);
    }
    startIdx = userIdx.length > roundCap ? userIdx[userIdx.length - roundCap]! : 0;
  }

  // ── 从最新一轮向前累计，直到用满预算 ────────────────────────────────────
  // startIdx 是"允许的最早起点"，我们从这个位置往后取；若超预算，则把起点往后推
  // （即丢弃**更旧**的轮），直到落在预算内。等价于"只取最近、够预算就停"。
  let trimmed = all.slice(startIdx);
  let droppedRounds = 0;
  let chars = trimmed.reduce((sum, m) => sum + approxMessageChars(m), 0);
  while (chars > budgetChars && trimmed.length > 1) {
    let nextUser = 1;
    while (nextUser < trimmed.length && trimmed[nextUser]!.role !== "user") nextUser++;
    if (nextUser >= trimmed.length) break; // 只剩最后一轮，再丢就没有上下文了
    for (let i = 0; i < nextUser; i++) chars -= approxMessageChars(trimmed[i]!);
    trimmed = trimmed.slice(nextUser);
    droppedRounds++;
  }

  // ── 注入 Master 压缩摘要（本会话"中段"的载体） ──────────────────────────
  let summaryInjected = false;
  if (masterSession.lastSummary) {
    const covered = trimmed.some(
      (m) => typeof m.content === "string" && m.content.includes("[对话历史摘要]")
    );
    if (!covered) {
      slaveSession.addSystemMessage(
        `## Master 对话历史摘要（本会话更早部分的压缩）\n\n${masterSession.lastSummary}`
      );
      summaryInjected = true;
    }
  }

  // ── 结构化导入（保留 tool_call / tool_result 结构，并落盘） ──────────────
  // 注意：必须先剥掉 `_loopTaskRef`。该字段的语义是"最后一条此类消息由
  // getMessagesForLLM() 展开成该路径的文件内容"，而 Slave 继承到的 ref 指向
  // **Master 的** loop 任务文件（如 loops/<id>.json）。若保留，Slave 侧会用它
  // 顶掉真正的注入载荷（本轮行情/步骤输出），使其只看到 loop 配置文件。
  // Slave 有自己的任务（最后一条 user 消息），Master 的 loop 任务对它是只读背景，
  // 用快照 content 即可，不需要跟随文件变化。
  const cleaned = trimmed.map((m) => {
    const withRef = m as ChatMessage & { _loopTaskRef?: string };
    if (!withRef._loopTaskRef) return m;
    const { _loopTaskRef: _dropped, ...rest } = withRef;
    return rest as ChatMessage;
  });

  if (cleaned.length > 0) {
    slaveSession.importMessages(cleaned, { persist: true });
  }

  return {
    mode: opts.mode,
    budgetTokens,
    usedTokens: Math.ceil(chars / 3.5),
    inheritedMessages: cleaned.length,
    // 报告**实际**继承的轮数（裁剪后重新计数），避免与 droppedRounds 互相矛盾
    inheritedRounds: cleaned.filter((m) => m.role === "user").length,
    summaryInjected,
    droppedRounds,
    inheritedChars: chars,
  };
}


// ── SlaveManager ──────────────────────────────────────────────────────────────

class SlaveManager {
  private readonly states = new Map<string, SlaveState>();
  private readonly sessions = new Map<string, Session>();

  /**
   * Fork 一个 Slave agent，立即返回 slaveId，后台异步运行。
   *
   * @param task                Slave 的任务描述（注入为最后一条 user 消息）
   * @param masterSession       Master Session（用于复制上下文快照）
   * @param contextRounds       轮数上限（与 mode 取更严格者）；<=0 表示不额外限制
   * @param contextMode         继承模式，默认取 config.memory.slaveContextMode
   * @param runFn               runAgent 实现（由 ToolContext.slaveRunFn 注入，避免循环依赖）
   * @param onComplete          Slave 完成后的回调
   * @param reportIntervalSecs  定期进度推送间隔（秒），0 或不传则不启用
   * @param onProgressNotify    定期进度推送回调（每 reportIntervalSecs 秒调用一次）
   * @param resultMode          结果交付模式："inject"（默认，完成后触发 onComplete）| "wait"（静默，Master 主动拉取）
   */
  fork(
    task: string,
    masterSession: Session,
    contextRounds: number,
    runFn: SlaveRunFn,
    onComplete?: (notif: SlaveNotification) => Promise<void>,
    reportIntervalSecs?: number,
    onProgressNotify?: SlaveProgressNotifyFn,
    resultMode: "inject" | "wait" = "inject",
    extraRunOpts?: SlaveRunExtraOpts,
    contextMode?: SlaveContextMode
  ): string {
    const slaveId = crypto.randomUUID().slice(0, 8);
    const mode = contextMode ?? loadConfig().memory.slaveContextMode;

    const state: SlaveState = {
      slaveId,
      task,
      status: "running",
      progress: { round: 0, toolsUsed: [], partialOutput: "" },
      startedAt: new Date().toISOString(),
      masterSessionId: masterSession.sessionId,
      agentId: masterSession.agentId,
      resultMode,
    };
    this.states.set(slaveId, state);

    // 创建独立 Slave Session（agentId 继承 Master，共享 workspace/memory）
    const slaveSessionId = `slave:${slaveId}`;
    const slaveSession = new Session(slaveSessionId, { agentId: masterSession.agentId });
    this.sessions.set(slaveId, slaveSession);

    // 结构化继承：按 mode 与预算取"最近的"若干轮（含工具调用与结果）
    const stats = buildSlaveContext(slaveSession, masterSession, {
      mode,
      rounds: contextRounds,
    });
    state.context = {
      mode: stats.mode,
      budgetTokens: stats.budgetTokens,
      usedTokens: stats.usedTokens,
      inheritedRounds: stats.inheritedRounds,
      inheritedMessages: stats.inheritedMessages,
      droppedRounds: stats.droppedRounds,
      inheritedChars: stats.inheritedChars,
      summaryInjected: stats.summaryInjected,
    };

    log.info(
      `[slave:${slaveId}] forked by ${masterSession.sessionId.slice(-12)}, mode=${stats.mode}, ` +
        `继承 ${stats.inheritedRounds} 轮 / ${stats.inheritedMessages} 条` +
        `${stats.summaryInjected ? " + 摘要" : ""}` +
        `${stats.droppedRounds > 0 ? ` (预算不足未纳入 ${stats.droppedRounds} 轮)` : ""}, ` +
        `约 ${stats.usedTokens}/${stats.budgetTokens} tokens, task="${task.slice(0, 60)}"`
    );

    // 后台运行（fire-and-forget）
    // wait 模式：Slave 完成后不触发 onComplete，Master 通过 agent_wait 主动拉取
    const effectiveOnComplete = resultMode === "wait" ? undefined : onComplete;
    void this._run(
      slaveId,
      slaveSession,
      task,
      runFn,
      effectiveOnComplete,
      reportIntervalSecs,
      onProgressNotify,
      false,
      extraRunOpts
    );

    return slaveId;
  }

  /**
   * Fork a continuation Slave that picks up an in-progress Master ReAct loop.
   *
   * 与 `fork()` 共用同一套**结构化继承**（buildSlaveContext），区别只是继承全量而非最近 N 轮。
   * `runFn` 以 `skipPreamble: true` 调用：不重建 system prompt、不注入用户消息，
   * session 里已经是完整可直接续跑的状态。
   *
   * Called automatically by `runAgent()` when elapsed time exceeds the auto-fork threshold.
   */
  forkContinuation(
    masterSession: Session,
    runFn: SlaveRunFn,
    onComplete?: (notif: SlaveNotification) => Promise<void>,
    onProgressNotify?: SlaveProgressNotifyFn
  ): string {
    const slaveId = crypto.randomUUID().slice(0, 8);

    const state: SlaveState = {
      slaveId,
      task: "(auto-fork continuation)",
      status: "running",
      progress: { round: 0, toolsUsed: [], partialOutput: "" },
      startedAt: new Date().toISOString(),
      masterSessionId: masterSession.sessionId,
      agentId: masterSession.agentId,
      resultMode: "inject",
    };
    this.states.set(slaveId, state);

    const slaveSessionId = `slave:${slaveId}`;
    const slaveSession = new Session(slaveSessionId, { agentId: masterSession.agentId });
    this.sessions.set(slaveId, slaveSession);

    // 结构化继承全量 Master 上下文（含 tool_call / tool_result），并落盘使轨迹自包含。
    // auto-fork 的语义是"接着刚才那轮继续"，因此用 standard 而不是 config 默认值，
    // 但仍受预算约束（不设轮数上限）。
    const stats = buildSlaveContext(slaveSession, masterSession, { mode: "standard" });
    state.context = {
      mode: stats.mode,
      budgetTokens: stats.budgetTokens,
      usedTokens: stats.usedTokens,
      inheritedRounds: stats.inheritedRounds,
      inheritedMessages: stats.inheritedMessages,
      droppedRounds: stats.droppedRounds,
      inheritedChars: stats.inheritedChars,
      summaryInjected: stats.summaryInjected,
    };

    // Append a brief continuation hint so the Slave knows it's running headless
    slaveSession.addSystemMessage(
      "## ⚠️ Sub-Agent 后台续跑提示\n\n" +
        "你是一个在后台继续执行的 Sub-Agent（Slave）。" +
        "上方对话历史是原 Master 会话的完整上下文（含已执行工具的结果）。\n" +
        "请直接从当前状态继续完成任务，无需重复已完成的步骤，无用户在线，自主决策。\n" +
        "禁止调用 agent_fork 工具（不得嵌套 fork）。"
    );

    log.info(
      `[slave:${slaveId}] auto-fork continuation from ${masterSession.sessionId.slice(-12)}, ` +
        `继承 ${stats.inheritedMessages} 条` +
        `${stats.droppedRounds > 0 ? ` (预算裁剪丢 ${stats.droppedRounds} 轮)` : ""}, ` +
        `约 ${stats.inheritedChars} 字符`
    );

    void this._run(
      slaveId,
      slaveSession,
      "(auto-fork continuation)",
      runFn,
      onComplete,
      undefined,
      onProgressNotify,
      true
    );

    return slaveId;
  }

  /** 软中断 Slave */
  abort(slaveId: string): string {
    const state = this.states.get(slaveId);
    if (!state) return `Slave "${slaveId}" 不存在`;
    if (state.status !== "running")
      return `Slave "${slaveId}" 当前状态为 ${state.status}，无需中断`;

    const session = this.sessions.get(slaveId);
    if (session) {
      session.abortRequested = true;
      session.llmAbortController?.abort();
    }

    // 软中断：状态由 _run 的真正收尾决定（工具执行中的 Slave 不会立即停下），
    // 这里只记录中止意图，避免状态领先于事实。
    state.progress.phase = "已请求中断，等待当前步骤结束";
    state.progress.updatedAt = new Date().toISOString();
    log.info(`[slave:${slaveId}] abort requested`);
    return `Slave "${slaveId}" 已请求中断（软中断，当前步骤结束后停止）`;
  }

  /** 查询单个 Slave 状态 */
  status(slaveId: string): SlaveState | undefined {
    return this.states.get(slaveId);
  }

  /** 查询全部 Slave 状态快照 */
  listAll(): SlaveState[] {
    return Array.from(this.states.values());
  }

  /**
   * 等待当前 master session 创建的所有 slave 结束。
   *
   * **超时不会改写任何 Slave 状态**（A3）：超时是调用方的观察结果，不是被观察对象的状态。
   * 调用方拿到 `timedOut: true` 后应继续用 agent_status 查询，或用 agent_abort 显式中止。
   *
   * @param masterSessionId  Master 的 sessionId（用于过滤出属于该 master 的 slave）
   * @param timeoutMs        等待超时（毫秒）
   */
  async waitForByMaster(
    masterSessionId: string,
    timeoutMs: number
  ): Promise<SlaveWaitAllResult> {
    const deadline = Date.now() + timeoutMs;
    const POLL_INTERVAL_MS = 200;

    while (Date.now() < deadline) {
      const mySlaves = Array.from(this.states.values()).filter(
        (s) => s.masterSessionId === masterSessionId
      );
      const running = mySlaves.filter((s) => s.status === "running");
      if (running.length === 0) break;
      await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    const stillRunningIds: string[] = [];
    const result = new Map<string, SlaveState>();
    for (const [id, state] of this.states) {
      if (state.masterSessionId !== masterSessionId) continue;
      result.set(id, { ...state });
      if (state.status === "running") stillRunningIds.push(id);
    }

    if (stillRunningIds.length > 0) {
      log.warn(
        `[master:${masterSessionId.slice(-12)}] waitForByMaster timeout, ` +
          `仍在运行: ${stillRunningIds.join(", ")}`
      );
    }

    return { states: result, timedOut: stillRunningIds.length > 0, stillRunningIds };
  }

  /**
   * 等待指定单个 Slave 完成（适用于 result_mode="wait" 的 Slave）。
   *
   * @param slaveId    要等待的 Slave ID
   * @param timeoutMs  等待超时（毫秒）
   * @returns 状态快照 + 是否超时；slaveId 不存在时返回 undefined。
   *          **超时不改写 Slave 状态**（A3）。
   */
  async waitForById(slaveId: string, timeoutMs: number): Promise<SlaveWaitResult | undefined> {
    const state = this.states.get(slaveId);
    if (!state) return undefined;

    const deadline = Date.now() + timeoutMs;
    const POLL_INTERVAL_MS = 200;

    while (state.status === "running" && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    const timedOut = state.status === "running";
    if (timedOut) {
      log.warn(`[slave:${slaveId}] waitForById timeout（Slave 仍在运行，状态未改写）`);
    }

    return { state: { ...state }, timedOut };
  }

  /** 清理已完成的 Slave 内存状态（轨迹已在 _run 收尾时归档，不会被删） */
  gc(): void {
    const now = Date.now();
    for (const [id, state] of this.states) {
      if (state.status !== "running" && state.finishedAt) {
        const age = now - new Date(state.finishedAt).getTime();
        if (age > 24 * 60 * 60 * 1000) {
          // 24h 后仅清理内存态；轨迹文件已归档到 ~/.tinyclaw/slaves/
          this.states.delete(id);
          this.sessions.delete(id);
        }
      }
    }

    // 扫描 sessions 目录，把孤立/中断遗留的 slave_*.jsonl **归档**而非删除
    // （进程重启后内存状态丢失，这些文件是那次运行唯一的轨迹证据）
    try {
      const sessDir = path.join(os.homedir(), ".tinyclaw", "sessions");
      if (fs.existsSync(sessDir)) {
        for (const entry of fs.readdirSync(sessDir)) {
          if (!/^slave_[0-9a-f]{8}\.jsonl$/.test(entry)) continue;
          const slaveId = entry.replace(/^slave_/, "").replace(/\.jsonl$/, "");
          const state = this.states.get(slaveId);
          if (state && state.status === "running") continue;
          this.archiveOrphan(slaveId, path.join(sessDir, entry));
        }
      }
    } catch (err) {
      log.warn(`[slave:gc] 扫描孤立 JSONL 失败: ${err instanceof Error ? err.message : err}`);
    }

    // 扫描 sessions 目录，清理孤立的 cron_*.jsonl
    // Stateful / pipeline cron job 使用固定 sessionId `cron:<jobId>`，
    // 对应 JSONL 文件名为 `cron_<jobId>.jsonl`。
    // 当 job 被删除后，该文件不再有 job 与之对应，需要清理。
    // 通过扫描 ~/.tinyclaw/cron/jobs/ 目录（无需解析 JSON，仅取文件名）获取现存 job ID 集合，
    // 避免 import cron/store.ts 引入额外依赖。
    try {
      const sessDir = path.join(os.homedir(), ".tinyclaw", "sessions");
      const cronJobsDir = path.join(os.homedir(), ".tinyclaw", "cron", "jobs");
      if (fs.existsSync(sessDir) && fs.existsSync(cronJobsDir)) {
        // 收集现存 job ID（文件名去掉 .json 后缀）
        const existingJobIds = new Set(
          fs
            .readdirSync(cronJobsDir)
            .filter((f) => f.endsWith(".json"))
            .map((f) => f.slice(0, -5))
        );
        for (const entry of fs.readdirSync(sessDir)) {
          // 匹配 cron_<jobId>.jsonl（jobId 仅含字母数字和连字符，不含下划线）
          // 无状态 session 的 sessionId 为 `cron:<jobId>:<ts>`，sanitized 后含下划线分隔时间戳，不匹配
          const match = /^cron_([a-zA-Z0-9-]+)\.jsonl$/.exec(entry);
          if (!match) continue;
          const jobId = match[1]!;
          if (!existingJobIds.has(jobId)) {
            try {
              fs.unlinkSync(path.join(sessDir, entry));
              console.log(`[cron:gc] 清理孤立 session JSONL: ${entry}`);
            } catch {
              /* 静默忽略 */
            }
          }
        }
      }
    } catch {
      /* 静默忽略，GC 失败不影响正常运行 */
    }
  }

  // ── 内部实现 ────────────────────────────────────────────────────────────────

  /**
   * 归档一个"孤儿" slave JSONL（进程重启后内存态丢失、或异常退出遗留）。
   * 只做归档，不解析内容。
   */
  private archiveOrphan(slaveId: string, jsonlPath: string): void {
    const stat = ((): { size: number; mtime: Date } | null => {
      try {
        const s = fs.statSync(jsonlPath);
        return { size: s.size, mtime: s.mtime };
      } catch {
        return null;
      }
    })();
    if (!stat) return;

    const iso = stat.mtime.toISOString();
    try {
      const res = archiveSlaveTrajectory({
        slaveId,
        agentId: "unknown",
        task: "(进程重启前遗留的 slave，未记录任务描述)",
        masterSessionId: "unknown",
        status: "error",
        startedAt: iso,
        finishedAt: iso,
        toolsUsed: [],
        result: `该 slave 的会话在进程重启/异常退出前未正常收尾，轨迹由 gc 归档。\n原始文件：${jsonlPath}\n字节数：${stat.size}`,
        sessionJsonlPath: jsonlPath,
        reason: "orphan",
      });
      log.info(`[slave:gc] 已归档孤立轨迹: ${res.dir}`);
    } catch (err) {
      log.warn(
        `[slave:gc] 归档孤立轨迹失败 ${slaveId}: ${err instanceof Error ? err.message : err}`
      );
    }
  }

  /**
   * 注入「召回层」：ACTIVE.md（近期活跃上下文）+ QMD 语义检索。
   *
   * 为什么放在这里而不是 buildSlaveContext：
   * - 两者都是 **async**，而 `fork()` 必须同步返回 slaveId
   * - 语义上也不同：继承给的是"最近聊了什么"（近因），召回给的是
   *   "主人当前在忙什么"（ACTIVE.md）与"以前相关的片段"（向量检索）
   *
   * 全部 best-effort：任一步失败只记日志，不影响 Slave 启动。
   */
  private async injectRecallLayer(
    session: Session,
    task: string,
    state: SlaveState
  ): Promise<void> {
    if (!loadConfig().memory.slaveRecall) return;

    // 1. ACTIVE.md —— 管家场景下"主人当前在忙什么"的正牌载体
    let activeInjected = false;
    try {
      const activePath = agentManager.activePath(session.agentId);
      if (fs.existsSync(activePath)) {
        const raw = fs.readFileSync(activePath, "utf-8").trim();
        if (raw) {
          const truncated =
            raw.length > ACTIVE_INJECT_MAX_CHARS
              ? `${raw.slice(0, ACTIVE_INJECT_MAX_CHARS)}\n…（ACTIVE.md 超长已截断）`
              : raw;
          session.addSystemMessage(
            `## 主人近期活跃上下文（ACTIVE.md）\n\n${truncated}`
          );
          activeInjected = true;
        }
      }
    } catch (err) {
      log.warn(
        `[slave:${state.slaveId}] ACTIVE.md 注入失败: ${err instanceof Error ? err.message : err}`
      );
    }

    // 2. QMD 语义检索 —— 用 task 作 query（Slave 的 task 语义清晰，天然适合检索）
    //    带整体超时：召回失败/变慢都不能拖住 Slave 开工
    let recallChars = 0;
    try {
      const hit = await withTimeout(
        searchMemory(task.slice(0, 200), session.agentId, 5),
        RECALL_TIMEOUT_MS,
        "记忆检索"
      );
      if (hit && hit.trim()) {
        const truncated =
          hit.length > RECALL_INJECT_MAX_CHARS ? `${hit.slice(0, RECALL_INJECT_MAX_CHARS)}…` : hit;
        session.addSystemMessage(`## 相关历史记忆（语义检索）\n\n${truncated}`);
        recallChars = truncated.length;
      }
    } catch (err) {
      log.warn(
        `[slave:${state.slaveId}] 记忆检索跳过: ${err instanceof Error ? err.message : err}`
      );
    }

    if (state.context) {
      state.context.recall = { activeMd: activeInjected, memoryChars: recallChars };
    }
    if (activeInjected || recallChars > 0) {
      log.info(
        `[slave:${state.slaveId}] 召回层: ACTIVE.md=${activeInjected ? "是" : "否"}, ` +
          `语义检索=${recallChars} 字符`
      );
    }
  }

  private async _run(
    slaveId: string,
    session: Session,
    task: string,
    runFn: SlaveRunFn,
    onComplete?: (notif: SlaveNotification) => Promise<void>,
    reportIntervalSecs?: number,
    onProgressNotify?: SlaveProgressNotifyFn,
    skipPreamble?: boolean,
    extraRunOpts?: SlaveRunExtraOpts
  ): Promise<void> {
    const state = this.states.get(slaveId)!;

    // ── 召回层（管家场景的"远期/近因"补充）────────────────────────────────
    // Slave 的自动记忆检索在 agent.ts 里被 `!isSlave` 关掉了，这里补两件事：
    //   1. ACTIVE.md —— "近期活跃上下文 / 未完成事项 / 最新要求"（主人当前在忙什么）
    //   2. QMD 语义检索 —— 用 task 做 query，召回跨会话的相关历史片段
    // 两者都比"把远期原文塞进上下文"更省 token 也更准。
    await this.injectRecallLayer(session, task, state);

    // ── 实时进度：把 Slave 自己的工具调用与输出流接进 SlaveProgress ──────────
    // 旧实现只在 _run 收尾时写一次 progress，导致「定期进度推送」全程汇报的是空值。
    const turnBuf = { text: "" };
    const progressOpts = {
      onToolCall: (name: string): void => {
        // 新一轮助手输出结束、工具开始执行 → 把它固化为 phase
        if (turnBuf.text.trim()) {
          state.progress.phase = turnBuf.text.trim().slice(0, MAX_PHASE_LEN);
        }
        turnBuf.text = "";
        state.progress.lastTool = name;
        state.progress.toolCallCount = (state.progress.toolCallCount ?? 0) + 1;
        if (!state.progress.toolsUsed.includes(name)) state.progress.toolsUsed.push(name);
        state.progress.updatedAt = new Date().toISOString();
      },
      onChunk: (delta: string): void => {
        turnBuf.text += delta;
        // 只保留尾部，避免长任务下缓冲区无限增长
        if (turnBuf.text.length > MAX_PARTIAL_LEN * 4) {
          turnBuf.text = turnBuf.text.slice(-MAX_PARTIAL_LEN * 2);
        }
        state.progress.partialOutput = turnBuf.text.slice(-MAX_PARTIAL_LEN);
        state.progress.updatedAt = new Date().toISOString();
      },
    };

    // 启动定期进度推送（如果配置了间隔 > 0 且有回调）
    let progressInterval: ReturnType<typeof setInterval> | undefined;
    if (reportIntervalSecs && reportIntervalSecs > 0 && onProgressNotify) {
      progressInterval = setInterval(() => {
        if (state.status !== "running") return;
        onProgressNotify(slaveId, { ...state }).catch((err) => {
          log.warn(`[slave:${slaveId}] onProgressNotify error: ${err instanceof Error ? err.message : err}`);
        });
      }, reportIntervalSecs * 1000);
    }

    try {
      const runOpts = skipPreamble
        ? { skipPreamble: true, ...progressOpts }
        : {
            systemPromptSuffix: extraRunOpts?.systemPromptSuffix
              ? `${SLAVE_SYSTEM_PROMPT}\n\n${extraRunOpts.systemPromptSuffix}`
              : SLAVE_SYSTEM_PROMPT,
            ...progressOpts,
          };
      const result = await runFn(session, task, runOpts);

      // 收尾：中止请求优先于 done
      state.status = session.abortRequested ? "aborted" : "done";
      state.result = result.content;
      state.progress.toolsUsed = result.toolsUsed;
      state.progress.partialOutput = result.content.slice(-MAX_PARTIAL_LEN);
    } catch (err) {
      state.status = session.abortRequested ? "aborted" : "error";
      state.result = `执行失败：${err instanceof Error ? err.message : String(err)}`;
      log.error(`[slave:${slaveId}] error: ${err instanceof Error ? err.message : err}`);
    }

    // 清除进度推送定时器
    if (progressInterval !== undefined) clearInterval(progressInterval);

    state.finishedAt = new Date().toISOString();
    state.progress.updatedAt = state.finishedAt;
    log.info(`[slave:${slaveId}] ${state.status} (${state.finishedAt})`);

    // ── 轨迹归档（A2）：把 Slave 的 JSONL **移动**到归档目录，不再删除 ──────
    // 使子 agent 的工具调用、参数、结果、最终产出全部可检索、可复盘。
    try {
      const meta: Omit<SlaveTrajectoryMeta, "trajectoryBytes" | "messageCount" | "reason"> = {
        slaveId,
        task,
        agentId: session.agentId,
        masterSessionId: state.masterSessionId,
        status: state.status as "done" | "error" | "aborted",
        startedAt: state.startedAt,
        finishedAt: state.finishedAt,
        toolsUsed: state.progress.toolsUsed,
      };
      const res = archiveSlaveTrajectory({
        ...meta,
        result: state.result ?? "",
        sessionJsonlPath: Session.getJsonlPath(session.sessionId),
        reason: "completed",
        ...(state.context
          ? {
              inheritedRounds: state.context.inheritedRounds,
              inheritedMessages: state.context.inheritedMessages,
              droppedRounds: state.context.droppedRounds,
              inheritedChars: state.context.inheritedChars,
            }
          : {}),
      });
      state.tracePath = res.dir;
    } catch (err) {
      log.warn(
        `[slave:${slaveId}] 轨迹归档失败: ${err instanceof Error ? err.message : err}`
      );
    }

    if (!onComplete) return;

    const notif: SlaveNotification = {
      slaveId,
      task: state.task,
      status: state.status as "done" | "error" | "aborted",
      result: state.result ?? "",
      masterSessionId: state.masterSessionId,
    };

    try {
      await onComplete(notif);
    } catch (err) {
      log.error(`[slave:${slaveId}] onComplete callback error: ${err instanceof Error ? err.message : err}`);
    }
  }
}

// ── 单例导出 ──────────────────────────────────────────────────────────────────

export const slaveManager = new SlaveManager();
