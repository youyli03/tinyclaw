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
  /**
   * Plan 模式：向用户展示计划摘要并等待确认（由 main.ts 注入）。
   * exit_plan_mode 工具调用此回调来暂停执行、等待用户选择操作。
   * - 返回 approved=true + selectedAction：用户批准，AI 继续执行
   * - 返回 approved=false + feedback：用户拒绝或提供反馈，AI 修改计划
   * 仅在 code + plan 子模式下注入；auto 模式或非 code 模式时为 undefined。
   */
  onPlanRequest?: (
    summary: string,
    actions?: string[],
    recommendedAction?: string,
    planPath?: string,
  ) => Promise<import("../core/session.js").PlanApprovalResult>;
  /**
   * MFA 确认回调（由 main.ts → runAgent opts 透传）。
   * 供 code_assist 在启动子 Agent 前做一次性预授权确认。
   */
  onMFARequest?: (warningMessage: string, verifyCode?: (code: string) => boolean) => Promise<boolean>;
  /**
   * ask_user 回调（由 main.ts 注入）。
   * AI 调用 ask_user 工具时触发，向用户展示问题和选项菜单，等待用户回复。
   * - answer：用户选择的 label 或自由输入的文本
   * - isFreeform：true 表示用户自由输入，false 表示选择了预设选项
   * 仅在交互式会话下注入；CLI/cron 模式时为 undefined，工具自动返回 skipped。
   */
  onAskUser?: (
    question: string,
    options?: Array<{ label: string; description?: string; recommended?: boolean }>,
    allowFreeform?: boolean,
  ) => Promise<{ answer: string; isFreeform: boolean }>;
  /**
   * ask_master 回调（由 code_assist 注入给 daily subagent）。
   * daily subagent 遇到不确定时调用，同步阻塞直到用户通过 master 回复。
   * 若有 planPath，调用方应先将 plan.md 渲染为图片后附在消息中。
   */
  onAskMaster?: (question: string, context: string, planPath?: string) => Promise<string>;
  /**
   * code subagent 调用函数（由 code_assist 注入给 daily subagent）。
   * daily subagent 调用此函数向 code subagent 发送指令，同步等待执行结果。
   */
  codeRunFn?: (instruction: string) => Promise<string>;
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

/**
 * MCP 工具的 agent 过滤回调。
 * 由 mcpManager.init() 注入，避免 registry ↔ mcp/client 循环依赖。
 * 签名：(toolName, agentId) => boolean（true = 允许，false = 过滤掉）
 */
let _mcpAgentFilter: ((toolName: string, agentId: string) => boolean) | undefined;

/**
 * 注册 MCP 工具的 agent 过滤回调（由 mcpManager.init() 调用）。
 * 仅需调用一次；重复调用会覆盖前一个回调。
 */
export function setMcpAgentFilter(fn: (toolName: string, agentId: string) => boolean): void {
  _mcpAgentFilter = fn;
}

/**
 * 内置工具的 agent 过滤回调。
 * 由 agent.ts 顶层（模块加载时）注入，读取各 agent 的 tools.toml。
 * 签名：(toolName, agentId) => boolean（true = 允许，false = 过滤掉）
 */
let _builtinAgentFilter: ((toolName: string, agentId: string) => boolean) | undefined;

/**
 * 注册内置工具的 agent 过滤回调（由 agent.ts 模块加载时调用）。
 * 仅需调用一次；重复调用会覆盖前一个回调。
 */
export function setBuiltinAgentFilter(fn: (toolName: string, agentId: string) => boolean): void {
  _builtinAgentFilter = fn;
}

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

/**
 * 获取所有工具的 OpenAI spec 列表（供 chat completions 使用）。
 * - 已隐藏（hidden=true）的工具不包含在内
 * - 若传入 agentId，MCP 工具（mcp_ 前缀）经过 mcp.toml agent 白名单过滤
 * - 若传入 agentId，内置工具经过 tools.toml 黑/白名单过滤
 */
export function getAllToolSpecs(agentId?: string): ChatCompletionTool[] {
  return Array.from(tools.values())
    .filter((t) => {
      if (t.hidden) return false;
      const name = t.spec.function.name;
      if (agentId) {
        // MCP 工具：走 mcp.toml agent 白名单
        if (_mcpAgentFilter && name.startsWith("mcp_")) {
          return _mcpAgentFilter(name, agentId);
        }
        // 内置工具：走 tools.toml 黑/白名单
        if (_builtinAgentFilter && !name.startsWith("mcp_")) {
          return _builtinAgentFilter(name, agentId);
        }
      }
      return true;
    })
    .map((t) => t.spec);
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
