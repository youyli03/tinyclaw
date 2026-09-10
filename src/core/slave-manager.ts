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

/** buildSlaveContext 的返回：便于在日志与 meta 中记录继承了哪些内容 */
export interface SlaveContextStats {
  inheritedMessages: number;
  inheritedRounds: number;
  /** 是否注入了 Master 压缩摘要 */
  summaryInjected: boolean;
}

/**
 * 构建 Slave 的初始上下文（**结构化继承**）。
 *
 * 设计要点：
 * - 两条 fork 路径共用本函数，避免 `fork()` 与 `forkContinuation()` 的继承质量不一致
 * - 保留 `tool_calls` 与 `role:"tool"` 的原始结构（旧实现用 extractText 降级为纯文本，
 *   且没有 `role:"tool"` 分支，导致 Slave 完全看不到工具证据）
 * - 裁剪按**轮数**（轮 = 一条 user 消息到下一个 user 消息之前）向前对齐，
 *   避免切断「assistant 发 tool_call / 结果未回」的中间态
 * - 继承内容同步写入 Slave 的 JSONL，使其轨迹自包含（见 core/slave-trajectory.ts）
 *
 * @param rounds 继承最近多少轮；省略或 <=0 表示继承全量
 */
function buildSlaveContext(
  slaveSession: Session,
  masterSession: Session,
  rounds?: number
): SlaveContextStats {
  const all = masterSession.getMessages();

  // ── 按轮对齐：找到倒数第 rounds 条 user 消息的下标 ──────────────────────
  let startIdx = 0;
  let inheritedRounds = 0;
  if (rounds !== undefined && rounds > 0) {
    const userIdx: number[] = [];
    for (let i = 0; i < all.length; i++) {
      if (all[i]!.role === "user") userIdx.push(i);
    }
    inheritedRounds = Math.min(rounds, userIdx.length);
    if (userIdx.length > rounds) {
      startIdx = userIdx[userIdx.length - rounds]!;
    }
  } else {
    inheritedRounds = all.filter((m) => m.role === "user").length;
  }
  const slice = all.slice(startIdx);

  // ── 注入 Master 压缩摘要（仅当切片未覆盖到它时） ────────────────────────
  let summaryInjected = false;
  if (masterSession.lastSummary) {
    const covered = slice.some(
      (m) => typeof m.content === "string" && m.content.includes("[对话历史摘要]")
    );
    if (!covered) {
      slaveSession.addSystemMessage(
        `## Master 对话历史摘要（背景信息）\n\n${masterSession.lastSummary}`
      );
      summaryInjected = true;
    }
  }

  // ── 结构化导入（保留 tool_call / tool_result 结构，并落盘） ──────────────
  if (slice.length > 0) {
    slaveSession.importMessages(slice as ChatMessage[], { persist: true });
  }

  return { inheritedMessages: slice.length, inheritedRounds, summaryInjected };
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
   * @param contextRounds       继承 Master 最近多少**轮**对话（一轮 = 一条 user 消息起算）；<=0 表示全量
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
    extraRunOpts?: SlaveRunExtraOpts
  ): string {
    const slaveId = crypto.randomUUID().slice(0, 8);

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

    // 结构化继承 Master 最近 contextRounds 轮对话（含工具调用与结果）
    const stats = buildSlaveContext(slaveSession, masterSession, contextRounds);

    log.info(
      `[slave:${slaveId}] forked by ${masterSession.sessionId.slice(-12)}, ` +
        `继承 ${stats.inheritedRounds} 轮 / ${stats.inheritedMessages} 条` +
        `${stats.summaryInjected ? " + 摘要" : ""}, task="${task.slice(0, 60)}"`
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

    // 结构化继承全量 Master 上下文（含 tool_call / tool_result），并落盘使轨迹自包含
    const stats = buildSlaveContext(slaveSession, masterSession);

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
        `继承 ${stats.inheritedMessages} 条`
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
