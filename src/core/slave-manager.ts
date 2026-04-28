/**
 * SlaveManager — Master-Slave Agent Fork
 *
 * Master agent 可 fork 一个 Slave，Slave 在后台运行完整 runAgent() loop：
 * - fork()   创建独立 Session，继承 Master 上下文快照，后台运行任务
 * - status() 查询 Slave 进度（round / toolsUsed / partialOutput）
 * - abort()  软中断 Slave
 *
 * 注意：SlaveRunFn 故意不从 agent.ts 导入，以避免循环依赖。
 * 调用方（agent-fork.ts）通过 ToolContext.slaveRunFn 注入 runAgent 引用。
 */

import { Session } from "./session.js";
import type { ChatMessage, ContentPart } from "../llm/client.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ── 类型定义 ──────────────────────────────────────────────────────────────────

export interface SlaveProgress {
  round: number;
  toolsUsed: string[];
  /** 最新输出片段（截断 500 字符，运行中为实时更新） */
  partialOutput: string;
}

export interface SlaveState {
  slaveId: string;
  task: string;
  status: "running" | "done" | "error" | "aborted";
  progress: SlaveProgress;
  result?: string;
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
  opts?: { systemPrompt?: string; systemPromptSuffix?: string; skipPreamble?: boolean }
) => Promise<{ content: string; toolsUsed: string[] }>;

// ── 常量 ──────────────────────────────────────────────────────────────────────

const MAX_RESULT_LEN = 10000;
const MAX_PARTIAL_LEN = 500;

const SLAVE_SYSTEM_PROMPT = `## ⚠️ 你正在以【Sub-Agent / Slave】身份运行（后台异步执行）

以下规则必须严格遵守：

### 执行规范
1. **直接执行**：消息中包含你的具体任务，立即执行，不要询问用户确认或追问细节
2. **无人值守**：没有用户在线，所有决策须自主完成，不依赖人工介入
3. **简洁输出**：仅输出最终结果和关键信息，不要描述执行步骤
4. **禁止嵌套 fork**：不得调用 agent_fork 工具（禁止嵌套 Slave）

### 上下文说明
- 若有"Master 对话历史摘要"system 消息，是 Master 历史对话的压缩摘要（只读背景）
- 后续 user / assistant / system 消息是 Master 最近的对话历史（只读，含工具调用结果）
- **最后一条 user 消息是你的具体任务**，请直接执行`;


// ── SlaveManager ──────────────────────────────────────────────────────────────

class SlaveManager {
  private readonly states = new Map<string, SlaveState>();
  private readonly sessions = new Map<string, Session>();

  /**
   * Fork 一个 Slave agent，立即返回 slaveId，后台异步运行。
   *
   * @param task                Slave 的任务描述（注入为最后一条 user 消息）
   * @param masterSession       Master Session（用于复制上下文快照）
   * @param contextWindow       从 Master 消息列表末尾截取的条数（默认 10）
   * @param runFn               runAgent 实现（由 ToolContext.slaveRunFn 注入，避免循环依赖）
   * @param onComplete          Slave 完成后的回调
   * @param reportIntervalSecs  定期进度推送间隔（秒），0 或不传则不启用
   * @param onProgressNotify    定期进度推送回调（每 reportIntervalSecs 秒调用一次）
   * @param resultMode          结果交付模式："inject"（默认，完成后触发 onComplete）| "wait"（静默，Master 主动拉取）
   */
  fork(
    task: string,
    masterSession: Session,
    contextWindow: number,
    runFn: SlaveRunFn,
    onComplete?: (notif: SlaveNotification) => Promise<void>,
    reportIntervalSecs?: number,
    onProgressNotify?: SlaveProgressNotifyFn,
    resultMode: "inject" | "wait" = "inject",
    extraRunOpts?: { systemPromptSuffix?: string; skipPreamble?: boolean },
  ): string {
    const slaveId = crypto.randomUUID().slice(0, 8);

    const state: SlaveState = {
      slaveId,
      task,
      status: "running",
      progress: { round: 0, toolsUsed: [], partialOutput: "" },
      startedAt: new Date().toISOString(),
      masterSessionId: masterSession.sessionId,
      resultMode,
    };
    this.states.set(slaveId, state);

    // 创建独立 Slave Session（agentId 继承 Master，共享 workspace/memory）
    const slaveSessionId = `slave:${slaveId}`;
    const slaveSession = new Session(slaveSessionId, { agentId: masterSession.agentId });
    this.sessions.set(slaveId, slaveSession);

    // 将 Master 历史消息快照（最近 contextWindow 条）注入到 Slave Session
    const masterMessages = masterSession.getMessages();
    const contextSlice = masterMessages.slice(-contextWindow);

    // 若 master session 存在压缩摘要，且 context slice 未覆盖到摘要内容，先注入摘要
    if (masterSession.lastSummary) {
      const summaryInSlice = contextSlice.some(
        (m) => typeof m.content === "string" && m.content.includes("[对话历史摘要]")
      );
      if (!summaryInSlice) {
        slaveSession.addSystemMessage(`## Master 对话历史摘要（背景信息）\n\n${masterSession.lastSummary}`);
      }
    }

    for (const msg of contextSlice) {
      const text = extractText(msg.content);
      if (!text) continue;
      if (msg.role === "system") slaveSession.addSystemMessage(text);
      else if (msg.role === "user") slaveSession.addUserMessage(text);
      else if (msg.role === "assistant") slaveSession.addAssistantMessage(text);
    }

    console.log(`[slave:${slaveId}] forked by ${masterSession.sessionId.slice(-12)}, task="${task.slice(0, 60)}"`);

    // 后台运行（fire-and-forget）
    // wait 模式：Slave 完成后不触发 onComplete，Master 通过 agent_wait 主动拉取
    const effectiveOnComplete = resultMode === "wait" ? undefined : onComplete;
    void this._run(slaveId, slaveSession, task, runFn, effectiveOnComplete, reportIntervalSecs, onProgressNotify, false, extraRunOpts);

    return slaveId;
  }

  /**
   * Fork a continuation Slave that picks up an in-progress Master ReAct loop.
   *
   * Unlike `fork()`, this clones the Master's FULL message history (not just a window),
   * preserving tool_call / tool_result structure so the Slave LLM sees the exact context.
   * `runFn` is called with `skipPreamble: true` to skip system-prompt rebuild and user
   * message injection — the session already has the complete, ready-to-continue state.
   *
   * Called automatically by `runAgent()` when elapsed time exceeds the auto-fork threshold.
   */
  forkContinuation(
    masterSession: Session,
    runFn: SlaveRunFn,
    onComplete?: (notif: SlaveNotification) => Promise<void>,
    onProgressNotify?: SlaveProgressNotifyFn,
  ): string {
    const slaveId = crypto.randomUUID().slice(0, 8);

    const state: SlaveState = {
      slaveId,
      task: "(auto-fork continuation)",
      status: "running",
      progress: { round: 0, toolsUsed: [], partialOutput: "" },
      startedAt: new Date().toISOString(),
      masterSessionId: masterSession.sessionId,
      resultMode: "inject",
    };
    this.states.set(slaveId, state);

    const slaveSessionId = `slave:${slaveId}`;
    const slaveSession = new Session(slaveSessionId, { agentId: masterSession.agentId });
    this.sessions.set(slaveId, slaveSession);

    // Deep-clone ALL master messages (preserves tool_call / tool_result structure)
    slaveSession.importMessages(masterSession.getMessages());

    // Append a brief continuation hint so the Slave knows it's running headless
    slaveSession.addSystemMessage(
      "## ⚠️ Sub-Agent 后台续跑提示\n\n" +
      "你是一个在后台继续执行的 Sub-Agent（Slave）。" +
      "上方对话历史是原 Master 会话的完整上下文（含已执行工具的结果）。\n" +
      "请直接从当前状态继续完成任务，无需重复已完成的步骤，无用户在线，自主决策。\n" +
      "禁止调用 agent_fork 工具（不得嵌套 fork）。"
    );

    console.log(`[slave:${slaveId}] auto-fork continuation from ${masterSession.sessionId.slice(-12)}`);

    void this._run(slaveId, slaveSession, "(auto-fork continuation)", runFn, onComplete, undefined, onProgressNotify, true);

    return slaveId;
  }

  /** 软中断 Slave */
  abort(slaveId: string): string {
    const state = this.states.get(slaveId);
    if (!state) return `Slave "${slaveId}" 不存在`;
    if (state.status !== "running") return `Slave "${slaveId}" 当前状态为 ${state.status}，无需中断`;

    const session = this.sessions.get(slaveId);
    if (session) {
      session.abortRequested = true;
      session.llmAbortController?.abort();
    }

    state.status = "aborted";
    state.finishedAt = new Date().toISOString();
    console.log(`[slave:${slaveId}] aborted`);
    return `Slave "${slaveId}" 已中断`;
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
   * 等待当前 master session 创建的所有 running slave 完成。
   *
   * @param masterSessionId  Master 的 sessionId（用于过滤出属于该 master 的 slave）
   * @param timeoutMs        等待超时（毫秒），超时后将仍 running 的 slave 标记为 error
   * @returns Map<slaveId, SlaveState>  所有属于该 master 的 slave 最终状态
   */
  async waitForByMaster(masterSessionId: string, timeoutMs: number): Promise<Map<string, SlaveState>> {
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

    // 超时：将仍 running 的 slave 标记为 error
    for (const state of this.states.values()) {
      if (state.masterSessionId === masterSessionId && state.status === "running") {
        state.status = "error";
        state.result = `等待超时（>${Math.round(timeoutMs / 1000)}s），任务可能仍在后台运行`;
        state.finishedAt = new Date().toISOString();
        console.warn(`[slave:${state.slaveId}] waitForByMaster timeout`);
      }
    }

    const result = new Map<string, SlaveState>();
    for (const [id, state] of this.states) {
      if (state.masterSessionId === masterSessionId) {
        result.set(id, { ...state });
      }
    }
    return result;
  }

  /**
   * 等待指定单个 Slave 完成（适用于 result_mode="wait" 的 Slave）。
   *
   * @param slaveId    要等待的 Slave ID
   * @param timeoutMs  等待超时（毫秒），超时后将 running 的 slave 标记为 error
   * @returns SlaveState 快照（含最终 result），若 slaveId 不存在则返回 undefined
   */
  async waitForById(slaveId: string, timeoutMs: number): Promise<SlaveState | undefined> {
    const state = this.states.get(slaveId);
    if (!state) return undefined;

    const deadline = Date.now() + timeoutMs;
    const POLL_INTERVAL_MS = 200;

    while (state.status === "running" && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }

    // 超时处理
    if (state.status === "running") {
      state.status = "error";
      state.result = `等待超时（>${Math.round(timeoutMs / 1000)}s），任务可能仍在后台运行`;
      state.finishedAt = new Date().toISOString();
      console.warn(`[slave:${slaveId}] waitForById timeout`);
    }

    return { ...state };
  }

  /** 清理已完成的 Slave（避免无限增长） */
  gc(): void {
    const now = Date.now();
    for (const [id, state] of this.states) {
      if (state.status !== "running" && state.finishedAt) {
        const age = now - new Date(state.finishedAt).getTime();
        if (age > 24 * 60 * 60 * 1000) { // 24h 后清理
          // 兜底：清理内存状态前确保 JSONL 已删除
          const session = this.sessions.get(id);
          if (session) {
            try { session.deleteJsonl(); } catch { /* 静默忽略 */ }
          }
          this.states.delete(id);
          this.sessions.delete(id);
        }
      }
    }

    // 扫描 sessions 目录，清理孤立的 slave_*.jsonl（进程重启后内存状态丢失遗留的文件）
    try {
      const sessDir = path.join(os.homedir(), ".tinyclaw", "sessions");
      if (fs.existsSync(sessDir)) {
        for (const entry of fs.readdirSync(sessDir)) {
          // 匹配 slave_<8位hex>.jsonl（不含 .code.jsonl）
          if (/^slave_[0-9a-f]{8}\.jsonl$/.test(entry)) {
            const slaveId = entry.replace(/^slave_/, "").replace(/\.jsonl$/, "");
            // 若内存中仍有运行中的 slave，不删除
            const state = this.states.get(slaveId);
            if (!state || state.status !== "running") {
              try {
                fs.unlinkSync(path.join(sessDir, entry));
                console.log(`[slave:gc] 清理孤立 JSONL: ${entry}`);
              } catch { /* 静默忽略 */ }
            }
          }
        }
      }
    } catch { /* 静默忽略，GC 失败不影响正常运行 */ }

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
          fs.readdirSync(cronJobsDir)
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
            } catch { /* 静默忽略 */ }
          }
        }
      }
    } catch { /* 静默忽略，GC 失败不影响正常运行 */ }
  }

  // ── 内部实现 ────────────────────────────────────────────────────────────────

  private async _run(
    slaveId: string,
    session: Session,
    task: string,
    runFn: SlaveRunFn,
    onComplete?: (notif: SlaveNotification) => Promise<void>,
    reportIntervalSecs?: number,
    onProgressNotify?: SlaveProgressNotifyFn,
    skipPreamble?: boolean,
    extraRunOpts?: { systemPromptSuffix?: string; skipPreamble?: boolean },
  ): Promise<void> {
    const state = this.states.get(slaveId)!;

    // 启动定期进度推送（如果配置了间隔 > 0 且有回调）
    let progressInterval: ReturnType<typeof setInterval> | undefined;
    if (reportIntervalSecs && reportIntervalSecs > 0 && onProgressNotify) {
      progressInterval = setInterval(() => {
        if (state.status !== "running") return;
        onProgressNotify(slaveId, { ...state }).catch((err) => {
          console.error(`[slave:${slaveId}] onProgressNotify error:`, err);
        });
      }, reportIntervalSecs * 1000);
    }

    try {
      const runOpts = skipPreamble
        ? { skipPreamble: true }
        : { systemPromptSuffix: extraRunOpts?.systemPromptSuffix
              ? `${SLAVE_SYSTEM_PROMPT}\n\n${extraRunOpts.systemPromptSuffix}`
              : SLAVE_SYSTEM_PROMPT };
      const result = await runFn(session, task, runOpts);

      // 更新完成状态
      if (state.status === "aborted") {
        // abort() 已提前设置状态，不覆盖
      } else {
        state.status = "done";
      }
      state.result = result.content.slice(0, MAX_RESULT_LEN);
      state.progress.toolsUsed = result.toolsUsed;
      state.progress.partialOutput = result.content.slice(-MAX_PARTIAL_LEN);
    } catch (err) {
      if (state.status !== "aborted") {
        state.status = "error";
      }
      state.result = `执行失败：${err instanceof Error ? err.message : String(err)}`.slice(0, MAX_RESULT_LEN);
      console.error(`[slave:${slaveId}] error:`, err);
    }

    // 清除进度推送定时器
    if (progressInterval !== undefined) clearInterval(progressInterval);

    state.finishedAt = new Date().toISOString();
    console.log(`[slave:${slaveId}] ${state.status} (${state.finishedAt})`);

    // 立即删除 Slave JSONL（Slave Session 的 chat JSONL 仅用于 crash 恢复，
    // Slave 完成后无需保留，避免磁盘无限堆积）
    try {
      session.deleteJsonl();
    } catch {
      // 静默忽略，不影响正常完成流程
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
      console.error(`[slave:${slaveId}] onComplete callback error:`, err);
    }
  }
}

// ── 工具函数 ──────────────────────────────────────────────────────────────────

/** 从 ChatMessage.content 提取纯文本（ContentPart[] → 拼接 text 块） */
function extractText(content: string | ContentPart[]): string {
  if (typeof content === "string") return content;
  return content
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

// ── 单例导出 ──────────────────────────────────────────────────────────────────

export const slaveManager = new SlaveManager();
