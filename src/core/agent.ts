import { Session } from "./session.js";
import { llmRegistry } from "../llm/registry.js";
import type { ChatResult } from "../llm/client.js";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { searchMemory } from "../memory/qmd.js";
import { getAllToolSpecs, getTool, executeTool } from "../tools/registry.js";
import { MFAError, toolNeedsMFA } from "../auth/guard.js";
import { requireMFA } from "../auth/mfa.js";
import { verifyTOTP } from "../auth/totp.js";
import { loadConfig } from "../config/loader.js";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { agentManager } from "./agent-manager.js";

// 确保所有工具在模块加载时注册
import "../tools/code-assist.js";
import "../tools/system.js";
import "../tools/cron.js";

const MAX_TOOL_ROUNDS = 10; // 防止工具调用死循环

/**
 * 内置系统提示词（动态生成，含 code_assist 次数限制）。
 */
function buildBuiltinSystem(maxCodeAssistCalls: number, workspacePath: string): string {
  const limitNote =
    maxCodeAssistCalls > 0
      ? `每次用户消息处理中最多调用 ${maxCodeAssistCalls} 次 code_assist，超出后需告知用户任务未完成，请求继续`
      : 'code_assist 调用次数不限制';
  const agentDir = join(workspacePath, '..');
  const memFilePath = join(agentDir, 'MEM.md');
  const skillsFilePath = join(agentDir, 'SKILLS.md');
  return `你是 tinyclaw，一个简洁高效的 AI 助手。

## code_assist 工具使用规范
- 需要执行代码编写/修改/调试任务时，调用 code_assist 工具，不要自己生成大段代码
- code_assist 没有对话历史，每次调用是独立会话，task 参数必须自包含完整背景：
  相关文件路径、现有代码片段（如有）、明确目标——不能只写修改上面的代码
- 如需多步完成任务，需监督每次结果：检查输出是否达成目标，若未完成则携带上次结果和剩余任务再次调用
- ${limitNote}

## 工作区规范
- 当前 Agent 的工作目录（exec_shell 默认 cwd）：${workspacePath}
- 子目录约定：
  - tmp/    临时文件（可随时清理）
  - output/ 输出产物（交付用文件、运行结果等）
- 所有无关联的中间文件放入 tmp/，输出成果放入 output/，保持目录整洁
- 可用绝对路径或 \`cd /other/path && command\` 切换工作目录

## MEM.md（持久记忆）
- MEM.md 是跨 session 的持久笔记，已在本 session 初始化时一次性加载
- 如需更新（记录用户偏好、重要结论、待办事项等），直接用 write_file 写入 ${memFilePath}
- 要获取最新内容（本 session 内被更新过），用 exec_shell 执行 cat ${memFilePath}

## SKILLS.md（技能目录）
- SKILLS.md 列出当前 Agent 所知技能和工作流程，已在本 session 初始化时一次性加载
- 需要执行某个工作流程时：根据 SKILLS.md 中的路径读取对应 README.md 并按照执行
- 如果 SKILLS.md 中找不到对应技能，应告知用户并询问如何继续
- 要获取最新 SKILLS.md（本 session 内被更新过），用 exec_shell 执行 cat ${skillsFilePath}

## 通用规范
- 执行高危操作前，必须先用文字告知用户将要执行什么操作，等待用户回复确认后再执行
- 用中文回复，简洁明了`;
}

/**
 * 为不支持 function calling 的模型生成文字版工具描述和调用格式说明（追加到 system prompt）。
 *
 * 格式约定：
 *   - 需要调用工具时，整条回复只包含一个 <tool_call> 块，不附加任何其他文字
 *   - 收到 [tool_result] 后继续推理，可再次调用工具
 *   - 所有工具执行完毕、任务确认完成后，输出最终中文回复，不得包含任何 <tool_call> 块
 */
function buildTextBasedToolInstructions(tools: ChatCompletionTool[]): string {
  const descs = tools
    .map((t) => {
      const fn = t.function;
      const params = fn.parameters as {
        properties?: Record<string, { type?: string; description?: string }>;
        required?: string[];
      } | undefined;
      const lines = [`### ${fn.name}`, `说明：${fn.description ?? ""}`];
      if (params?.properties) {
        lines.push("参数：");
        for (const [k, v] of Object.entries(params.properties)) {
          const req = params.required?.includes(k) ? "必填" : "可选";
          lines.push(`  - ${k} (${v.type ?? "any"}, ${req})：${v.description ?? ""}`);
        }
      }
      return lines.join("\n");
    })
    .join("\n\n");

  return `## 工具调用格式（文字模式）

当前模型不支持 function calling，使用以下文字格式调用工具。

**调用规则：**
1. 需要调用工具时，整条回复只能包含以下格式的一个块，不得附加任何其他文字或解释：
   <tool_call>
   {"name": "工具名", "args": {"参数名": "值"}}
   </tool_call>
2. 系统执行工具后，会在 [tool_result:工具名] 消息中返回结果，你需继续推理
3. 可多次调用工具，每次只调用一个
4. **最终回复**：所有工具调用完毕、任务确认完成后，输出完整的中文回复，回复中不得包含任何 <tool_call> 块

## 可用工具

${descs}`;
}

/** 读取 ~/.tinyclaw/SYSTEM.md 作为全局自定义 prompt（文件不存在时返回 undefined） */
function loadUserSystemPrompt(): string | undefined {
  const home = process.env["HOME"] ?? process.env["USERPROFILE"] ?? "";
  const p = join(home, ".tinyclaw", "SYSTEM.md");
  if (!existsSync(p)) return undefined;
  const content = readFileSync(p, "utf-8").trim();
  return content.length > 0 ? content : undefined;
}

/** 读取 Agent 的 MEM.md（文件不存在时返回 undefined） */
function loadAgentMem(agentId: string): string | undefined {
  const p = agentManager.memPath(agentId);
  if (!existsSync(p)) return undefined;
  const content = readFileSync(p, "utf-8").trim();
  return content.length > 0 ? content : undefined;
}

/** 读取 Agent 的 SKILLS.md（文件不存在时返回 undefined） */
function loadAgentSkills(agentId: string): string | undefined {
  const p = agentManager.skillsPath(agentId);
  if (!existsSync(p)) return undefined;
  const content = readFileSync(p, "utf-8").trim();
  return content.length > 0 ? content : undefined;
}

/** 读取 Agent 的 SYSTEM.md（文件不存在时返回 undefined） */
function loadAgentSystemPrompt(agentId: string): string | undefined {
  const p = agentManager.systemPromptPath(agentId);
  if (!existsSync(p)) return undefined;
  const content = readFileSync(p, "utf-8").trim();
  return content.length > 0 ? content : undefined;
}

/**
 * 构建最终 system prompt：内置 + 全局 SYSTEM.md（可选）+ Agent SYSTEM.md（可选）+ MEM.md（可选）+ SKILLS.md（可选）
 * opts.systemPrompt 优先于从文件读取的 Agent 提示。
 */
function buildSystemPrompt(agentId = "default", extra?: string): string {
  const maxCalls = loadConfig().tools.code_assist.maxCallsPerRun;
  const workspacePath = agentManager.workspaceDir(agentId);
  const parts: string[] = [buildBuiltinSystem(maxCalls, workspacePath)];
  const userPrompt = loadUserSystemPrompt();
  if (userPrompt) parts.push(userPrompt);
  const agentPrompt = extra ?? loadAgentSystemPrompt(agentId);
  if (agentPrompt) parts.push(agentPrompt);
  const mem = loadAgentMem(agentId);
  if (mem) parts.push(`## 持久记忆（MEM.md）\n\n${mem}`);
  const skills = loadAgentSkills(agentId);
  if (skills) parts.push(`## 技能目录（SKILLS.md）\n\n${skills}`);
  return parts.join("\n\n");
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
  onMFARequest?: (warningMessage: string, verifyCode?: (code: string) => boolean) => Promise<boolean>;
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

  // 工具列表和模式在 system prompt 注入前确定（textMode 会影响 prompt 内容）
  const tools = getAllToolSpecs();
  const textMode = !client.supportsToolCalls;

  // 1. 新 session 时注入 system prompt（三层堆叠：内置 + 全局 + Agent）
  const messages = session.getMessages();
  if (messages.length === 0 || messages[0]?.role !== "system") {
    let sysPrompt = buildSystemPrompt(session.agentId, opts.systemPrompt);
    if (textMode && tools.length > 0) {
      sysPrompt += "\n\n" + buildTextBasedToolInstructions(tools);
    }
    // 始终插到最前：确保恢复的 session（如 qqbot）有正确的指令，不被旧历史覆盖
    session.prependSystemMessage(sysPrompt);
  }

  // 2. 搜索相关历史记忆，注入为 system 消息
  const memoryContext = await searchMemory(userContent, session.agentId);
  if (memoryContext) {
    session.addSystemMessage(memoryContext);
  }

  // 3. 添加用户消息
  session.addUserMessage(userContent);

  let finalContent = "";
  let codeAssistCallCount = 0;

  // 4. ReAct 循环
  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    // ── LLM 调用（支持 AbortSignal）──────────────────────────────────────
    let response: ChatResult;
    try {
      response = await client.chat(session.getMessages(), {
        ...(tools.length > 0 && client.supportsToolCalls
          ? { tools, tool_choice: "auto" }
          : {}),
        signal: llmAc.signal,
      });
    } catch (err) {
      // AbortError = 被软中断打断，干净退出循环
      if (err instanceof Error && (err.name === "AbortError" || err.message.includes("abort"))) {
        break;
      }
      throw err;
    }

    const { content, toolCalls } = parseResponse(response, textMode);

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

      // ── code_assist 调用次数限制 ──────────────────────────────────────
      if (call.name === "code_assist") {
        const maxCalls = loadConfig().tools.code_assist.maxCallsPerRun;
        if (maxCalls > 0 && codeAssistCallCount >= maxCalls) {
          session.addSystemMessage(
            `[tool_result:code_assist]\n已达本次最大调用次数（${maxCalls}），此次调用未执行。` +
            `请在当前回复中告知用户任务状态，用户可发新消息继续。`
          );
          continue;
        }
        codeAssistCallCount++;
      }

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
          } else if (mfaCfg?.interface === "totp") {
            // Interface C: TOTP 验证码
            if (opts.onMFARequest) {
              const desc = describeToolCall(call.name, call.args);
              const secretPath = mfaCfg.totpSecretPath;
              mfaPassed = await opts.onMFARequest(
                `⚠️ 即将执行：${desc}\n请打开 Authenticator App，将当前 6 位验证码回复给我（30 秒内有效）`,
                (code: string) => {
                  const ok = verifyTOTP(code, secretPath);
                  return ok;
                }
              );
              if (!mfaPassed) {
                opts.onMFAPrompt?.("✗ TOTP 验证失败，操作已取消");
              }
            } else {
              // CLI fallback
              mfaPassed = true;
            }
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
        result = await executeTool(call.name, call.args, { cwd: agentManager.workspaceDir(session.agentId), sessionId: session.sessionId });
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

// ── tool_call 解析 ────────────────────────────────────────────────────────────

interface ToolCall {
  name: string;
  args: Record<string, unknown>;
}

interface ParsedResponse {
  content: string;
  toolCalls?: ToolCall[];
}

function parseResponse(result: ChatResult, textMode = false): ParsedResponse {
  // ── Function calling 模式：直接用 API 返回的 tool_calls ──────────────────
  if (!textMode) {
    if (result.toolCalls && result.toolCalls.length > 0) {
      return {
        content: result.content,
        toolCalls: result.toolCalls.map((tc) => ({ name: tc.name, args: tc.args })),
      };
    }
    return { content: result.content };
  }

  // ── 文字模式：从 content 里提取 <tool_call>...</tool_call> 块 ─────────────
  const TAG_RE = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  const matches = [...result.content.matchAll(TAG_RE)];
  if (matches.length === 0) return { content: result.content };

  const toolCalls: ToolCall[] = [];
  for (const m of matches) {
    try {
      const parsed = JSON.parse(m[1]!) as unknown;
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        "name" in parsed &&
        typeof (parsed as Record<string, unknown>)["name"] === "string"
      ) {
        toolCalls.push({
          name: (parsed as Record<string, unknown>)["name"] as string,
          args: ((parsed as Record<string, unknown>)["args"] ?? {}) as Record<string, unknown>,
        });
      }
    } catch {
      // JSON 格式错误，跳过
    }
  }

  // <tool_call> 块是中间步骤，从内容中去掉，不透传给用户
  const cleanContent = result.content.replace(TAG_RE, "").trim();
  return {
    content: cleanContent,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };
}
