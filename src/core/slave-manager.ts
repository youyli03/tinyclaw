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
  opts?: { systemPrompt?: string }
) => Promise<{ content: string; toolsUsed: string[] }>;

// ── 常量 ──────────────────────────────────────────────────────────────────────

const MAX_RESULT_LEN = 2000;
const MAX_PARTIAL_LEN = 500;

const SLAVE_SYSTEM_PROMPT = `## ⚠️ 你正在以【Sub-Agent / Slave】身份运行（后台异步执行）

以下规则必须严格遵守：

### 执行规范
1. **直接执行**：消息中包含你的具体任务，立即执行，不要询问用户确认或追问细节
2. **无人值守**：没有用户在线，所有决策须自主完成，不依赖人工介入
3. **简洁输出**：仅输出最终结果和关键信息，不要描述执行步骤
4. **禁止嵌套 fork**：不得调用 agent_fork 工具（禁止嵌套 Slave）

### 上下文说明
你收到的前几条消息是 Master 对话历史（背景信息，只读），最后一条 user 消息是你的具体任务。`;

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
   */
  fork(
    task: string,
    masterSession: Session,
    contextWindow: number,
    runFn: SlaveRunFn,
    onComplete?: (notif: SlaveNotification) => Promise<void>,
    reportIntervalSecs?: number,
    onProgressNotify?: SlaveProgressNotifyFn
  ): string {
    const slaveId = crypto.randomUUID().slice(0, 8);

    const state: SlaveState = {
      slaveId,
      task,
      status: "running",
      progress: { round: 0, toolsUsed: [], partialOutput: "" },
      startedAt: new Date().toISOString(),
      masterSessionId: masterSession.sessionId,
    };
    this.states.set(slaveId, state);

    // 创建独立 Slave Session（agentId 继承 Master，共享 workspace/memory）
    const slaveSessionId = `slave:${slaveId}`;
    const slaveSession = new Session(slaveSessionId, { agentId: masterSession.agentId });
    this.sessions.set(slaveId, slaveSession);

    // 将 Master 历史消息快照（最近 contextWindow 条）注入到 Slave Session
    const masterMessages = masterSession.getMessages();
    const contextSlice = masterMessages.slice(-contextWindow);
    for (const msg of contextSlice) {
      const text = extractText(msg.content);
      if (!text) continue;
      if (msg.role === "system") slaveSession.addSystemMessage(text);
      else if (msg.role === "user") slaveSession.addUserMessage(text);
      else if (msg.role === "assistant") slaveSession.addAssistantMessage(text);
    }

    console.log(`[slave:${slaveId}] forked by ${masterSession.sessionId.slice(-12)}, task="${task.slice(0, 60)}"`);

    // 后台运行（fire-and-forget）
    void this._run(slaveId, slaveSession, task, runFn, onComplete, reportIntervalSecs, onProgressNotify);

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

  /** 清理已完成的 Slave（避免无限增长） */
  gc(): void {
    const now = Date.now();
    for (const [id, state] of this.states) {
      if (state.status !== "running" && state.finishedAt) {
        const age = now - new Date(state.finishedAt).getTime();
        if (age > 24 * 60 * 60 * 1000) { // 24h 后清理
          this.states.delete(id);
          this.sessions.delete(id);
        }
      }
    }
  }

  // ── 内部实现 ────────────────────────────────────────────────────────────────

  private async _run(
    slaveId: string,
    session: Session,
    task: string,
    runFn: SlaveRunFn,
    onComplete?: (notif: SlaveNotification) => Promise<void>,
    reportIntervalSecs?: number,
    onProgressNotify?: SlaveProgressNotifyFn
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
      const result = await runFn(session, task, { systemPrompt: SLAVE_SYSTEM_PROMPT });

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
