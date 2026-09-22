import { detectPromptInjection } from "../security/injection-detector.js";
import { Session } from "./session.js";
import { AgentEventBus, resolveEventBus, type AgentEventSink } from "./agent-events.js";
import { llmRegistry, buildFallbackClient } from "../llm/registry.js";
import { LLMConnectionError, pathToDataUrlCompressed } from "../llm/client.js";
import { APIError } from "openai";
import type { ChatResult } from "../llm/client.js";
import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { acquireLLMSlot, releaseLLMSlot } from "../llm/concurrency.js";
import { searchMemory } from "../memory/qmd.js";
import { appendTranscript } from "../memory/transcript.js";
import { shouldSummarize, shouldSummarizeCode, distillTurnToDiary } from "../memory/summarizer.js";
import { getAllToolSpecs, getTool, executeTool, setBuiltinAgentFilter } from "../tools/registry.js";
import {
  injectPurposeParam,
  normalizePurpose,
  stripReservedArgs,
} from "../tools/reserved-args.js";
import { createPurposeArbiter } from "./purpose-arbiter.js";
import { MFAError, toolNeedsMFA } from "../auth/guard.js";
import { auditToolCall, enforceUnattendedTool, unattendedMfaFallback } from "../auth/tool-policy.js";
import type { RunOrigin } from "../security/audit.js";
import {
  argsAreWithinOwnScope,
  isSelfAccessGranted,
  runtimeRoot,
} from "../tools/path-guard.js";
import { PlanAbortError } from "../core/session.js";
import { requireMFA } from "../auth/mfa.js";
import { verifyTOTP } from "../auth/totp.js";
import { loadConfig } from "../config/loader.js";
import { insertMetric, isMetricKeyAllowed, addMetricKey, insertTokenBreakdown, insertTokenUsageOnly } from "../web/backend/db.js";
import { breakdownMessages, classifyTokenSource } from "../memory/token-estimate.js";
import { detectReasoningRepetition, emptyReplyNudge } from "../llm/reasoning-guard.js";
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { isAbsolute, resolve as resolvePath } from "path";
import { agentManager } from "./agent-manager.js";
import { slaveManager } from "./slave-manager.js";
import { buildCodeSystemPrompt } from "../code/system-prompt.js";
import { buildProjectSystemPrompt, loadProjectContext } from "../code/project-prompt.js";
import { readFeedback, FEEDBACK_INJECT_MAX_CHARS } from "./feedback-writer.js";
import { sanitizeUserInput } from "../tools/sanitize.js";
import {
  isPromptIntegrityActive,
  verifyPromptBaseline,
  injectCanary,
  checkCanary,
  stripCanary,
  PromptIntegrityError,
} from "../auth/prompt-integrity.js";
import { skillRegistry } from "../skills/registry.js";
import {
  ensureWorkspaceInstructionsBaseline,
  pushWorkspaceInstructionDeltas,
  WORKSPACE_TOUCHING_TOOLS,
} from "../instructions/workspace-prompt.js";

// 确保所有工具在模块加载时注册
import "../tools/system.js";
import "../tools/fs-search.js";
import "../tools/cron.js";
import "../tools/skill-creator.js";
import "../tools/skill-run.js";
import "../tools/mcp-manager.js";
import "../tools/mcp-admin.js";
import { mcpManager } from "../mcp/client.js";
import "../tools/agent-fork.js";
import "../tools/notify.js";
import "../tools/send-report.js";
import "../tools/release-file.js";
import "../tools/render-diagram.js";
import "../tools/search-store.js";
import "../tools/search-newsnow.js";
import "../tools/read-url.js";
import "../tools/ask-user-tool.js";
import "../tools/memory.js";
import "../tools/self-status.js";
import "../tools/self-runtime.js";
import "../tools/fs-grant-tool.js";
import "../tools/session-bridge.js";
import "../tools/http-request.js";
import "../tools/web-search.js";
import "../tools/restart.js";
import { buildVisionContent } from "../connectors/utils/media-parser.js";

// 注册内置工具的 per-agentId 黑/白名单过滤回调（模块加载时执行一次）
// 读取 ~/.tinyclaw/agents/<id>/tools.toml，对非 mcp_ 工具应用黑/白名单过滤

/**
 * 当主模型不支持视觉时，用 vision 后端对图片做单轮描述，返回文字描述。
 * 解析失败时返回 null。
 */
/**
 * 用 vision client 链（主模型 + fallbacks）依序识别图片。
 * 某个 client 遇到 429/RPD超限/网络错误时自动切到下一个，全部失败返回 null。
 */
async function describeImageWithVisionFallback(
  imgPath: string,
  visionClientOrChain:
    import("../llm/registry.js").AnyLLMClient | import("../llm/registry.js").AnyLLMClient[],
  customPrompt?: string
): Promise<{ description: string; usage: ChatResult["usage"] } | null> {
  const chain = Array.isArray(visionClientOrChain) ? visionClientOrChain : [visionClientOrChain];
  const nodeFs = await import("fs");
  const path = await import("path");
  const os = await import("os");
  const resolved = path.resolve(imgPath.replace(/^~/, os.homedir()));
  if (!nodeFs.existsSync(resolved)) return null;
  const ext = path.extname(resolved).toLowerCase().slice(1);
  const mime =
    ext === "jpg" || ext === "jpeg"
      ? "image/jpeg"
      : ext === "png"
        ? "image/png"
        : ext === "gif"
          ? "image/gif"
          : ext === "webp"
            ? "image/webp"
            : "image/png";
  const buf = nodeFs.readFileSync(resolved);
  const dataUrl =
    pathToDataUrlCompressed(resolved) ?? `data:${mime};base64,${buf.toString("base64")}`;
  const VISION_MAX_BASE64 = 1 * 1024 * 1024;
  if (dataUrl.length > VISION_MAX_BASE64) {
    console.warn(
      `[visionFallback] 图片 base64 仍超限(${(dataUrl.length / 1024).toFixed(0)} KB),跳过描述`
    );
    return null;
  }
  for (let i = 0; i < chain.length; i++) {
    const client = chain[i];
    if (!client) continue;
    try {
      let description = "";
      const result = await client.streamChat(
        [
          {
            role: "user",
            content: [
              { type: "image_url", image_url: { url: dataUrl, detail: "auto" } },
              {
                type: "text",
                text:
                  (customPrompt ? customPrompt + "\n" : "") +
                  "Describe the image in detail, including all elements, text, and charts. Note the approximate position of each element (e.g., top-left, center, bottom-right). Only describe what you can see — do not infer or guess. Reply in Chinese.",
              },
            ],
          },
        ],
        (chunk) => {
          description += chunk;
        },
        { includeReasoningInStream: true }
      );
      if (result.content.trim()) {
        if (i > 0) console.info(`[visionFallback] 主模型失败,使用第 ${i + 1} 个备用模型成功`);
        return { description: result.content.trim(), usage: result.usage };
      }
    } catch (e: any) {
      const isRateLimit =
        e?.status === 429 || (typeof e?.message === "string" && e.message.includes("429"));
      console.warn(
        `[visionFallback] client[${i}] 失败(${isRateLimit ? "429/RPD" : (e?.message ?? e)})${i < chain.length - 1 ? ",尝试下一个..." : ""}`
      );
    }
  }
  console.error("[visionFallback] 所有 vision 后端均失败");
  return null;
}

setBuiltinAgentFilter((toolName: string, agentId: string): boolean => {
  const cfg = agentManager.readToolsConfig(agentId);
  if (!cfg) return true; // 文件不存在 → 不限制
  if (cfg.mode === "allowlist") return cfg.tools.includes(toolName);
  if (cfg.mode === "denylist") return !cfg.tools.includes(toolName);
  return true;
});

/** Chat 模式工具调用轮次上限（在 config 中未配置时的后备默认值，0=无限制） */
const MAX_TOOL_ROUNDS = 0;
/** Slave 最大嵌套深度：0=Master，1=一级Slave，不允许 Slave 再 fork */
const MAX_SLAVE_DEPTH = 1;
/** Code 模式：context window 用量超过此比例时，通知用户已接近上限（触发压缩的阈值更低，为 75%） */
const CODE_CONTEXT_WARN_THRESHOLD = 0.9;
/**
 * 「秒返回但把活干在后台」的工具：`__purpose` 跳过 hold 直接尝试展示。
 *
 * 这类工具的执行耗时极短（派发即返回），按"跑得久才展示"的规则会被当成快工具而永远静默，
 * 但它们的 purpose 恰恰最该说——"已派发后台任务，正在跑"。受 minGap 与去重约束。
 */
const INSTANT_ASYNC_TOOLS: ReadonlySet<string> = new Set(["agent_fork", "session_send"]);

/**
 * 判断某个内置工具对指定 agent 是否可用（读 tools.toml）。
 * 仅用于 system prompt 动态描述生成，与工具的实际执行路由无关。
 * 文件不存在 → 全量可用（返回 true）。
 */
function isToolAvailable(toolName: string, agentId: string): boolean {
  const cfg = agentManager.readToolsConfig(agentId);
  if (!cfg) return true;
  if (cfg.mode === "allowlist") return cfg.tools.includes(toolName);
  if (cfg.mode === "denylist") return !cfg.tools.includes(toolName);
  return true;
}

/**
 * 内置系统提示词(动态生成)。
 * agentId 仅用于读取 tools.toml 以决定 MEM.md 操作说明的措辞,与记忆的操作对象无关。
 */
function buildBuiltinSystem(
  workspacePath: string,
  supportsVision = false,
  agentId = "default"
): string {
  const agentDir = join(workspacePath, "..");
  const memFilePath = join(agentDir, "MEM.md");
  const activeFilePath = join(agentDir, "ACTIVE.md");
  const skillsFilePath = join(agentDir, "SKILLS.md");
  // ── chat feedback.md（跨 session 用户行为纠正，若存在则注入；注入长度受限） ──
  const chatFeedbackContent = readFeedback(agentId, "chat", FEEDBACK_INJECT_MAX_CHARS);

  // ── MEM.md 操作说明（动态，根据 agent tools.toml 决定使用哪种工具描述） ──────
  const hasWriteFile = isToolAvailable("write_file", agentId);
  const hasExecShell = isToolAvailable("exec_shell", agentId);
  const hasMemWriteTool = isToolAvailable("memory_write_mem", agentId);
  const hasMemReadTool = isToolAvailable("memory_read_mem", agentId);

  let memWriteDesc: string;
  let memReadDesc: string;
  if (hasWriteFile && hasMemWriteTool) {
    // 两者均可用：优先推荐 memory_write_mem（无需 MFA），write_file 作备选
    memWriteDesc = `call the memory_write_mem tool (no MFA required); write_file with ${memFilePath} also works`;
    memReadDesc = hasMemReadTool
      ? `call memory_read_mem, or run cat ${memFilePath} through exec_shell`
      : hasExecShell
        ? `run cat ${memFilePath} through exec_shell`
        : `call memory_read_mem`;
  } else if (hasWriteFile) {
    // 只有 write_file 可用（默认/无限制 agent 且未配置 memory_write_mem）
    memWriteDesc = `use write_file to write ${memFilePath}`;
    memReadDesc = hasExecShell
      ? `run cat ${memFilePath} through exec_shell`
      : hasMemReadTool
        ? `call the memory_read_mem tool`
        : `(no way to read it right now)`;
  } else if (hasMemWriteTool) {
    // 受限 agent：write_file/exec_shell 被禁，仅有 memory_write_mem 可用
    memWriteDesc = `call the memory_write_mem tool (overwrite / append modes are both supported)`;
    memReadDesc = hasMemReadTool ? `call the memory_read_mem tool` : `(no way to read it right now)`;
  } else {
    // 两者均不可用（极度受限 agent）
    memWriteDesc = `(this agent has no write access; MEM.md is maintained by the administrator)`;
    memReadDesc = hasMemReadTool ? `call the memory_read_mem tool` : `(this agent has no read access)`;
  }

  return `You are tinyclaw, a concise and efficient AI assistant.

## Reply formatting
Always make full use of Markdown so the content is clear and readable:
- **Code, commands, configuration**: wrap them in fenced code blocks and tag the language (\`\`\`python / \`\`\`bash / \`\`\`json …)
- **Quotes, log excerpts, error messages**: use block quotes (> )
- **Comparisons, parameter lists**: use tables (| col | col |)
- **Procedures**: use ordered lists; parallel options use bullet lists
- **Keywords, terms, file paths**: mark them with inline code (\`xxx\`)
- Never drop formatting in the name of brevity — the formatting is part of the information

## Tool precedence

When handling a task, choose the execution path in this order:

1. **Built-in tools** (exec_shell / write_file / read_file …) — direct call, fastest response
2. **MCP tools** (mcp_* prefix) — if the built-ins are not enough, list the available services with mcp_list_servers, then activate the right one with mcp_enable_server and call its tools
3. **Skills (workflow documents)** — if neither of the above fits, and the user's intent exactly matches an available skill's description/trigger_phrases, run it with the skill_run tool

Do not skip levels: if a built-in tool can do it, do not start an MCP server; if an MCP tool can do it, do not hand-run a skill script.
- \`exec_shell\` times out after 60 seconds by default; for anything expected to take longer, pass a larger \`timeout_sec\` explicitly
- Do not run build / test / install / large network requests / repo-wide scans against that 60-second default


## Workspace rules

Two core directories:

| Purpose | Path |
|---------|------|
| Working directory (exec_shell's default cwd, holds tmp/ and output/) | ${workspacePath} |
| Agent configuration directory (MEM.md / ACTIVE.md / SKILLS.md / feedback.md all live here) | ${agentDir} |

> **Every agent management file lives in the configuration directory, not the working directory.**
>
> - tmp/    temporary files (safe to clean up at any time)
> - output/ deliverables (files to hand over, run results, …)
> - Put every unrelated intermediate file in tmp/ and every result in output/, and keep the tree tidy
- You may use absolute paths, or switch with \`cd /other/path && command\`
- **write_file / edit_file / delete_file may only touch the workspace and the agent configuration directory**; going outside triggers a user authorization prompt, that grant lasts only for the current turn, and without confirmation the write fails
- **When you need a temporary file, its path must be under '${workspacePath}/tmp/' or '/tmp/'** — never another system path or a project source tree
- exec_shell may switch to any directory, but writing to the \$HOME root, system directories (/etc /usr /bin …) or sensitive config files (.gitconfig / .bashrc / .ssh …) is strictly forbidden
- When running long commands through exec_shell, set a suitable \`timeout_sec\` yourself instead of letting the 60-second default cut them off

## MEM.md (long-term memory)
- MEM.md is the long-lived, cross-session memory; it was loaded once when this session started
- It is **general chat-mode memory**: it serves not only engineering/project work but also everyday conversation, life situations, long-term preferences, relationships and habits
- To update it, ${memWriteDesc}
- To read the latest content (after it was updated earlier in this session), ${memReadDesc}

### What belongs in MEM.md
- Long-term preferences, habits or standing requirements the user has stated explicitly
- Stable relationships, identity details, environment facts and rules that stay valid over time
- Important conclusions, long-lived decisions and stable facts that must survive across sessions

## ACTIVE.md (active context)
- ACTIVE.md holds the currently active context: topics that keep coming up, short-term unfinished items, the latest explicit requests
- This layer covers both life and project situations, so that not every short-term detail has to be squeezed into MEM.md
- If memory_read_active / memory_write_active are available to this agent, prefer them for reading or updating ${activeFilePath}

### What fits better in ACTIVE.md
- Items still being followed up within the last 7–14 days
- Current unfinished tasks, latest goals, short-term blockers
- The most recent request that the user may well bring up again

## SKILLS.md (skill catalog)
- Available skills are injected every turn via the skill reminder (XML, with the exact document path in <doc_path>)
- When a skill triggers: **you must first call read_file on the <doc_path> document**, then follow its steps exactly — never work from memory
- Trigger conditions: the user's intent must match <description> or <trigger_phrases> exactly; never guess
- Skills marked disable-model-invocation=true may only be invoked explicitly with the /skill:name command; the AI must not trigger them on its own
- To create a new skill, call the create_skill tool for the full guide
- To read the latest skill list, run cat ${skillsFilePath} through exec_shell

## Time-sensitive data (mandatory)
- For anything real-time or time-sensitive (weather, stock prices, FX rates, news, system state, disk space …), fetch the real data through tools first, and only then produce an answer
- Never answer a time-sensitive question straight from training knowledge — actually fetch it with exec_shell (curl/wget …) or another tool, even when you expect the value to be the same
- If the call fails or the data cannot be obtained, say so plainly ("data fetch failed: <reason>", in the user's language) — never substitute a guess, an estimate or stale data

## The __purpose parameter (progress narration)
Any tool call may carry one extra optional argument, __purpose: a short **user-facing** line saying what you are doing right now.
The user **sees that line directly** — it is their only progress signal while you work (the system no longer sends generic "still working" notices).

### Language and length
- Write it in the **user's own language** — a Chinese user gets Chinese
- ≤10 Chinese characters, or ≤10 English words; mixed technical terms are fine (e.g. 「调 API 拉行情」)
- **emoji is free-form**: use it naturally if you want, anywhere, or not at all; emoji do not count toward the limit
- Over-long text gets truncated, so keep it short

### When to write it (moderate frequency — not on every call)
- Before something that will **make the user wait**: a lookup, a scrape, a build, a long-running operation
- When entering a new phase (e.g. 「数据齐了，开始分析」)
- **For a run of similar small operations, write it only the first time** — reading a second file or calling the same endpoint again needs no new line
- Purely internal probing can go without
- If the tool finishes within seconds the line will not be shown anyway, so do not force it

### How to write it
- Conversational, starting with 「正在/我」 in Chinese (or "I'm …" in English), user-facing, **no technical detail**
- ✅ 「🔍 正在查你最近三个月的持仓」
- ✅ 「📄 正在把报告转成 PDF」
- ✅ 「正在调 API 拉行情 🌐」
- ❌ 「调用 exec_shell 执行 tj.py monitor」 (a technical changelog)
- ❌ 「正在思考」「稍等」 (empty filler)
- ❌ Never write conclusions here, and never repeat the user's own wording

### The catch
After writing __purpose you must **keep calling tools** — do not treat it as a reply and end the turn.

## Sending rich media
- To send an image / audio / video / file to the user, embed the matching tag in your reply text and the system will send it:
  - Image: \`<img src="/absolute/path/or-https://URL"/>\`
  - Audio: \`<audio src="..."/>\`
  - Video: \`<video src="..."/>\`
  - File: \`<file src="..." name="name.ext"/>\`
- Use absolute paths for local files (e.g. \`${workspacePath}/output/cat.png\`) and confirm the file really exists before sending
- Remote resources must be publicly reachable https:// URLs
- **Size**: a local file may be at most 200 MB (hard upstream limit). Up to 7.5 MB it is uploaded inline; anything
  larger automatically goes through chunked upload, which is slower (part by part, and slower the bigger it is);
  beyond 200 MB the system rejects it and replies "⚠️ 附件发送失败" on your behalf
- **The wire type follows the file format, the tag only expresses intent**: use png/jpg for images and mp4 for video
  (anything else is sent as a file); **for audio only silk is sent as a voice message**, while mp3/m4a/wav are sent as
  **file attachments** (never stuffed into a voice bubble) — to make sure the other side gets the real mp3, use
  \`<file src="...mp3" name="name.mp3"/>\`
- Never dump image content as base64 text — always use the tags above

## General rules
- Before a high-risk operation, first tell the user in words what you are about to do and wait for their confirmation
- **Always reply in the user's own language** — a Chinese user gets Chinese, an English user gets English.
  This prompt is written in English for precision; that is **not** a reason to answer in English.
- **No flattery**: never open with "great question", "your thinking is very clear" and the like; get straight to the content
- **Do not over-apologize**: a brief apology followed immediately by the fix is enough; do not keep apologizing

## Asking the user (ask_user)

Call the **ask_user** tool instead of guessing when:
- The requirement is vague and several readings are genuinely reasonable
- There are 2–4 viable options and the user's preference decides which one
- You hit a branch halfway through the task that needs a user decision before you can continue

How to use it:
- Offer 2–5 preset options (each with a label, plus an optional description and a recommended marker)
- Free-form input stays allowed by default (the user is not limited to the presets)
- Do not ask about anything **you could confirm yourself by reading a file or running a command**
- **ask_user can only be called once per turn**; if several ask_user calls appear in the same LLM output, only the first runs and the rest are skipped — when you hit branches or ambiguity, merge every question into one ask_user call

## Background tasks (agent_fork)

For work that takes a while (expect >10 seconds) or can run in parallel with something else, prefer **agent_fork** so the user does not wait:

- **Good for background**: long compiles, dependency installs, big file processing, network scraping, multi-step data analysis
- **Bad for background**: simple questions needing an immediate answer, tasks that still need clarification, very short operations

How to use it:
1. Call agent_fork(task="full task description") → it returns a slave_id immediately and you continue serving the user
2. Tell the user the background task has started and that they will be notified when it finishes
3. Call agent_status() at any time to list every background task with its progress (status_filter="running" for running ones only), or agent_status(slave_id="xxx") for one task
4. To cancel, call agent_abort(slave_id="xxx")${
    supportsVision
      ? `

## Vision
- The model you are running on can read images directly; no OCR tool is needed
- Images the user sends are attached to the message automatically, so you can describe and analyse them directly
- When a message contains an image, look at it and answer — never suggest installing tesseract or another OCR tool`
      : ""
  }${
    chatFeedbackContent
      ? `

## Behavioral constraints (from past feedback)
The user has corrected these behaviors before — follow them strictly:

${chatFeedbackContent}

> When the user explicitly corrects your behavior ("don't …" / "from now on …" / "always …"), record it with \`memory_append_feedback(content="…")\` (no MFA, deduplicated automatically)`
      : `

## Recording behavioral feedback
When the user explicitly corrects your behavior ("don't …" / "from now on …" / "always …"), record it with \`memory_append_feedback(content="…")\` (no MFA, deduplicated automatically)`
  }`;
}

/**
 * 为不支持 function calling 的模型生成文字版工具描述和调用格式说明（追加到 system prompt）。
 *
 * 格式约定：
 *   - 需要调用工具时，整条回复只包含一个 <tool_call> 块，不附加任何其他文字
 *   - 收到 [tool_result] 后继续推理，可再次调用工具
 *   - 所有工具执行完毕、任务确认完成后，输出最终回复（语言跟随用户），不得包含任何 <tool_call> 块
 */
function buildTextBasedToolInstructions(tools: ChatCompletionTool[]): string {
  const descs = tools
    .map((t) => {
      const fn = t.function;
      const params = fn.parameters as
        | {
            properties?: Record<string, { type?: string; description?: string }>;
            required?: string[];
          }
        | undefined;
      const lines = [`### ${fn.name}`, `Description: ${fn.description ?? ""}`];
      if (params?.properties) {
        lines.push("Parameters:");
        for (const [k, v] of Object.entries(params.properties)) {
          const req = params.required?.includes(k) ? "required" : "optional";
          lines.push(`  - ${k} (${v.type ?? "any"}, ${req}): ${v.description ?? ""}`);
        }
      }
      return lines.join("\n");
    })
    .join("\n\n");

  return `## Tool-calling format (text mode)

This model does not support function calling, so call tools with the plain-text format below.

**Rules:**
1. To call a tool, the whole reply must contain exactly one block in this format and nothing else:
   <tool_call>
   {"name": "<tool_name>", "args": {"<param>": "<value>"}}
   </tool_call>
2. After the system runs the tool it returns the result in a [tool_result:<tool_name>] message; keep reasoning
3. You may call tools repeatedly, one call per reply
4. **Final reply**: when every tool call is done and the task is confirmed complete, output the full
   reply — **in the user's own language** — with no <tool_call> block inside

## Available tools

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
 *
 * 导出以便探针直接断言"自指权限段只对被授权的 agent 注入"（`tmp/probe-self-access-*.ts`）。
 */
export function buildSystemPrompt(
  agentId = "default",
  extra?: string,
  supportsVision = false,
  suffix?: string,
  currentProvider?: string
): string {
  const workspacePath = agentManager.workspaceDir(agentId);
  const parts: string[] = [buildBuiltinSystem(workspacePath, supportsVision, agentId)];
  // 自指运行权限：只有被 [selfAccess].grantedAgents 授权的 agent 才被告知该能力
  // （未授权时提它只会让模型反复尝试并被拒）
  if (isSelfAccessGranted(agentId)) parts.push(buildSelfAccessPrompt(agentId));
  // 沙箱：开启时告诉模型边界在哪、以及（若允许）两条提权路径怎么用
  const sandboxPrompt = buildSandboxPrompt(agentId);
  if (sandboxPrompt) parts.push(sandboxPrompt);
  const userPrompt = loadUserSystemPrompt();
  if (userPrompt) parts.push(userPrompt);
  const agentPrompt = extra ?? loadAgentSystemPrompt(agentId);
  if (agentPrompt) parts.push(agentPrompt);
  if (suffix) parts.push(suffix);
  const mem = loadAgentMem(agentId);
  if (mem) parts.push(`## Long-term memory (MEM.md)\n\n${mem}`);
  const skills = loadAgentSkills(agentId);
  if (skills) parts.push(`## Skill catalog (SKILLS.md)\n\n${skills}`);
  // Response hook:按 provider 注入
  if (currentProvider) {
    const hooks = loadConfig().agent.responseHooks;
    const hookText = hooks?.[currentProvider];
    if (hookText) parts.push(hookText);
  }
  return parts.join("\n\n");
}

/**
 * Self-runtime access prompt section (injected only for granted agents).
 *
 * Purpose: tell the agent where "its own runtime directory" is, what it may do there,
 * and that secrets are a hard line — so it can answer "how much disk are you using" or
 * "clean up the junk" by itself instead of asking the user every time.
 */
function buildSelfAccessPrompt(agentId: string): string {
  const root = runtimeRoot();
  return [
    "## Self-runtime access (granted)",
    "",
    `You have been granted access to your own runtime directory \`${root}\` (agent: \`${agentId}\`).`,
    "The dedicated tools below let you inspect and clean it up (memory, session records, cron jobs, loop",
    "configs, logs, cache, downloads and outputs).",
    "",
    "- To inspect or clean up disk usage: run `self_runtime_scan` first (per-directory usage plus cleanup",
    "  candidates), then `self_runtime_read` to look at a specific file, and `self_runtime_delete` to remove one",
    "  (requires `confirm: true`; pass `dry_run: true` to preview first).",
    "- `self_status` also reports runtime usage.",
    "- File operations that stay inside your own scope (your workspace, or runtime paths when",
    "  `[selfAccess].wideWriteAccess` is on) do not require MFA confirmation.",
    "- **Secrets are a hard line**: `config.toml` / `secrets.toml` / `mcp.toml` / `auth/**` / `*.key` / any file whose",
    "  name contains `token` cannot be read, written or deleted. The runtime root itself, its `.git` and `agents` as",
    "  a whole cannot be deleted either.",
    "- Before deleting `[caution]`-level candidates (downloaded assets, outputs, archived memory), tell the user what",
    "  will be removed and how much space it frees.",
    "- Note: generic writes outside your workspace (this includes `memory/` and `skills/` when wideWriteAccess is",
    "  off) require an explicit grant — see the sandbox section for the current rules.",
  ].join("\n");
}

/**
 * 沙箱说明段（仅在 `[sandbox].enabled && execShell === "sandbox"` 时注入）。
 *
 * 目的：让模型**知道边界**，不要反复尝试注定失败的路径（例如沙箱里 ssh 必然失败），
 * 并在确实需要时走**正确的提权入口**（`fs_grant` 换路径写权限 / `elevate` 让一条命令出沙箱），
 * 而不是绕路、放弃、或者反复撞同一堵墙。
 *
 * ⚠️ 本段必须与实现同步（`sandbox/bwrap.ts` 的可写基座、`sandbox/elevation.ts`、
 * `auth/fs-grant.ts`）。三者任一处改了范围，这里就要改 —— 否则模型会照着过期的边界行动。
 */
function buildSandboxPrompt(agentId: string): string | null {
  let cfg;
  try {
    cfg = loadConfig().sandbox;
  } catch {
    return null;
  }
  if (!cfg.enabled || cfg.execShell !== "sandbox") return null;

  const workspace = agentManager.workspaceDir(agentId).replace(runtimeRoot(), "~/.tinyclaw");
  const lines = [
    "## Execution sandbox (you are running inside one)",
    "",
    "Your `exec_shell` commands run in an isolated bubblewrap sandbox, **not** directly on the host. Boundaries:",
    "",
    `- **Writable by default: only your own workspace** — \`${workspace}\` (including \`tmp/\` \`output/\` \`downloads/\`) and the system \`/tmp\`.`,
    "- **The rest of your agent directory is read-only**: `memory/` `cards/` `skills/` `notes/` `logs/` `MEM.md`",
    "  `ACTIVE.md` `SYSTEM.md` `agent.toml` `access.toml` — writing them via the shell or `write_file` fails or is blocked.",
    "  (Write your own memory with the `memory_*` tools: those are sanctioned entry points and are not affected.)",
    "- Readable but not writable: system directories, `~/.nvm`, `~/.cache`, repositories, other `~/.tinyclaw` data.",
    "- **Invisible (the file simply does not exist — this is not a permission error)**:",
    "  `~/.tinyclaw/{config,secrets,mcp}.toml`, `~/.tinyclaw/auth/`, `*.key`, `~/.ssh`, `~/.aws`, `~/.netrc`.",
    "  Consequently `ssh`, `git push` over SSH and `scp` **fail outright**.",
    `- Network: ${cfg.network === "allow" ? "outbound allowed" : "**outbound denied** (this task was classified as handling untrusted content)"}`,
    "",
    "### Writing outside your workspace (two different escape hatches — do not confuse them)",
    "",
  ];

  if (cfg.grant.enabled) {
    lines.push(
      "- **Need write access to a path** (including `memory/` `skills/` inside your agent directory, or",
      "  `~/.tinyclaw/data`, `~/Documents`, …): call `fs_grant({ path, reason })` first. **The user is not asked**;",
      "  it takes effect immediately, lasts 1 hour by default and is audited. Afterwards `write_file` / `edit_file` /",
      "  `exec_shell` can write that path. **Prefer getting the work done inside your workspace** and only ask when it is",
      "  genuinely necessary — do not treat `fs_grant` as a default step."
    );
  } else {
    lines.push(
      "- `fs_grant` is currently **disabled**: only the workspace is writable. Ask the user to make other changes."
    );
  }

  if (cfg.elevation.enabled) {
    lines.push(
      "- **Need one command to leave the sandbox** (e.g. `ssh` / `git push`, which requires `~/.ssh`):",
      "  `exec_shell({ command, elevate: true })`. It applies to **that one command only**, is valid for 120 seconds by",
      "  default, and requires user approval (read-only commands may be auto-approved; side-effecting ones are confirmed",
      "  every time). If the user declines, use a sandbox-side alternative and **do not repeat the same request** (it is throttled)."
    );
  } else {
    lines.push(
      "- `elevate` is currently **disabled**: when you need host capabilities, tell the user which command to run outside the sandbox."
    );
  }

  lines.push(
    "",
    "⚠️ In unattended runs (cron / loop) **neither escape hatch is available**: their writable scope is fixed by the task",
    "configuration's `writablePaths` and cannot be widened at runtime — report failures honestly instead of retrying."
  );

  return lines.join("\n");
}

/** 格式化工具调用描述（用于 MFA 警告消息） */
function describeToolCall(name: string, args: Record<string, unknown>): string {
  if (name === "exec_shell") return `exec_shell: ${String(args["command"] ?? "")}`;
  if (name === "write_file") return `write_file: ${String(args["path"] ?? "")}`;
  if (name === "delete_file") return `delete_file: ${String(args["path"] ?? "")}`;
  return `${name}(${JSON.stringify(args)})`;
}

export interface AgentRunOptions {
  /**
   * 本次运行的来源，决定权限策略：
   * - `cron` / `loop` = **无人值守**：工具按 `[sandbox.unattended]` 白名单放行，
   *   且 MFA 无法送达时默认拒绝（而不是静默放行）
   * - `chat` / `cli` / `slave` = 有交互路径（slave 继承其 master 的来源）
   * 省略时按 `unknown` 处理（不套用无人值守白名单）。
   */
  origin?: RunOrigin;
  /**
   * 本次运行额外允许写入的目录（沙箱 bind 成可写）。
   * cron job / loop 配置的 `writablePaths` 经此传入，作用于该任务的所有 exec_shell。
   */
  sandboxExtraRwPaths?: string[];
  /** 本次运行声明要读的密钥名（cron/loop 的 `secrets`），传给 exec_shell 做按任务过滤 */
  sandboxSecretNames?: string[];
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
  onMFARequest?: (
    warningMessage: string,
    verifyCode?: (code: string) => boolean
  ) => Promise<boolean>;
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
   * 展示工具调用的 `__purpose` 进度旁白（由 main.ts 注入）。
   *
   * 代替了旧的定时心跳：进度提示不再由系统定时推送通用文案，而是由模型在关键节点
   * 自己写的短旁白驱动（何时展示由 core/purpose-arbiter.ts 仲裁）。
   */
  onPurpose?: (purpose: string) => void | Promise<void>;
  /**
   * 主动向用户推送消息（由 main.ts 注入）。
   * 供 notify_user 工具调用，不等 runAgent 结束即发送，不触发新一轮 LLM 推理。
   */
  onNotify?: (message: string) => Promise<void>;
  /**
   * 工具调用通知(synchro 订阅使用)。在 runOneTool 开始前调用。
   * `meta.purpose` 为该工具调用携带的 `__purpose`（已剥离、已归一化，可能不存在）。
   */
  onToolCall?: (
    name: string,
    args: Record<string, unknown>,
    meta?: { purpose?: string }
  ) => void;
  /**
   * 工具结果通知(synchro 订阅使用)。在 runOneTool 完成后调用。
   */
  onToolResult?: (name: string, result: string) => void;
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
   * 审批策略（对齐 DSH 的 `DelegatedPolicyOverrides.approvalPolicy = 'never'`）。
   *
   * `"never"` = 本次运行的**审批类请求一律确定性拒绝**：需要 MFA 的工具直接拒绝、
   * `exec_shell({ elevate: true })` 直接拒绝，且不会向用户发起任何确认。
   * 语义是"子 Agent 只能在委派时定下的作用域里干活"——子 Agent 不允许向上伸手要权限。
   *
   * 由 `slaveRunFn` 给所有 Slave 强制加上；cron / loop 的 slaveRunFn 同样加上（纵深防御）。
   */
  approvalPolicy?: "never";
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
   * 未设置时取 `config.agent.autoForkThresholdMs`（默认 120_000 = 2 分钟）；**0 = 禁用**。
   */
  autoForkThresholdMs?: number;
  /**
   * 额外注入给 LLM 的工具列表(追加到 getAllToolSpecs() 之后)。
   * 用于向特定 Agent(如 fork 出的 slave)暴露 hidden 工具。
   */
  customTools?: import("openai/resources/chat/completions").ChatCompletionTool[];
  /**
   * 覆盖 llmRegistry 选出的 LLM client（cron 指定 model 时使用）。
   * 不传则走默认逻辑：code 模式用 code 后端，其余用 daily 后端。
   */
  overrideClient?: import("../llm/client.js").LLMClient | import("../llm/registry.js").AnyLLMClient;
  /**
   * 跨 session 消息注入函数(由 main.ts 注入)。
   * 透传到 ToolContext，供 session_send 工具使用。
   */
  sessionSendFn?: import("../tools/registry.js").ToolContext["sessionSendFn"];
  /**
   * 跨 session 可见列表函数（由 main.ts 注入）。
   * 透传到 ToolContext，供 session_get 工具使用。
   */
  sessionGetFn?: import("../tools/registry.js").ToolContext["sessionGetFn"];
  /**
   * loop_exit 工具回调（由 loop-trigger 注入）。
   * 透传到 ToolContext，AI 调用 loop_exit 工具时触发，设置退出信号标志。
   */
  onLoopExit?: import("../tools/registry.js").ToolContext["onLoopExit"];
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
  /** 当前 connector 的 botId(从 main.ts 透传,供工具自动推断输出通道) */
  botId?: string;
  /**
   * 事件流订阅(事件流化重构)。
   * 传入 AgentEventBus 或单个 sink;循环内部可观测事件(生命周期/preamble/turn/工具/压缩/MFA/收尾)
   * 统一走此通道。旧回调(onChunk/onToolCall/onToolResult/onCompress/onPurpose/onMFAPrompt)
   * 仍保留并同步触发,迁移期两者并存。
   */
  onEvent?: AgentEventSink | AgentEventBus;
}

export interface AgentRunResult {
  content: string;
  /** 本次运行调用了哪些工具 */
  toolsUsed: string[];
  /**
   * 空回复守卫的判定（仅当最终内容为空时出现）：
   * - `length`：输出被长度上限截断
   * - `degenerate`：reasoning 退化成重复（思考把预算烧完、正文为空）
   * - `silent`：模型确实没有说话（工具已交付结果时属正常）
   * 调用方据此决定兜底文案：前两者要给用户**诚实**的提示，而不是「✅ 已完成」。
   */
  emptyReplyKind?: "length" | "degenerate" | "silent";
}

/**
 * 单次 Agent 运行（一轮用户消息 → 完整响应）。
 * 支持多轮 tool_call（ReAct 循环），轮次上限由 tools.maxChatToolRounds 配置（0=无限制）。
 */
/** 生成工具调用的单行摘要，用于日志 */
function toolCallSummary(name: string, args: Record<string, unknown>): string {
  const MAX_SUMMARY_LEN = 120;

  // 特殊工具:展示最有价值的参数
  if (name === "exec_shell") {
    const cmd = String(args["command"] ?? "").replace(/\n/g, " ");
    return `${name}: "${cmd.slice(0, 80)}${cmd.length > 80 ? "…" : ""}"`;
  }
  if (name === "write_file" || name === "read_file" || name === "delete_file" || name === "edit_file") {
    return `${name}: ${args["path"] ?? "?"}`;
  }
  if (name === "cron_add") {
    const desc = String(args["message"] ?? "").slice(0, 30);
    return `${name}: type=${args["type"]} msg="${desc}"`;
  }
  if (name === "cron_remove") return `${name}: id=${args["id"] ?? "?"}`;
  if (name === "session_send") {
    const msg = String(args["message"] ?? "").slice(0, 30);
    return `${name}: target=${(args["target_session_id"] ?? "?").toString().slice(0, 12)} "${msg}"`;
  }
  if (name === "project_switch") {
    const task = String(args["task"] ?? "").slice(0, 30);
    return `${name}: → ${args["project"] ?? "?"} "${task}"`;
  }

  // 通用:取前 3 个参数,截断值
  const keys = Object.keys(args).filter((k) => k !== "_meta" && k !== "requestId");
  if (keys.length === 0) return name;

  const parts = keys.slice(0, 3).map((k) => {
    const v = String(args[k] ?? "").replace(/\n/g, " ");
    return `${k}=${v.slice(0, 20)}${v.length > 20 ? "…" : ""}`;
  });
  const summary = `${name}: ${parts.join(" ")}`;
  return summary.length > MAX_SUMMARY_LEN ? summary.slice(0, MAX_SUMMARY_LEN - 3) + "..." : summary;
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

/**
 * 事件流化门面:创建事件总线,包 try/catch 保证异常也能被观测(agent:error),
 * 然后委托给 runAgentInner。任何错误原样 rethrow,不改变调用方语义。
 */
export async function runAgent(
  session: Session,
  userContent: string,
  opts: AgentRunOptions = {}
): Promise<AgentRunResult> {
  const bus = resolveEventBus(opts.onEvent);
  try {
    return await runAgentInner(session, userContent, opts, bus);
  } catch (err) {
    bus.emit({
      type: "agent:error",
      sessionId: session.sessionId,
      mode: session.mode === "code" ? "code" : "chat",
      stage: "run",
      error: {
        name: err instanceof Error ? err.name : "Error",
        message: err instanceof Error ? err.message : String(err),
      },
    });
    throw err;
  }
}

/**
 * 阶段 0: 准备(prepare)。确定 LLM client / 工具快照 / textMode,重置并发状态,发射 agent:start。
 * 事件流化拆分(提交 2):逻辑与原 runAgentInner 头部完全一致,仅物理移动。
 */
async function prepareRun(
  session: Session,
  userContent: string,
  opts: AgentRunOptions,
  bus: AgentEventBus
): Promise<PrepareResult> {
  const isCodeMode = session.mode === "code";
  let client = opts.overrideClient ?? llmRegistry.get(isCodeMode ? "code" : "daily");
  const visionClient = !client.supportsVision ? llmRegistry.getVisionClientChain() : undefined;
  const totalVisionPromptTokens = 0; // vision 模型 input token 累计
  const totalVisionCompletionTokens = 0; // vision 模型 output token 累计
  const totalVisionCacheReadTokens = 0; // vision 模型 cache read token 累计
  const totalVisionCacheCreationTokens = 0; // vision 模型 cache creation token 累计

  // 恢复该 session 上次已启用的 MCP server
  void mcpManager.restoreSession(session.sessionId, isCodeMode ? "code" : "chat", session.agentId);

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
  if (!opts.skipAddUserMessage || userContent) {
    console.log(`${logPrefix} ← "${msgPreview}${userContent.length > 60 ? "..." : ""}"`);
  }

  // ── 事件总线(事件流化)─────────────────────────────────────────────
  // 整个 run 的生命周期事件统一走 bus(由 runAgent 门面创建传入);异步 sink fire-and-forget,不阻塞循环
  const providerName = (() => {
    try {
      return String(client.model).split("/")[0] ?? "unknown";
    } catch {
      return "unknown";
    }
  })();
  bus.emit({
    type: "agent:start",
    sessionId: session.sessionId,
    mode: isCodeMode ? "code" : "chat",
    userContent: userContent.slice(0, 200),
    provider: providerName,
    model: String(client.model),
  });
  const startMs = Date.now();

  // code 模式工具调用节流：每分钟汇总一次通知
  const toolThrottler =
    isCodeMode && opts.onNotify ? new ToolCallThrottler((msg) => void opts.onNotify!(msg)) : null;

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
  // code 模式过滤 restart_tool(该工具仅 code 模式下有意义)
  // code 模式过滤 agent fork 系列(code 模式本身是子 agent,不应再向下 fork)
  const CODE_MODE_EXCLUDED = new Set([
    "skill_run",
    "agent_fork",
    "agent_status",
    "agent_wait",
    "agent_abort",
    // chat 专属记忆工具（code 模式用 code_note_read/code_note 替代）
    "memory_write_mem",
    "memory_write_active",
    "memory_read_mem",
    "memory_read_active",
    "memory_append_card",
    "memory_append",
  ]);
  const CODE_ONLY_TOOLS = new Set([
    "restart_tool",
    "project_switch",
    "project_status",
    "project_list",
  ]);
  const initialTools = getAllToolSpecs(session.agentId).filter((t) => {
    if (isCodeMode && CODE_MODE_EXCLUDED.has(t.function.name)) return false;
    if (!isCodeMode && CODE_ONLY_TOOLS.has(t.function.name)) return false;
    return true;
  });
  const textMode = !client.supportsToolCalls;

  // preRunLength：连接失败时用于回滚本次注入的消息
  const preRunLength = session.getMessages().length;

  return {
    isCodeMode,
    client,
    visionClient,
    isSlave,
    logPrefix,
    providerName,
    toolsUsed,
    textMode,
    initialTools,
    CODE_MODE_EXCLUDED,
    CODE_ONLY_TOOLS,
    preRunLength,
    startMs,
    toolThrottler,
    llmAc,
    totalVisionPromptTokens,
    totalVisionCompletionTokens,
    totalVisionCacheReadTokens,
    totalVisionCacheCreationTokens,
  };
}

interface PrepareResult {
  /** code 模式(会话 mode === "code") */
  isCodeMode: boolean;
  client: ReturnType<typeof llmRegistry.get>;
  visionClient: ReturnType<typeof llmRegistry.getVisionClientChain> | undefined;
  isSlave: boolean;
  logPrefix: string;
  /** provider 名(如 copilot/openai),供 agent:start / preamble 事件使用 */
  providerName: string;
  toolsUsed: string[];
  textMode: boolean;
  initialTools: import("openai/resources/chat/completions").ChatCompletionTool[];
  CODE_MODE_EXCLUDED: Set<string>;
  CODE_ONLY_TOOLS: Set<string>;
  /** 连接失败时用于回滚本次注入的消息 */
  preRunLength: number;
  startMs: number;
  toolThrottler: ToolCallThrottler | null;
  llmAc: AbortController;
  totalVisionPromptTokens: number;
  totalVisionCompletionTokens: number;
  totalVisionCacheReadTokens: number;
  totalVisionCacheCreationTokens: number;
}

/**
 * 本 run 里「工具执行」与「工作区指令」共用的工作目录：
 * code 模式且已绑定项目 → 项目目录；否则 agent workspace。
 * 与 `executeTool` 的 `ctx.cwd` 取值保持一致，避免"指令按 A 目录算、工具按 B 目录写"。
 */
function runToolCwd(session: Session, isCodeMode: boolean): string {
  return isCodeMode && session.codeWorkdir
    ? session.codeWorkdir
    : agentManager.workspaceDir(session.agentId);
}

async function runAgentInner(
  session: Session,
  userContent: string,
  opts: AgentRunOptions = {},
  bus: AgentEventBus
): Promise<AgentRunResult> {
  // 阶段 0: 准备(client/工具快照/textMode/并发状态重置 + agent:start)
  const prep = await prepareRun(session, userContent, opts, bus);
  const {
    isCodeMode,
    client,
    visionClient,
    isSlave,
    logPrefix,
    providerName,
    toolsUsed,
    textMode,
    initialTools,
    CODE_MODE_EXCLUDED,
    CODE_ONLY_TOOLS,
    startMs,
    toolThrottler,
    llmAc,
  } = prep;
  // 以下变量在后续阶段会被重新赋值,需 let 解构
  let {
    preRunLength,
    totalVisionPromptTokens,
    totalVisionCompletionTokens,
    totalVisionCacheReadTokens,
    totalVisionCacheCreationTokens,
  } = prep;


  // ── 阶段 1: Preamble(system prompt / 记忆 / skill / microcompact / 压缩 / 加用户消息)──
  // skipPreamble=true(auto-fork continuation)时整段跳过
  if (!opts.skipPreamble) {
    // 1. 每次 run 都刷新 system prompt（替换已有的，或首次插到最前）
    // 这样配置变更、能力更新（如 supportsVision）和 session 恢复后都能生效
    {
      let sysPrompt: string;
      if (isCodeMode) {
        // code 模式：使用代码专注 prompt，忽略 MEM.md / SKILLS.md / 用户自定义 prompt
        const _codeProvider =
          (() => {
            try {
              return loadConfig().llm.backends["code"]?.model.split("/")[0];
            } catch {
              return undefined;
            }
          })() ?? undefined;
        if (session.projectSlug) {
          // project session: MEMORY.md + topic table injection
          const pctx = loadProjectContext(session.agentId, session.projectSlug);
          const projOpts: { sessionId: string; supportsVision: boolean; currentProvider?: string } =
            {
              sessionId: session.sessionId,
              supportsVision: client.supportsVision,
            };
          if (_codeProvider) projOpts.currentProvider = _codeProvider;
          sysPrompt = buildProjectSystemPrompt(session.agentId, pctx, projOpts);
        } else {
          sysPrompt = buildCodeSystemPrompt(
            session.agentId,
            client.supportsVision,
            "plan",
            session.codeWorkdir ?? undefined,
            session.sessionId,
            _codeProvider
          );
        }
      } else {
        const _provider =
          (() => {
            try {
              return loadConfig().llm.backends[isCodeMode ? "code" : "daily"]?.model.split("/")[0];
            } catch {
              return undefined;
            }
          })() ?? undefined;
        sysPrompt = buildSystemPrompt(
          session.agentId,
          opts.systemPrompt,
          client.supportsVision,
          opts.systemPromptSuffix,
          _provider
        );
      }
      if (textMode && initialTools.length > 0) {
        sysPrompt += "\n\n" + buildTextBasedToolInstructions(initialTools);
      }

      // Prompt 完整性 / 中转站篡改检测(默认全关,由 [auth.prompt_integrity] 控制)
      try {
        const _piCfg = loadConfig().auth.prompt_integrity;
        if (isPromptIntegrityActive(_piCfg)) {
          const _piMode = _piCfg.mode;
          const _piKey = `${session.agentId}:${isCodeMode ? "code" : "chat"}`;
          // (a) 本地基线:检测 system prompt(含 MEM/SYSTEM)被本地篡改
          if (_piCfg.baselineHash) {
            const _r = verifyPromptBaseline(_piKey, sysPrompt);
            if (!_r.firstSeen && !_r.match) {
              const _msg =
                `⚠️ Prompt 完整性告警:本地 system prompt 与基线不一致(${_piKey})\n` +
                `   旧 hash: ${_r.oldHash?.slice(0, 16)}… → 新 hash: ${_r.newHash.slice(0, 16)}…\n` +
                `   可能是 MEM/SYSTEM/skills 被篡改,或你刚修改了配置。\n` +
                `   确认无误后删除 ~/.tinyclaw/prompt-baseline.json 对应项以更新基线。`;
              console.warn(`[prompt-integrity] ${_msg}`);
              if (_piMode === "halt") {
                await opts.onNotify?.(_msg);
                throw new PromptIntegrityError(_msg, "baseline");
              } else {
                await opts.onNotify?.(_msg);
              }
            }
          }
          // (b) 中转站 canary:回复校验回显
          // ⚠️ nonce 每轮都不同,若注入 system prompt 会让每轮前缀都变化(缓存全失效),
          //    因此改为追加一条独立的尾部消息,冻结的 system prompt 保持逐字节稳定。
          if (_piCfg.canary && !textMode) {
            const _inj = injectCanary("");
            session.pendingCanaryNonce = _inj.nonce;
            session.addSystemMessage(_inj.prompt.trim());
          } else {
            session.pendingCanaryNonce = undefined;
          }
        } else {
          session.pendingCanaryNonce = undefined;
        }
      } catch (e) {
        if (e instanceof PromptIntegrityError) throw e;
        // 配置读取等异常不阻断主流程
      }

      // 缓存友好:内容未变时完全不改动 messages[0];变了则追加到尾部而非原地重写
      const _spAction = session.applySystemPrompt(sysPrompt);
      if (_spAction === "appended") {
        console.log(`${logPrefix} 🔁 system prompt 变化 → 追加到尾部(保持前缀缓存)`);
      }
      bus.emit({
        type: "preamble:system-prompt",
        provider: providerName,
        vision: client.supportsVision,
        action: _spAction,
      });
    }

    // system prompt 刷新后更新回滚点
    preRunLength = session.getMessages().length;

    // 2. 搜索相关历史记忆,注入为 system 消息(code 模式 / slave 跳过)
    // 触发条件:非 code 模式 + 非 slave + 用户消息纯文本 > 15 字;结果截断至 1000 字符
    if (!isCodeMode && !isSlave) {
      const _rawText = userContent;
      if (_rawText.replace(/\s/g, "").length > 15) {
        // 节流:连续短对话时复用上次记忆注入,避免每轮都做向量搜索。
        // 仅当①尚未搜索过,②无记忆注入,或③距上次搜索 promptTokens 增量 ≥ 阈值时才重新搜索。
        const MEM_SEARCH_TOKEN_DELTA = 3000;
        const _prevSnapshot = session.lastMemorySearchPromptTokens;
        const _curTokens = session.lastPromptTokens;
        const _shouldSearch =
          _prevSnapshot < 0 ||
          !session.hasMemoryContext() ||
          _curTokens - _prevSnapshot >= MEM_SEARCH_TOKEN_DELTA;
        if (_shouldSearch) {
          try {
            const _memResult = await searchMemory(_rawText.slice(0, 200), session.agentId, 5);
            if (_memResult && _memResult.trim()) {
              const _truncated =
                _memResult.length > 1000 ? _memResult.slice(0, 1000) + "..." : _memResult;
              session.appendMemoryContext(`## Relevant past memories\n\n${_truncated}`);
            }
            session.lastMemorySearchPromptTokens = _curTokens;
            bus.emit({
              type: "preamble:memory-search",
              found: !!(_memResult && _memResult.trim()),
              chars: _memResult ? _memResult.length : 0,
            });
          } catch {
            /* 静默跳过,不阻断主流程 */
          }
        }
      }
    }

    // 2.3 Skill Reminder:每轮注入可用技能列表（chat 模式 + 非 slave）
    if (!isCodeMode && !isSlave) {
      const reminder = buildSkillReminder(session.agentId);
      if (reminder) {
        session.appendSkillReminder(reminder);
      }
      bus.emit({ type: "preamble:skill-reminder", skills: reminder ? 1 : 0 });
    }

    // 2.4 工作区指令（AGENTS.md / CLAUDE.md 及 local 覆盖）：
    // 首次进入某个工作目录时注入一份 baseline（**user 角色**，不进 system prompt），
    // 之后只在该 run 里 fs 触碰文件后才下发增量（见下方 WORKSPACE_TOUCHING_TOOLS 钩子）。
    // 子 Agent 也走这里（对齐 DSH：每个 agent 按自己的 cwd 组装）——
    // 它若从父会话继承了同身份的基线，接线层会**认领而不重发**（见 workspace-prompt.ts 的 ①a）。
    const _wsPush = ensureWorkspaceInstructionsBaseline(session, runToolCwd(session, isCodeMode));
    if (_wsPush.files > 0) {
      console.log(
        `${logPrefix} 📄 workspace instructions: ${_wsPush.action}, ${_wsPush.files} file(s), ` +
          `${_wsPush.bytes} B${_wsPush.pushed ? "" : "（无需变更）"}`
      );
    }

    // 2.5 工具结果剪枝（参考 DSH dsh-compaction-tool-result-pruner）
    // 先做**无模型**剪枝：把超大的历史工具结果替换为「头部 + 标记 + 尾部」（有界、幂等）。
    // 剪完用估算值重新判断压力——若已回到阈值以下，下面的压缩步骤会自然跳过摘要。
    // 与已废弃的旧 MicroCompact 的区别：只在压力触发时执行一次，不再每轮反复改写前缀。
    let _effectiveTokens = session.lastPromptTokens;
    {
      const _pruneCtx = isCodeMode
        ? llmRegistry.getContextWindow("code", session.lastResponseAt)
        : llmRegistry.getContextWindow("daily", session.lastResponseAt);
      const _overThreshold = isCodeMode
        ? _pruneCtx > 0 && shouldSummarizeCode(session.getMessages(), _pruneCtx, _effectiveTokens)
        : shouldSummarize(session.getMessages(), _effectiveTokens, session.lastResponseAt);
      if (_overThreshold) {
        const _before = _effectiveTokens > 0 ? _effectiveTokens : session.estimatedTokens();
        const pr = session.pruneToolResults();
        if (pr.prunedCount > 0) {
          _effectiveTokens = session.estimatedTokens();
          console.log(
            `${logPrefix} ✂️ 剪枝 ${pr.prunedCount} 条历史工具结果（省 ${pr.savedChars} 字符）` +
              (_pruneCtx > 0
                ? `，压力 ${Math.round((_before / _pruneCtx) * 100)}% → ${Math.round((_effectiveTokens / _pruneCtx) * 100)}%`
                : "")
          );
        }
      }
    }

    // 3. Pre-flight 压缩:在添加用户消息前检测 session 是否已超阈值
    // 防止上次 run 结束后 session 继续膨胀,导致本次首次 LLM 调用直接 408
    // 优先使用上一轮实际 promptTokens；若上面做过剪枝，则用剪枝后的估算值
    if (!session.abortRequested) {
      if (!isCodeMode && shouldSummarize(session.getMessages(), _effectiveTokens, session.lastResponseAt)) {
        // chat 模式：完整摘要压缩
        const pfBefore = session.getMessages().length;
        opts.onCompress?.("start");
        const summary = await session.compress();
        opts.onCompress?.("done", summary);
        bus.emit({
          type: "preamble:compress",
          before: pfBefore,
          after: session.getMessages().length,
        });
        // 压缩后更新回滚点（压缩已清空历史，只剩 system + 摘要）
        preRunLength = session.getMessages().length;
      } else if (isCodeMode) {
        // code 模式：pre-flight 检测 session 是否已超限（如上次 run 400 后 session 未清理）
        // 用 lastPromptTokens（API 实测值）或字符估算进行判断；若超限则先压缩再执行
        const codeCtx = llmRegistry.getContextWindow("code", session.lastResponseAt);
        const exceedsWindowThreshold =
          codeCtx > 0 &&
          shouldSummarizeCode(session.getMessages(), codeCtx, _effectiveTokens);
        if (exceedsWindowThreshold) {
          console.log(`${logPrefix} ℹ️ Code session pre-flight：上下文超限，执行滑动窗口压缩`);
          const pfBefore = session.getMessages().length;
          await session.compressForCode();
          bus.emit({
            type: "preamble:compress",
            before: pfBefore,
            after: session.getMessages().length,
          });
          preRunLength = session.getMessages().length;
        }
      }
    }

    // 4. 添加用户消息（若模型支持视觉且消息含图片，转为 ContentPart[] 格式）
    if (!opts.skipAddUserMessage) {
      const sanitizedContent = sanitizeUserInput(userContent);
      if (client.supportsVision) {
        session.addUserMessage(buildVisionContent(sanitizedContent));
      } else {
        // 主模型不支持视觉:保留原始文字内容，若有 visionClient 则额外追加图片描述
        session.addUserMessage(sanitizedContent);
        if (visionClient) {
          const visionContent = buildVisionContent(sanitizedContent);
          const imageParts = Array.isArray(visionContent)
            ? visionContent.filter(
                (p: import("../llm/client.js").ContentPart) => p.type === "image_path"
              )
            : [];
          for (const imgPart of imageParts) {
            if (imgPart.type === "image_path") {
              const visResult = await describeImageWithVisionFallback(imgPart.path, visionClient);
              if (visResult) {
                session.addUserMessage(`[image description ${imgPart.path}]:\n${visResult.description}`);
                totalVisionPromptTokens += visResult.usage.promptTokens;
                totalVisionCompletionTokens += visResult.usage.completionTokens;
                totalVisionCacheReadTokens += visResult.usage.cacheReadTokens ?? 0;
                totalVisionCacheCreationTokens += visResult.usage.cacheCreationTokens ?? 0;
              }
            }
          }
        }
      }
    }
  }

  let finalContent = "";
  /** 本轮所有工具调用的紧凑摘要（供逐字层 transcript 记录细节） */
  const toolCallSummaries: string[] = [];
  let lastUsage: ChatResult["usage"] = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
  let totalCompletionTokens = 0; // 本次 runAgent 所有 LLM 轮次的 output token 累计
  let totalPromptTokens = 0; // input token 累计
  let totalCacheReadTokens = 0; // cache read token 累计
  let totalCacheCreationTokens = 0; // cache creation token 累计
  // 文字模式格式纠错标记：true = 已注入纠错提示并重试，再次失败则直接返回原始输出
  let formatRetryPending = false;
  // 空回复守卫：true = 已为"空正文"重试过一次（每次 run 只救一次，避免死循环）
  let emptyRetryPending = false;
  /** 空回复的性质（写入指标 / 交给 main.ts 决定兜底文案）：length=被长度截断，degenerate=思考退化，silent=模型就是没说话 */
  let emptyReplyKind: "length" | "degenerate" | "silent" | undefined;

  // 轮次上限：0 = 无限制（用 Infinity 表示）；chat/cron 模式读取 maxChatToolRounds，code 模式读取 maxCodeToolRounds
  const configuredRounds = isCodeMode
    ? loadConfig().tools.maxCodeToolRounds
    : (loadConfig().tools.maxChatToolRounds ?? MAX_TOOL_ROUNDS);
  const maxToolRounds = configuredRounds === 0 ? Infinity : configuredRounds;
  // code 模型 context window（供 token 预算检查用）
  const codeContextWindow = isCodeMode ? llmRegistry.getContextWindow("code", session.lastResponseAt) : 0;

  // ── 阶段 2: ReAct 循环(多轮 turn:LLM 调用 → 工具执行 → 下一轮)────────────
  // 每次用户消息生成一个固定 taskId，供所有 round 共享 X-Agent-Task-Id。
  // Copilot 服务端据此将整次 agent 运行识别为同一任务，只对首轮（X-Initiator: user）计费。
  const agentTaskId = opts.agentTaskIdOverride ?? crypto.randomUUID();
  session.currentAgentTaskId = agentTaskId;
  let promptExceededRetried = false; // guard: compress+retry at most once per run
  // ── `__purpose` 仲裁器（每次 run 一个）──────────────────────────────────
  // 进度提示的唯一来源（已取代旧的定时心跳）：模型在关键节点写短旁白，
  // 这里决定哪一条真正展示给用户——只有"用户确实在等"的那些才会被说出来。
  // 必须建在 round 循环之外：候选池与展示间隔要跨轮保持。
  const agentPurposeCfg = loadConfig().agent;
  const purposeArbiter =
    agentPurposeCfg.toolPurpose && opts.onPurpose
      ? createPurposeArbiter({
          holdMs: agentPurposeCfg.purposeHoldMs,
          minGapMs: agentPurposeCfg.purposeMinGapMs,
          instantAsyncTools: INSTANT_ASYNC_TOOLS,
          onShow: (purpose: string) => {
            bus.emit({ type: "purpose:show", purpose });
            try {
              const r = opts.onPurpose?.(purpose);
              if (r && typeof r.then === "function") {
                r.then(undefined, (err: unknown) => {
                  console.warn(
                    `${logPrefix} onPurpose 回调失败: ${err instanceof Error ? err.message : err}`
                  );
                });
              }
            } catch (err) {
              console.warn(
                `${logPrefix} onPurpose 回调抛错: ${err instanceof Error ? err.message : err}`
              );
            }
          },
        })
      : null;
  for (let round = 0; round < maxToolRounds; round++) {
    bus.emit({ type: "turn:start", round });
    // 每轮重新获取工具快照，保证 mcp_enable_server 后新工具在本轮就生效
    // code 模式本身是子 agent,不应再向下 fork(agent_fork 等已被 CODE_MODE_EXCLUDED 过滤)
    // 非 code 模式不暴露 restart_tool；code 模式排除 agent fork 系列
    const rawTools = [
      ...getAllToolSpecs(session.agentId).filter((t) => {
        if (isCodeMode && CODE_MODE_EXCLUDED.has(t.function.name)) return false;
        if (!isCodeMode && CODE_ONLY_TOOLS.has(t.function.name)) return false;
        return true;
      }),
      ...(opts.customTools ?? []),
    ];
    // DeepSeek 等模型要求工具名唯一,customTools 可能与 getAllToolSpecs 重复,去重保留最后出现的
    const seenToolNames = new Set<string>();
    const dedupedTools = rawTools.filter((t) => {
      const name = t.function.name;
      if (seenToolNames.has(name)) return false;
      seenToolNames.add(name);
      return true;
    });
    // ── 注入 `__purpose`（所有模式、所有工具来源一视同仁）────────────────
    // 内置工具 / MCP 工具 / customTools 都在这里收口。injectPurposeParam 会深拷贝，
    // 因为 getAllToolSpecs() 返回的是注册表里的同一对象引用。
    const agentCfg = loadConfig().agent;
    const tools = agentCfg.toolPurpose
      ? injectPurposeParam(dedupedTools)
      : dedupedTools;

    // ── 轮间压缩（chat 模式）：tool result 可能使 session 在循环中间超限 → 提前压缩避免 408 ──
    // round 0 不需要检查（pre-flight 已处理），从 round 1 起才有 tool results 写入
    // Code 模式轮间压缩:95% 时提前触发,防止下一轮 LLM 调用时直接超限
    if (round > 0 && isCodeMode && !session.abortRequested && codeContextWindow > 0) {
      const estimatedNow =
        session.lastPromptTokens > 0 ? session.lastPromptTokens : session.estimatedTokens();
      if (estimatedNow / codeContextWindow >= 0.95) {
        console.log(
          `${logPrefix} ⚠️ Code 轮间检测到上下文达 ${Math.round((estimatedNow / codeContextWindow) * 100)}%(round ${round}),执行压缩`
        );
        await session.compressForCode();
        bus.emit({
          type: "turn:compress",
          reason: "pre-round-code",
          usageRatio: estimatedNow / codeContextWindow,
          msgCount: session.getMessages().length,
        });
      }
    }
    if (
      round > 0 &&
      !isCodeMode &&
      !session.abortRequested &&
      shouldSummarize(session.getMessages(), session.lastPromptTokens, session.lastResponseAt)
    ) {
      console.log(`${logPrefix} ℹ️ Chat session 轮间检测到上下文超限（round ${round}），执行压缩`);
      opts.onCompress?.("start");
      await session.compress();
      opts.onCompress?.("done");
      bus.emit({
        type: "turn:compress",
        reason: "pre-round-chat",
        usageRatio: session.estimatedTokens() / Math.max(1, llmRegistry.getContextWindow("daily", session.lastResponseAt)),
        msgCount: session.getMessages().length,
      });
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
    // 本次请求的完整消息：发出去的那一份，**同一个引用**也用于下面的构成统计
    // （不能事后重新取，压缩/注入都可能改变结果）
    const reqMessages = session.getMessagesForLLM();
    {
      // ── 并发限流：等待空闲 LLM slot（FIFO 排队）────────────────────────
      // 工具执行期间不占用 slot，仅在真正发起 LLM 请求时持有。
      // slotHeld 追踪当前是否持有 slot，防止 onRetryWait 和 finally 双重 release。
      let slotHeld = false;
      try {
        await acquireLLMSlot(llmAc.signal);
        slotHeld = true;
      } catch (err) {
        // acquire 被 AbortSignal 中断（软中断打断等待）
        break;
      }

      let streamBytes = 0;
      let lastProgressPrint = 0;
      // 会话级思考档位（`/think` 写入 sessions/<id>.toml，惰性读一次并缓存）。
      // 仅在 DeepSeek 系后端生效（client 用 backend.thinkingControl 把守）。
      const sessionThinking = session.getThinkingLevel();
      try {
        response = await client.streamChat(
          reqMessages,
          (delta) => {
            bus.emit({ type: "turn:chunk", delta });
            opts.onChunk?.(delta);
            streamBytes += Buffer.byteLength(delta, "utf8");
            const now = Date.now();
            if (now - lastProgressPrint >= 500) {
              lastProgressPrint = now;
              const kb = (streamBytes / 1024).toFixed(1);
              process.stdout.write(`\r${logPrefix} ▶ ${kb} KB`);
            }
          },
          {
            ...(tools.length > 0 && client.supportsToolCalls ? { tools, tool_choice: "auto" } : {}),
            signal: llmAc.signal,
            isUserInitiated: round === 0 && !opts.skipPreamble && !opts.continueAsAgentRound,
            taskId: agentTaskId,
            _retryHooks: {
              onRetryWait: () => {
                // 进入重试等待：归还 slot，其他请求可趁机推进
                if (slotHeld) {
                  releaseLLMSlot();
                  slotHeld = false;
                }
              },
              onRetryResume: async () => {
                // 重试等待结束：重新排队获取 slot（若 abort 则 throw）
                await acquireLLMSlot(llmAc.signal);
                slotHeld = true;
              },
            },
            // code 模式：首 chunk 后禁用 idle timeout（长代码生成 token 间隔可 >60s）
            // code 模式开启 thinking(内部推理),chat 模式不开启
            ...(isCodeMode ? { enableThinking: true } : {}),
            ...(isCodeMode ? { disableIdleAfterFirstChunk: true } : {}),
            // 会话级 `/think` 覆盖（优先级高于 backend.reasoningEffort）
            ...(sessionThinking ? { thinking: sessionThinking } : {}),
            // /retry 命令传入的 requestId override（首轮才有意义）
            ...(round === 0 && opts.turnRequestIdOverride
              ? { turnRequestIdOverride: opts.turnRequestIdOverride }
              : {}),
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
          round--; // 重新执行本轮
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
        // 异常退出路径也要清掉仲裁器的待触发计时器，否则可能在 run 结束后补发一条旁白
        purposeArbiter?.dispose();
        throw err;
      } finally {
        // LLM 请求已结束（无论成功/失败），释放 slot（若尚未被 onRetryWait 释放）
        if (slotHeld) {
          releaseLLMSlot();
          slotHeld = false;
        }
      }
    }

    lastUsage = response.usage;
    totalCompletionTokens += lastUsage.completionTokens;
    totalPromptTokens += lastUsage.promptTokens;
    totalCacheReadTokens += lastUsage.cacheReadTokens ?? 0;
    totalCacheCreationTokens += lastUsage.cacheCreationTokens ?? 0;
    bus.emit({
      type: "turn:usage",
      promptTokens: lastUsage.promptTokens,
      completionTokens: lastUsage.completionTokens,
      cacheReadTokens: lastUsage.cacheReadTokens ?? 0,
      cacheCreationTokens: lastUsage.cacheCreationTokens ?? 0,
    });
    // 记录到 session,供 /status 展示实际 token 用量
    session.lastPromptTokens = lastUsage.promptTokens;
    Session.persistPromptTokens(
      session.sessionId,
      session.mode === "code" ? "code" : "chat",
      lastUsage.promptTokens
    );
    // 记录该 session 最后一次 LLM 响应完成时刻(闲置判定 + crash 恢复用)
    session.lastResponseAt = Date.now();
    Session.persistLastResponseAt(
      session.sessionId,
      session.mode === "code" ? "code" : "chat",
      session.lastResponseAt
    );

    // ── Prompt 构成细分（Dashboard「Token」页）：每一轮 LLM 请求写一行 ──────────
    // 纪律（对齐 DSH dsh-token-meter）：构成是**启发式近似**，总量以提供方报告值为准；
    // 失败静默（DB 写不进去绝不能影响对话）。
    try {
      const breakdown = breakdownMessages(reqMessages, tools);
      const ctxWindow = llmRegistry.getContextWindow("daily", session.lastResponseAt);
      insertTokenBreakdown({
        session_id: session.sessionId,
        source: classifyTokenSource({
          sessionId: session.sessionId,
          mode: session.mode === "code" ? "code" : "chat",
          ...(opts.origin ? { origin: opts.origin } : {}),
        }),
        agent_id: session.agentId,
        model: String(client.model),
        round,
        actual_prompt: lastUsage.promptTokens,
        actual_output: lastUsage.completionTokens,
        cache_read: lastUsage.cacheReadTokens ?? 0,
        cache_write: lastUsage.cacheCreationTokens ?? 0,
        est_total: breakdown.estimatedTotal,
        message_tokens: breakdown.messageTokens,
        context_window: ctxWindow,
        session_tokens: session.estimatedTokens(),
        items: JSON.stringify(breakdown.items),
        top: JSON.stringify(breakdown.top),
        tools: JSON.stringify(breakdown.tools),
      });
    } catch (err) {
      console.warn(
        `${logPrefix} ⚠️ token 构成写入失败（不影响对话）：${err instanceof Error ? err.message : String(err)}`
      );
    }

    // ── Code 模式：调用后 Token 预算检查（用实际 promptTokens，比估算更准确）──
    // 放在 LLM 调用后，此时 lastPromptTokens 已是本轮真实值
    if (isCodeMode && !session.abortRequested) {
      // 实际值为 0（极少见）时 fallback 到字符估算
      const actualTokens =
        session.lastPromptTokens > 0 ? session.lastPromptTokens : session.estimatedTokens();
      if (codeContextWindow > 0) {
        const usageRatio = actualTokens / codeContextWindow;
        if (usageRatio >= CODE_CONTEXT_WARN_THRESHOLD) {
          console.log(
            `${logPrefix} ⚠️ Code context 已达 ${Math.round(usageRatio * 100)}%（实际 ${actualTokens} tokens），尝试滑动窗口压缩`
          );
          const compressed = await session.compressForCode();
          bus.emit({
            type: "turn:compress",
            reason: "post-call-code-95",
            usageRatio,
            msgCount: session.getMessages().length,
          });
          if (compressed) {
            const msgCount = session.getMessages().length;
            console.log(`${logPrefix} ✅ 压缩完成,消息数:${msgCount}`);
            void opts.onNotify?.(
              `⚠️ 上下文已达 ${Math.round(usageRatio * 100)}%，已自动压缩/截断历史工具结果以继续执行（当前消息数:${msgCount}）。`
            );
          } else {
            console.log(`${logPrefix} ⚠️ 压缩无效果(轮次不足或已最小化),上下文可能继续增长`);
            void opts.onNotify?.(
              `⚠️ 上下文已达 ${Math.round(usageRatio * 100)}%，压缩无效果，请考虑开启新会话。`
            );
          }
        } else if (usageRatio >= 0.75) {
          console.log(
            `${logPrefix} ℹ️ Code context 已达 ${Math.round(usageRatio * 100)}%（实际 ${actualTokens} tokens），静默压缩`
          );
          await session.compressForCode();
          bus.emit({
            type: "turn:compress",
            reason: "post-call-code-75",
            usageRatio,
            msgCount: session.getMessages().length,
          });
        }
      }
      // (post-call 绝对 token 数阈值压缩已移除：headers 修复后无 60s 超时，由正常滑动窗口处理)
    }

    const _parsed = parseResponse(response, textMode);
    let content = _parsed.content;
    const toolCalls = _parsed.toolCalls;

    // ── 格式纠错：检测格式错误并重提示（最多 1 次，不限 textMode）──────────
    // 根因：supportsToolCalls 默认 true → textMode=false，但模型仍可能输出裸 JSON
    if (!toolCalls || toolCalls.length === 0) {
      if (formatRetryPending) {
        // 已纠错一次，模型仍未使用正确格式 → 直接把原始输出返回给用户
        console.log(
          `${logPrefix} ❌ 格式纠错重试仍失败（textMode=${textMode}），返回原始输出：` +
            content.slice(0, 60).replace(/\n/g, " ") +
            (content.length > 60 ? "…" : "")
        );
        finalContent = content;
        session.addAssistantMessage(finalContent);
        formatRetryPending = false;
        break;
      }
      // textMode=true(不支持 function calling):检测疑似工具调用尝试
      // textMode=false(支持 function calling):不做格式检测,
      // 纠错注入的 <tool_call> XML 指令会误导支持 native tool_calls 的模型输出 XML 文本
      if (textMode) {
        const trimmedContent = content.trim();
        const looksLikeToolAttempt =
          trimmedContent.startsWith("{") ||
        /"(tool|function|exec_shell|tool_call)"\s*:/.test(trimmedContent);
        if (looksLikeToolAttempt) {
          console.log(
            `${logPrefix} ⚠️ 格式错误:无 tool_call(textMode=${textMode},round=${round}),` +
              `内容:${trimmedContent.slice(0, 60).replace(/\n/g, " ")}${trimmedContent.length > 60 ? "..." : ""}`
          );
          console.log(`${logPrefix} ⚠️ 注入格式纠错提示,重试本轮`);
          session.addAssistantMessage(content);
          session.addSystemMessage(
            "[format error] The tool-call format is wrong. Use exactly this format, with the whole reply " +
              "containing nothing but this block:\n" +
              "<tool_call>\n" +
              '{"name": "<tool_name>", "args": {"<param>": "<value>"}}\n' +
              "</tool_call>"
          );
          bus.emit({ type: "turn:format-retry", reason: "bare-json-without-tool-call" });
          formatRetryPending = true;
          continue;
        }
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
      // 中转站 canary 校验:检测 system prompt 是否在传输中被篡改/删除
      if (session.pendingCanaryNonce) {
        const _nonce = session.pendingCanaryNonce;
        session.pendingCanaryNonce = undefined;
        try {
          const _piCfg = loadConfig().auth.prompt_integrity;
          const _chk = checkCanary(content, _nonce);
          // strip 掉 canary 标记,避免泄露给用户
          content = stripCanary(content);
          bus.emit({ type: "turn:canary", ok: _chk.ok });
          if (!_chk.ok) {
            const _detail = _chk.found
              ? `回显 nonce 不匹配(期望 ${_nonce.slice(0, 6)}… 实得 ${_chk.gotNonce?.slice(0, 6)}…)`
              : `回复缺失完整性标记`;
            const _backend = isCodeMode ? "code" : "daily";
            const _msg =
              `🚨 中转站篡改告警:${_detail}\n` +
              `   backend=${_backend} 可能存在中转站(proxy/relay)删改了 system prompt,\n` +
              `   或当前模型指令遵循能力不足导致误报。\n` +
              `   建议:核查 provider baseUrl 是否为可信端点;持续告警请勿信任该 backend。`;
            console.warn(`[prompt-integrity] ${_msg}`);
            await opts.onNotify?.(_msg);
            if (_piCfg.mode === "halt") {
              finalContent = content;
              session.addAssistantMessage(finalContent);
              throw new PromptIntegrityError(_msg, "canary", _backend);
            }
          }
        } catch (e) {
          if (e instanceof PromptIntegrityError) throw e;
          // 配置/校验异常仅 strip,不阻断
          content = stripCanary(content);
        }
      }
      // ── 空回复守卫（2026-09-13）──────────────────────────────────────────
      // 模型**没有工具调用但正文为空**时不能当作最终回复：实测 flash 级模型在超长会话里
      // 会把输出预算全用在思考里、甚至退化成同一句的无限重复（reasoning_content 里
      // "好。写。好。发送。…"），content 为空 —— 旧行为直接收尾，用户只看到兜底「✅ 已完成」。
      // 这里：记日志（含 finish_reason / 退化检测）+ 注入纠偏提示**重试本轮一次**。
      if (!emptyRetryPending && !content.trim()) {
        const reasoning = _parsed.reasoningContent ?? "";
        const rep = detectReasoningRepetition(reasoning);
        emptyReplyKind =
          response.finishReason === "length" ? "length" : rep.degenerate ? "degenerate" : "silent";
        console.warn(
          `${logPrefix} ⚠️ 收到空回复（finish_reason=${response.finishReason ?? "?"}, ` +
            `reasoning=${reasoning.length} 字符, 单元=${rep.units}/去重=${rep.uniqueUnits}` +
            `${rep.degenerate ? `, **reasoning 重复退化**："${rep.repeatedLine}" ×${rep.repeats}` : ""}）` +
            `→ 注入纠偏提示并重试本轮`
        );
        try {
          const KEY = "empty_reply";
          if (!isMetricKeyAllowed("llm", KEY)) {
            addMetricKey("llm", KEY, "空回复次数（思考退化/长度截断）", "bar");
          }
          insertMetric({ category: "llm", key: KEY, value: 1, note: emptyReplyKind });
        } catch {
          /* 指标写入失败不影响主流程 */
        }
        emptyRetryPending = true;
        session.addSystemMessage(emptyReplyNudge(emptyReplyKind));
        continue;
      }

      finalContent = content;
      session.addAssistantMessage(finalContent, _parsed.reasoningContent);
      bus.emit({ type: "turn:assistant", content, hasToolCalls: false });
      break;
    }

    // 有工具调用 → 执行并将结果追加到 messages
    // function calling 模式：assistant 消息需携带 tool_calls 数组（供 API 匹配 tool_call_id）
    // 文本模式：普通 assistant 消息即可
    // 过滤掉 null/undefined（LLM 返回稀疏 index 时可能出现），避免孤立 tool_call_id
    const validToolCalls = toolCalls.filter(Boolean);
    let interruptEmitted = false;
    if (!textMode) {
      session.addAssistantWithToolCalls(content || "", validToolCalls, _parsed.reasoningContent);
    } else {
      session.addAssistantMessage(content || "", _parsed.reasoningContent);
    }
    bus.emit({ type: "turn:assistant", content: content || "", hasToolCalls: true });

    // tool call 伴随的文本内容（如"好的，我来查一下"）也发给用户
    if (content && content.trim() && opts.onNotify) {
      const accompanied = content.startsWith("<img") ? content : `💬 [AI]\n${content.trim()}`;
      void opts.onNotify(accompanied);
    }

    // ── 工具执行（支持批量并发）────────────────────────────────────────────
    //
    // 并发策略：
    //   - 需要用户交互的工具(ask_user / notify_user / MFA 工具)必须串行
    //   - agent_fork 涉及子 agent 状态,必须串行
    //   - 其余只读/幂等工具（exec_shell、read_file、mcp_*、search_store 等）可并发
    //
    // 并发执行时，结果按原始顺序写入 session，保证 function calling 模式下
    // tool_call_id 与 assistant.tool_calls[] 的顺序严格对应。
    //
    // 并发分批：遇到必须串行的工具时，先 flush 前面积累的并发批次，
    // 再串行执行该工具，然后继续下一批。
    // ─────────────────────────────────────────────────────────────────────────
    /** 同一轮 LLM 输出中只允许一次 ask_user（强制串行单次）*/
    let hasAskedUser = false;
    const SERIAL_TOOLS = new Set([
      "ask_user",
      "notify_user",
      "send_report",
      "render_diagram",
      "agent_fork",
      "exit_plan_mode",
      "create_skill",
      "session_send",
      "restart_tool", // 触发 process.exit，必须串行且需提前写 tool result
      "read_image", // 读图后需注入 image_path/vision描述，必须串行避免穿插在 tool_result 之间
    ]);

    /**
     * 执行单个工具调用，返回结果字符串（已截断）。
     * 不写 session，仅返回结果供上层按顺序写入。
     */
    const runOneTool = async (call: (typeof validToolCalls)[number]): Promise<string> => {
      const toolDef = getTool(call.name);
      if (!toolDef) {
        bus.emit({ type: "tool:blocked", name: call.name, reason: "unknown" });
        return "未知工具";
      }

      // ── 剥离框架保留字段 `__purpose` ────────────────────────────────────
      // 工具实现与 MCP server 永远看不到它；文本模式（<tool_call>）走的是同一条路径。
      const { args: toolArgs, purpose: rawPurpose } = stripReservedArgs(
        call.args as Record<string, unknown>
      );
      const purpose = agentPurposeCfg.toolPurpose
        ? normalizePurpose(rawPurpose, agentPurposeCfg.purposeMaxUnits)
        : undefined;

      const callSummary = toolCallSummary(call.name, toolArgs);
      toolCallSummaries.push(callSummary);
      console.log(`${logPrefix} tool: ${callSummary}${purpose ? ` 「${purpose}」` : ""}`);
      bus.emit({
        type: "tool:call",
        name: call.name,
        args: toolArgs,
        summary: callSummary,
        round,
        ...(purpose ? { purpose } : {}),
      });
      const toolStartMs = Date.now();
      if (call.name !== "notify_user") {
        toolThrottler?.add(call.name);
      }
      opts.onToolCall?.(call.name, toolArgs, purpose ? { purpose } : undefined);
      // 交给仲裁器：快工具不会被展示，慢工具到点才展示
      purposeArbiter?.onToolStart(call.name, purpose);

      let result: string;
      let err0: unknown;
      const currentDepth = opts.slaveDepth ?? 0;
      try {
        result = await executeTool(call.name, toolArgs, {
          cwd:
            isCodeMode && session.codeWorkdir
              ? session.codeWorkdir
              : agentManager.workspaceDir(session.agentId),
          sessionId: session.sessionId,
          mode: isCodeMode ? "code" : "chat",
          agentId: session.agentId,
          ...(opts.botId !== undefined ? { botId: opts.botId } : {}),
          masterSession: session,
          ...(session.currentAgentTaskId ? { agentTaskId: session.currentAgentTaskId } : {}),
          ...(!textMode && call.callId ? { currentCallId: call.callId } : {}), // function calling 模式下注入 callId，供 restart_tool 等在 process.exit 前写 tool result
          ...(currentDepth < MAX_SLAVE_DEPTH
            ? {
                slaveRunFn: (s, c, o) =>
                  runAgent(s, c, {
                    ...o,
                    slaveDepth: currentDepth + 1,
                    // 子 Agent 的审批策略钉死为 never（对齐 DSH 委派语义）：
                    // 它只能在委派时定下的作用域里干活，不能弹 MFA / 提权 / ask_user。
                    approvalPolicy: "never",
                    ...(opts.onNotify ? { onNotify: opts.onNotify } : {}),
                  }),
              }
            : {}),
          ...(opts.onSlaveComplete ? { onSlaveComplete: opts.onSlaveComplete } : {}),
          ...(opts.onProgressNotify ? { onProgressNotify: opts.onProgressNotify } : {}),
          ...(opts.onNotify ? { onNotify: opts.onNotify } : {}),
          ...(opts.onPlanRequest ? { onPlanRequest: opts.onPlanRequest } : {}),
          ...(opts.onAskUser ? { onAskUser: opts.onAskUser } : {}),
          ...(opts.onMFARequest ? { onMFARequest: opts.onMFARequest } : {}),
          ...(opts.sessionSendFn ? { sessionSendFn: opts.sessionSendFn } : {}),
          ...(opts.sessionGetFn ? { sessionGetFn: opts.sessionGetFn } : {}),
          ...(opts.onLoopExit ? { onLoopExit: opts.onLoopExit } : {}),
          ...(opts.sandboxExtraRwPaths ? { sandboxExtraRwPaths: opts.sandboxExtraRwPaths } : {}),
          ...(opts.sandboxSecretNames ? { sandboxSecretNames: opts.sandboxSecretNames } : {}),
          ...(opts.origin ? { origin: opts.origin } : {}),
          ...(opts.approvalPolicy ? { approvalPolicy: opts.approvalPolicy } : {}),
        });
      } catch (err) {
        err0 = err;
        if (err instanceof PlanAbortError) {
          // exit_plan_mode 被用户新消息中断:用"未执行"消息替代 approved:false，避免 AI 误判继续执行
          result = "操作被用户新消息中断，此工具调用未执行";
        } else if (err instanceof MFAError) {
          result = `操作被取消：${err.message}`;
        } else {
          result = `工具执行错误：${err instanceof Error ? err.message : String(err)}`;
        }
      }

      // 工作区指令：fs 工具（读/写/改/删）成功后重新协调 —— 身份变了只追加 diff，基线丢失则补发。
      // 参考 DSH `dsh-agent-instructions`：`tools/result` 后重算、`agent/pre-step` 前同步。
      if (err0 === undefined && WORKSPACE_TOUCHING_TOOLS.has(call.name)) {
        const _touched = String(toolArgs["path"] ?? "");
        if (_touched) {
          try {
            const _touchedAbs = isAbsolute(_touched)
              ? _touched
              : resolvePath(runToolCwd(session, isCodeMode), _touched);
            const _ws = pushWorkspaceInstructionDeltas(session, runToolCwd(session, isCodeMode), [
              _touchedAbs,
            ]);
            if (_ws.pushed) {
              console.log(
                `${logPrefix} 📄 workspace instructions: ${_ws.action}（${call.name} → ${_touched}）`
              );
            }
          } catch {
            /* 协调失败不影响工具结果 */
          }
        }
      }

      // 工具结果截断
      // 工具结果截断：头 70% + 尾 30%，保留尾部关键信息（退出码/报错结尾/最终结果），
      // 中间省略部分用标记连接。纯保留头部会丢失 exec_shell 等命令的关键尾部输出。
      const maxResultChars = loadConfig().tools.maxToolResultChars;
      if (maxResultChars > 0 && result.length > maxResultChars) {
        const origLen = result.length;
        const headLen = Math.floor(maxResultChars * 0.7);
        const tailLen = maxResultChars - headLen;
        const omitted = origLen - maxResultChars;
        result =
          result.slice(0, headLen) +
          `\n\n[...内容过长，已省略中间 ${omitted} 字符（原始 ${origLen} 字符）。保留头 ${headLen} + 尾 ${tailLen} 字符。如需完整内容请缩小范围重新调用...]\n\n` +
          result.slice(origLen - tailLen);
      }
      const toolDurationMs = Date.now() - toolStartMs;
      // 审计：成功路径也留痕（决策 + 耗时 + 意图），便于事后回答"它到底做了什么"
      auditToolCall({
        event: "tool",
        origin: opts.origin,
        agentId: session.agentId,
        sessionId: session.sessionId,
        tool: call.name,
        decision: err0 ? "deny" : "allow",
        args: toolArgs,
        ...(purpose ? { purpose } : {}),
        durationMs: toolDurationMs,
        ...(err0 ? { error: err0 instanceof Error ? err0.message : String(err0) } : {}),
        cfg: loadConfig().sandbox,
      });
      opts.onToolResult?.(call.name, result);
      bus.emit({
        type: "tool:result",
        name: call.name,
        durationMs: toolDurationMs,
        truncated: result.includes("[...内容过长"),
      });
      // 工具结束 → 仲裁器的 T2 触发点（长工具刚收尾且无在跑工具时展示它的 purpose）
      purposeArbiter?.onToolEnd(call.name, toolDurationMs);

      // ── Prompt Injection 检测 ────────────────────────────────────────────
      const injAlert = detectPromptInjection(call.name, result, loadConfig());
      if (injAlert) {
        console.warn(
          `[security] prompt injection detected in tool "${call.name}": ${injAlert.pattern} | snippet: ${injAlert.snippet}`
        );
        void opts.onNotify?.(
          `⚠️ **[安全警告] 检测到疑似提示词注入！**\n` +
            `工具: \`${call.name}\`\n` +
            `规则: ${injAlert.pattern}\n` +
            `片段: \`${injAlert.snippet}\`\n\n` +
            `可疑内容已自动屏蔽，建议检查该工具的数据来源。`
        );
        result = injAlert.sanitized;
      }

      return result;
    };

    // ── roundPendingUserMsgs ─────────────────────────────────────────────────
    // 整轮工具调用期间需要延迟追加的 user 消息（image_path / 图片描述等）。
    // 必须等当前轮次所有 tool_result 全部写完后再统一注入，以保证消息链为：
    //   assistant([A, B]) → tool(A) → tool(B) → user(image)
    // 而非夹在中间（如 tool(A) → user(image) → tool(B)）触发 Anthropic API 400。
    //
    // 根因：read_image 是 SERIAL 工具，exec_shell 等是 CONCURRENT 工具。
    // 当 LLM 同时调用两者时，read_image 先串行执行并调用 flushResults，
    // 若在 flushResults 内追加 user(image_path)，此时 exec_shell 的 tool_result
    // 还未写入，user 消息就会夹在两个 tool_result 之间。
    // 解决方案：将 pendingUserMsgs 提升到 for 循环外部，统一在末尾写入。
    type PendingMsg = string | import("../llm/client.js").ContentPart[];
    const roundPendingUserMsgs: PendingMsg[] = [];

    /** 将本轮积累的 pendingUserMsgs 统一写入 session 并清空。 */
    const flushRoundPendingUserMsgs = () => {
      for (const msg of roundPendingUserMsgs) {
        if (typeof msg === "string") {
          session.addUserMessage(msg);
        } else {
          session.addUserMessage(msg as import("../llm/client.js").ContentPart[]);
        }
      }
      roundPendingUserMsgs.length = 0;
    };

    /** 将 (call, result) 列表按顺序写入 session */
    const flushResults = async (
      pairs: Array<{ call: (typeof validToolCalls)[number]; result: string }>
    ) => {
      // 注意：此函数只写 tool_result，不追加 user 消息。
      // image_path 等延迟消息统一收集到外部 roundPendingUserMsgs，
      // 由调用方在所有工具执行完毕后调用 flushRoundPendingUserMsgs() 统一注入。
      for (const { call, result } of pairs) {
        if (!textMode) {
          // read_image tool 返回 data URL 时,改用路径引用存储,避免 base64 写入 JSONL
          // 从 call.args 取原始路径,tool result 存路径占位,注入 image_path 供 resolveMessagesForApi 按需编码
          if (call.name === "read_image" && result.startsWith("data:image/")) {
            const origPath = String((call.args as Record<string, unknown>)["path"] ?? "");
            session.addToolResultMessage(
              call.callId,
              origPath ? `[image loaded: ${origPath}]` : result
            );
            if (origPath) {
              // 仅当主模型支持视觉时才注入 image_path,避免将图片传给不支持视觉的模型(如 deepseek)
              if (client.supportsVision) {
                roundPendingUserMsgs.push([{ type: "image_path" as const, path: origPath }]);
              }
              if (visionClient) {
                const customPrompt =
                  typeof (call.args as Record<string, unknown>)["prompt"] === "string"
                    ? ((call.args as Record<string, unknown>)["prompt"] as string)
                    : undefined;
                const visResult = await describeImageWithVisionFallback(
                  origPath,
                  visionClient,
                  customPrompt
                );
                if (visResult) {
                  roundPendingUserMsgs.push(`[image description ${origPath}]:\n${visResult.description}`);
                  totalVisionPromptTokens += visResult.usage.promptTokens;
                  totalVisionCompletionTokens += visResult.usage.completionTokens;
                  totalVisionCacheReadTokens += visResult.usage.cacheReadTokens ?? 0;
                  totalVisionCacheCreationTokens += visResult.usage.cacheCreationTokens ?? 0;
                }
              }
            }
          } else {
            session.addToolResultMessage(call.callId, result);
          }
          // MCP tool 返回了图片(如截图),直接注入视觉上下文
          if (result.includes("__MCP_IMAGE__:")) {
            const lines = result.split("\n");
            const imgPaths: string[] = [];
            for (const line of lines) {
              if (line.startsWith("__MCP_IMAGE__:")) {
                imgPaths.push(line.slice("__MCP_IMAGE__:".length).trim());
              }
            }
            for (const imgPath of imgPaths) {
              if (client.supportsVision) {
                roundPendingUserMsgs.push([{ type: "image_path" as const, path: imgPath }]);
              }
              if (visionClient) {
                const visResult = await describeImageWithVisionFallback(imgPath, visionClient);
                if (visResult) {
                  roundPendingUserMsgs.push(`[image description ${imgPath}]:\n${visResult.description}`);
                  totalVisionPromptTokens += visResult.usage.promptTokens;
                  totalVisionCompletionTokens += visResult.usage.completionTokens;
                  totalVisionCacheReadTokens += visResult.usage.cacheReadTokens ?? 0;
                  totalVisionCacheCreationTokens += visResult.usage.cacheCreationTokens ?? 0;
                }
              }
            }
          }
        } else {
          session.addSystemMessage(`[tool_result:${call.name}]\n${result}`);
        }
      }
      // ⚠️ 不在此处追加 user 消息，由外部 flushRoundPendingUserMsgs() 统一处理
    };
    // 积累并发批次，遇到串行工具时先 flush 再串行执行
    let concurrentBatch: (typeof validToolCalls)[number][] = [];

    const flushConcurrentBatch = async () => {
      if (concurrentBatch.length === 0) return;
      const batch = concurrentBatch;
      concurrentBatch = [];
      bus.emit({
        type: "tool:batch",
        mode: batch.length === 1 ? "sequential" : "parallel",
        names: batch.map((c) => c.name),
      });
      if (batch.length === 1) {
        // 单个工具无需 Promise.all 开销
        const result = await runOneTool(batch[0]!);
        await flushResults([{ call: batch[0]!, result }]);
      } else {
        // 并发执行，结果按原始顺序收集
        const results = await Promise.all(batch.map((c) => runOneTool(c)));
        await flushResults(batch.map((call, i) => ({ call, result: results[i]! })));
      }
    };

    for (const call of validToolCalls) {
      // ── 软中断检测 ────────────────────────────────────────────────────
      if (session.abortRequested) {
        await flushConcurrentBatch();
        if (!interruptEmitted) {
          interruptEmitted = true;
          bus.emit({ type: "user:interrupt" });
        }
        bus.emit({ type: "tool:blocked", name: call.name, reason: "interrupted" });
        if (!textMode) {
          session.addToolResultMessage(call.callId, "操作被用户新消息中断，此工具调用未执行");
        } else {
          session.addSystemMessage(
            `[tool_result:${call.name}]\n操作被用户新消息中断，此工具调用未执行`
          );
        }
        continue;
      }

      const toolDef = getTool(call.name);
      if (!toolDef) {
        await flushConcurrentBatch();
        bus.emit({ type: "tool:blocked", name: call.name, reason: "unknown" });
        if (!textMode) {
          session.addToolResultMessage(call.callId, "未知工具");
        } else {
          session.addSystemMessage(`[tool_result:${call.name}]\n未知工具`);
        }
        continue;
      }

      toolsUsed.push(call.name);

      // ── 无人值守策略（cron / loop）：白名单外直接拒绝 ────────────────────
      // 这两条路径没有人能审批，所以只能靠事前白名单；审计在策略模块内落盘。
      const sandboxCfg = loadConfig().sandbox;
      const policyStripped = stripReservedArgs(call.args as Record<string, unknown>);
      const policyArgs = policyStripped.args;
      const policyDecision = enforceUnattendedTool({
        toolName: call.name,
        origin: opts.origin,
        // ReAct 通道：模型临场挑选的工具调用（与 job 配置里声明式的 steps 区别对待）
        channel: "react",
        agentId: session.agentId,
        sessionId: session.sessionId,
        cfg: sandboxCfg,
      });
      if (!policyDecision.allow) {
        auditToolCall({
          event: "policy",
          origin: opts.origin,
          agentId: session.agentId,
          sessionId: session.sessionId,
          tool: call.name,
          decision: "deny",
          reason: "无人值守白名单外",
          args: policyArgs,
          ...(policyStripped.purpose ? { purpose: policyStripped.purpose } : {}),
          cfg: sandboxCfg,
        });
        const denyMsg = policyDecision.reason ?? `已拒绝：${call.name}`;
        if (!textMode) session.addToolResultMessage(call.callId, denyMsg);
        else session.addSystemMessage(`[tool_result:${call.name}]\n${denyMsg}`);
        continue;
      }

      // ── MFA 检查(需要用户交互,先 flush 并发批次再串行)────────────
      const mfaCfg = loadConfig().auth.mfa;
      // MFA 判定与提示文案都用"剥离保留字段后"的参数，避免 __purpose 混进警告文本
      const mfaArgs = policyArgs;
      // 自指权限 / fs_grant 授权豁免：只动"自己范围"的写操作不再逐次要求 MFA
      const selfAccessCfg = loadConfig().selfAccess;
      const selfAccessExempt =
        selfAccessCfg.exemptMfa &&
        argsAreWithinOwnScope(mfaArgs, { agentId: session.agentId, masterSession: session });
      if (
        (toolNeedsMFA(call.name, mfaArgs, mfaCfg) || getTool(call.name)?.requiresMFA) &&
        !selfAccessExempt &&
        !session.mfaApprovedForThisRun &&
        !session.mfaPreApproved
      ) {
        // 子 Agent（approvalPolicy="never"）不允许任何审批：确定性拒绝，连提示都不发。
        // 对应 DSH 委派子 Agent 时的 approvalPolicy 钉死为 never。
        if (opts.approvalPolicy === "never") {
          const msg = "已拒绝：子 Agent 不允许发起审批（approvalPolicy=never），请在委派范围内完成";
          auditToolCall({
            event: "mfa",
            origin: opts.origin,
            agentId: session.agentId,
            sessionId: session.sessionId,
            tool: call.name,
            decision: "deny",
            reason: "子 Agent approvalPolicy=never",
            args: mfaArgs,
            ...(policyStripped.purpose ? { purpose: policyStripped.purpose } : {}),
            cfg: sandboxCfg,
          });
          bus.emit({ type: "mfa:denied" });
          if (!textMode) session.addToolResultMessage(call.callId, msg);
          else session.addSystemMessage(`[tool_result:${call.name}]\n${msg}`);
          continue;
        }
        await flushConcurrentBatch();
        bus.emit({ type: "mfa:prompt", message: describeToolCall(call.name, mfaArgs) });
        let mfaPassed = false;
        let mfaFailOpen = false;
        try {
          if (mfaCfg?.interface === "msal") {
            await requireMFA(opts.onMFAPrompt);
            opts.onMFAPrompt?.("✓ MFA 已通过，继续执行");
            mfaPassed = true;
          } else if (mfaCfg?.interface === "totp") {
            if (opts.onMFARequest) {
              const desc = describeToolCall(call.name, mfaArgs);
              const secretPath = mfaCfg.totpSecretPath;
              mfaPassed = await opts.onMFARequest(
                `⚠️ 即将执行：${desc}\n请打开 Authenticator App，将当前 6 位验证码回复给我（30 秒内有效）`,
                (code: string) => verifyTOTP(code, secretPath)
              );
              if (!mfaPassed) opts.onMFAPrompt?.("✗ TOTP 验证失败，操作已取消");
            } else {
              mfaPassed = true;
              mfaFailOpen = true;
            }
          } else if (opts.onMFARequest) {
            const desc = describeToolCall(call.name, mfaArgs);
            mfaPassed = await opts.onMFARequest(`⚠️ 即将执行：${desc}\n请回复 确认 / 取消`);
            if (!mfaPassed) opts.onMFAPrompt?.("✗ MFA 被拒绝，操作已取消");
          } else {
            mfaPassed = true;
            mfaFailOpen = true;
          }
        } catch {
          const msg = "操作被取消：MFA 未通过";
          bus.emit({ type: "mfa:timeout" });
          if (!textMode) session.addToolResultMessage(call.callId, msg);
          else session.addSystemMessage(`[tool_result:${call.name}]\n${msg}`);
          continue;
        }

        // 无交互回调（无人值守）时的兜底：默认拒绝，而不是静默放行
        if (mfaFailOpen) {
          const fallback = unattendedMfaFallback({
            toolName: call.name,
            origin: opts.origin,
            agentId: session.agentId,
            sessionId: session.sessionId,
            cfg: sandboxCfg,
          });
          if (!fallback.allow) {
            auditToolCall({
              event: "mfa",
              origin: opts.origin,
              agentId: session.agentId,
              sessionId: session.sessionId,
              tool: call.name,
              decision: "deny",
              reason: "无交互回调且 unattended.mfaFallback=deny",
              args: mfaArgs,
              ...(policyStripped.purpose ? { purpose: policyStripped.purpose } : {}),
              cfg: sandboxCfg,
            });
            bus.emit({ type: "mfa:denied" });
            const msg = fallback.reason ?? "操作被取消：无人值守且无法进行 MFA 确认";
            if (!textMode) session.addToolResultMessage(call.callId, msg);
            else session.addSystemMessage(`[tool_result:${call.name}]\n${msg}`);
            continue;
          }
        }

        if (!mfaPassed) {
          bus.emit({ type: "mfa:denied" });
          const msg = "操作被取消：用户拒绝了 MFA 确认";
          if (!textMode) session.addToolResultMessage(call.callId, msg);
          else session.addSystemMessage(`[tool_result:${call.name}]\n${msg}`);
          continue;
        }
        session.mfaApprovedForThisRun = true;
        bus.emit({ type: "mfa:approved" });
      }

      // ── 分类:串行工具先 flush 再单独执行;其余加入并发批次 ──────────
      if (SERIAL_TOOLS.has(call.name)) {
        await flushConcurrentBatch();
        bus.emit({
          type: "tool:serial",
          name: call.name,
          reason:
            call.name === "ask_user"
              ? "ask_user"
              : call.name === "agent_fork"
                ? "fork"
                  : call.name === "restart_tool"
                    ? "restart"
                    : "limit",
        });
        // restart_tool 必须等本轮所有其他工具执行完再重启
        if (call.name === "restart_tool") {
          const restIdx = validToolCalls.indexOf(call);
          const pending = validToolCalls.slice(restIdx + 1);
          if (pending.length > 0) {
            // 先把剩余工具全部串行/并发执行完
            for (const later of pending) {
              if (!later) continue;
              if (SERIAL_TOOLS.has(later.name) && later.name !== "restart_tool") {
                await flushConcurrentBatch();
                const r = await runOneTool(later);
                await flushResults([{ call: later, result: r }]);
              } else if (!SERIAL_TOOLS.has(later.name)) {
                concurrentBatch.push(later);
              }
            }
            await flushConcurrentBatch();
          }
        }
        // ask_user 同一轮只允许一次
        if (call.name === "ask_user" && hasAskedUser) {
          const skipMsg = "skipped: only one ask_user allowed per turn";
          if (!textMode) session.addToolResultMessage(call.callId, skipMsg);
          else session.addSystemMessage(`[tool_result:${call.name}]\n${skipMsg}`);
          continue;
        }
        if (call.name === "ask_user") hasAskedUser = true;

        const result = await runOneTool(call);
        await flushResults([{ call, result }]);
        // ask_user 执行后,同轮剩余工具全部 skip,等用户回复后 LLM 再决定
        if (call.name === "ask_user") {
          // 若用户回复携带图片，在 tool_result 之后注入 image_path 供 LLM 查看
          try {
            const parsed = JSON.parse(result) as { image_paths?: string[] };
            if (parsed.image_paths && parsed.image_paths.length > 0) {
              const imgParts: import("../llm/client.js").ContentPart[] = parsed.image_paths.map(
                (p) => ({ type: "image_path" as const, path: p })
              );
              session.addUserMessage(imgParts);
              if (!client.supportsVision && visionClient) {
                for (const p of parsed.image_paths) {
                  const visResult = await describeImageWithVisionFallback(p, visionClient);
                  if (visResult) {
                    session.addUserMessage(`[image description ${p}]:\n${visResult.description}`);
                    totalVisionPromptTokens += visResult.usage.promptTokens;
                    totalVisionCompletionTokens += visResult.usage.completionTokens;
                    totalVisionCacheReadTokens += visResult.usage.cacheReadTokens ?? 0;
                    totalVisionCacheCreationTokens += visResult.usage.cacheCreationTokens ?? 0;
                  }
                }
              }
            }
          } catch {
            /* ignore */
          }
          for (const remaining of validToolCalls.slice(validToolCalls.indexOf(call) + 1)) {
            if (!remaining) continue;
            const skipMsg = "skipped: ask_user is pending, waiting for user reply";
            if (!textMode) session.addToolResultMessage(remaining.callId, skipMsg);
            else session.addSystemMessage(`[tool_result:${remaining.name}]\n${skipMsg}`);
          }
          // ask_user 前先注入积累的 image_path 消息（若有），确保不被 break 丢弃
          flushRoundPendingUserMsgs();
          break;
        }
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
    // 所有工具结果写完后，统一追加本轮积累的 image_path / 图片描述等 user 消息
    flushRoundPendingUserMsgs();

    // ── Project switch 处理 ─────────────────────────────────────────
    // project_switch 工具可能在本轮执行。为避免 task 注入打断 tool_result
    // 序列（导致 400），handler 仅设置 _projectJustSwitched + _pendingProjectTask，
    // 在此处本轮所有 tool_result 写入完成后统一注入 + 重建 system prompt。
    if (session._projectJustSwitched && session._pendingProjectTask) {
      // 从跳板文件读取 projectSlug(在所有 tool_result 写入完成后才生效)
      const { getProjectBinding } = await import("../core/project-router.js");
      const bound = getProjectBinding(session.sessionId);
      if (bound) session.projectSlug = bound;

      session.addUserMessage(session._pendingProjectTask);
      if (isCodeMode && session.projectSlug) {
        const pctx = loadProjectContext(session.agentId, session.projectSlug);
        session.codeWorkdir = pctx.workdir;
        const _codeProvider =
          (() => {
            try {
              return loadConfig().llm.backends["code"]?.model.split("/")[0];
            } catch {
              return undefined;
            }
          })() ?? undefined;
        const projOpts = {
          sessionId: session.sessionId,
          supportsVision: client.supportsVision,
          ...(_codeProvider ? { currentProvider: _codeProvider } : {}),
        };
        const newSysPrompt = buildProjectSystemPrompt(session.agentId, pctx, projOpts);
        // 同样走缓存友好的应用路径（内容变化 → 追加到尾部，而非原地重写前缀）
        session.applySystemPrompt(newSysPrompt);
      }
      session._projectJustSwitched = false;
      delete session._pendingProjectTask;
    }

    // 一整批工具处理完，若已中断则退出轮次循环
    if (session.abortRequested) break;

    // ── Auto-fork 检查：超过阈值时将剩余任务交给 Slave 继续执行 ──────────
    // Code 模式是有状态的交互会话（工作区、plan 子模式等），不应 auto-fork
    {
      const threshold = opts.autoForkThresholdMs ?? loadConfig().agent.autoForkThresholdMs;
      if (
        threshold > 0 &&
        !isSlave &&
        !isCodeMode &&
        (opts.slaveDepth ?? 0) === 0 &&
        opts.onSlaveComplete !== undefined &&
        Date.now() - startMs > threshold
      ) {
        const continuationRunFn = (s: Session, c: string, o?: Record<string, unknown>) =>
          runAgent(s, c, {
            ...(o as AgentRunOptions),
            slaveDepth: 1,
            ...(opts.onNotify ? { onNotify: opts.onNotify } : {}),
          });
        const slaveId = slaveManager.forkContinuation(
          session,
          continuationRunFn,
          opts.onSlaveComplete,
          opts.onProgressNotify
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
            "[system] The maximum number of tool-calling rounds for this run is reached; no more tools " +
            "can be called. In this reply:\n" +
            "1. summarise the work completed so far;\n" +
            "2. list the tasks still unfinished;\n" +
            "3. tell the user they can send a new message (e.g. \"continue\") to carry on.\n" +
            "Do not call any tool. Reply in the user's own language.",
        },
      ];
      try {
        const summary = await client.chat(summaryMessages, {
          signal: llmAc.signal,
        });
        finalContent = summary.content;
        session.addAssistantMessage(finalContent, summary.reasoningContent);
      } catch (err) {
        if (err instanceof Error && (err.name === "AbortError" || err.message.includes("abort"))) {
          break;
        }
        throw err;
      }
    }
  }

  // 5. JSONL 持久化：各消息在 addUserMessage / addAssistantMessage 等调用时已逐条写入，无需在此重复。

/**
 * 阶段 3: 收尾(finalize)。压缩检查、diary 蒸馏、PLAN.md 日志、dashboard 统计、agent:end。
 * 事件流化拆分(提交 2):逻辑与原 runAgentInner 尾部完全一致,仅物理移动。
 */
async function finalizeRun(ctx: FinalizeContext): Promise<AgentRunResult> {
  // 6. 检查是否需要压缩（工具调用后 session 继续增长，此处再次检查；code 模式跳过）
  // 使用最后一轮实际 promptTokens（比字符估算更准确）
  if (!session.abortRequested && !isCodeMode) {
    if (shouldSummarize(session.getMessages(), lastUsage.promptTokens, session.lastResponseAt)) {
      opts.onCompress?.("start");
      const summary = await session.compress();
      opts.onCompress?.("done", summary);
    }
  }

  // Code 模式：无论是否被用户中断，run 结束时都尝试压缩，防止下次运行时 context 超限
  if (isCodeMode && !isSlave) {
    await session
      .compressForCode()
      .catch((e) =>
        console.warn("[agent] post-run code compress failed:", e instanceof Error ? e.message : e)
      );
  }

  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  const contextWindow = llmRegistry.getContextWindow(isCodeMode ? "code" : "daily", session.lastResponseAt);
  const fmtK = (n: number) => (n >= 1000 ? `${Math.floor(n / 1000)}k` : String(n));
  // 缓存命中率：命中 token 占本轮 run 输入 token 的比例（服务端 KV cache 复用情况）。
  // 前缀稳定性优化（system prompt 冻结 / 注入只追加）的收益直接体现在这个数字上。
  const cacheHitRate = totalPromptTokens > 0 ? totalCacheReadTokens / totalPromptTokens : 0;
  session.lastCacheReadTokens = totalCacheReadTokens;
  session.lastCacheHitRate = cacheHitRate;
  const cacheInfo = totalPromptTokens > 0 ? ` cache ${Math.round(cacheHitRate * 100)}%` : "";
  const tokenInfo = `${fmtK(lastUsage.promptTokens)}/${fmtK(contextWindow)}${cacheInfo}`;
  if (toolsUsed.length > 0) {
    console.log(
      `${logPrefix} → done in ${elapsed}s (tools: ${[...new Set(toolsUsed)].join(", ")}) [${tokenInfo}]`
    );
  } else {
    console.log(`${logPrefix} → done in ${elapsed}s [${tokenInfo}]`);
  }

  // flush 剩余工具调用通知，清理定时器
  toolThrottler?.stop();
  // 仲裁器收尾：清掉所有待触发的 purpose 计时器，避免运行结束后还补发旁白
  purposeArbiter?.dispose();

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
        if (!lastUser && m.role === "user" && !Session.isInjectedUserMessage(m)) lastUser = m;
        if (lastUser && lastAssistant) break;
      }
      if (lastUser && lastAssistant) {
        distillTurnToDiary(lastUser, lastAssistant, session.agentId)
          .then(() => bus.emit({ type: "finalize:diary", ok: true }))
          .catch((err) =>
            console.warn(
              "[agent] chat diary distill failed:",
              err instanceof Error ? err.message : err
            )
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
        appendFileSync(planPath, `- [${hms}] tools this round: ${uniqueTools}\n`, "utf-8");
        bus.emit({ type: "finalize:plan-log", path: planPath });
      }
    } catch (err) {
      console.warn("[agent] PLAN.md 执行日志追加失败:", err instanceof Error ? err.message : err);
    }
  }
  // 写本次 runAgent token 到 dashboard DB(仅非 copilot 模型,按来源分类写增量)
  // 每个来源(chat/code/cron)写三条 key: input / output / cache
  try {
    const _isNotCopilot = !("isCopilot" in client) || !client.isCopilot;
    if (_isNotCopilot && (totalCompletionTokens > 0 || totalPromptTokens > 0)) {
      const LLM_CAT = "llm";
      const source = session.sessionId.startsWith("cron:")
        ? "cron"
        : session.mode === "code"
          ? "code"
          : "chat";

      // source 下三个 key: token/<source>/input, token/<source>/output, token/<source>/cache
      const entries: Array<{ key: string; value: number; desc: string }> = [
        {
          key: `token/${source}/input`,
          value: totalPromptTokens,
          desc: `${source} input token 增量`,
        },
        {
          key: `token/${source}/output`,
          value: totalCompletionTokens,
          desc: `${source} output token 增量`,
        },
        {
          key: `token/${source}/cache`,
          value: totalCacheReadTokens + totalCacheCreationTokens,
          desc: `${source} cache token 增量`,
        },
      ];

      for (const e of entries) {
        if (e.value <= 0) continue;
        if (!isMetricKeyAllowed(LLM_CAT, e.key)) addMetricKey(LLM_CAT, e.key, e.desc, "bar");
        insertMetric({ category: LLM_CAT, key: e.key, value: e.value, note: client.model });
      }
      bus.emit({ type: "finalize:dashboard", entries: entries.length });

      // vision token 用量(独立模型,独立 source)
      if (totalVisionPromptTokens > 0 || totalVisionCompletionTokens > 0) {
        const visSource = "vision";
        const visEntries: Array<{ key: string; value: number; desc: string }> = [
          {
            key: `token/${visSource}/input`,
            value: totalVisionPromptTokens,
            desc: `${visSource} input token 增量`,
          },
          {
            key: `token/${visSource}/output`,
            value: totalVisionCompletionTokens,
            desc: `${visSource} output token 增量`,
          },
          {
            key: `token/${visSource}/cache`,
            value: totalVisionCacheReadTokens + totalVisionCacheCreationTokens,
            desc: `${visSource} cache token 增量`,
          },
        ];
        for (const e of visEntries) {
          if (e.value <= 0) continue;
          if (!isMetricKeyAllowed(LLM_CAT, e.key)) addMetricKey(LLM_CAT, e.key, e.desc, "bar");
          insertMetric({ category: LLM_CAT, key: e.key, value: e.value, note: "vision" });
        }
        // 同步进 Token 页（只记总量：vision 是独立客户端、没有主循环那套消息构成）
        const visModel = visionClient?.[0]?.model;
        insertTokenUsageOnly({
          sessionId: session.sessionId,
          source: "vision",
          agentId: session.agentId,
          model: visModel ? String(visModel) : "vision",
          prompt: totalVisionPromptTokens,
          output: totalVisionCompletionTokens,
          cacheRead: totalVisionCacheReadTokens,
          cacheWrite: totalVisionCacheCreationTokens,
        });
      }
    }
  } catch {
    /* 写 db 失败不影响主流程 */
  }

  bus.emit({
    type: "agent:end",
    sessionId: session.sessionId,
    mode: isCodeMode ? "code" : "chat",
    result: { content: finalContent, toolsUsed },
    stats: {
      durationMs: Date.now() - startMs,
      promptTokens: totalPromptTokens,
      completionTokens: totalCompletionTokens,
      cacheReadTokens: totalCacheReadTokens,
      cacheCreationTokens: totalCacheCreationTokens,
      cacheHitRate,
      visionPromptTokens: totalVisionPromptTokens,
      visionCompletionTokens: totalVisionCompletionTokens,
    },
  });

  return {
    content: finalContent,
    ...(emptyReplyKind ? { emptyReplyKind } : {}),
    toolsUsed,
  };
}

interface FinalizeContext {
  session: Session;
  opts: AgentRunOptions;
  bus: AgentEventBus;
  client: ReturnType<typeof llmRegistry.get>;
  isCodeMode: boolean;
  isSlave: boolean;
  logPrefix: string;
  toolsUsed: string[];
  finalContent: string;
  /** 空回复守卫的判定结果（仅当内容为空时存在）：供 main.ts 选择诚实的兜底文案 */
  emptyReplyKind?: "length" | "degenerate" | "silent";
  lastUsage: ChatResult["usage"];
  startMs: number;
  toolThrottler: ToolCallThrottler | null;
  totalPromptTokens: number;
  totalCompletionTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
  totalVisionPromptTokens: number;
  totalVisionCompletionTokens: number;
  totalVisionCacheReadTokens: number;
  totalVisionCacheCreationTokens: number;
}

  // ── 逐字层：把本轮原文追加到 transcript，供 QMD 检索命中原话 ──
  // 仅交互式 chat 会话（code / slave / loop 任务跳过）；失败不影响主流程
  if (!isCodeMode && !isSlave && !opts.skipAddUserMessage && finalContent) {
    try {
      appendTranscript(session.agentId, {
        user: userContent,
        assistant: finalContent,
        tools: toolCallSummaries,
      });
    } catch (err) {
      console.warn("[agent] transcript 写入失败:", err instanceof Error ? err.message : err);
    }
  }

  return finalizeRun({
    session,
    opts,
    bus,
    client,
    isCodeMode,
    isSlave,
    logPrefix,
    toolsUsed,
    finalContent,
    ...(emptyReplyKind ? { emptyReplyKind } : {}),
    lastUsage,
    startMs,
    toolThrottler,
    totalPromptTokens,
    totalCompletionTokens,
    totalCacheReadTokens,
    totalCacheCreationTokens,
    totalVisionPromptTokens,
    totalVisionCompletionTokens,
    totalVisionCacheReadTokens,
    totalVisionCacheCreationTokens,
  });
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
  reasoningContent: string | undefined;
}

function parseResponse(result: ChatResult, textMode = false): ParsedResponse {
  // ── Function calling 模式：直接用 API 返回的 tool_calls ──────────────────
  if (!textMode) {
    if (result.toolCalls && result.toolCalls.length > 0) {
      return {
        content: result.content,
        reasoningContent: result.reasoningContent,
        toolCalls: result.toolCalls.map((tc) => ({
          name: tc.name,
          args: tc.args,
          callId: tc.callId,
        })),
      };
    }
    return { content: result.content,
        reasoningContent: result.reasoningContent };
  }

  // ── 文字模式：从 content 里提取 <tool_call>...</tool_call> 块 ─────────────
  const TAG_RE = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  const matches = [...result.content.matchAll(TAG_RE)];
  if (matches.length === 0) return { content: result.content,
        reasoningContent: result.reasoningContent };

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
          callId: "", // 文本模式无 ID
        });
      }
    } catch {
      // JSON 格式错误，跳过
    }
  }

  // <tool_call> 块是中间步骤，从内容中去掉，不透传给用户
  const cleanContent = result.content.replace(TAG_RE, "").trim();
  return {
    reasoningContent: undefined,
    content: cleanContent,
    ...(toolCalls.length > 0 ? { toolCalls } : {}),
  };
}
