/**
 * LoopRunner — Loop Agent 持续轮询执行引擎
 *
 * 读取 agent.toml 中的 [loop] 配置块，为每个启用的 loop agent 启动 setInterval，
 * 每次 tick 从 TASK.md（或配置的 taskFile）读取任务指令，注入 agent session 执行。
 *
 * Session 策略：进程内常驻复用（与 main.ts 的 getSession 机制完全一致），
 * 记忆/摘要/MEM.md/searchMemory 全走 runAgent 内部原有路径，无任何特殊处理。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { Session } from "./session.js";
import { runAgent } from "./agent.js";
import { agentManager } from "./agent-manager.js";
import type { LoopConfig } from "./agent-manager.js";
import type { Connector } from "../connectors/base.js";
import type { InboundMessage } from "../connectors/base.js";
import { appendLog } from "../cron/store.js";
import { parseModelSymbol } from "../llm/registry.js";
import { buildCopilotClient } from "../llm/copilot.js";
import { LLMClient } from "../llm/client.js";
import { loadConfig } from "../config/loader.js";

// ── Loop Agent 专用 system prompt ────────────────────────────────────────────

const LOOP_AGENT_SYSTEM = `## ⚠️ 你正在以【Loop Agent】身份自主运行

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

async function buildOverrideClient(model: string, agentId: string): Promise<LLMClient | undefined> {
  try {
    const { provider, modelId } = parseModelSymbol(model);
    if (provider === "copilot") {
      const cfg = loadConfig();
      const copilotCfg = cfg.providers.copilot;
      if (!copilotCfg) throw new Error("loop agent model 使用 copilot provider，但 [providers.copilot] 未配置");
      const { client } = await buildCopilotClient({
        githubToken: copilotCfg.githubToken,
        model: modelId,
        timeoutMs: copilotCfg.timeoutMs,
      });
      console.log(`[loop] agent=${agentId} 使用指定模型: ${model}`);
      return client;
    } else if (provider === "openai") {
      const cfg = loadConfig();
      const openaiCfg = cfg.providers.openai;
      if (!openaiCfg) throw new Error("loop agent model 使用 openai provider，但 [providers.openai] 未配置");
      console.log(`[loop] agent=${agentId} 使用指定模型: ${model}`);
      return new LLMClient({
        baseUrl: openaiCfg.baseUrl,
        apiKey: openaiCfg.apiKey,
        model: modelId,
        maxTokens: openaiCfg.maxTokens,
        timeoutMs: openaiCfg.timeoutMs,
      });
    } else {
      throw new Error(`loop agent model 使用未知 provider "${provider}"`);
    }
  } catch (err) {
    console.error(`[loop] agent=${agentId} 模型初始化失败，回退到默认：`, err);
    return undefined;
  }
}

// ── LoopRunner ────────────────────────────────────────────────────────────────

class LoopRunner {
  private connector: Connector | null = null;
  /** agentId → timer handle */
  private timers = new Map<string, ReturnType<typeof setInterval>>();
  /** agentId → 常驻 Session（与 main.ts 的 sessions Map 一致） */
  private sessions = new Map<string, Session>();
  /** 正在执行的 agentId 集合（并发保护：同一 agent 不允许多个 tick 同时运行） */
  private running = new Set<string>();

  async start(connector: Connector | null): Promise<void> {
    this.connector = connector;
    const agents = agentManager.loadAll();
    let count = 0;
    for (const agent of agents) {
      const cfg = agentManager.readLoopConfig(agent.id);
      if (cfg) {
        this.scheduleAgent(agent.id, cfg);
        count++;
      }
    }
    console.log(`[loop] LoopRunner started (${count} active loop agents)`);
  }

  stop(): void {
    for (const handle of this.timers.values()) {
      clearInterval(handle);
    }
    this.timers.clear();
    this.sessions.clear();
    console.log("[loop] LoopRunner stopped");
  }

  /** 重新调度单个 agent 的 loop（改配置后调用） */
  restartAgent(agentId: string): void {
    const old = this.timers.get(agentId);
    if (old !== undefined) clearInterval(old);
    this.timers.delete(agentId);
    this.sessions.delete(agentId); // 清空旧 session，下次 tick 重建

    const cfg = agentManager.readLoopConfig(agentId);
    if (cfg) {
      this.scheduleAgent(agentId, cfg);
      console.log(`[loop] agent=${agentId} 已重新调度（tickSeconds=${cfg.tickSeconds}）`);
    } else {
      console.log(`[loop] agent=${agentId} loop 已停用或配置不存在`);
    }
  }

  /** 立即触发一次 tick（不影响定时计划） */
  triggerNow(agentId: string): boolean {
    const cfg = agentManager.readLoopConfig(agentId);
    if (!cfg) return false;
    void this.tick(agentId, cfg);
    return true;
  }

  private scheduleAgent(agentId: string, cfg: LoopConfig): void {
    const intervalMs = cfg.tickSeconds * 1000;
    const handle = setInterval(() => {
      void this.tick(agentId, cfg);
    }, intervalMs);
    this.timers.set(agentId, handle);
    console.log(`[loop] agent=${agentId} 已启动（每 ${cfg.tickSeconds}s tick）`);
  }

  private async tick(agentId: string, cfg: LoopConfig): Promise<void> {
    if (this.running.has(agentId)) {
      console.log(`[loop] agent=${agentId} tick 跳过（上次仍在执行）`);
      return;
    }
    this.running.add(agentId);
    const now = new Date().toISOString();

    // 读取任务文件
    const taskFilePath = path.join(agentManager.agentDir(agentId), cfg.taskFile);
    if (!fs.existsSync(taskFilePath)) {
      console.warn(`[loop] agent=${agentId} 任务文件不存在：${taskFilePath}，跳过本次 tick`);
      this.running.delete(agentId);
      return;
    }
    let taskContent: string;
    try {
      taskContent = fs.readFileSync(taskFilePath, "utf-8").trim();
    } catch (err) {
      console.error(`[loop] agent=${agentId} 读取任务文件失败：`, err);
      this.running.delete(agentId);
      return;
    }
    if (!taskContent) {
      console.warn(`[loop] agent=${agentId} 任务文件为空，跳过本次 tick`);
      this.running.delete(agentId);
      return;
    }

    // 复用或首次创建 Session（与 main.ts getSession 完全一致）
    let session = this.sessions.get(agentId);
    if (!session) {
      session = new Session(`loop:${agentId}`, { agentId });
      this.sessions.set(agentId, session);
    }

    // 构建可选 override client
    const overrideClient = cfg.model ? await buildOverrideClient(cfg.model, agentId) : undefined;

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
      console.error(`[loop] agent=${agentId} tick 执行失败：`, err);
    }

    // 写日志（复用 cron 日志系统）
    appendLog({ ts: now, status, result: resultText, jobId: `loop:${agentId}` });

    // 推送策略
    const lastResult = this._lastResults.get(agentId);
    const shouldNotify = ((): boolean => {
      switch (cfg.notify) {
        case "always":    return true;
        case "on_error":  return status === "error";
        case "on_change": return resultText !== (lastResult ?? "");
        case "never":     return false;
      }
    })();
    this._lastResults.set(agentId, resultText);

    if (shouldNotify && this.connector && cfg.peerId) {
      const validMsgTypes: InboundMessage["type"][] = ["c2c", "group", "guild", "dm"];
      const msgType: InboundMessage["type"] = validMsgTypes.includes(cfg.msgType as InboundMessage["type"])
        ? (cfg.msgType as InboundMessage["type"])
        : "c2c";
      try {
        await this.connector.send(cfg.peerId, msgType, resultText);
      } catch (err) {
        console.error(`[loop] agent=${agentId} 推送结果失败：`, err);
      }
    }

    this.running.delete(agentId);
  }

  /** agentId → 上次结果文本（用于 on_change 通知策略） */
  private _lastResults = new Map<string, string>();
}

export const loopRunner = new LoopRunner();
