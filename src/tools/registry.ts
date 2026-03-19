import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { Session } from "../core/session.js";
import type { SlaveNotification, SlaveRunFn } from "../core/slave-manager.js";

/** 工具执行上下文（由 runAgent 提供） */
export interface ToolContext {
  /** exec_shell 的默认工作目录 */
  cwd?: string;
  /** 当前 session 的 ID（供 cron_add 等工具自动绑定 output.sessionId） */
  sessionId?: string;
  /** 当前 Agent 的 ID */
  agentId?: string;
  /** 当前 Master Session（供 agent_fork 读取上下文快照） */
  masterSession?: Session;
  /**
   * runAgent 的引用（由 agent.ts 注入，避免 tools → agent.ts 的循环依赖）。
   * 供 agent_fork 工具传给 SlaveManager.fork()。
   */
  slaveRunFn?: SlaveRunFn;
  /**
   * Slave 完成时的通知回调（由 main.ts 注入）。
   * 负责等待 Master 当前 run 结束、触发新的 runAgent、推送结果给用户。
   */
  onSlaveComplete?: (notif: SlaveNotification) => Promise<void>;
  /**
   * Slave 定期进度推送回调（由 main.ts 注入）。
   * 每隔 reportIntervalSecs 秒向用户推送 Slave 当前进度快照，不触发 runAgent。
   */
  onProgressNotify?: (slaveId: string, state: import("../core/slave-manager.js").SlaveState) => Promise<void>;
  /**
   * 主动向用户推送消息（由 main.ts 注入）。
   * 供 notify_user 工具调用，不等 runAgent 结束即发送，不触发新一轮 LLM 推理。
   */
  onNotify?: (message: string) => Promise<void>;
}

export interface ToolDef {
  /** OpenAI function calling 格式的工具描述 */
  spec: ChatCompletionTool;
  /** 是否需要 MFA 确认，默认 false */
  requiresMFA: boolean;
  /** 工具执行函数，参数为 JSON 字符串化的 arguments */
  execute: (args: Record<string, unknown>, ctx?: ToolContext) => Promise<string>;
  /** 是否对 LLM 隐藏（不出现在 getAllToolSpecs() 返回值中），默认 false */
  hidden?: boolean;
}

const tools = new Map<string, ToolDef>();

/** 注册工具 */
export function registerTool(def: ToolDef): void {
  const name = def.spec.function.name;
  if (tools.has(name)) {
    throw new Error(`Tool "${name}" is already registered`);
  }
  tools.set(name, def);
}

/** 获取工具定义 */
export function getTool(name: string): ToolDef | undefined {
  return tools.get(name);
}

/** 获取所有工具的 OpenAI spec 列表（供 chat completions 使用，已隐藏的工具不包含在内） */
export function getAllToolSpecs(): ChatCompletionTool[] {
  return Array.from(tools.values()).filter((t) => !t.hidden).map((t) => t.spec);
}

/** 设置工具的可见性（hidden=true 则从 getAllToolSpecs() 中隐藏） */
export function setToolVisibility(name: string, hidden: boolean): void {
  const def = tools.get(name);
  if (def) def.hidden = hidden;
}

/** 注销工具，返回是否成功（工具不存在时返回 false） */
export function unregisterTool(name: string): boolean {
  return tools.delete(name);
}

/** 执行工具，返回字符串结果 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx?: ToolContext
): Promise<string> {
  const tool = tools.get(name);
  if (!tool) return `错误：未知工具 "${name}"`;
  return tool.execute(args, ctx);
}
