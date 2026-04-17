import { Session } from "./session.js";
import { llmRegistry, buildFallbackClient } from "../llm/registry.js";
import { LLMConnectionError } from "../llm/client.js";
import { APIError } from "openai";
import type { ChatResult } from "../llm/client.js";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { acquireLLMSlot, releaseLLMSlot } from "../llm/concurrency.js";
import { searchMemory } from "../memory/qmd.js";
import { shouldSummarize, shouldSummarizeCode, distillTurnToDiary } from "../memory/summarizer.js";
import { getAllToolSpecs, getTool, executeTool, setBuiltinAgentFilter } from "../tools/registry.js";
import { MFAError, toolNeedsMFA } from "../auth/guard.js";
import { requireMFA } from "../auth/mfa.js";
import { verifyTOTP } from "../auth/totp.js";
import { loadConfig } from "../config/loader.js";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { agentManager } from "./agent-manager.js";
import { slaveManager } from "./slave-manager.js";
import { buildCodeSystemPrompt } from "../code/system-prompt.js";
import { readFeedback } from "./feedback-writer.js";
import { sanitizeUserInput } from "../tools/sanitize.js";
import { skillRegistry } from "../skills/registry.js";

// 确保所有工具在模块加载时注册
import "../tools/code-assist.js";
import "../tools/system.js";
import "../tools/cron.js";
import "../tools/skill-creator.js";
import "../tools/skill-run.js";
import "../tools/mcp-manager.js";
import "../tools/agent-fork.js";
import "../tools/notify.js";
import "../tools/send-report.js";
import "../tools/render-diagram.js";
import "../tools/search-store.js";
import "../tools/ask-user-tool.js";
import "../tools/ask-master.js";
import "../tools/run-code-subagent.js";
import "../tools/memory.js";
import "../tools/session-bridge.js";
import "../tools/http-request.js";
import "../tools/restart.js";
import { buildVisionContent } from "../connectors/utils/media-parser.js";

// 注册内置工具的 per-agentId 黑/白名单过滤回调（模块加载时执行一次）
// 读取 ~/.tinyclaw/agents/<id>/tools.toml，对非 mcp_ 工具应用黑/白名单过滤
setBuiltinAgentFilter((toolName: string, agentId: string): boolean => {
  const cfg = agentManager.readToolsConfig(agentId);
  if (!cfg) return true; // 文件不存在 → 不限制
  if (cfg.mode === "allowlist") return cfg.tools.includes(toolName);
  if (cfg.mode === "denylist")  return !cfg.tools.includes(toolName);
  return true;
});

/** Chat 模式工具调用轮次上限（在 config 中未配置时的后备默认值，0=无限制） */
const MAX_TOOL_ROUNDS = 0;
/** Slave 最大嵌套深度：0=Master，1=一级Slave，不允许 Slave 再 fork */
const MAX_SLAVE_DEPTH = 1;
/** 超过此时长（ms）且仍在执行工具时，自动 fork 为 Slave 继续执行 */
const AUTO_FORK_THRESHOLD_MS = 120_000;
/** Code 模式：context window 用量超过此比例时，通知用户已接近上限（触发压缩的阈值更低，为 75%） */
const CODE_CONTEXT_WARN_THRESHOLD = 0.9;

/**
 * 判断某个内置工具对指定 agent 是否可用（读 tools.toml）。
 * 仅用于 system prompt 动态描述生成，与工具的实际执行路由无关。
 * 文件不存在 → 全量可用（返回 true）。
 */
function isToolAvailable(toolName: string, agentId: string): boolean {
  const cfg = agentManager.readToolsConfig(agentId);
  if (!cfg) return true;
  if (cfg.mode === "allowlist") return cfg.tools.includes(toolName);
  if (cfg.mode === "denylist")  return !cfg.tools.includes(toolName);
  return true;
}

/**
 * 内置系统提示词（动态生成，含 code_assist 次数限制）。
 * agentId 仅用于读取 tools.toml 以决定 MEM.md 操作说明的措辞，与记忆的操作对象无关。
 */
function buildBuiltinSystem(maxCodeAssistCalls: number, workspacePath: string, supportsVision = false, agentId = "default"): string {
  const limitNote =
    maxCodeAssistCalls > 0
      ? `每次用户消息处理中最多调用 ${maxCodeAssistCalls} 次 code_assist，超出后需告知用户任务未完成，请求继续`
      : 'code_assist 调用次数不限制';
  const agentDir = join(workspacePath, '..');
  const memFilePath = join(agentDir, 'MEM.md');
  const activeFilePath = join(agentDir, 'ACTIVE.md');
  const skillsFilePath = join(agentDir, 'SKILLS.md');
  const chatFeedbackPath = agentManager.feedbackPath(agentId, "chat");

  // ── chat feedback.md（跨 session 用户行为纠正，若存在则注入） ───────────────
  const chatFeedbackContent = readFeedback(agentId, "chat");

  // ── MEM.md 操作说明（动态，根据 agent tools.toml 决定使用哪种工具描述） ──────
  const hasWriteFile     = isToolAvailable("write_file",      agentId);
  const hasExecShell     = isToolAvailable("exec_shell",      agentId);
  const hasMemWriteTool  = isToolAvailable("memory_write_mem", agentId);
  const hasMemReadTool   = isToolAvailable("memory_read_mem",  agentId);

  let memWriteDesc: string;
  let memReadDesc: string;
  if (hasWriteFile && hasMemWriteTool) {
    // 两者均可用：优先推荐 memory_write_mem（无需 MFA），write_file 作备选
    memWriteDesc = `优先调用 memory_write_mem 工具（无需 MFA）；也可用 write_file 写入 ${memFilePath}`;
    memReadDesc  = hasMemReadTool
      ? `调用 memory_read_mem；也可用 exec_shell 执行 cat ${memFilePath}`
      : (hasExecShell ? `用 exec_shell 执行 cat ${memFilePath}` : `调用 memory_read_mem`);
  } else if (hasWriteFile) {
    // 只有 write_file 可用（默认/无限制 agent 且未配置 memory_write_mem）
    memWriteDesc = `直接用 write_file 写入 ${memFilePath}`;
    memReadDesc  = hasExecShell
      ? `用 exec_shell 执行 cat ${memFilePath}`
      : (hasMemReadTool ? `调用 memory_read_mem 工具` : `（暂无可用方式）`);
  } else if (hasMemWriteTool) {
    // 受限 agent：write_file/exec_shell 被禁，仅有 memory_write_mem 可用
    memWriteDesc = `调用 memory_write_mem 工具（支持 overwrite 覆盖 / append 追加两种模式）`;
    memReadDesc  = hasMemReadTool ? `调用 memory_read_mem 工具` : `（暂无可用方式）`;
  } else {
    // 两者均不可用（极度受限 agent）
    memWriteDesc = `（当前 Agent 无写入权限，MEM.md 由管理员维护）`;
    memReadDesc  = hasMemReadTool ? `调用 memory_read_mem 工具` : `（当前 Agent 无读取权限）`;
  }

  return `你是 tinyclaw，一个简洁高效的 AI 助手。

## 工具使用优先级

处理任务时，按以下顺序选择执行方式：

1. **内置工具**（exec_shell / write_file / read_file / code_assist 等）——直接调用，响应最快
2. **MCP 工具**（mcp_* 前缀）——若内置工具无法满足，先用 mcp_list_servers 查看可用服务，再用 mcp_enable_server 激活对应服务后调用其工具
3. **Skill（工作流文档）**——若前两类均不适用，且用户意图与可用技能的 description/trigger_phrases 精确匹配，使用 skill_run 工具执行

不要跳级使用：能用内置工具解决的，不必启动 MCP 服务；能用 MCP 工具解决的，不必手动执行 Skill 脚本。
- \`exec_shell\` 默认超时为 60 秒；预计超过 60 秒的命令，必须显式传入更大的 \`timeout_sec\`
- build / test / install / 大型网络请求 / 仓库级扫描等长任务，不要直接使用默认 60 秒硬跑

## code_assist 工具使用规范
- 需要执行代码编写/修改/调试任务时，调用 code_assist 工具，不要自己生成大段代码
- code_assist 采用 **两阶段工作流**（plan→execute）：
  1. 调用 code_assist(task) → 子 Agent 探索代码库并返回计划摘要 + sessionId
  2. 审阅计划后：
     - 批准并执行：调用 code_assist_run(sessionId)，等待执行完成
     - 修改计划：调用 code_assist_run(sessionId, "反馈意见")，子 Agent 重规划后返回新计划
- task 参数必须自包含完整背景：相关文件路径、现有代码片段（如有）、明确目标——不能只写修改上面的代码
- ${limitNote}

## 工作区规范
- 当前 Agent 的工作目录（exec_shell 默认 cwd）：${workspacePath}
- 子目录约定：
  - tmp/    临时文件（可随时清理）
  - output/ 输出产物（交付用文件、运行结果等）
- 所有无关联的中间文件放入 tmp/，输出成果放入 output/，保持目录整洁
- 可用绝对路径或 \`cd /other/path && command\` 切换工作目录
- **write_file / edit_file / delete_file 只允许操作 workspace 和 agent 配置目录**；超出范围将触发用户授权确认，授权仅当前轮对话有效，未确认则写入失败
- **需要写临时文件时，路径必须在 '${workspacePath}/tmp/' 或 '/tmp/' 下，不得写入其他系统路径或项目源码目录**
- exec_shell 可切换任意目录，但严禁写入 \$HOME 根目录、系统目录（/etc /usr /bin 等）及敏感配置文件（.gitconfig / .bashrc / .ssh 等）
- 使用 exec_shell 跑长命令时，要主动设置合适的 \`timeout_sec\`，不要让默认 60 秒误伤长任务

## MEM.md(持久记忆)
- MEM.md 是跨 session 的长期稳定记忆,已在本 session 初始化时一次性加载
- 它属于 **chat 模式通用记忆**,不仅服务工程/项目任务,也覆盖日常对话、生活场景、长期偏好、关系与习惯
- 如需更新,${memWriteDesc}
- 要获取最新内容(本 session 内被更新过),${memReadDesc}

### 应主动记录到 MEM.md 的内容
- 用户明确表达的长期偏好、习惯或固定要求
- 稳定的人物关系、身份信息、环境信息与长期有效规则
- 重要结论、长期有效的决策和跨 session 仍需保留的稳定事实

## ACTIVE.md(活跃上下文)
- ACTIVE.md 用于保存近期活跃的上下文,如最近反复提起的话题、短期未完成事项、最新明确要求
- 这层同时覆盖生活场景和项目场景,避免把所有短期信息都挤进 MEM.md
- 若当前 Agent 可用 memory_read_active / memory_write_active,应优先用它们读取或更新 ${activeFilePath}

### 更适合写入 ACTIVE.md 的内容
- 最近 7~14 天仍在跟进的事项
- 当前未完成任务、最新目标、短期阻塞点
- 最近一次用户明确提出、后续仍可能继续提起的要求

## SKILLS.md（技能目录）
- 可用技能已通过 skill reminder 在每轮注入（XML 格式，含精确文档路径 <doc_path>）
- 触发 skill 时：**必须先调用 read_file 读取 <doc_path> 文档**，再严格按文档步骤执行，禁止凭记忆执行
- 触发条件：用户意图需与 <description> 或 <trigger_phrases> 精确匹配，禁止主动猜测
- disable-model-invocation=true 的 skill：仅可通过 /skill:name 命令显式调用，AI 不得主动触发
- 如需创建新技能，调用 create_skill 工具获取完整指南
- 要获取最新技能列表，用 exec_shell 执行 cat ${skillsFilePath}

## 时效性数据规范（强制）
- 凡涉及实时或时效性数据（天气、股价、汇率、新闻、系统状态、磁盘空间等），必须先通过工具获取真实数据，再输出结果
- 禁止用训练知识直接回答时效性问题——必须调用 exec_shell（curl/wget 等）或其他工具实际获取，哪怕数据可能与预期相同
- 若工具调用失败或无法获取数据，明确输出"数据获取失败：<原因>"，不得用任何猜测、估算或历史数据替代

## 富媒体发送规范
- 若需发送图片/音频/视频/文件给用户，在回复文本中嵌入对应标签，系统会自动识别并发送：
  - 图片：\`<img src="/绝对路径或https://URL"/>\`
  - 音频：\`<audio src="..."/>\`
  - 视频：\`<video src="..."/>\`
  - 文件：\`<file src="..." name="文件名"/>\`
- 本地文件使用绝对路径（如 \`${workspacePath}/output/cat.png\`），确保文件确实存在后再发送
- 远程资源使用公网可访问的 https:// URL
- 禁止把图片内容转成 base64 文本输出——必须用上述标签格式

## 通用规范
- 执行高危操作前，必须先用文字告知用户将要执行什么操作，等待用户回复确认后再执行
- 用中文回复，简洁明了

## 主动询问用户（ask_user）

遇到以下情况时，调用 **ask_user** 工具向用户提问，而不是盲目假设：
- 需求描述模糊，存在多种合理理解方式
- 有 2～4 个可行方案，用户偏好决定走哪条路
- 任务执行到一半遇到分支，需要用户决策才能继续

使用方式：
- 提供 2~5 个预设选项(含 label,可加 description 说明和 recommended 推荐标记)
- 默认允许用户自由输入（不局限于预设选项）
- 不要用此工具询问**可以自行通过读文件/执行命令确认**的事项
- **ask_user 在同一次处理过程中不消耗额外请求**,遇到分支、歧义或需要用户决策时可放心多次调用;无需强行把所有问题合并为一次

## 后台任务（agent_fork）

对于耗时较长（预计 >10 秒）或可以与其他工作并行的任务，优先使用 **agent_fork** 在后台异步执行，不要让用户等待：

- **适合后台**：长时间编译、依赖安装、大文件处理、网络抓取、多步骤数据分析等
- **不适合后台**：需要立即回复用户的简单问题、需要追问确认的任务、极短操作

使用方式：
1. 调用 agent_fork(task="完整任务描述") → 立即返回 slave_id，继续响应用户
2. 告知用户后台任务已启动，将在完成后自动通知
3. 可随时调用 agent_status() 列出全部后台任务及进度（status_filter="running" 只看运行中），或 agent_status(slave_id="xxx") 查询特定任务
4. 若需取消，调用 agent_abort(slave_id="xxx")${supportsVision ? `

## 视觉能力
- 你当前使用的模型支持直接读取图片，不需要 OCR 工具
- 用户发送的图片会被自动附加到消息中，你可以直接描述和分析图片内容
- 收到含图片的消息时，直接观察并回答，不要建议安装 tesseract 或其他 OCR 工具` : ''}${chatFeedbackContent ? `

## 行为约束（来自历史反馈）
以下是用户过去纠正过的行为，请严格遵守：

${chatFeedbackContent}

> 当用户明确纠正你的行为（"不要…"/"以后…"/"每次都要…"），用 \`edit_file\` 追加到 \`${chatFeedbackPath}\`，格式：\`- [YYYY-MM-DD] 纠正内容\`` : `

## 行为反馈记录
当用户明确纠正你的行为（"不要…"/"以后…"/"每次都要…"），用 \`edit_file\` 追加到 \`${chatFeedbackPath}\`，格式：\`- [YYYY-MM-DD] 纠正内容\``}`;}

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

/** 读取 Agent 的 SKILLS.md 文本（供 system prompt 使用，走缓存） */
function loadAgentSkills(agentId: string): string | undefined {
  // skillRegistry 缓存解析结果；多并发 session 不会重复 I/O
  const p = agentManager.skillsPath(agentId);
  if (!existsSync(p)) return undefined;
  const text = readFileSync(p, "utf-8").trim();
  return text.length > 0 ? text : undefined;
}

/** 读取 Agent 的 SYSTEM.md（文件不存在时返回 undefined） */
function loadAgentSystemPrompt(agentId: string): string | undefined {
  const p = agentManager.systemPromptPath(agentId);
  if (!existsSync(p)) return undefined;
  const content = readFileSync(p, "utf-8").trim();
  return content.length > 0 ? content : undefined;
}

// ── Skill Reminder 辅助函数 ──────────────────────────────────────────────────

/** 构建 skill reminder 文本（name + 一行描述列表），无 skill 时返回 null */
/** 构建 skill reminder 文本（走 skillRegistry 缓存，无 skill 时返回 null） */
function buildSkillReminder(agentId: string): string | null {
  return skillRegistry.getPromptSnapshot(agentId) ?? null;
}

/**
 * 构建最终 system prompt：内置 + 全局 SYSTEM.md（可选）+ Agent SYSTEM.md（可选）+ MEM.md（可选）+ SKILLS.md（可选）+ suffix（可选）
 * opts.systemPrompt 优先于从文件读取的 Agent 提示。
 * opts.systemPromptSuffix 追加到 Agent 提示之后（不替换）。
 */
function buildSystemPrompt(agentId = "default", extra?: string, supportsVision = false, suffix?: string): string {
  const maxCalls = loadConfig().tools.code_assist.maxCallsPerRun;
  const workspacePath = agentManager.workspaceDir(agentId);
  const parts: string[] = [buildBuiltinSystem(maxCalls, workspacePath, supportsVision, agentId)];
  const userPrompt = loadUserSystemPrompt();
  if (userPrompt) parts.push(userPrompt);
  const agentPrompt = extra ?? loadAgentSystemPrompt(agentId);
  if (agentPrompt) parts.push(agentPrompt);
  if (suffix) parts.push(suffix);
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
  /** 替换 Agent SYSTEM.md 的自定义 prompt（优先级高于文件） */
  systemPrompt?: string;
  /** 追加到 Agent SYSTEM.md 之后的额外 prompt（不替换，适合 slave 注入规则） */
  systemPromptSuffix?: string;
  /** 收到流式 chunk 时的回调 */
  onChunk?: (delta: string) => void;
  /**
   * Interface A MFA：发送警告消息并等待用户确认。
   * 返回 true = 确认，false = 取消，reject = 超时。
   * 未提供时（CLI 模式）自动通过。
   */
  onMFARequest?: (warningMessage: string, verifyCode?: (code: string) => boolean) => Promise<boolean>;
  /**
   * Interface B MFA / 状态通知：展示文字消息的回调
   */
  onMFAPrompt?: (message: string) => void;
  /**
   * 触发记忆压缩时的通知回调。
   * phase="start" 在压缩开始前调用，phase="done" 完成后调用（含摘要文本）。
   */
  onCompress?: (phase: "start" | "done", summary?: string) => void;
  /**
   * Slave agent 完成时的通知回调（由 main.ts 注入）。
   * 负责等待 Master 当前 run 结束、触发新的 runAgent、推送结果给用户。
   */
  onSlaveComplete?: import("../tools/registry.js").ToolContext["onSlaveComplete"];
  /**
   * Slave 定期进度推送回调（由 main.ts 注入）。
   * 每隔 reportIntervalSecs 秒向用户推送 Slave 当前进度快照，不触发 runAgent。
   */
  onProgressNotify?: import("../tools/registry.js").ToolContext["onProgressNotify"];
  /**
   * LLM 调用心跳回调（由 main.ts 注入）。
   * 流式请求期间每隔 agent.heartbeatIntervalSecs 秒调用一次，向用户推送"仍在处理中"。
   */
  onHeartbeat?: (message: string) => void;
  /**
   * 主动向用户推送消息（由 main.ts 注入）。
   * 供 notify_user 工具调用，不等 runAgent 结束即发送，不触发新一轮 LLM 推理。
   */
  onNotify?: (message: string) => Promise<void>;
  /**
   * Plan 模式：向用户展示计划摘要并等待确认（由 main.ts 注入）。
   * 仅在 code + plan 子模式下注入；auto 模式或非 code 模式时不注入。
   */
  onPlanRequest?: import("../tools/registry.js").ToolContext["onPlanRequest"];
  /**
   * ask_user：向用户展示问题和选项菜单，等待用户回答（由 main.ts 注入）。
   * Chat 和 Code 模式下均注入；CLI/cron 模式时不注入，工具自动返回 skipped。
   */
  onAskUser?: import("../tools/registry.js").ToolContext["onAskUser"];
  /**
   * 当前 runAgent 调用的 Slave 嵌套深度（0 = 交互式 Master，1 = 一级 Slave，以此类推）。
   * 用于控制 agent_fork 的嵌套上限：深度 >= MAX_SLAVE_DEPTH 时，ToolContext 不注入
   * slaveRunFn，agent_fork 工具会返回明确错误，防止无限嵌套或结果丢失。
   */
  slaveDepth?: number;
  /**
   * 跳过 runAgent 前置步骤（system prompt 重建、记忆搜索、压缩、添加用户消息），
   * 直接进入 ReAct 循环。用于 auto-fork continuation slave——session 已包含完整上下文。
   */
  skipPreamble?: boolean;
  /**
   * 跳过记忆搜索步骤（step 2）。
   * 用于 loop trigger tick：task content 可能包含大量 K 线数据，超出 embedding 模型上下文限制。
   */
  skipMemorySearch?: boolean;
  /**
   * 跳过向 session 添加用户消息（step 4）。
   * 用于 loop session：task 消息已通过 session.addLoopTaskMessage() 预先注入，
   * 避免 runAgent 内部重复 addUserMessage。
   */
  skipAddUserMessage?: boolean;
  /**
   * 自动 fork 的时间阈值（毫秒）。超过该时间后，每批工具执行完毕即触发 auto-fork。
   * 默认 120_000（2 分钟）。设为 0 可禁用 auto-fork。
   */
  autoForkThresholdMs?: number;
  /**
   * 额外注入给 LLM 的工具列表（追加到 getAllToolSpecs() 之后）。
   * 用于向特定 Agent（如 daily subagent）暴露 hidden 工具（ask_master / run_code_subagent 等）。
   */
  customTools?: import("openai/resources/chat/completions").ChatCompletionTool[];
  /**
   * 覆盖 llmRegistry 选出的 LLM client（cron 指定 model 时使用）。
   * 不传则走默认逻辑：code 模式用 code 后端，其余用 daily 后端。
   */
  overrideClient?: import("../llm/client.js").LLMClient;
  /**
   * ask_master 回调（由 code_assist 注入给 daily subagent）。
   * 透传到 ToolContext，供 ask_master 工具使用。
   */
  onAskMaster?: import("../tools/registry.js").ToolContext["onAskMaster"];
  /**
   * code subagent 调用函数（由 code_assist 注入给 daily subagent）。
   * 透传到 ToolContext，供 run_code_subagent 工具使用。
   */
  codeRunFn?: import("../tools/registry.js").ToolContext["codeRunFn"];
  /**
   * 跨 session 消息注入函数（由 main.ts 注入）。
   * 透传到 ToolContext，供 session_send 工具使用。
   */
  sessionSendFn?: import("../tools/registry.js").ToolContext["sessionSendFn"];
  /**
   * 跨 session 可见列表函数（由 main.ts 注入）。
   * 透传到 ToolContext，供 session_get 工具使用。
   */
  sessionGetFn?: import("../tools/registry.js").ToolContext["sessionGetFn"];
  /**
   * 覆盖本轮 X-Request-Id（/retry 命令传入上次失败的 requestId，避免服务端重复计费）。
   * 传入 streamChat 的 turnRequestIdOverride。
   */
  turnRequestIdOverride?: string;
  /**
   * 覆盖本次 run 的 X-Agent-Task-Id。
   * 供 restart 后续接原任务时复用，避免被服务端识别为新的任务。
   */
  agentTaskIdOverride?: string;
  /**
   * 将本次 run 的第 0 轮标记为 agent continuation，而非新的用户发起请求。
   * 供 restart 后续接已有 tool_result 时使用，避免额外消耗 premium request。
   */
  continueAsAgentRound?: boolean;
}

export interface AgentRunResult {
  content: string;
  /** 本次运行调用了哪些工具 */
  toolsUsed: string[];
}

/**
 * 单次 Agent 运行（一轮用户消息 → 完整响应）。
 * 支持多轮 tool_call（ReAct 循环），轮次上限由 tools.maxChatToolRounds 配置（0=无限制）。
 */
/** 生成工具调用的单行摘要，用于日志 */
function toolCallSummary(name: string, args: Record<string, unknown>): string {
  if (name === "exec_shell") {
    const cmd = String(args["command"] ?? "").replace(/\n/g, " ");
    return `${name}: ${cmd.slice(0, 80)}${cmd.length > 80 ? "…" : ""}`;
  }
  if (name === "write_file" || name === "read_file" || name === "delete_file" || name === "edit_file") {
    return `${name}: ${args["path"] ?? ""}`;
  }
  if (name === "cron_add") return `${name}: ${args["name"] ?? ""} (${args["schedule"] ?? ""})`;
  if (name === "cron_remove") return `${name}: ${args["id"] ?? ""}`;
  return name;
}

/**
 * Code 模式工具调用节流器：将每次工具调用汇总为每分钟一条通知，防止刷屏。
 * 每 FLUSH_INTERVAL_MS 毫秒 flush 一次（若有未发通知）；run 结束时调用 stop() 清理。
 */
class ToolCallThrottler {
  private static readonly FLUSH_INTERVAL_MS = 60_000;
  private count = 0;
  private names: Record<string, number> = {};
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly onFlush: (msg: string) => void;

  constructor(onFlush: (msg: string) => void) {
    this.onFlush = onFlush;
  }

  add(toolName: string): void {
    this.count++;
    this.names[toolName] = (this.names[toolName] ?? 0) + 1;
    // 首次调用时启动定时器
    if (this.timer === null) {
      this.timer = setInterval(() => this.flush(), ToolCallThrottler.FLUSH_INTERVAL_MS);
    }
  }

  private flush(): void {
    if (this.count === 0) return;
    const detail = Object.entries(this.names)
      .sort((a, b) => b[1] - a[1])
      .map(([name, n]) => (n > 1 ? `${name}×${n}` : name))
      .join("、");
    this.onFlush(`⚙️ 过去1分钟工具调用 ${this.count} 次（${detail}）`);
    this.count = 0;
    this.names = {};
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.flush(); // 最后 flush 剩余调用
  }
}

export async function runAgent(
  session: Session,
  userContent: string,
  opts: AgentRunOptions = {}
): Promise<AgentRunResult> {
  const isCodeMode = session.mode === "code";
  let client = opts.overrideClient ?? llmRegistry.get(isCodeMode ? "code" : "daily");

  // ── Premium 白名单守卫 ─────────────────────────────────────────────────────
  // slave session 继承 master 的鉴权上下文，不单独做白名单检查
  const isSlave = session.sessionId.startsWith("slave:");
  if (!isSlave) {
    const cfg = loadConfig();
    const allowlist = cfg.llm.premiumAllowlist;
    if (allowlist.enabled && allowlist.premiumModels.includes(client.model)) {
      const inSessionAllowlist = allowlist.allowedSessions.includes(session.sessionId);
      // codeOnly=true 时，仅 code 模式才可用高级模型；false 时 chat 也可以
      const modeAllowed = allowlist.codeOnly ? isCodeMode : true;
      const allowed = inSessionAllowlist && modeAllowed;
      if (!allowed) {
        const reason = inSessionAllowlist ? "非 code 模式" : "session 不在白名单";
        console.warn(
          `[premiumGuard] session=${session.sessionId} ${reason}，` +
          `降级 ${client.model} → ${allowlist.fallbackModel}`
        );
        const fallback = await buildFallbackClient();
        if (fallback) client = fallback;
      }
    }
  }
  // ── END Premium 白名单守卫 ─────────────────────────────────────────────────

  const toolsUsed: string[] = [];
  // slave session ID 格式为 "slave:abc12345",显示为 "[slave:abc12345]";其他 session 取末尾 12 位
  const sid = isSlave ? session.sessionId.slice("slave:".length) : session.sessionId.slice(-12);
  const logPrefix = isSlave ? `[slave:${sid}]` : `[agent] ${sid}`;
  const msgPreview = userContent.replace(/\n/g, " ").slice(0, 60);
  console.log(`${logPrefix} ← "${msgPreview}${userContent.length > 60 ? "…" : ""}"`);
  const startMs = Date.now();

  // code 模式工具调用节流：每分钟汇总一次通知
  const toolThrottler = (isCodeMode && opts.onNotify)
    ? new ToolCallThrottler((msg) => void opts.onNotify!(msg))
    : null;

  // ── 前置：重置并发控制状态，创建新 AbortController ───────────────────────
  session.abortRequested = false;
  session.mfaApprovedForThisRun = false;
  session.approvedOutOfBoundPaths = new Set();
  const llmAc = new AbortController();
  session.llmAbortController = llmAc;

  // 清理可能由上一次异常退出遗留的不完整工具调用链，防止 400 Bad Request 死循环
  session.sanitizeMessages();

  // 工具列表和模式在 system prompt 注入前确定（textMode 会影响 prompt 内容）
  // initialTools 快照用于 textMode 系统提示构建；ReAct 循环内每轮重新取最新快照
  // code 模式过滤 code_assist / code_assist_run（code 模式本身即代码助手）
  // 非 code 模式过滤 restart_tool（该工具仅 code 模式下有意义）
  // code 模式过滤 agent fork 系列（code 模式本身是子 agent，不应再向下 fork）
  const CODE_MODE_EXCLUDED = new Set([
    "code_assist", "code_assist_run", "skill_run",
    "agent_fork", "agent_status", "agent_wait", "agent_abort",
    // chat 专属记忆工具（code 模式用 code_note_read/code_note 替代）
    "memory_write_mem", "memory_write_active", "memory_read_mem",
    "memory_read_active", "memory_append_card", "memory_append",
  ]);
  const initialTools = getAllToolSpecs(session.agentId).filter((t) => {
    if (isCodeMode && CODE_MODE_EXCLUDED.has(t.function.name)) return false;
    if (!isCodeMode && t.function.name === "restart_tool") return false;
    return true;
  });
  const textMode = !client.supportsToolCalls;

  // preRunLength：连接失败时用于回滚本次注入的消息
  let preRunLength = session.getMessages().length;

  if (!opts.skipPreamble) {
    // 1. 每次 run 都刷新 system prompt（替换已有的，或首次插到最前）
    // 这样配置变更、能力更新（如 supportsVision）和 session 恢复后都能生效
    {
      let sysPrompt: string;
      if (isCodeMode) {
        // code 模式：使用代码专注 prompt，忽略 MEM.md / SKILLS.md / 用户自定义 prompt
        sysPrompt = buildCodeSystemPrompt(session.agentId, client.supportsVision, "plan", session.codeWorkdir ?? undefined, session.sessionId);
      } else {
        sysPrompt = buildSystemPrompt(session.agentId, opts.systemPrompt, client.supportsVision, opts.systemPromptSuffix);
      }
      if (textMode && initialTools.length > 0) {
        sysPrompt += "\n\n" + buildTextBasedToolInstructions(initialTools);
      }
      session.replaceOrPrependSystemMessage(sysPrompt);
    }

    // system prompt 刷新后更新回滚点
    preRunLength = session.getMessages().length;

    // 2. 搜索相关历史记忆，注入为 system 消息（code 模式跳过，null = 未启用，"" = 无结果）
    if (!isCodeMode && !opts.skipMemorySearch) {
      const memoryContext = await searchMemory(userContent, session.agentId);
      if (memoryContext) {
        session.replaceOrAddMemoryContext(memoryContext);
      }
    }

    // 2.3 Skill Reminder:每轮注入可用技能列表（chat 模式 + 非 slave）
    if (!isCodeMode && !isSlave) {
      const reminder = buildSkillReminder(session.agentId);
      if (reminder) {
        session.replaceOrAddSkillReminder(reminder);
      }
    }

    // 2.5 MicroCompact：截断几轮前过长的 tool 结果（chat + code 均触发，不走 LLM）
    // 在 pre-flight 压缩之前执行，降低 token 水位，减少触发全量压缩的频率
    {
      const mcCtx = isCodeMode
        ? llmRegistry.getContextWindow("code")
        : llmRegistry.getContextWindow("daily");
      session.microCompact(mcCtx, session.lastPromptTokens);
    }

    // 3. Pre-flight 压缩：在添加用户消息前检测 session 是否已超阈值
    // 防止上次 run 结束后 session 继续膨胀，导致本次首次 LLM 调用直接 408
    // 优先使用上一轮实际 promptTokens（session.lastPromptTokens），0 时 fallback 字符估算
    if (!session.abortRequested) {
      if (!isCodeMode && shouldSummarize(session.getMessages(), session.lastPromptTokens)) {
        // chat 模式：完整摘要压缩
        opts.onCompress?.("start");
        const summary = await session.compress();
        opts.onCompress?.("done", summary);
        // 压缩后更新回滚点（压缩已清空历史，只剩 system + 摘要）
        preRunLength = session.getMessages().length;
      } else if (isCodeMode) {
        // code 模式：pre-flight 检测 session 是否已超限（如上次 run 400 后 session 未清理）
        // 用 lastPromptTokens（API 实测值）或字符估算进行判断；若超限则先压缩再执行
        const codeCtx = llmRegistry.getContextWindow("code");
        const exceedsWindowThreshold = codeCtx > 0 && shouldSummarizeCode(session.getMessages(), codeCtx, session.lastPromptTokens);
        if (exceedsWindowThreshold) {
          console.log(`${logPrefix} ℹ️ Code session pre-flight：上下文超限，执行滑动窗口压缩`);
          await session.compressForCode();
          preRunLength = session.getMessages().length;
        }
      }
    }

    // 4. 添加用户消息（若模型支持视觉且消息含图片，转为 ContentPart[] 格式）
    if (!opts.skipAddUserMessage) {
      const sanitizedContent = sanitizeUserInput(userContent);
      const msgContent = client.supportsVision ? buildVisionContent(sanitizedContent) : sanitizedContent;
      session.addUserMessage(msgContent);
    }
  }

  let finalContent = "";
  let codeAssistCallCount = 0;
  let lastUsage: ChatResult["usage"] = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  // 文字模式格式纠错标记：true = 已注入纠错提示并重试，再次失败则直接返回原始输出
  let formatRetryPending = false;

  // 轮次上限：0 = 无限制（用 Infinity 表示）；chat/cron 模式读取 maxChatToolRounds，code 模式读取 maxCodeToolRounds
  const configuredRounds = isCodeMode
    ? loadConfig().tools.maxCodeToolRounds
    : (loadConfig().tools.maxChatToolRounds ?? MAX_TOOL_ROUNDS);
  const maxToolRounds = configuredRounds === 0 ? Infinity : configuredRounds;
  // code 模型 context window（供 token 预算检查用）
  const codeContextWindow = isCodeMode ? llmRegistry.getContextWindow("code") : 0;

  // 5. ReAct 循环
  // 每次用户消息生成一个固定 taskId，供所有 round 共享 X-Agent-Task-Id。
  // Copilot 服务端据此将整次 agent 运行识别为同一任务，只对首轮（X-Initiator: user）计费。
  const agentTaskId = opts.agentTaskIdOverride ?? crypto.randomUUID();
  session.currentAgentTaskId = agentTaskId;
  let promptExceededRetried = false;  // guard: compress+retry at most once per run
  for (let round = 0; round < maxToolRounds; round++) {
    // 每轮重新获取工具快照，保证 mcp_enable_server 后新工具在本轮就生效
    // code 模式本身就是代码助手，无需 code_assist / code_assist_run（避免递归委派）
    // 非 code 模式不暴露 restart_tool；code 模式排除 agent fork 系列
    const tools = [
      ...getAllToolSpecs(session.agentId).filter((t) => {
        if (isCodeMode && CODE_MODE_EXCLUDED.has(t.function.name)) return false;
        if (!isCodeMode && t.function.name === "restart_tool") return false;
        return true;
      }),
      ...(opts.customTools ?? []),
    ];

    // ── 轮间压缩（chat 模式）：tool result 可能使 session 在循环中间超限 → 提前压缩避免 408 ──
    // round 0 不需要检查（pre-flight 已处理），从 round 1 起才有 tool results 写入
    if (round > 0 && !isCodeMode && !session.abortRequested
        && shouldSummarize(session.getMessages(), session.lastPromptTokens)) {
      console.log(`${logPrefix} ℹ️ Chat session 轮间检测到上下文超限（round ${round}），执行压缩`);
      opts.onCompress?.("start");
      await session.compress();
      opts.onCompress?.("done");
      // 压缩后更新 preRunLength：指向当前 user 消息位置，确保后续 LLM 失败时回滚正确
      const msgsAfterCompress = session.getMessages();
      for (let i = msgsAfterCompress.length - 1; i >= 0; i--) {
        if (msgsAfterCompress[i]?.role === "user") {
          preRunLength = i;
          break;
        }
      }
    }

    // ── LLM 调用（流式，支持 AbortSignal + 心跳）────────────────────────
    let response: ChatResult;
    {
      const heartbeatSecs = loadConfig().agent.heartbeatIntervalSecs;
      let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
      const roundStart = Date.now();

      if (heartbeatSecs > 0 && opts.onHeartbeat) {
        heartbeatTimer = setInterval(() => {
          const elapsed = Math.round((Date.now() - roundStart) / 1000);
          opts.onHeartbeat!(`⏳ Agent 仍在处理中，请稍候…（已用时 ${elapsed}s）`);
        }, heartbeatSecs * 1000);
      }

      // ── 并发限流：等待空闲 LLM slot（FIFO 排队）────────────────────────
      // 工具执行期间不占用 slot，仅在真正发起 LLM 请求时持有。
      // slotHeld 追踪当前是否持有 slot，防止 onRetryWait 和 finally 双重 release。
      let slotHeld = false;
      try {
        await acquireLLMSlot(llmAc.signal);
        slotHeld = true;
      } catch (err) {
        // acquire 被 AbortSignal 中断（软中断打断等待）
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        break;
      }

      let streamBytes = 0;
      try {
        response = await client.streamChat(
          session.getMessagesForLLM(),
          (delta) => {
            opts.onChunk?.(delta);
            streamBytes += Buffer.byteLength(delta, "utf8");
            const kb = (streamBytes / 1024).toFixed(1);
            process.stdout.write(`\r${logPrefix} ▶ ${kb} KB`);
          },
          {
            ...(tools.length > 0 && client.supportsToolCalls
              ? { tools, tool_choice: "auto" }
              : {}),
            signal: llmAc.signal,
            isUserInitiated: round === 0 && !opts.skipPreamble && !opts.continueAsAgentRound,
            taskId: agentTaskId,
            _retryHooks: {
              onRetryWait: () => {
                // 进入重试等待：归还 slot，其他请求可趁机推进
                if (slotHeld) { releaseLLMSlot(); slotHeld = false; }
              },
              onRetryResume: async () => {
                // 重试等待结束：重新排队获取 slot（若 abort 则 throw）
                await acquireLLMSlot(llmAc.signal);
                slotHeld = true;
              },
            },
            // code 模式：首 chunk 后禁用 idle timeout（长代码生成 token 间隔可 >60s）
            ...(isCodeMode ? { disableIdleAfterFirstChunk: true } : {}),
            // /retry 命令传入的 requestId override（首轮才有意义）
            ...(round === 0 && opts.turnRequestIdOverride ? { turnRequestIdOverride: opts.turnRequestIdOverride } : {}),
          }
        );
        // 清除流式进度行，后续日志正常换行输出
        if (streamBytes > 0) process.stdout.write(`\r\x1b[K`);
      } catch (err) {
        // 确保进度行被清除
        if (streamBytes > 0) process.stdout.write(`\r\x1b[K`);
        // AbortError = 被软中断打断，干净退出循环
        if (err instanceof Error && (err.name === "AbortError" || err.message.includes("abort"))) {
          break;
        }
        // 400 model_max_prompt_tokens_exceeded：压缩上下文后重试本轮（最多1次）
        if (
          !promptExceededRetried &&
          err instanceof APIError &&
          err.status === 400 &&
          (err as APIError & { code?: string }).code === "model_max_prompt_tokens_exceeded"
        ) {
          promptExceededRetried = true;
          console.warn(`${logPrefix} ⚠️ Prompt tokens 超限，压缩后重试...`);
          const compressed = await session.compressForCode();
          if (!compressed) {
            // 压缩无效（历史已最短），回滚并抛出
            session.trimToLength(preRunLength);
            toolThrottler?.stop();
            throw err;
          }
          round--;  // 重新执行本轮
          continue;
        }
        // LLM 调用失败（连接错误、400/500、限流等）：回滚本次注入的消息，保持 session 状态干净
        if (err instanceof LLMConnectionError && err.requestId) {
          // 保存失败请求的 X-Request-Id 和原始用户消息内容，供 /retry 命令复用
          // trimToLength 会回滚用户消息，userContent 需另行保存以便 /retry 重新添加
          session.lastFailedRequestId = err.requestId;
          session.lastFailedUserContent = userContent;
        }
        session.trimToLength(preRunLength);
        toolThrottler?.stop();
        throw err;
      } finally {
        // LLM 请求已结束（无论成功/失败），释放 slot（若尚未被 onRetryWait 释放）
        if (slotHeld) { releaseLLMSlot(); slotHeld = false; }
        if (heartbeatTimer) clearInterval(heartbeatTimer);
      }
    }

    lastUsage = response.usage;
    // 记录到 session，供 /status 展示实际 token 用量
    session.lastPromptTokens = lastUsage.promptTokens;
    Session.persistPromptTokens(session.sessionId, session.mode === "code" ? "code" : "chat", lastUsage.promptTokens);

    // ── Code 模式：调用后 Token 预算检查（用实际 promptTokens，比估算更准确）──
    // 放在 LLM 调用后，此时 lastPromptTokens 已是本轮真实值
    if (isCodeMode && !session.abortRequested) {
      // 实际值为 0（极少见）时 fallback 到字符估算
      const actualTokens = session.lastPromptTokens > 0 ? session.lastPromptTokens : session.estimatedTokens();
      if (codeContextWindow > 0) {
        const usageRatio = actualTokens / codeContextWindow;
        if (usageRatio >= CODE_CONTEXT_WARN_THRESHOLD) {
          console.log(`${logPrefix} ⚠️ Code context 已达 ${Math.round(usageRatio * 100)}%（实际 ${actualTokens} tokens），尝试滑动窗口压缩`);
          const compressed = await session.compressForCode();
          if (compressed) {
            console.log(`${logPrefix} ✅ 压缩完成，消息数：${session.getMessages().length}`);
            void opts.onNotify?.("⚠️ 上下文已接近上限，已自动压缩历史记录以继续执行。");
          } else {
            console.log(`${logPrefix} ⚠️ 压缩无效果（轮次不足或已最小化），上下文可能继续增长`);
          }
        } else if (usageRatio >= 0.75) {
          console.log(`${logPrefix} ℹ️ Code context 已达 ${Math.round(usageRatio * 100)}%（实际 ${actualTokens} tokens），静默压缩`);
          await session.compressForCode();
        }
      }
      // (post-call 绝对 token 数阈值压缩已移除：headers 修复后无 60s 超时，由正常滑动窗口处理)
    }

    const { content, toolCalls } = parseResponse(response, textMode);

    // ── 格式纠错：检测格式错误并重提示（最多 1 次，不限 textMode）──────────
    // 根因：supportsToolCalls 默认 true → textMode=false，但模型仍可能输出裸 JSON
    if (!toolCalls || toolCalls.length === 0) {
      if (formatRetryPending) {
        // 已纠错一次，模型仍未使用正确格式 → 直接把原始输出返回给用户
        console.log(
          `${logPrefix} ❌ 格式纠错重试仍失败（textMode=${textMode}），返回原始输出：` +
          content.slice(0, 60).replace(/\n/g, " ") + (content.length > 60 ? "…" : "")
        );
        finalContent = content;
        session.addAssistantMessage(finalContent);
        formatRetryPending = false;
        break;
      }
      // 判断是否疑似工具调用尝试（以 { 开头，或含常见工具调用关键词）
      const trimmedContent = content.trim();
      const looksLikeToolAttempt =
        trimmedContent.startsWith("{") ||
        /"(tool|function|exec_shell|tool_call)"\s*:/.test(trimmedContent);
      if (looksLikeToolAttempt) {
        console.log(
          `${logPrefix} ⚠️ 格式错误：无 tool_call（textMode=${textMode}，round=${round}），` +
          `内容：${trimmedContent.slice(0, 60).replace(/\n/g, " ")}${trimmedContent.length > 60 ? "…" : ""}`
        );
        console.log(`${logPrefix} ⚠️ 注入格式纠错提示，重试本轮`);
        session.addAssistantMessage(content);
        session.addSystemMessage(
          "[格式纠错] 工具调用格式不正确。请严格使用以下格式，整条回复只包含此块，不附加任何其他文字：\n" +
          "<tool_call>\n" +
          '{"name": "工具名", "args": {"参数名": "值"}}\n' +
          "</tool_call>"
        );
        formatRetryPending = true;
        continue;
      }
    }
    // 成功解析到工具调用（含纠错后成功）→ 重置纠错标记，后续轮次仍可纠错
    if (toolCalls && toolCalls.length > 0) {
      if (formatRetryPending) {
        console.log(`${logPrefix} ✅ 格式纠错成功（round=${round}）`);
      }
      formatRetryPending = false;
    }

    // 没有工具调用 → 最终回复
    if (!toolCalls || toolCalls.length === 0) {
      finalContent = content;
      session.addAssistantMessage(finalContent);
      break;
    }

    // 有工具调用 → 执行并将结果追加到 messages
    // function calling 模式：assistant 消息需携带 tool_calls 数组（供 API 匹配 tool_call_id）
    // 文本模式：普通 assistant 消息即可
    // 过滤掉 null/undefined（LLM 返回稀疏 index 时可能出现），避免孤立 tool_call_id
    const validToolCalls = toolCalls.filter(Boolean);
    if (!textMode) {
      session.addAssistantWithToolCalls(content || "", validToolCalls);
    } else {
      session.addAssistantMessage(content || "");
    }

    // ── 工具执行（支持批量并发）────────────────────────────────────────────
    //
    // 并发策略：
    //   - 需要用户交互的工具（ask_user / ask_master / notify_user / MFA 工具）必须串行
    //   - code_assist 需要维护调用计数器，必须串行
    //   - agent_fork / run_code_subagent 涉及子 agent 状态，必须串行
    //   - 其余只读/幂等工具（exec_shell、read_file、mcp_*、search_store 等）可并发
    //
    // 并发执行时，结果按原始顺序写入 session，保证 function calling 模式下
    // tool_call_id 与 assistant.tool_calls[] 的顺序严格对应。
    //
    // 并发分批：遇到必须串行的工具时，先 flush 前面积累的并发批次，
    // 再串行执行该工具，然后继续下一批。
    // ─────────────────────────────────────────────────────────────────────────
    const SERIAL_TOOLS = new Set([
      "ask_user", "ask_master", "notify_user", "send_report", "render_diagram",
      "code_assist", "code_assist_run",
      "agent_fork", "run_code_subagent",
      "exit_plan_mode",
      "create_skill",
      "session_send",
      "restart_tool",  // 触发 process.exit，必须串行且需提前写 tool result
    ]);

    /**
     * 执行单个工具调用，返回结果字符串（已截断）。
     * 不写 session，仅返回结果供上层按顺序写入。
     */
    const runOneTool = async (call: (typeof validToolCalls)[number]): Promise<string> => {
      const toolDef = getTool(call.name);
      if (!toolDef) return "未知工具";

      console.log(`${logPrefix} tool: ${toolCallSummary(call.name, call.args)}`);
      if (call.name !== "notify_user") {
        toolThrottler?.add(call.name);
      }

      let result: string;
      const currentDepth = opts.slaveDepth ?? 0;
      try {
        result = await executeTool(call.name, call.args, {
          cwd: (isCodeMode && session.codeWorkdir) ? session.codeWorkdir : agentManager.workspaceDir(session.agentId),
          sessionId: session.sessionId,
          agentId: session.agentId,
          masterSession: session,
          ...(!textMode && call.callId ? { currentCallId: call.callId } : {}),  // function calling 模式下注入 callId，供 restart_tool 等在 process.exit 前写 tool result
          ...(currentDepth < MAX_SLAVE_DEPTH
            ? { slaveRunFn: (s, c, o) => runAgent(s, c, { ...o, slaveDepth: currentDepth + 1, ...(opts.onNotify ? { onNotify: opts.onNotify } : {}) }) }
            : {}),
          ...(opts.onSlaveComplete ? { onSlaveComplete: opts.onSlaveComplete } : {}),
          ...(opts.onProgressNotify ? { onProgressNotify: opts.onProgressNotify } : {}),
          ...(opts.onNotify ? { onNotify: opts.onNotify } : {}),
          ...(opts.onPlanRequest ? { onPlanRequest: opts.onPlanRequest } : {}),
          ...(opts.onAskUser ? { onAskUser: opts.onAskUser } : {}),
          ...(opts.onMFARequest ? { onMFARequest: opts.onMFARequest } : {}),
          ...(opts.onAskMaster ? { onAskMaster: opts.onAskMaster } : {}),
          ...(opts.codeRunFn ? { codeRunFn: opts.codeRunFn } : {}),
          ...(opts.sessionSendFn ? { sessionSendFn: opts.sessionSendFn } : {}),
          ...(opts.sessionGetFn ? { sessionGetFn: opts.sessionGetFn } : {}),
        });
      } catch (err) {
        if (err instanceof MFAError) {
          result = `操作被取消：${err.message}`;
        } else {
          result = `工具执行错误：${err instanceof Error ? err.message : String(err)}`;
        }
      }

      // 工具结果截断
      const maxResultChars = loadConfig().tools.maxToolResultChars;
      if (maxResultChars > 0 && result.length > maxResultChars) {
        result = result.slice(0, maxResultChars) +
          `\n\n[内容过长，已截断。原始长度 ${result.length} 字符，保留前 ${maxResultChars} 字符。如需查看更多请缩小范围重新调用。]`;
      }
      return result;
    };

    /** 将 (call, result) 列表按顺序写入 session */
    const flushResults = (pairs: Array<{ call: (typeof validToolCalls)[number]; result: string }>) => {
      for (const { call, result } of pairs) {
        if (!textMode) {
          // read_image tool 返回 data URL 时，改用路径引用存储，避免 base64 写入 JSONL
          // 从 call.args 取原始路径，tool result 存路径占位，注入 image_path 供 resolveMessagesForApi 按需编码
          if (call.name === "read_image" && result.startsWith("data:image/")) {
            const origPath = String((call.args as Record<string, unknown>)["path"] ?? "");
            session.addToolResultMessage(call.callId, origPath ? `[图片已加载: ${origPath}]` : result);
            if (origPath) {
              session.addUserMessage([{ type: "image_path", path: origPath }]);
            }
          } else {
            session.addToolResultMessage(call.callId, result);
          }
        } else {
          session.addSystemMessage(`[tool_result:${call.name}]\n${result}`);
        }
      }
    };

    // 积累并发批次，遇到串行工具时先 flush 再串行执行
    let concurrentBatch: (typeof validToolCalls)[number][] = [];

    const flushConcurrentBatch = async () => {
      if (concurrentBatch.length === 0) return;
      const batch = concurrentBatch;
      concurrentBatch = [];
      if (batch.length === 1) {
        // 单个工具无需 Promise.all 开销
        const result = await runOneTool(batch[0]!);
        flushResults([{ call: batch[0]!, result }]);
      } else {
        // 并发执行，结果按原始顺序收集
        const results = await Promise.all(batch.map(c => runOneTool(c)));
        flushResults(batch.map((call, i) => ({ call, result: results[i]! })));
      }
    };

    for (const call of validToolCalls) {
      // ── 软中断检测 ────────────────────────────────────────────────────
      if (session.abortRequested) {
        await flushConcurrentBatch();
        if (!textMode) {
          session.addToolResultMessage(call.callId, "操作被用户新消息中断，此工具调用未执行");
        } else {
          session.addSystemMessage(`[tool_result:${call.name}]\n操作被用户新消息中断，此工具调用未执行`);
        }
        continue;
      }

      const toolDef = getTool(call.name);
      if (!toolDef) {
        await flushConcurrentBatch();
        if (!textMode) {
          session.addToolResultMessage(call.callId, "未知工具");
        } else {
          session.addSystemMessage(`[tool_result:${call.name}]\n未知工具`);
        }
        continue;
      }

      toolsUsed.push(call.name);

      // ── code_assist 调用次数限制（串行处理）──────────────────────────
      if (call.name === "code_assist") {
        await flushConcurrentBatch();
        const maxCalls = loadConfig().tools.code_assist.maxCallsPerRun;
        if (maxCalls > 0 && codeAssistCallCount >= maxCalls) {
          const msg = `已达本次最大调用次数（${maxCalls}），此次调用未执行。请在当前回复中告知用户任务状态，用户可发新消息继续。`;
          if (!textMode) session.addToolResultMessage(call.callId, msg);
          else session.addSystemMessage(`[tool_result:${call.name}]\n${msg}`);
          continue;
        }
        codeAssistCallCount++;
      }

      // ── MFA 检查（需要用户交互，先 flush 并发批次再串行）────────────
      const mfaCfg = loadConfig().auth.mfa;
      if (toolNeedsMFA(call.name, call.args, mfaCfg) && !session.mfaApprovedForThisRun && !session.mfaPreApproved) {
        await flushConcurrentBatch();
        let mfaPassed = false;
        try {
          if (mfaCfg?.interface === "msal") {
            await requireMFA(opts.onMFAPrompt);
            opts.onMFAPrompt?.("✓ MFA 已通过，继续执行");
            mfaPassed = true;
          } else if (mfaCfg?.interface === "totp") {
            if (opts.onMFARequest) {
              const desc = describeToolCall(call.name, call.args);
              const secretPath = mfaCfg.totpSecretPath;
              mfaPassed = await opts.onMFARequest(
                `⚠️ 即将执行：${desc}\n请打开 Authenticator App，将当前 6 位验证码回复给我（30 秒内有效）`,
                (code: string) => verifyTOTP(code, secretPath)
              );
              if (!mfaPassed) opts.onMFAPrompt?.("✗ TOTP 验证失败，操作已取消");
            } else {
              mfaPassed = true;
            }
          } else if (opts.onMFARequest) {
            const desc = describeToolCall(call.name, call.args);
            mfaPassed = await opts.onMFARequest(`⚠️ 即将执行：${desc}\n请回复 确认 / 取消`);
            if (!mfaPassed) opts.onMFAPrompt?.("✗ MFA 被拒绝，操作已取消");
          } else {
            mfaPassed = true;
          }
        } catch {
          const msg = "操作被取消：MFA 未通过";
          if (!textMode) session.addToolResultMessage(call.callId, msg);
          else session.addSystemMessage(`[tool_result:${call.name}]\n${msg}`);
          continue;
        }

        if (!mfaPassed) {
          const msg = "操作被取消：用户拒绝了 MFA 确认";
          if (!textMode) session.addToolResultMessage(call.callId, msg);
          else session.addSystemMessage(`[tool_result:${call.name}]\n${msg}`);
          continue;
        }
        session.mfaApprovedForThisRun = true;
      }

      // ── 分类：串行工具先 flush 再单独执行；其余加入并发批次 ──────────
      if (SERIAL_TOOLS.has(call.name)) {
        await flushConcurrentBatch();
        const result = await runOneTool(call);
        flushResults([{ call, result }]);
      } else {
        concurrentBatch.push(call);
      }

      // 工具执行完毕后再次检查 abort
      if (session.abortRequested) {
        await flushConcurrentBatch();
        break;
      }
    }

    // flush 最后一批并发工具
    await flushConcurrentBatch();

    // 一整批工具处理完，若已中断则退出轮次循环
    if (session.abortRequested) break;

    // ── Auto-fork 检查：超过阈值时将剩余任务交给 Slave 继续执行 ──────────
    // Code 模式是有状态的交互会话（工作区、plan 子模式等），不应 auto-fork
    {
      const threshold = opts.autoForkThresholdMs ?? AUTO_FORK_THRESHOLD_MS;
      if (
        threshold > 0 &&
        !isSlave &&
        !isCodeMode &&
        (opts.slaveDepth ?? 0) === 0 &&
        opts.onSlaveComplete !== undefined &&
        Date.now() - startMs > threshold
      ) {
        const continuationRunFn = (s: Session, c: string, o?: Record<string, unknown>) =>
          runAgent(s, c, { ...(o as AgentRunOptions), slaveDepth: 1, ...(opts.onNotify ? { onNotify: opts.onNotify } : {}) });
        const slaveId = slaveManager.forkContinuation(
          session,
          continuationRunFn,
          opts.onSlaveComplete,
          opts.onProgressNotify,
        );
        finalContent =
          `⏱️ 任务已运行超过 ${Math.round(threshold / 60_000)} 分钟，` +
          `已自动在后台创建 Sub-Agent \`${slaveId}\` 继续执行。\n` +
          `您可以继续提问，任务完成后将自动通知您。\n` +
          `用 \`agent_status(slave_id="${slaveId}")\` 查询进度。`;
        session.addAssistantMessage(finalContent);
        break;
      }
    }

    // 最后一轮，强制用 LLM 生成总结（注入系统提示告知已达轮次上限）
    if (round === maxToolRounds - 1) {
      const summaryMessages = [
        ...session.getMessagesForLLM(),
        {
          role: "system" as const,
          content:
            "[系统] 已达本次最大工具调用轮次上限，无法继续调用工具。" +
            "请在此回复中：\n" +
            "1. 总结本次已完成的工作内容；\n" +
            "2. 列出尚未完成的任务；\n" +
            "3. 告知用户可以发送新消息（如「继续」）以继续执行。\n" +
            "请勿调用任何工具。",
        },
      ];
      try {
        const summary = await client.chat(summaryMessages, {
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

  // 5. JSONL 持久化：各消息在 addUserMessage / addAssistantMessage 等调用时已逐条写入，无需在此重复。

  // 6. 检查是否需要压缩（工具调用后 session 继续增长，此处再次检查；code 模式跳过）
  // 使用最后一轮实际 promptTokens（比字符估算更准确）
  if (!session.abortRequested && !isCodeMode) {
    if (shouldSummarize(session.getMessages(), lastUsage.promptTokens)) {
      opts.onCompress?.("start");
      const summary = await session.compress();
      opts.onCompress?.("done", summary);
    }
  }

  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  const contextWindow = llmRegistry.getContextWindow(isCodeMode ? "code" : "daily");
  const fmtK = (n: number) => n >= 1000 ? `${Math.floor(n / 1000)}k` : String(n);
  const tokenInfo = `${fmtK(lastUsage.promptTokens)}/${fmtK(contextWindow)}`;
  if (toolsUsed.length > 0) {
    console.log(`${logPrefix} → done in ${elapsed}s (tools: ${[...new Set(toolsUsed)].join(", ")}) [${tokenInfo}]`);
  } else {
    console.log(`${logPrefix} → done in ${elapsed}s [${tokenInfo}]`);
  }

  // flush 剩余工具调用通知，清理定时器
  toolThrottler?.stop();

  // ── Chat 模式轻量 diary 更新（每 3 轮触发一次，fire-and-forget） ──────────
  // 仿 CC postSamplingHook：对话进行中持续维护 diary，无需等 context 满才压缩
  const CHAT_DIARY_EVERY_N = 3;
  if (!isCodeMode && !isSlave && (opts.slaveDepth ?? 0) === 0) {
    if (session.chatTurnCount > 0 && session.chatTurnCount % CHAT_DIARY_EVERY_N === 0) {
      const msgs = session.getMessages();
      // 找最后一条 user 消息和最后一条无 tool_calls 的 assistant 消息
      let lastUser: (typeof msgs)[number] | undefined;
      let lastAssistant: (typeof msgs)[number] | undefined;
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i]!;
        if (!lastAssistant && m.role === "assistant") {
          const calls = (m as { role: "assistant"; tool_calls?: unknown[] }).tool_calls;
          if (!calls || calls.length === 0) lastAssistant = m;
        }
        if (!lastUser && m.role === "user") lastUser = m;
        if (lastUser && lastAssistant) break;
      }
      if (lastUser && lastAssistant) {
        distillTurnToDiary(lastUser, lastAssistant, session.agentId).catch((err) =>
          console.warn("[agent] chat diary distill failed:", err instanceof Error ? err.message : err)
        );
      }
    }
  }

  // ── Code 模式：执行日志追加到 PLAN.md ────────────────────────────────────
  // 仅在 code 模式、有工具调用、非 slave 时触发，异步追加不阻塞返回
  if (isCodeMode && toolsUsed.length > 0 && !isSlave) {
    try {
      const planPath = agentManager.codePlanPath(session.agentId, session.sessionId);
      const { mkdirSync, appendFileSync, existsSync } = await import("node:fs");
      const { dirname } = await import("node:path");
      if (existsSync(planPath)) {
        mkdirSync(dirname(planPath), { recursive: true });
        const now = new Date();
        const hms = now.toTimeString().slice(0, 8);
        const uniqueTools = [...new Set(toolsUsed)].join(", ");
        appendFileSync(planPath, `- [${hms}] 本轮工具：${uniqueTools}\n`, "utf-8");
      }
    } catch (err) {
      console.warn("[agent] PLAN.md 执行日志追加失败:", err instanceof Error ? err.message : err);
    }
  }

  return { content: finalContent, toolsUsed };
}

// ── tool_call 解析 ────────────────────────────────────────────────────────────

interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  /** function calling 模式下 LLM 分配的唯一 ID，用于 tool_call_id 匹配；文本模式为空字符串 */
  callId: string;
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
        toolCalls: result.toolCalls.map((tc) => ({ name: tc.name, args: tc.args, callId: tc.callId })),
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
          callId: "",  // 文本模式无 ID
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
