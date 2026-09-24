import type { ChatCompletionTool } from "openai/resources/chat/completions";
import type { Session } from "../core/session.js";
import type { SlaveNotification, SlaveRunFn } from "../core/slave-manager.js";
import { sanitizeToolResult } from "./sanitize.js";
import type { ActivityEntry } from "../ipc/server.js";
import { MCP_META_TOOLS, MCP_ADMIN_TOOLS } from "../mcp/meta-tools.js";
import { DEFAULT_AGENT_ONLY_TOOLS, isSelfManagementAllowed } from "./agent-binding.js";

/** 跨 session 通信：单个 session 的信息（由 sessionGetFn 返回） */
export interface SessionInfo {
  sessionId: string;
  agentId: string;
  /** 当前是否正在执行 runAgent */
  running: boolean;
  /** 是否为 loop session（有 [loop] enabled=true 配置） */
  isLoop: boolean;
  /** 最近操作记录，最新在前，最多 10 条（tool_call / tool_result / error） */
  recentActivity: ActivityEntry[];
}

/** 工具执行上下文（由 runAgent 提供） */
export interface ToolContext {
  /** exec_shell 的默认工作目录 */
  cwd?: string;
  /** 当前 session 的 ID（供 cron_add 等工具自动绑定 output.sessionId） */
  sessionId?: string;
  /**
   * 当前 session 实际使用的 JSONL 路径（chat / code / project 三态都已解析）。
   * 供 `memory_expand` / `memory_recall` 定位同目录的**原文账本**（`*.journal.jsonl`）。
   */
  sessionJsonlPath?: string;
  /** 当前 session 的模式（chat / code），用于 MCP 持久化 */
  mode?: string;
  /** 当前 Agent 的 ID */
  agentId?: string;
  /** 当前 connector 的 botId(供 cron_add 等工具自动推断输出通道) */
  botId?: string;
  /** 当前 Master Session（供 agent_fork 读取上下文快照） */
  masterSession?: Session;
  /**
   * 审批策略（对齐 DSH `DelegatedPolicyOverrides.approvalPolicy`）。
   * `"never"` = 本次运行的**任何**审批请求（MFA / 提权 / ask_user 类）一律确定性拒绝：
   * 子 Agent 只能在委派时定下的作用域里干活，不能向上伸手要权限。
   * 由 agent.ts 从 `AgentRunOptions.approvalPolicy` 透传下来。
   */
  approvalPolicy?: "never";
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
  onProgressNotify?: (
    slaveId: string,
    state: import("../core/slave-manager.js").SlaveState
  ) => Promise<void>;
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
    planPath?: string
  ) => Promise<import("../core/session.js").PlanApprovalResult>;
  /**
   * MFA 确认回调(由 main.ts → runAgent opts 透传)。
   * 需要 MFA 的工具调用前触发,向用户请求确认。
   */
  onMFARequest?: (
    warningMessage: string,
    verifyCode?: (code: string) => boolean
  ) => Promise<boolean>;
  /**
   * ask_user 回调（由 main.ts 注入）。
   * AI 调用 ask_user 工具时触发，向用户展示问题和选项菜单，等待用户回复。
   * - answer：用户选择的 label 或自由输入的文本
   * - isFreeform：true 表示用户自由输入，false 表示选择了预设选项
   * 仅在交互式会话下注入；CLI/cron 模式时为 undefined，工具自动返回 skipped。
   */
  /**
   * loop_exit 工具调用时触发的回调(由 loop-trigger 注入)。
   * 调用后当前 tick 完成时退出本轮时间窗口,不再继续 tick,直到下一个时间窗口重置。
   * allowExit=false 时不注入,工具返回错误。
   */
  onLoopExit?: () => void;
  onAskUser?: (
    question: string,
    options?: Array<{ label: string; description?: string; recommended?: boolean }>,
    allowFreeform?: boolean
  ) => Promise<{ answer: string; isFreeform: boolean; imagePaths?: string[] }>;

  sessionSendFn?: (
    targetSessionId: string,
    message: string,
    fromAgentId: string,
    /** 发送方所在 session，用于拦截"发给自己"造成的自锁 */
    fromSessionId?: string
  ) => Promise<string>;
  /**
   * 跨 session 通信：获取当前 Agent 可见的 session 列表（由 main.ts 注入）。
   * 过滤出发送方有权访问的 session（双向 access.toml 检查）。
   */
  sessionGetFn?: (fromAgentId: string) => Promise<SessionInfo[]>;
  /**
   * 当前正在执行的工具调用 ID（function calling 模式下由 agent.ts 注入）。
   * 供需要在 process.exit 前提前写入 tool result 的特殊工具（如 restart_tool）使用。
   * text 模式下不注入（undefined）。
   */
  currentCallId?: string;
  /** 当前 agent run 的 taskId（X-Agent-Task-Id），供 restart_tool 写入 marker 续接计费 */
  agentTaskId?: string | undefined;
  /**
   * 本次运行额外允许写入的目录（沙箱会 bind 成可写）。
   *
   * 来源：cron job / loop 配置里的 `writablePaths`（用户对无人值守任务的显式豁免）。
   * 之所以走 ctx 而不是读配置：豁免是**按任务**声明的，全局读不到。
   */
  sandboxExtraRwPaths?: string[];
  /** 本次运行的来源（chat / cron / loop / cli / slave），供策略与工具（如 fs_grant）判定 */
  origin?: import("../security/audit.js").RunOrigin;
  /**
   * 本次运行**声明**需要读取的密钥名（cron job / loop 配置的 `secrets`）。
   * exec_shell 会据此生成只含这些 key 的过滤文件并 bind 到沙箱内的 `secrets.toml`。
   */
  sandboxSecretNames?: string[];
}

export interface ToolDef {
  /** OpenAI function calling 格式的工具描述 */
  spec: ChatCompletionTool;
  /** 是否需要 MFA 确认，默认 false */
  requiresMFA: boolean;
  /**
   * 按**参数**决定是否需要 MFA（与 `requiresMFA` 取或）。
   *
   * 用于"同一工具，危险参数才要审批"的场景：例如 `env_set` 写 `LOG_LEVEL` 不必打扰，
   * 但写 `OPENAI_API_KEY` 必须审批 —— 静态的 `requiresMFA` 表达不了这个区别。
   */
  requiresMFAFor?: (args: Record<string, unknown>, ctx?: ToolContext) => boolean;
  /**
   * 把**不该出现在 MFA 提示与审计里的**参数替换掉（返回新对象，不要改原参数）。
   *
   * 用于"参数里带明文密钥"的工具：`env_set` 的 `value` 可能是明文 token，而 MFA 提示会发给用户、
   * 审计会落盘 —— 两处都只能看到键名。默认不脱敏（返回原参数）。
   */
  redactArgs?: (args: Record<string, unknown>) => Record<string, unknown>;
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
        // "自我管理"类工具默认只绑定 default agent（见 tools/agent-binding.ts）：
        // 连可见性都不给其他 agent，避免模型看到"能改自己配置的工具"却调不动
        if (DEFAULT_AGENT_ONLY_TOOLS.has(name) && !isSelfManagementAllowed(agentId)) {
          return false;
        }
        const isMcp = name.startsWith("mcp_");
        const isMeta = MCP_META_TOOLS.has(name);
        // MCP 工具（非框架 meta 工具）：走 mcp.toml agent 白名单
        if (isMcp && !isMeta && _mcpAgentFilter) {
          return _mcpAgentFilter(name, agentId);
        }
        // 内置工具 + MCP 管理类 meta 工具：走 tools.toml 黑/白名单
        if (_builtinAgentFilter && (!isMcp || MCP_ADMIN_TOOLS.has(name))) {
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
  const result = await tool.execute(args, ctx);
  return sanitizeToolResult(result);
}
