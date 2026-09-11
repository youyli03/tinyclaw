/**
 * Memory Tools —— 无 MFA 的记忆操作工具集
 *
 * 所有工具通过 ctx.agentId 自动路由到当前 agent 的目录,无法操作其他 agent 的记忆。
 *
 * - memory_read_mem     : 读取当前 agent 的 MEM.md
 * - memory_write_mem    : 覆写或追加当前 agent 的 MEM.md
 * - memory_append_feedback : 记录用户行为纠正到 feedback.md（去重 + 自动裁剪）
 * - memory_read_active  : 读取当前 agent 的 ACTIVE.md
 * - memory_write_active : 覆写或追加当前 agent 的 ACTIVE.md
 * - memory_append_card  : 主动追加一张结构化记忆卡片
 * - memory_search       : 手动触发 QMD 向量搜索历史记忆
 * - memory_append       : 主动追加一条记忆到当日历史存档并触发 QMD 索引更新
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as dns from "node:dns/promises";
import { registerTool, type ToolContext } from "./registry.js";
import { agentManager } from "../core/agent-manager.js";
import * as projectMemory from "../core/project-memory.js";
import { searchMemory, searchStore, updateStore } from "../memory/qmd.js";
import { persistSummary } from "../memory/store.js";
import { CARD_STATUSES, CARD_TYPES, appendCard } from "../memory/cards.js";
import { appendFeedback } from "../core/feedback-writer.js";

function readTextFileOrMissing(
  filePath: string,
  missingMessage: string,
  emptyMessage: string
): string {
  if (!fs.existsSync(filePath)) return missingMessage;
  const content = fs.readFileSync(filePath, "utf-8");
  return content || emptyMessage;
}

function writeTextFile(filePath: string, content: string, mode: string, label: string): string {
  if (mode === "append") {
    fs.appendFileSync(filePath, content, "utf-8");
    return `已追加到 ${label}(${content.length} 字节):${filePath}`;
  }
  fs.writeFileSync(filePath, content, "utf-8");
  return `已覆写 ${label}(${content.length} 字节):${filePath}`;
}

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "memory_read_mem",
      description:
        "Read the current Agent's MEM.md persistent memory file. " +
        "Use it to get the latest MEM.md content within a session " +
        "(call it to refresh if MEM.md changed after session initialization).",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  execute: async (_args: Record<string, unknown>, ctx?: ToolContext): Promise<string> => {
    const agentId = ctx?.agentId ?? "default";
    return readTextFileOrMissing(
      agentManager.memPath(agentId),
      "(MEM.md 尚不存在,可调用 memory_write_mem 创建)",
      "(MEM.md 为空)"
    );
  },
});

/**
 * 章节级 upsert:在 MEM.md 中定位指定 `## section` 章节,替换或追加其内容。
 * - mode=upsert(默认):替换该章节标题行之后、下一个 ## 章节之前的全部内容
 * - mode=append:在该章节末尾追加内容
 * - 章节不存在时:在文件末尾追加新章节
 * 操作完成后触发向量索引更新(fire-and-forget)。
 */
export function upsertMemSection(
  filePath: string,
  section: string,
  content: string,
  mode: "upsert" | "append",
  agentId: string
): string {
  const heading = `## ${section}`;

  // 文件不存在时直接创建
  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, `# 持久记忆\n\n${heading}\n\n${content.trimEnd()}\n`, "utf-8");
    return `已创建 MEM.md 并写入章节"${section}"`;
  }

  const fileContent = fs.readFileSync(filePath, "utf-8");
  const lines = fileContent.split("\n");

  // 查找章节起始行(## section)
  const startLineIdx = lines.findIndex((l) => l.trimEnd() === heading);

  if (startLineIdx === -1) {
    // 章节不存在,追加到文件末尾
    const trimmed = fileContent.trimEnd();
    fs.writeFileSync(filePath, `${trimmed}\n\n${heading}\n\n${content.trimEnd()}\n`, "utf-8");
    import("../memory/qmd.js")
      .then(({ updateStore }) => {
        updateStore("memory", agentId).catch(() => {});
      })
      .catch(() => {});
    return `已在 MEM.md 末尾追加新章节"${section}"(${content.length} 字节)`;
  }

  // 查找章节结束行(下一个 ## 行,或文件末尾)
  let endLineIdx = lines.length;
  for (let i = startLineIdx + 1; i < lines.length; i++) {
    if ((lines[i] ?? "").startsWith("## ")) {
      endLineIdx = i;
      break;
    }
  }

  let newLines: string[];
  if (mode === "append") {
    const contentLines = content.trimEnd().split("\n");
    newLines = [
      ...lines.slice(0, endLineIdx),
      ...contentLines,
      ...(endLineIdx < lines.length ? ["", ...lines.slice(endLineIdx)] : [""]),
    ];
  } else {
    const contentLines = content.trimEnd().split("\n");
    newLines = [
      ...lines.slice(0, startLineIdx + 1),
      "",
      ...contentLines,
      ...(endLineIdx < lines.length ? ["", ...lines.slice(endLineIdx)] : [""]),
    ];
  }

  const joined = newLines.join("\n").trimEnd() + "\n";
  fs.writeFileSync(filePath, joined, "utf-8");

  import("../memory/qmd.js")
    .then(({ updateStore }) => {
      updateStore("memory", agentId).catch(() => {});
    })
    .catch(() => {});

  const action = mode === "append" ? "已追加内容到" : "已更新";
  return `${action} MEM.md 章节"${section}"(${content.length} 字节):${filePath}`;
}

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "memory_write_mem",
      description:
        "Write the current Agent's MEM.md persistent memory file - a section-level update " +
        "that leaves all other sections intact.\n" +
        "You must specify section: the target section heading without the ## prefix, copied " +
        "verbatim from MEM.md.\n" +
        "- mode=upsert (default): replaces that section's body, other sections intact\n" +
        "- mode=append: append at the end of the section without overwriting it\n" +
        "If the specified section does not exist, a new one is appended at the end of MEM.md.\n" +
        "No MFA required; suitable for agents where write_file is disabled.",
      parameters: {
        type: "object",
        properties: {
          section: {
            type: "string",
            description:
              "Target section heading without the ## prefix, copied verbatim from MEM.md " +
              "(do not translate it). MEM.md has a fixed set of emoji-prefixed sections: user " +
              "preferences / current tasks / common skills and tasks / pitfalls / completed " +
              "milestones / behavior feedback / recent changes",
          },
          content: {
            type: "string",
            description: "New section content (without the ## heading)",
          },
          mode: {
            type: "string",
            enum: ["upsert", "append"],
            description:
              "upsert (default): replaces the whole section body; " +
              "append: appends at the end of the section",
          },
        },
        required: ["section", "content"],
      },
    },
  },
  execute: async (args: Record<string, unknown>, ctx?: ToolContext): Promise<string> => {
    const agentId = ctx?.agentId ?? "default";
    const section = String(args["section"] ?? "").trim();
    const content = String(args["content"] ?? "");
    const mode = String(args["mode"] ?? "upsert") === "append" ? "append" : "upsert";
    if (!section) return "错误:缺少 section 参数,请指定目标章节标题(如「👤 用户偏好」)";
    return upsertMemSection(agentManager.memPath(agentId), section, content, mode, agentId);
  },
});

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "memory_append_feedback",
      description:
        "Record a user correction or requirement about the AI's behavior into feedback.md " +
        "(permanent across sessions; injected into the system prompt on every later turn).\n" +
        "Call it when the user explicitly states a correction such as stop doing X, " +
        "from now on do Y, or always do Z.\n" +
        "No MFA required; entries are deduplicated and the file is trimmed automatically " +
        "(equivalent items are not stored twice; oldest are dropped when it grows too long).",
      parameters: {
        type: "object",
        properties: {
          content: {
            type: "string",
            description:
              "One sentence describing the behavior rule to follow " +
              "(e.g. do not use flattering language; in stock analysis give conclusions only, " +
              "without trading advice)",
          },
        },
        required: ["content"],
      },
    },
  },
  execute: async (args: Record<string, unknown>, ctx?: ToolContext): Promise<string> => {
    const agentId = ctx?.agentId ?? "default";
    const mode = ctx?.mode === "code" ? "code" : "chat";
    const content = String(args["content"] ?? "").trim();
    if (!content) return "错误：缺少 content 参数";
    const result = appendFeedback(agentId, mode, content);
    return result.added
      ? `已记入行为反馈（${mode}）：${content}`
      : "该行为反馈已存在（或内容为空），未重复记录";
  },
});

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "memory_read_active",
      description:
        "Read the current Agent's ACTIVE.md active-context file. " +
        "Use it to get the latest recent activity, short-term open items and life/project " +
        "context within a session.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  execute: async (_args: Record<string, unknown>, ctx?: ToolContext): Promise<string> => {
    const agentId = ctx?.agentId ?? "default";
    return readTextFileOrMissing(
      agentManager.activePath(agentId),
      "(ACTIVE.md 尚不存在,可等待维护任务自动创建,或调用 memory_write_active 创建)",
      "(ACTIVE.md 为空)"
    );
  },
});

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "memory_write_active",
      description:
        "Write the current Agent's ACTIVE.md active-context file. " +
        "Supports two modes: overwrite (replace the whole file, default) and " +
        "append (add at the end). " +
        "No MFA required; suitable for recording recent active topics, current open items and " +
        "the latest explicit requirements.",
      parameters: {
        type: "object",
        properties: {
          topic: {
            type: "string",
            description:
              "Topic file name (without the .md suffix, e.g. constraints/architecture). " +
              "If omitted, the MEMORY.md index is written instead.",
          },
          section: {
            type: "string",
            description:
              "Section heading (without the ## prefix). " +
              "When given, that section is upserted instead of the whole file.",
          },
          content: { type: "string", description: "Content to write" },
          mode: {
            type: "string",
            enum: ["overwrite", "append"],
            description:
              "Write mode: overwrite replaces the whole file (default), " +
              "append adds at the end",
          },
        },
        required: ["content"],
      },
    },
  },
  execute: async (args: Record<string, unknown>, ctx?: ToolContext): Promise<string> => {
    const agentId = ctx?.agentId ?? "default";
    return writeTextFile(
      agentManager.activePath(agentId),
      String(args["content"] ?? ""),
      String(args["mode"] ?? "overwrite"),
      "ACTIVE.md"
    );
  },
});

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "memory_append_card",
      description:
        "Append a structured memory card to the current Agent's cards/ directory " +
        "and trigger a cards collection index update. " +
        "Use it to explicitly store high-value memories such as preferences, constraints, " +
        "relationships, decisions, open loops and task status.",
      parameters: {
        type: "object",
        properties: {
          type: { type: "string", enum: [...CARD_TYPES], description: "Card type" },
          scope: { type: "string", description: "Memory scope, e.g. personal / project:tinyclaw" },
          facet: { type: "string", description: "Facet, e.g. communication / memory / reminder" },
          title: { type: "string", description: "Card title" },
          summary: { type: "string", description: "Card body summary" },
          status: {
            type: "string",
            enum: [...CARD_STATUSES],
            description: "Status, default active",
          },
          importance: { type: "number", description: "Importance 0~1, default 0.7" },
          ts: { type: "string", description: "ISO timestamp, optional" },
          tags: { type: "array", items: { type: "string" }, description: "Tags array, optional" },
          supersedes: {
            type: "array",
            items: { type: "string" },
            description: "IDs of superseded cards, optional",
          },
        },
        required: ["type", "scope", "facet", "title", "summary"],
      },
    },
  },
  execute: async (args: Record<string, unknown>, ctx?: ToolContext): Promise<string> => {
    const agentId = ctx?.agentId ?? "default";
    const message = appendCard(
      {
        id: String(args["id"] ?? ""),
        type: String(args["type"] ?? "") as (typeof CARD_TYPES)[number],
        scope: String(args["scope"] ?? "general"),
        facet: String(args["facet"] ?? "general"),
        status: String(args["status"] ?? "active") as (typeof CARD_STATUSES)[number],
        importance: Number(args["importance"] ?? 0.7),
        ts: String(args["ts"] ?? new Date().toISOString()),
        title: String(args["title"] ?? ""),
        summary: String(args["summary"] ?? ""),
        tags: Array.isArray(args["tags"])
          ? args["tags"].filter((x): x is string => typeof x === "string")
          : [],
        supersedes: Array.isArray(args["supersedes"])
          ? args["supersedes"].filter((x): x is string => typeof x === "string")
          : [],
      },
      agentId
    );
    await updateStore("cards", agentId).catch(() => {});
    return message;
  },
});

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "memory_search",
      description:
        "Run a semantic vector search over the current Agent's historical memory and return " +
        "relevant fragments. " +
        "Use it as a manual lookup for specific historical information, complementing " +
        "the automatically injected memory context. " +
        "No MFA required and no read_file permission needed.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query text (natural language; Chinese and English both work)",
          },
          limit: { type: "number", description: "Maximum number of results, default 5, max 20" },
          include_obsolete: {
            type: "boolean",
            description:
              "Whether to include expired (obsolete/resolved) cards, default false. " +
              "Set it to true to search past memories",
          },
        },
        required: ["query"],
      },
    },
  },
  execute: async (args: Record<string, unknown>, ctx?: ToolContext): Promise<string> => {
    const agentId = ctx?.agentId ?? "default";
    const query = String(args["query"] ?? "").trim();
    if (!query) return "错误:缺少 query 参数";
    const rawLimit = Number(args["limit"] ?? 5);
    const limit = Math.max(1, Math.min(20, Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 5));
    const includeObsolete = args["include_obsolete"] === true;
    const result = await searchMemory(query, agentId, limit, "chat", includeObsolete);
    if (result === null) return "记忆功能未启用(memory.enabled = false)";
    if (!result) return "未找到相关历史记忆";
    return result;
  },
});

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "memory_append",
      description:
        "Proactively append a memory entry to the current Agent's history archive " +
        "(date-based .md files) and trigger a QMD vector index update. " +
        "Use it to store important conclusions, user preferences and similar content during " +
        "a conversation, without waiting for automatic archiving at compaction time. " +
        "No MFA required; no write_file permission needed.",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "Memory content to store (Markdown format)" },
        },
        required: ["content"],
      },
    },
  },
  execute: async (args: Record<string, unknown>, ctx?: ToolContext): Promise<string> => {
    const agentId = ctx?.agentId ?? "default";
    const content = String(args["content"] ?? "").trim();
    if (!content) return "错误:缺少 content 参数";
    await persistSummary(content, agentId);
    return `记忆已存档并触发索引更新(agentId=${agentId},${content.length} 字节)`;
  },
});

// ── Code 模式项目记忆工具 ──────────────────────────────────────────────────────

/**
 * 将 workdir 路径或 ssh host:path 转换为项目 slug。
 * /home/lyy/tinyclaw → _home_lyy_tinyclaw
 * root@m1saka.cc:/opt/app → ssh_m1saka.cc_opt_app
 */
export function pathToProjectSlug(p: string): string {
  // win: 前缀 → 映射到 ssh_win_ slug（Windows MCP 远程操作，对齐已有格式）
  if (p.startsWith("win:")) {
    const winPath = p.slice(4); // "F:/Github/fpgallm"
    const host = "win";
    return "ssh_" + host + "_" + winPath.replace(/[:\\\/]/g, "_");
  }
  // home: 前缀 → 本地路径（显式标注，避免与裸路径混淆）
  if (p.startsWith("home:")) {
    return pathToProjectSlug(p.slice(5));
  }
  // SSH 格式：user@host:/path 或 ssh://user@host/path
  const sshMatch = p.match(/(?:ssh:\/\/)?(?:[^@]+@)?([^:/]+):?(\/.*)?$/);
  if (p.startsWith("ssh://") || p.includes("@")) {
    const host = sshMatch?.[1] ?? p;
    const remotePath = sshMatch?.[2] ?? "";
    return "ssh_" + host.replace(/\./g, "_") + remotePath.replace(/\//g, "_");
  }
  // 本地路径
  return p.replace(/\//g, "_");
}

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "code_note_read",
      description:
        "Read the cross-session memory of the given project (MEMORY.md index or a topic file). " +
        "Default is summary mode (each entry's title plus the first 200 characters); " +
        "summary=false returns the full text; topic takes a file name (without .md); " +
        "section takes a section name; omit project to list all known projects.",
      parameters: {
        type: "object",
        properties: {
          project: {
            type: "string",
            description:
              "Project slug (e.g. _home_lyy_tinyclaw or ssh_m1saka.cc_opt_app); " +
              "omit it to list all known projects",
          },
          summary: {
            type: "boolean",
            description:
              "Summary mode (default true): title plus the first 200 characters; " +
              "false returns the full text",
          },
          limit: {
            type: "number",
            description: "Maximum number of entries in summary mode (default 50)",
          },
          topic: {
            type: "string",
            description:
              "Topic file name (without the .md suffix, e.g. constraints/architecture); " +
              "reads its full text and adds an age warning",
          },
          section: {
            type: "string",
            description:
              "Section heading (without the ## prefix); " +
              "returns only that section's content",
          },
        },
        required: [],
      },
    },
  },
  execute: async (args: Record<string, unknown>, ctx?: ToolContext): Promise<string> => {
    const agentId = ctx?.agentId ?? "default";

    // 不传 project → 列出所有有 MEMORY.md 的项目
    if (!args["project"]) {
      const projects = projectMemory.listProjects(agentId);
      if (projects.length === 0) return "(暂无已知项目记忆,可通过 code_note_write 创建)";
      return "已知项目列表:\n" + projects.map((d) => "- " + d).join("\n");
    }

    const project = String(args["project"]).trim();

    // 提取 section 的辅助函数
    const extractSection = (fileContent: string, secName: string): string | null => {
      const heading = `## ${secName}`;
      const lines = fileContent.split("\n");
      const startIdx = lines.findIndex((l) => l.trimEnd() === heading);
      if (startIdx === -1) return null;
      let endIdx = lines.length;
      for (let i = startIdx + 1; i < lines.length; i++) {
        if ((lines[i] ?? "").startsWith("## ")) {
          endIdx = i;
          break;
        }
      }
      return lines.slice(startIdx, endIdx).join("\n").trim();
    };

    // 传 topic → 读对应 topic 文件,带 age warning
    if (args["topic"]) {
      const topic = String(args["topic"]).trim();
      const topicFilePath = projectMemory.topicPath(agentId, project, topic);
      if (!fs.existsSync(topicFilePath)) {
        return 'topic 文件 "' + topic + '.md" 不存在。可用 code_note_write 创建: ' + topicFilePath;
      }
      const age = projectMemory.getTopicAge(agentId, project, topic);
      let prefix = "";
      if (age && age.daysAgo > 7) {
        prefix = "⚠️ " + topic + ".md 已有 " + age.daysAgo + " 天未更新\n\n";
      }
      const topicContent = fs.readFileSync(topicFilePath, "utf-8").trim();

      // section 过滤
      if (args["section"]) {
        const sec = String(args["section"]).trim();
        const extracted = extractSection(topicContent, sec);
        if (extracted === null) {
          return (
            prefix +
            'topic "' +
            topic +
            '.md" 中未找到分点 "' +
            sec +
            '"。\n\n> 文件路径: ' +
            topicFilePath
          );
        }
        return prefix + extracted + "\n\n> 文件路径: " + topicFilePath;
      }

      return prefix + (topicContent || "(空文件)") + "\n\n> 文件路径: " + topicFilePath;
    }

    // 传 project,不传 topic → 读 MEMORY.md
    const memPath = projectMemory.memoryIndexPath(agentId, project);
    if (!fs.existsSync(memPath)) {
      return '项目 "' + project + '" 暂无记忆索引,可通过 code_note_write 创建。';
    }

    const rawContent = fs.readFileSync(memPath, "utf-8");

    // section 过滤(MEMORY.md)
    if (args["section"]) {
      const sec = String(args["section"]).trim();
      const extracted = extractSection(rawContent, sec);
      if (extracted === null) {
        return '项目 "' + project + '" 的 MEMORY.md 中未找到分区 "' + sec + '"。';
      }
      return extracted;
    }

    const summaryMode = args["summary"] !== false;
    if (!summaryMode) {
      return rawContent.slice(0, 16000);
    }

    // 摘要模式: 解析 ## Section 标题 + 每节前 2 条
    const maxEntries =
      typeof args["limit"] === "number" && args["limit"] > 0 ? Math.floor(args["limit"]) : 50;
    const lines = rawContent.split("\n");
    const sections: Array<{ heading: string; pointers: string[] }> = [];
    let currentSection: { heading: string; pointers: string[] } | null = null;

    for (const line of lines) {
      const sectionMatch = line.match(/^##\s+(.+)$/);
      if (sectionMatch && sectionMatch[1]) {
        if (currentSection) sections.push(currentSection);
        currentSection = { heading: sectionMatch[1].trim(), pointers: [] };
        continue;
      }
      if (currentSection && line.trim().startsWith("-") && currentSection.pointers.length < 2) {
        currentSection.pointers.push(line.trim());
      }
    }
    if (currentSection) sections.push(currentSection);

    if (sections.length === 0) {
      return '项目 "' + project + '" 的 MEMORY.md 为空。';
    }

    const output: string[] = [];
    let count = 0;
    for (const sec of sections) {
      if (count >= maxEntries) break;
      output.push(sec.heading + ":");
      count++;
      for (const p of sec.pointers) {
        if (count >= maxEntries) break;
        output.push("  " + p);
        count++;
      }
    }

    return output.join("\n") || '项目 "' + project + '" 的 MEMORY.md 暂无条目。';
  },
});

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "code_note_write",
      description:
        "Write or append to the cross-session memory of the given project " +
        "(MEMORY.md or a topic file). " +
        "Call it immediately when you find a cross-session constraint, a key milestone or a " +
        "non-obvious root cause, before reporting a task as done; do not wait for the session " +
        "to end. " +
        "mode=append (default) appends; overwrite rewrites the whole file (use with care). " +
        "See the memory-keeper skill for the detailed format and examples",
      parameters: {
        type: "object",
        properties: {
          project: {
            type: "string",
            description:
              "Project slug (e.g. _home_lyy_tinyclaw). Name it by repo/server semantics; " +
              "use code_clarify_project first if unsure",
          },
          topic: {
            type: "string",
            description:
              "Topic file name (without the .md suffix, e.g. constraints/architecture); " +
              "omit it to write the MEMORY.md index",
          },
          section: {
            type: "string",
            description:
              "Section heading (without the ## prefix); " +
              "upserts that section instead of the whole file",
          },
          content: {
            type: "string",
            description:
              "Content to write (Markdown). For the MEMORY.md index use the format: " +
              "- [YYYY-MM-DD] [s:5] summary → topic.md; " +
              "[s:N]=stability (1-10), default 5; " +
              "the higher the value the longer it survives in the prompt",
          },
          mode: {
            type: "string",
            enum: ["append", "overwrite"],
            description: "append (default) appends at the end; overwrite rewrites the whole file",
          },
        },
        required: ["content"],
      },
    },
  },
  execute: async (args: Record<string, unknown>, ctx?: ToolContext): Promise<string> => {
    const agentId = ctx?.agentId ?? "default";
    const project = String(args["project"] ?? "").trim();
    const topic = args["topic"] ? String(args["topic"]).trim() : "";
    const section = args["section"] ? String(args["section"]).trim() : "";
    const content = String(args["content"] ?? "").trim();
    if (!content) return "错误:缺少 content 参数";
    const mode = String(args["mode"] ?? "append");

    if (!project) return "错误:缺少 project 参数";

    // ensure project memory structure
    projectMemory.ensureProjectMemory(agentId, project);

    // 确定目标文件路径
    let targetPath: string;
    let fileLabel: string;
    if (topic) {
      targetPath = projectMemory.topicPath(agentId, project, topic);
      fileLabel = `topic "${topic}.md"`;
    } else {
      targetPath = projectMemory.memoryIndexPath(agentId, project);
      fileLabel = "MEMORY.md";
    }

    // 有 section → 章节级 upsert
    if (section) {
      const result = upsertMemSection(
        targetPath,
        section,
        content,
        mode === "append" ? "append" : "upsert",
        agentId
      );
      if (topic) {
        projectMemory.refreshTopicMeta(agentId, project, topic);
      } else {
        projectMemory.refreshIndexMeta(agentId, project);
      }
      return result + " (" + fileLabel + ")";
    }

    // 无 section → 整文件操作
    if (mode === "overwrite") {
      const ts0 = new Date().toISOString().slice(0, 10);
      fs.writeFileSync(targetPath, `<!-- overwrite ${ts0} -->\n${content}\n`, "utf-8");
      if (topic) {
        projectMemory.refreshTopicMeta(agentId, project, topic);
      } else {
        projectMemory.refreshIndexMeta(agentId, project);
      }
      return `已覆写项目 "${project}" ${fileLabel}(${content.length} 字节):${targetPath}`;
    }

    // append 模式(无 section)
    if (topic) {
      // topic 文件追加: 直接 append
      fs.appendFileSync(targetPath, "\n" + content + "\n", "utf-8");
      projectMemory.refreshTopicMeta(agentId, project, topic);
      return `已追加到项目 "${project}" ${fileLabel}(${content.length} 字节):${targetPath}`;
    }

    // MEMORY.md 追加: 按日期分区
    const ts = new Date().toISOString().slice(0, 10);
    const entry = `\n### ${ts}\n${content}\n`;
    fs.appendFileSync(targetPath, entry, "utf-8");
    projectMemory.refreshIndexMeta(agentId, project);
    // 写入后立即触发增量索引(fire-and-forget)
    import("../memory/qmd.js")
      .then(({ updateStore }) => {
        updateStore("code_notes", agentId).catch((e) => {
          console.warn("[code_note_write] post-write index update failed:", e);
        });
      })
      .catch(() => {});
    return `已追加到项目 "${project}" ${fileLabel}(${content.length} 字节):${targetPath}`;
  },
});

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "code_note_search",
      description:
        "Run a semantic vector search over the current Agent's project memory " +
        "(code_note store) and return relevant fragments.\n" +
        "Call it first for any question about project history, constraints, progress or " +
        "decisions; if nothing is found, use code_note_read for the full memory.\n" +
        "No MFA required and no read_file permission needed.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search query text (natural language; Chinese and English both work)",
          },
          limit: {
            type: "number",
            description: "Maximum number of results, default 5, max 20",
          },
        },
        required: ["query"],
      },
    },
  },
  execute: async (args: Record<string, unknown>, ctx?: ToolContext): Promise<string> => {
    const agentId = ctx?.agentId ?? "default";
    const query = String(args["query"] ?? "").trim();
    const rawLimit = Number(args["limit"] ?? 5);
    const limit = Math.max(1, Math.min(20, Number.isFinite(rawLimit) ? Math.floor(rawLimit) : 5));
    if (!query) return "错误：缺少 query 参数";

    const result = await searchStore("code_notes", query, agentId, limit);
    if (result === null) {
      return "向量记忆功能未启用（memory.enabled = false），无法搜索。";
    }
    if (!result) {
      return `在项目记忆中未找到与 "${query}" 相关的内容。`;
    }
    return result;
  },
});

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "code_clarify_project",
      description:
        "Call it when you cannot tell which project the current operation belongs to; it lists " +
        "known projects so the user can pick one or type a new name; pass ssh_host to compare " +
        "against the existing IP mapping via DNS automatically",
      parameters: {
        type: "object",
        properties: {
          hint: {
            type: "string",
            description:
              "Clue about the current operation (e.g. repo name, service description) " +
              "to help the user decide",
          },
          ssh_host: {
            type: "string",
            description:
              "Pass the hostname (e.g. m1saka.cc) when the operation involves SSH; " +
              "resolved via DNS and compared automatically",
          },
        },
        required: [],
      },
    },
  },
  execute: async (args: Record<string, unknown>, ctx?: ToolContext): Promise<string> => {
    const agentId = ctx?.agentId ?? "default";
    const aliasesPath = agentManager.codeProjectAliasesPath(agentId);
    const projectsDir = agentManager.codeProjectsDir(agentId);

    // 读取别名表
    let aliases: Record<string, string> = {};
    if (fs.existsSync(aliasesPath)) {
      try {
        aliases = JSON.parse(fs.readFileSync(aliasesPath, "utf-8"));
      } catch {
        /* ignore */
      }
    }

    // SSH DNS 解析：先查是否已有映射
    const sshHost = String(args["ssh_host"] ?? "").trim();
    if (sshHost) {
      try {
        const result = await dns.lookup(sshHost);
        const ip = result.address;
        if (aliases[ip]) {
          return `DNS 解析 ${sshHost} → ${ip}，已匹配到项目：${aliases[ip]}`;
        }
        // IP 已知但未映射 → 告知 AI，附带 IP，让 AI 决定是否继续问用户
        const knownIPs = Object.keys(aliases);
        if (knownIPs.length > 0) {
          return `DNS 解析 ${sshHost} → ${ip}，未在别名表中找到匹配项目。已知 IP 映射：${JSON.stringify(aliases)}。请继续调用 code_clarify_project（不传 ssh_host）让用户确认。`;
        }
      } catch {
        // DNS 失败不阻断流程
      }
    }

    // 列出已知项目
    let knownProjects: string[] = [];
    if (fs.existsSync(projectsDir)) {
      knownProjects = fs
        .readdirSync(projectsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    }

    const hint = String(args["hint"] ?? "").trim();
    const hintText = hint ? `\n当前操作线索：${hint}` : "";

    // 构建选项
    const options = [
      ...knownProjects.map((p) => ({ label: p, description: "已有项目" })),
      {
        label: "（新建项目）",
        description: "输入新项目名（格式如 _home_lyy_myrepo 或 ssh_host_path）",
      },
    ];

    // 通过 ask_user 工具机制无法在这里直接调用，返回结构化信息让 AI 调用 ask_user
    return JSON.stringify({
      action: "ask_user",
      question: `请确认当前操作属于哪个项目？${hintText}`,
      options,
      instruction:
        "请调用 ask_user 工具，将上面的 question 和 options 展示给用户，获得确认后：\n1. 若用户选择已有项目，直接使用该 slug\n2. 若用户输入新项目名，用 code_note_write 写入初始记忆，并用下面的方式更新别名表",
      aliasesPath,
      resolvedIP: sshHost ? "（DNS 解析失败或未提供）" : undefined,
    });
  },
});
