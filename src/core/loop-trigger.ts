/**
 * LoopTriggerManager — 基于独立配置文件的 Loop 触发器
 *
 * 配置文件: ~/.tinyclaw/loops/<id>.json
 * 触发器通过 bindTo 字段绑定任意 session（包括 qqbot 聊天 session）。
 *
 * 特性：
 * - 永远 stateful：历史消息不清空，由 session 自动压缩
 * - pipeline steps：tool 输出拼接为前缀后与 message 合并注入 session
 * - timeRange：段外静默跳过
 * - 串行间隔：上次 tick 结束后等 tickSeconds 再触发
 * - session.running 时 await 等待，不 abort
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { z } from "zod";
import { executeTool, getTool, type ToolContext } from "../tools/registry.js";
import type { Session } from "./session.js";
import type { runAgent as RunAgentFn } from "./agent.js";

// ── Schema ─────────────────────────────────────────────────────────────────

const ToolStepSchema = z.object({
  type: z.literal("tool"),
  name: z.string().min(1),
  args: z.record(z.unknown()).default({}),
});

const TriggerConfigSchema = z.object({
  id: z.string().min(1),
  enabled: z.boolean().default(true),
  /** 绑定的 session id，如 "qqbot:c2c:xxx" 或 "cli:yyy" */
  bindTo: z.string().min(1),
  /** 使用的 agent id（记忆/系统提示来源） */
  agentId: z.string().default("default"),
  /** 每次 tick 间隔秒数（上次结束后等待） */
  tickSeconds: z.number().int().min(1).default(60),
  /** 时间段过滤:支持多段，任一命中即触发；兼容单对象写法。段外静默跳过。 */
  timeRanges: z.union([
    z.array(z.object({
      start: z.string().regex(/^\d{2}:\d{2}$/),
      end: z.string().regex(/^\d{2}:\d{2}$/),
      weekdays: z.array(z.number().int().min(0).max(6)).optional(),
    })),
    z.object({
      start: z.string().regex(/^\d{2}:\d{2}$/),
      end: z.string().regex(/^\d{2}:\d{2}$/),
      weekdays: z.array(z.number().int().min(0).max(6)).optional(),
    }).transform((v) => [v]),
  ]).optional(),
  /**
   * 是否允许 AI 通过调用 loop_exit 工具退出本轮任务（默认 false）。
   * true: AI 调用 loop_exit 后，本时间窗口内不再 tick，等下一个窗口重置后继续；
   * false: AI 无法自主退出，持续每 tickSeconds 一次（适合持续监控）。
   */
  allowExit: z.boolean().default(false),
  /** tool steps：顺序执行，输出拼成前缀字符串 */
  steps: z.array(ToolStepSchema).optional(),
  /** 注入 session 的 user message（steps 输出作为前缀拼在其前面） */
  message: z.string().optional(),
  /**
   * 推送消息使用的 bot id（对应 config.toml 中 [channels.qqbots.<botId>] 的键名）。
   * 不填则使用第一个 connector（main bot）。
   */
  botId: z.string().optional(),
  /**
   * 推送策略:
   * - "always": 每次 tick 结束后将 LLM 完整回复推送给用户
   * - "llm":    由 LLM 决定——输出含 [NOTIFY]...[/NOTIFY] 块时推送，其余静默
   * - "never":  不主动推送(依赖 notify_user / send_report 工具，默认)
   */
  notify: z.enum(["always", "llm", "never"]).default("never"),
});

export type TriggerConfig = z.infer<typeof TriggerConfigSchema>;

// ── 工具函数 ───────────────────────────────────────────────────────────────

/** 返回当前命中的时间段索引（-1=未命中；无 timeRanges 配置视为全天，返回 0） */
function currentTimeRangeIndex(cfg: TriggerConfig): number {
  if (!cfg.timeRanges?.length) return 0;
  const now = new Date();
  const weekday = now.getDay();
  const cur = now.getHours() * 60 + now.getMinutes();
  return cfg.timeRanges.findIndex((r) => {
    if (r.weekdays && !r.weekdays.includes(weekday)) return false;
    const [sh = 0, sm = 0] = r.start.split(":").map(Number);
    const [eh = 0, em = 0] = r.end.split(":").map(Number);
    return cur >= sh * 60 + sm && cur < eh * 60 + em;
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 提取 [NOTIFY]...[/NOTIFY] 块内容 */
function extractNotifyBlocks(text: string): string[] {
  const results: string[] = [];
  const re = /\[NOTIFY\]([\s\S]*?)\[\/NOTIFY\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const c = m[1]!.trim();
    if (c) results.push(c);
  }
  return results;
}

// ── LoopTriggerManager ─────────────────────────────────────────────────────

export class LoopTriggerManager {
  private configs: Map<string, TriggerConfig> = new Map();
  private stopped = new Set<string>();
  private running = new Set<string>();
  private paused = new Set<string>();
  private scheduled = new Set<string>();

  private getSession: ((sessionId: string) => Session) | null = null;
  private runAgent: typeof RunAgentFn | null = null;
  private connectors: Map<string, { send(peerId: string, type: string, content: string): Promise<void> }> = new Map();
  private loopsDir: string = path.join(os.homedir(), ".tinyclaw", "loops");

  /** 启动所有启用的触发器 */
  start(opts: {
    loopsDir?: string;
    getSession: (sessionId: string) => Session;
    runAgent: typeof RunAgentFn;
    connectors: Map<string, { send(peerId: string, type: string, content: string): Promise<void> }>;
  }): void {
    this.getSession = opts.getSession;
    this.runAgent = opts.runAgent;
    this.connectors = opts.connectors;
    if (opts.loopsDir) this.loopsDir = opts.loopsDir;

    this.stopped.clear();
    this.paused.clear();
    this.scheduled.clear();
    this.configs.clear();

    const cfgs = this.loadAll();
    let count = 0;
    for (const cfg of cfgs) {
      if (!cfg.enabled) continue;
      this.configs.set(cfg.id, cfg);
      this.scheduleOne(cfg);
      count++;
    }
    console.log(`[loop-trigger] started (${count} active triggers)`);
  }

  stop(): void {
    for (const id of this.scheduled) {
      this.stopped.add(id);
    }
    this.getSession = null;
    this.runAgent = null;
    console.log("[loop-trigger] stopped");
  }

  /** 立即触发一次（不影响定时计划） */
  triggerNow(id: string): boolean {
    const cfg = this.configs.get(id);
    if (!cfg) return false;
    if (this.running.has(id)) {
      console.log(`[loop-trigger] id=${id} triggerNow 跳过（当前 tick 仍在执行）`);
      return true;
    }
    void this.tick(cfg);
    return true;
  }

  pause(id: string): boolean {
    if (!this.scheduled.has(id)) return false;
    this.paused.add(id);
    console.log(`[loop-trigger] id=${id} 已暂停`);
    return true;
  }

  resume(id: string): boolean {
    if (!this.scheduled.has(id)) return false;
    this.paused.delete(id);
    console.log(`[loop-trigger] id=${id} 已恢复`);
    return true;
  }

  /** id 是否已绑定某个 session */
  isBound(sessionId: string): boolean {
    for (const cfg of this.configs.values()) {
      if (cfg.bindTo === sessionId) return true;
    }
    return false;
  }

  listStatus(): Array<{ id: string; bindTo: string; status: "running" | "paused" | "idle" | "not_found" }> {
    return Array.from(this.configs.values()).map((cfg) => ({
      id: cfg.id,
      bindTo: cfg.bindTo,
      status: !this.scheduled.has(cfg.id)
        ? "not_found"
        : this.running.has(cfg.id)
        ? "running"
        : this.paused.has(cfg.id)
        ? "paused"
        : "idle",
    }));
  }

  // ── 内部 ────────────────────────────────────────────────────────────────

  private loadAll(): TriggerConfig[] {
    if (!fs.existsSync(this.loopsDir)) return [];
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.loopsDir, { withFileTypes: true });
    } catch {
      return [];
    }
    const result: TriggerConfig[] = [];
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith(".json")) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(this.loopsDir, e.name), "utf-8")) as unknown;
        const cfg = TriggerConfigSchema.parse(raw);
        result.push(cfg);
      } catch (err) {
        console.warn(`[loop-trigger] 跳过无效配置 ${e.name}:`, err);
      }
    }
    return result;
  }

  private scheduleOne(cfg: TriggerConfig): void {
    console.log(`[loop-trigger] id=${cfg.id} bindTo=${cfg.bindTo} 已启动（每 ${cfg.tickSeconds}s tick）`);
    this.scheduled.add(cfg.id);
    void this.loop(cfg);
  }

  private async loop(cfg: TriggerConfig): Promise<void> {
    // exitedWindowIdx: 当前时间窗口已被 AI 退出，等待切换到新窗口后重置
    let exitedWindowIdx: number | null = null;

    while (!this.stopped.has(cfg.id)) {
      await delay(cfg.tickSeconds * 1000);
      if (this.stopped.has(cfg.id)) break;

      if (this.paused.has(cfg.id)) {
        continue;
      }

      // 重新读取配置（支持热更新）
      const latest = this.reloadConfig(cfg.id);
      if (!latest || !latest.enabled) {
        console.log(`[loop-trigger] id=${cfg.id} 配置已移除或禁用，退出循环`);
        break;
      }

      const windowIdx = currentTimeRangeIndex(latest);

      // 段外：静默跳过，同时重置退出状态（下次进入新窗口时从头开始）
      if (windowIdx === -1) {
        exitedWindowIdx = null;
        continue;
      }

      // 当前窗口已被 AI 退出（allowExit=true），等待进入新窗口
      if (latest.allowExit && exitedWindowIdx === windowIdx) {
        continue;
      }

      // 窗口切换时重置退出状态
      if (exitedWindowIdx !== null && exitedWindowIdx !== windowIdx) {
        exitedWindowIdx = null;
      }

      const exited = await this.tick(latest);
      if (exited && latest.allowExit) {
        exitedWindowIdx = windowIdx;
        console.log(`[loop-trigger] id=${latest.id} 当前窗口任务完成，等待下一个时间窗口`);
      }
    }
    this.scheduled.delete(cfg.id);
  }


  /** 返回 true 表示 AI 调用了 loop_exit（本窗口任务完成信号） */
  private async tick(cfg: TriggerConfig): Promise<boolean> {
    if (this.running.has(cfg.id)) {
      console.log(`[loop-trigger] id=${cfg.id} tick 跳过（上次仍在执行）`);
      return false;
    }
    if (!this.getSession || !this.runAgent) return false;

    const message = cfg.message ?? "";
    if (!cfg.steps?.length && !message) {
      console.warn(`[loop-trigger] id=${cfg.id} 无 steps 也无 message，跳过`);
      return false;
    }

    this.running.add(cfg.id);
    try {
      const session = this.getSession(cfg.bindTo);

      // 若 session 当前处于 code 模式，跳过本次 tick，避免 loop 消息污染编码上下文
      if (session.mode === "code") {
        console.log(`[loop-trigger] id=${cfg.id} tick 跳过(session 处于 code 模式)`);
        return false;
      }

      // 等待 session 当前 run 完成
      if (session.running && session.currentRunPromise) {
        await session.currentRunPromise.catch(() => {});
      }

      // 再次检查：等待期间 session 可能切换到 code 模式
      if ((session.mode as string) === "code") {
        console.log(`[loop-trigger] id=${cfg.id} tick 跳过(session 在等待期间切换到 code 模式)`);
        return false;
      }

      // 构建 notifyFn（从 bindTo 解析 peerId）
      const notifyFn = this.buildNotifyFn(cfg.bindTo, cfg.botId);

      // allowExit=true 时：退出信号标志 + onLoopExit 回调
      let exitSignaled = false;
      const onLoopExit = cfg.allowExit ? () => { exitSignaled = true; } : undefined;

      // 执行 tool steps，收集输出拼成前缀
      let prefix = "";
      if (cfg.steps?.length) {
        const toolCtx = this.buildToolCtx(cfg, session, notifyFn, onLoopExit);
        const parts: string[] = [];
        for (const step of cfg.steps) {
          console.log(`[loop-trigger] id=${cfg.id} tool step: ${step.name}`);
          try {
            const result = await executeTool(step.name, step.args as Record<string, unknown>, toolCtx);
            parts.push(`[${step.name}]\n${result}`);
          } catch (err) {
            parts.push(`[${step.name}] 执行失败: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        if (parts.length > 0) {
          prefix = parts.join("\n\n") + "\n\n";
        }
      }

      // allowExit=true 时在 message 末尾追加退出提示（退出条件由用户写在 message 字段里）
      const exitHint = cfg.allowExit
        ? "\n\n---\n你可以调用 loop_exit 工具退出本次监控窗口。退出条件见上面的任务描述。"
        : "";
      // notify=llm/always 时注入格式说明
      const notifyHint =
        cfg.notify === "llm"
          ? "\n\n---\n如需将内容推送给用户，请用 [NOTIFY]...[/NOTIFY] 块包裹。不需要推送时直接回复，不要加该标签。"
          : cfg.notify === "always"
            ? "\n\n---\n你的回复将直接推送给用户，请保持简洁。"
            : "";
      // notifyHint 不存入 session 历史（不拼入 content），改为 systemPromptSuffix 临时注入，
      // 避免 [NOTIFY] 格式指令持久化到 .jsonl，污染后续普通聊天上下文。
      const content = prefix + message + exitHint;
      if (!content.trim()) {
        console.warn(`[loop-trigger] id=${cfg.id} 合并后内容为空，跳过`);
        return false;
      }

      // 以 addLoopTaskMessage 注入（历史中折叠为占位符，不堆积 K 线数据）
      const taskRef = path.join(this.loopsDir, `${cfg.id}.json`);
      session.addLoopTaskMessage(taskRef, content);

      // allowExit=true 时通过 customTools 注入 loop_exit 和 loop_control 工具 spec
      const loopExitDef = cfg.allowExit ? getTool("loop_exit") : undefined;
      const loopControlDef = cfg.allowExit ? getTool("loop_control") : undefined;
      const customTools = [
        ...(loopExitDef ? [loopExitDef.spec] : []),
        ...(loopControlDef ? [loopControlDef.spec] : []),
      ] as import("openai/resources/chat/completions").ChatCompletionTool[] | undefined;
      const customToolsFinal = customTools?.length ? customTools : undefined;

      const { content: finalContent } = await this.runAgent(session, content, {
        skipAddUserMessage: true,
        skipMemorySearch: true,
        ...(notifyHint ? { systemPromptSuffix: notifyHint } : {}),
        ...(notifyFn ? { onNotify: notifyFn } : {}),
        ...(onLoopExit ? { onLoopExit } : {}),
        ...(customToolsFinal ? { customTools: customToolsFinal } : {}),
      });

      // loop 完成后，去掉 assistant 消息中的 [NOTIFY] 标签（保留内容），避免污染后续聊天历史
      session.stripLoopTagsFromLastAssistantMessage();

      // ── 根据 notify 策略推送 LLM 最终回复 ──────────────────────────────
      if (notifyFn && finalContent.trim()) {
        if (cfg.notify === "always") {
          await notifyFn(finalContent.trim());
        } else if (cfg.notify === "llm") {
          const blocks = extractNotifyBlocks(finalContent);
          for (const block of blocks) {
            await notifyFn(block);
          }
        }
      }

      if (exitSignaled) {
        console.log(`[loop-trigger] id=${cfg.id} AI 调用了 loop_exit，本窗口任务完成`);
      }
      console.log(`[loop-trigger] id=${cfg.id} tick 完成`);
      return exitSignaled;
    } catch (err) {
      console.error(`[loop-trigger] id=${cfg.id} tick 失败:`, err);
      return false;
    } finally {
      this.running.delete(cfg.id);
    }
  }

  private buildNotifyFn(bindTo: string, botId?: string): ((msg: string) => Promise<void>) | undefined {
    if (this.connectors.size === 0) return undefined;
    // 解析 qqbot:c2c:<peerId> 或 qqbot:group:<peerId>
    const m = bindTo.match(/^qqbot:(c2c|group|guild|dm):(.+)$/);
    if (!m) return undefined;
    const [, type, peerId] = m;
    // 按 botId 路由；找不到则 fallback 第一个 connector
    const connector = (botId ? this.connectors.get(botId) : undefined) ?? [...this.connectors.values()][0];
    if (!connector) return undefined;
    return async (msg: string) => {
      const prefixed = msg.startsWith("<img") ? msg : `🔔 [监控]
${msg}`;
      await connector.send(peerId!, type!, prefixed);
    };
  }

  private buildToolCtx(
    cfg: TriggerConfig,
    session: Session,
    notifyFn: ((msg: string) => Promise<void>) | undefined,
    onLoopExit?: () => void,
  ): ToolContext {
    return {
      sessionId: cfg.bindTo,
      agentId: cfg.agentId,
      cwd: os.homedir(),
      masterSession: session,
      slaveRunFn: (s, c, o) =>
        this.runAgent!(s, c, {
          ...(o as Parameters<typeof RunAgentFn>[2]),
          slaveDepth: 1,
          ...(notifyFn ? { onNotify: notifyFn } : {}),
        }),
      onSlaveComplete: async () => { /* no-op */ },
      ...(notifyFn ? { onNotify: notifyFn } : {}),
      ...(onLoopExit ? { onLoopExit } : {}),
    };
  }

  private reloadConfig(id: string): TriggerConfig | null {
    const filePath = path.join(this.loopsDir, `${id}.json`);
    if (!fs.existsSync(filePath)) return null;
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
      return TriggerConfigSchema.parse(raw);
    } catch {
      return null;
    }
  }
}

export const loopTriggerManager = new LoopTriggerManager();
