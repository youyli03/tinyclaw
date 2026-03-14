import { Session } from "./session.js";
import { llmRegistry } from "../llm/registry.js";
import { searchMemory } from "../memory/qmd.js";
import { getAllToolSpecs, getTool, executeTool } from "../tools/registry.js";
import { MFAError } from "../auth/guard.js";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

// 确保所有工具在模块加载时注册
import "../tools/codex.js";
import "../tools/copilot.js";
import "../tools/system.js";

const MAX_TOOL_ROUNDS = 10; // 防止工具调用死循环

/**
 * 内置系统提示词（写死，始终生效）。
 * 描述 tinyclaw 的核心能力边界，不应被用户完全覆盖。
 */
const BUILTIN_SYSTEM = `你是 tinyclaw，一个简洁高效的 AI 助手。
- 需要执行代码任务时，优先调用 codex 或 copilot 工具，不要自己生成大段代码
- 执行高危操作（exec_shell / write_file / delete_file）前会触发 MFA 验证
- 用中文回复，简洁明了`;

/** 读取 ~/.tinyclaw/SYSTEM.md 作为用户自定义 prompt（文件不存在时返回 undefined） */
function loadUserSystemPrompt(): string | undefined {
  const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? "";
  const path = join(home, ".tinyclaw", "SYSTEM.md");
  if (!existsSync(path)) return undefined;
  const content = readFileSync(path, "utf-8").trim();
  return content.length > 0 ? content : undefined;
}

/** 构建最终 system prompt：内置 + 用户自定义（如有） */
function buildSystemPrompt(extra?: string): string {
  const userPrompt = extra ?? loadUserSystemPrompt();
  return userPrompt ? `${BUILTIN_SYSTEM}\n\n${userPrompt}` : BUILTIN_SYSTEM;
}

export interface AgentRunOptions {
  /** 追加到内置 prompt 之后的用户自定义 prompt（优先级高于 config.toml [agent].systemPrompt） */
  systemPrompt?: string;
  /** 收到流式 chunk 时的回调（不提供则等待完整响应） */
  onChunk?: (delta: string) => void;
  /** 展示 MFA 提示的回调 */
  onMFAPrompt?: (message: string) => void;
}

export interface AgentRunResult {
  content: string;
  /** 本次运行调用了哪些工具 */
  toolsUsed: string[];
}

/**
 * 单次 Agent 运行（一轮用户消息 → 完整响应）。
 * 支持多轮 tool_call（ReAct 循环），最多 MAX_TOOL_ROUNDS 轮。
 */
export async function runAgent(
  session: Session,
  userContent: string,
  opts: AgentRunOptions = {}
): Promise<AgentRunResult> {
  const client = llmRegistry.get("daily");
  const toolsUsed: string[] = [];

  // 1. 新 session 时注入 system prompt
  const messages = session.getMessages();
  if (messages.length === 0 || messages[0]?.role !== "system") {
    session.addSystemMessage(buildSystemPrompt(opts.systemPrompt));
  }

  // 2. 搜索相关历史记忆，注入为 system 消息
  const memoryContext = await searchMemory(userContent);
  if (memoryContext) {
    session.addSystemMessage(memoryContext);
  }

  // 3. 添加用户消息
  session.addUserMessage(userContent);

  const tools = getAllToolSpecs();
  let finalContent = "";

  // 4. ReAct 循环
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await client.chat(session.getMessages(), {
      // 将工具 spec 通过 ChatOptions 扩展传入（openai 包支持）
      ...(tools.length > 0 ? { tools, tool_choice: "auto" } as object : {}),
    });

    const { content, toolCalls } = parseResponse(response.content);

    // 没有工具调用 → 最终回复
    if (!toolCalls || toolCalls.length === 0) {
      finalContent = content;
      session.addAssistantMessage(finalContent);
      break;
    }

    // 有工具调用 → 执行并将结果追加到 messages
    session.addAssistantMessage(content || "");

    for (const call of toolCalls) {
      const toolDef = getTool(call.name);
      if (!toolDef) {
        session.addSystemMessage(`[tool_result:${call.name}] 未知工具`);
        continue;
      }

      toolsUsed.push(call.name);

      // MFA guard 已内置在工具的 execute 里，这里额外捕获 MFAError
      let result: string;
      try {
        result = await executeTool(call.name, call.args);
      } catch (err) {
        if (err instanceof MFAError) {
          result = `操作被取消：${err.message}`;
        } else {
          result = `工具执行错误：${err instanceof Error ? err.message : String(err)}`;
        }
      }

      session.addSystemMessage(`[tool_result:${call.name}]\n${result}`);
    }

    // 最后一轮，强制用 LLM 生成总结
    if (round === MAX_TOOL_ROUNDS - 1) {
      const summary = await client.chat(session.getMessages());
      finalContent = summary.content;
      session.addAssistantMessage(finalContent);
    }
  }

  // 5. 持久化到 QMD，检查是否需要压缩
  await session.persistLastTurn();
  await session.maybeCompress();

  return { content: finalContent, toolsUsed };
}

// ── 简单的 tool_call 解析（兼容 openai 返回的 JSON 格式） ─────────────────────

interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

interface ParsedResponse {
  content: string;
  toolCalls?: ToolCall[];
}

function parseResponse(raw: string): ParsedResponse {
  // openai SDK 返回的 tool_calls 通过 response.choices[0].message.tool_calls 获取，
  // 但我们的 LLMClient.chat() 只返回 content string。
  // 这里解析 LLM 可能以 JSON 形式内嵌的 tool_calls（fallback 方案）。
  // 正式实现中应在 LLMClient 返回完整 message 对象；此处先做简单处理。
  return { content: raw };
}
