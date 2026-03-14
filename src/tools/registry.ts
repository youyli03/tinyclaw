import type { ChatCompletionTool } from "openai/resources/chat/completions";

export interface ToolDef {
  /** OpenAI function calling 格式的工具描述 */
  spec: ChatCompletionTool;
  /** 是否需要 MFA 确认，默认 false */
  requiresMFA: boolean;
  /** 工具执行函数，参数为 JSON 字符串化的 arguments */
  execute: (args: Record<string, unknown>) => Promise<string>;
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
  args: Record<string, unknown>
): Promise<string> {
  const tool = tools.get(name);
  if (!tool) return `错误：未知工具 "${name}"`;
  return tool.execute(args);
}
