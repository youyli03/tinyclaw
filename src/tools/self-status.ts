/**
 * self_status —— AI 的**自省**工具（只读）
 *
 * 让 Agent 能查询自身运行状态：当前模型、上下文用量与缓存命中率、记忆规模
 * （MEM / ACTIVE / 卡片 / 逐字层）、定时任务与 loop 数量、行为反馈条数、
 * 当前 agent / mode / session。
 *
 * 纯读取，不修改任何状态；无需 MFA。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { registerTool, type ToolContext } from "./registry.js";
import { agentManager } from "../core/agent-manager.js";
import { llmRegistry } from "../llm/registry.js";
import { readExistingCards } from "../memory/cards.js";
import { loadJobs } from "../cron/store.js";
import { readFeedback } from "../core/feedback-writer.js";

/** 单文件统计（行数按非空行计） */
function fileStats(filePath: string): { exists: boolean; bytes: number; lines: number } {
  try {
    if (!fs.existsSync(filePath)) return { exists: false, bytes: 0, lines: 0 };
    const text = fs.readFileSync(filePath, "utf-8");
    return {
      exists: true,
      bytes: Buffer.byteLength(text, "utf-8"),
      lines: text.split("\n").filter((l) => l.trim()).length,
    };
  } catch {
    return { exists: false, bytes: 0, lines: 0 };
  }
}

/** 递归统计目录下匹配的文件数与总字节数（兼容 Node < 20.12 的 dirent.path） */
function dirStats(
  dir: string,
  filter: (relPath: string) => boolean
): { files: number; bytes: number } {
  try {
    if (!fs.existsSync(dir)) return { files: 0, bytes: 0 };
    let files = 0;
    let bytes = 0;
    for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const dirent = entry as unknown as { parentPath?: string; path?: string };
      const full = path.join(dirent.parentPath ?? dirent.path ?? dir, entry.name);
      const rel = path.relative(dir, full).split(path.sep).join("/");
      if (!filter(rel)) continue;
      files++;
      try {
        bytes += fs.statSync(full).size;
      } catch {
        /* ignore */
      }
    }
    return { files, bytes };
  } catch {
    return { files: 0, bytes: 0 };
  }
}

/** 统计启用的 loop session（sessions/*.toml 中 [loop] enabled = true） */
function countLoopSessions(): number {
  try {
    const dir = path.join(os.homedir(), ".tinyclaw", "sessions");
    if (!fs.existsSync(dir)) return 0;
    let n = 0;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".toml")) continue;
      try {
        const text = fs.readFileSync(path.join(dir, f), "utf-8");
        if (/\[loop\][\s\S]*?enabled\s*=\s*true/.test(text)) n++;
      } catch {
        /* ignore */
      }
    }
    return n;
  } catch {
    return 0;
  }
}

/** 统计 loop-trigger 配置数（~/.tinyclaw/loops/*.json） */
function countLoopTriggers(): number {
  try {
    const dir = path.join(os.homedir(), ".tinyclaw", "loops");
    if (!fs.existsSync(dir)) return 0;
    return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).length;
  } catch {
    return 0;
  }
}

function countFeedbackLines(agentId: string, mode: "chat" | "code"): number {
  const text = readFeedback(agentId, mode);
  if (!text) return 0;
  return text.split("\n").filter((l) => l.trim().startsWith("- ")).length;
}

const fmtBytes = (n: number): string =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)}MB` : n >= 1024 ? `${(n / 1024).toFixed(1)}KB` : `${n}B`;

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "self_status",
      description:
        "查询**你自己**当前的运行状态（只读，不修改任何东西）。返回：当前模型、上下文窗口与用量、" +
        "缓存命中率、记忆规模（MEM.md / ACTIVE.md / 卡片数 / 逐字层）、定时任务与 loop 数量、" +
        "行为反馈条数、当前 agent / mode / session。\n" +
        "适用场景：判断上下文是否快满、了解自己积累了多少记忆、确认有哪些定时任务在跑、" +
        "或在回答用户关于「你现在状态如何」的问题时先取真实数据。",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  execute: async (_args: Record<string, unknown>, ctx?: ToolContext): Promise<string> => {
    const agentId = ctx?.agentId ?? "default";
    const mode = ctx?.mode === "code" ? "code" : "chat";
    const backend = mode === "code" ? "code" : "daily";
    const session = ctx?.masterSession;

    let model = "(未知)";
    let ctxWindow = 0;
    try {
      model = String(llmRegistry.get(backend).model);
      ctxWindow = llmRegistry.getContextWindow(backend, session?.lastResponseAt ?? 0);
    } catch {
      /* 后端未初始化时不阻断 */
    }

    const memDir = agentManager.memoryDir(agentId);
    const mem = fileStats(agentManager.memPath(agentId));
    const active = fileStats(agentManager.activePath(agentId));

    let cardCount = 0;
    try {
      cardCount = readExistingCards(agentId).length;
    } catch {
      /* 卡片目录损坏时不阻断 */
    }
    const transcript = dirStats(path.join(memDir, "transcript"), (r) => r.endsWith(".md"));
    const diary = dirStats(memDir, (r) => /^\d{4}-\d{2}\/\d{4}-\d{2}-\d{2}\.md$/.test(r));

    const jobs = loadJobs();
    const enabledJobs = jobs.filter((j) => j.enabled).length;
    const loops = countLoopSessions();
    const triggers = countLoopTriggers();

    const promptTokens = session?.lastPromptTokens ?? 0;
    const usedPct = ctxWindow > 0 && promptTokens > 0 ? Math.round((promptTokens / ctxWindow) * 100) : null;
    const hitPct =
      session && session.lastCacheHitRate > 0 ? Math.round(session.lastCacheHitRate * 100) : null;

    const lines = [
      "**自身状态（只读）**",
      "",
      `- Agent / 模式：\`${agentId}\` / ${mode}`,
      `- 模型：\`${model}\`（后端 \`${backend}\`）`,
      `- 上下文：${promptTokens > 0 ? `${promptTokens.toLocaleString()} / ${ctxWindow.toLocaleString()} token` : "尚无实测值"}` +
        (usedPct !== null ? `（已用 ${usedPct}%）` : "") +
        (hitPct !== null
          ? `，缓存命中 ${hitPct}%（复用 ${(session?.lastCacheReadTokens ?? 0).toLocaleString()} token）`
          : ""),
      `- 会话消息数：${session ? session.getMessages().length : 0} 条`,
      "",
      "**记忆规模**",
      "",
      `- MEM.md：${mem.exists ? `${mem.lines} 行 / ${fmtBytes(mem.bytes)}` : "不存在"}`,
      `- ACTIVE.md：${active.exists ? `${active.lines} 行 / ${fmtBytes(active.bytes)}` : "不存在"}`,
      `- 记忆卡片：${cardCount} 张`,
      `- 逐字层 transcript：${transcript.files} 个文件 / ${fmtBytes(transcript.bytes)}`,
      `- 日记摘要：${diary.files} 个文件 / ${fmtBytes(diary.bytes)}`,
      `- 行为反馈：chat ${countFeedbackLines(agentId, "chat")} 条 / code ${countFeedbackLines(agentId, "code")} 条`,
      "",
      "**自主执行**",
      "",
      `- 定时任务：${jobs.length} 个（启用 ${enabledJobs}）`,
      `- Loop session：${loops} 个启用`,
      `- Loop trigger：${triggers} 个配置`,
    ];
    return lines.join("\n");
  },
});
