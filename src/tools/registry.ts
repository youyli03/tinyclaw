import type { ChatCompletionTool } from "openai/resources/chat/completions";

/** 工具执行上下文（由 runAgent 提供） */
export interface ToolContext {
  /** exec_shell 的默认工作目录 */
  cwd?: string;
  /** 当前 session 的 ID（供 cron_add 等工具自动绑定 output.sessionId） */
  sessionId?: string;
}

export interface ToolDef {
  /** OpenAI function calling 格式的工具描述 */
  spec: ChatCompletionTool;
  /** 是否需要 MFA 确认，默认 false */
  requiresMFA: boolean;
  /** 工具执行函数，参数为 JSON 字符串化的 arguments */
  execute: (args: Record<string, unknown>, ctx?: ToolContext) => Promise<string>;
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

/** 获取所有工具的 OpenAI spec 列表（供 chat completions 使用） */
export function getAllToolSpecs(): ChatCompletionTool[] {
  return Array.from(tools.values()).map((t) => t.spec);
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
