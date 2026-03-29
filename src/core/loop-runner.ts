/**
 * LoopRunner — Loop Session 持续轮询执行引擎
 *
 * 读取 sessions/<sanitized-sessionId>.toml 中的 [loop] 配置块，
 * 为每个启用的 loop session 启动 setInterval，每次 tick 从 taskFile 读取任务指令，
 * 注入对应 session 执行。
 *
 * Session 策略：进程内常驻复用，记忆/摘要/MEM.md 全走 runAgent 内部原有路径。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { Session } from "./session.js";
import { runAgent } from "./agent.js";
import { agentManager } from "./agent-manager.js";
import type { LoopSessionConfig } from "./agent-manager.js";
import type { Connector } from "../connectors/base.js";
import type { InboundMessage } from "../connectors/base.js";
import { appendLog } from "../cron/store.js";
import { parseModelSymbol } from "../llm/registry.js";
import { buildCopilotClient } from "../llm/copilot.js";
import { LLMClient } from "../llm/client.js";
import { loadConfig } from "../config/loader.js";

// ── Loop Session 专用 system prompt ──────────────────────────────────────────

const LOOP_AGENT_SYSTEM = `## ⚠️ 你正在以【Loop Session】身份自主运行

以下规则必须严格遵守：

### 执行规范
1. **直接执行**：user 消息即为本次 tick 的任务指令，立即执行，不要询问确认
2. **无人值守**：默认没有用户在线，所有工具调用须自主完成
3. **简洁输出**：输出最终结果，不要描述操作步骤

### 记忆管理
4. **主动维护 MEM.md**：重要发现、经验总结、当前状态请写入 MEM.md 持久化
5. **利用历史记忆**：本次 tick 开始前已注入相关历史记忆，善加利用

### 数据规范
6. **实时数据必须用工具获取**：禁止凭记忆或训练知识直接输出时效性数值
7. **失败时明确报告**：工具调用失败时输出"获取失败：<原因>"，不得用猜测值替代`;

// ── 构建 LLM override client ──────────────────────────────────────────────────

async function buildOverrideClient(model: string, sessionId: string): Promise<LLMClient | undefined> {
  try {
    const { provider, modelId } = parseModelSymbol(model);
    if (provider === "copilot") {
      const cfg = loadConfig();
      const copilotCfg = cfg.providers.copilot;
      if (!copilotCfg) throw new Error("loop session model 使用 copilot provider，但 [providers.copilot] 未配置");
      const { client } = await buildCopilotClient({
        githubToken: copilotCfg.githubToken,
        model: modelId,
        timeoutMs: copilotCfg.timeoutMs,
      });
      console.log(`[loop] session=${sessionId} 使用指定模型: ${model}`);
      return client;
    } else if (provider === "openai") {
      const cfg = loadConfig();
      const openaiCfg = cfg.providers.openai;
      if (!openaiCfg) throw new Error("loop session model 使用 openai provider，但 [providers.openai] 未配置");
      console.log(`[loop] session=${sessionId} 使用指定模型: ${model}`);
      return new LLMClient({
        baseUrl: openaiCfg.baseUrl,
        apiKey: openaiCfg.apiKey,
        model: modelId,
        maxTokens: openaiCfg.maxTokens,
        timeoutMs: openaiCfg.timeoutMs,
      });
    } else {
      throw new Error(`loop session model 使用未知 provider "${provider}"`);
    }
  } catch (err) {
    console.error(`[loop] session=${sessionId} 模型初始化失败，回退到默认：`, err);
    return undefined;
  }
}

// ── LoopRunner ────────────────────────────────────────────────────────────────

class LoopRunner {
  private connector: Connector | null = null;
  /** sessionId → timer handle */
  private timers = new Map<string, ReturnType<typeof setInterval>>();
  /** sessionId → 常驻 Session */
  private sessions = new Map<string, Session>();
  /** 正在执行的 sessionId 集合（并发保护：同一 session 不允许多个 tick 同时运行） */
  private running = new Set<string>();

  async start(connector: Connector | null): Promise<void> {
    this.connector = connector;
    const loops = agentManager.listSessionLoops();
    let count = 0;
    for (const { sessionId, cfg } of loops) {
      this.scheduleSession(sessionId, cfg);
      count++;
    }
    console.log(`[loop] LoopRunner started (${count} active loop sessions)`);
  }

  stop(): void {
    for (const handle of this.timers.values()) {
      clearInterval(handle);
    }
    this.timers.clear();
    this.sessions.clear();
    console.log("[loop] LoopRunner stopped");
  }

  /** 重新调度单个 session 的 loop（改配置后调用） */
  restartSession(sessionId: string): void {
    const old = this.timers.get(sessionId);
    if (old !== undefined) clearInterval(old);
    this.timers.delete(sessionId);
    this.sessions.delete(sessionId); // 清空旧 session，下次 tick 重建

    const cfg = agentManager.readSessionLoop(sessionId);
    if (cfg) {
      this.scheduleSession(sessionId, cfg);
      console.log(`[loop] session=${sessionId} 已重新调度（tickSeconds=${cfg.tickSeconds}）`);
    } else {
      console.log(`[loop] session=${sessionId} loop 已停用或配置不存在`);
    }
  }

  /** 立即触发一次 tick（不影响定时计划） */
  triggerNow(sessionId: string): boolean {
    const cfg = agentManager.readSessionLoop(sessionId);
    if (!cfg) return false;
    void this.tick(sessionId, cfg);
    return true;
  }

  private scheduleSession(sessionId: string, cfg: LoopSessionConfig): void {
    const intervalMs = cfg.tickSeconds * 1000;
    const handle = setInterval(() => {
      void this.tick(sessionId, cfg);
    }, intervalMs);
    this.timers.set(sessionId, handle);
    console.log(`[loop] session=${sessionId} 已启动（每 ${cfg.tickSeconds}s tick）`);
  }

  private async tick(sessionId: string, cfg: LoopSessionConfig): Promise<void> {
    if (this.running.has(sessionId)) {
      console.log(`[loop] session=${sessionId} tick 跳过（上次仍在执行）`);
      return;
    }
    this.running.add(sessionId);
    const now = new Date().toISOString();

    // 读取任务文件（绝对路径，或相对于 agentDir 的路径）
    const taskFilePath = path.isAbsolute(cfg.taskFile)
      ? cfg.taskFile
      : path.join(agentManager.agentDir(cfg.agentId), cfg.taskFile);

    if (!fs.existsSync(taskFilePath)) {
      console.warn(`[loop] session=${sessionId} 任务文件不存在：${taskFilePath}，跳过本次 tick`);
      this.running.delete(sessionId);
      return;
    }
    let taskContent: string;
    try {
      taskContent = fs.readFileSync(taskFilePath, "utf-8").trim();
    } catch (err) {
      console.error(`[loop] session=${sessionId} 读取任务文件失败：`, err);
      this.running.delete(sessionId);
      return;
    }
    if (!taskContent) {
      console.warn(`[loop] session=${sessionId} 任务文件为空，跳过本次 tick`);
      this.running.delete(sessionId);
      return;
    }

    // 复用或首次创建 Session
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = new Session(sessionId, { agentId: cfg.agentId });
      this.sessions.set(sessionId, session);
    }

    // 构建可选 override client
    const overrideClient = cfg.model ? await buildOverrideClient(cfg.model, sessionId) : undefined;

    let status: "success" | "error" = "success";
    let resultText = "";

    try {
      const result = await runAgent(session, taskContent, {
        systemPrompt: LOOP_AGENT_SYSTEM,
        ...(overrideClient ? { overrideClient } : {}),
      });
      resultText = result.content;
    } catch (err) {
      status = "error";
      resultText = `执行失败：${err instanceof Error ? err.message : String(err)}`;
      console.error(`[loop] session=${sessionId} tick 执行失败：`, err);
    }

    // 写日志（复用 cron 日志系统）
    appendLog({ ts: now, status, result: resultText, jobId: `loop:${sessionId}` });

    // 推送策略
    const lastResult = this._lastResults.get(sessionId);
    const shouldNotify = ((): boolean => {
      switch (cfg.notify) {
        case "always":    return true;
        case "on_error":  return status === "error";
        case "on_change": return resultText !== (lastResult ?? "");
        case "never":     return false;
      }
    })();
    this._lastResults.set(sessionId, resultText);

    if (shouldNotify && this.connector && cfg.peerId) {
      const validMsgTypes: InboundMessage["type"][] = ["c2c", "group", "guild", "dm"];
      const msgType: InboundMessage["type"] = validMsgTypes.includes(cfg.msgType as InboundMessage["type"])
        ? (cfg.msgType as InboundMessage["type"])
        : "c2c";
      try {
        await this.connector.send(cfg.peerId, msgType, resultText);
      } catch (err) {
        console.error(`[loop] session=${sessionId} 推送结果失败：`, err);
      }
    }

    this.running.delete(sessionId);
  }

  /** sessionId → 上次结果文本（用于 on_change 通知策略） */
  private _lastResults = new Map<string, string>();
}

export const loopRunner = new LoopRunner();
