import { Session } from "./session.js";
import { llmRegistry } from "../llm/registry.js";
import { searchMemory } from "../memory/qmd.js";
import { getAllToolSpecs, getTool, executeTool } from "../tools/registry.js";
import { MFAError, toolNeedsMFA } from "../auth/guard.js";
import { requireMFA } from "../auth/mfa.js";
import { loadConfig } from "../config/loader.js";
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
- 执行高危操作前，必须先用文字告知用户将要执行什么操作，等待用户回复确认后再执行
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

/** 格式化工具调用描述（用于 MFA 警告消息） */
function describeToolCall(name: string, args: Record<string, unknown>): string {
  if (name === "exec_shell") return `exec_shell: ${String(args["command"] ?? "")}`;
  if (name === "write_file") return `write_file: ${String(args["path"] ?? "")}`;
  if (name === "delete_file") return `delete_file: ${String(args["path"] ?? "")}`;
  return `${name}(${JSON.stringify(args)})`;
}

export interface AgentRunOptions {
  /** 追加到内置 prompt 之后的用户自定义 prompt */
  systemPrompt?: string;
  /** 收到流式 chunk 时的回调 */
  onChunk?: (delta: string) => void;
  /**
   * Interface A MFA：发送警告消息并等待用户确认。
   * 返回 true = 确认，false = 取消，reject = 超时。
   * 未提供时（CLI 模式）自动通过。
   */
  onMFARequest?: (warningMessage: string) => Promise<boolean>;
  /** Interface B MFA / 状态通知：展示文字消息的回调 */
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

  // ── 前置：重置并发控制状态，创建新 AbortController ───────────────────────
  session.abortRequested = false;
  session.mfaApprovedForThisRun = false;
  const llmAc = new AbortController();
  session.llmAbortController = llmAc;

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
    // ── LLM 调用（支持 AbortSignal）──────────────────────────────────────
    let response;
    try {
      response = await client.chat(session.getMessages(), {
        ...(tools.length > 0 ? { tools, tool_choice: "auto" } as object : {}),
        signal: llmAc.signal,
      });
    } catch (err) {
      // AbortError = 被软中断打断，干净退出循环
      if (err instanceof Error && (err.name === "AbortError" || err.message.includes("abort"))) {
        break;
      }
      throw err;
    }

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
      // ── 软中断检测：跳过未执行的工具 ──────────────────────────────────
      if (session.abortRequested) {
        session.addSystemMessage(
          `[tool_result:${call.name}]\n操作被用户新消息中断，此工具调用未执行`
        );
        continue;
      }

      const toolDef = getTool(call.name);
      if (!toolDef) {
        session.addSystemMessage(`[tool_result:${call.name}] 未知工具`);
        continue;
      }

      toolsUsed.push(call.name);

      // ── MFA 检查（执行工具前）────────────────────────────────────────
      const mfaCfg = loadConfig().auth.mfa;
      if (toolNeedsMFA(call.name, call.args, mfaCfg) && !session.mfaApprovedForThisRun) {
        let mfaPassed = false;
        try {
          if (mfaCfg?.interface === "msal") {
            // Interface B: Microsoft Authenticator push
            await requireMFA(opts.onMFAPrompt);
            opts.onMFAPrompt?.("✓ MFA 已通过，继续执行");
            mfaPassed = true;
          } else if (opts.onMFARequest) {
            // Interface A: 文字确认
            const desc = describeToolCall(call.name, call.args);
            mfaPassed = await opts.onMFARequest(`⚠️ 即将执行：${desc}\n请回复 确认 / 取消`);
            if (!mfaPassed) {
              opts.onMFAPrompt?.("✗ MFA 被拒绝，操作已取消");
            }
          } else {
            // CLI fallback：本地用户，自动通过
            mfaPassed = true;
          }
        } catch {
          // 超时或其他失败 → 取消操作
          const result = "操作被取消：MFA 未通过";
          session.addSystemMessage(`[tool_result:${call.name}]\n${result}`);
          continue;
        }

        if (!mfaPassed) {
          session.addSystemMessage(
            `[tool_result:${call.name}]\n操作被取消：用户拒绝了 MFA 确认`
          );
          continue;
        }

        session.mfaApprovedForThisRun = true;
      }

      // ── 执行工具 ──────────────────────────────────────────────────────
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

      // 工具执行完毕后再次检查 abort（新消息可能在工具运行期间到达）
      if (session.abortRequested) break;
    }

    // 一整批工具处理完，若已中断则退出轮次循环
    if (session.abortRequested) break;

    // 最后一轮，强制用 LLM 生成总结
    if (round === MAX_TOOL_ROUNDS - 1) {
      try {
        const summary = await client.chat(session.getMessages(), {
          signal: llmAc.signal,
        });
        finalContent = summary.content;
        session.addAssistantMessage(finalContent);
      } catch (err) {
        if (err instanceof Error && (err.name === "AbortError" || err.message.includes("abort"))) {
          break;
        }
        throw err;
      }
    }
  }

  // 5. JSONL 持久化（异步，不阻塞响应返回）
  if (finalContent) {
    session.appendLastTurnToJsonl();
  }

  // 6. 检查是否需要压缩（仅在未被中断时执行）
  if (!session.abortRequested) {
    await session.maybeCompress();
  }

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
