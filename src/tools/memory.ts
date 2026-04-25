/**
 * Memory Tools —— 无 MFA 的记忆操作工具集
 *
 * 所有工具通过 ctx.agentId 自动路由到当前 agent 的目录,无法操作其他 agent 的记忆。
 *
 * - memory_read_mem     : 读取当前 agent 的 MEM.md
 * - memory_write_mem    : 覆写或追加当前 agent 的 MEM.md
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
import { searchMemory, updateStore } from "../memory/qmd.js";
import { persistSummary } from "../memory/store.js";
import { CARD_STATUSES, CARD_TYPES, appendCard } from "../memory/cards.js";

function readTextFileOrMissing(filePath: string, missingMessage: string, emptyMessage: string): string {
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
        "读取当前 Agent 的 MEM.md 持久记忆文件内容。" +
        "用于在 session 内获取最新的 MEM.md 内容(session 初始化后若 MEM.md 被更新过,需调用本工具刷新)。",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  execute: async (_args: Record<string, unknown>, ctx?: ToolContext): Promise<string> => {
    const agentId = ctx?.agentId ?? "default";
    return readTextFileOrMissing(agentManager.memPath(agentId), "(MEM.md 尚不存在,可调用 memory_write_mem 创建)", "(MEM.md 为空)");
  },
});

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "memory_write_mem",
      description:
        "写入当前 Agent 的 MEM.md 持久记忆文件。" +
        "支持 overwrite(覆盖全文,默认)和 append(追加到末尾)两种模式。" +
        "无需 MFA,适合在禁用了 write_file 的 Agent 中使用。",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "要写入的内容" },
          mode: { type: "string", enum: ["overwrite", "append"], description: "写入模式:overwrite 覆盖全文(默认),append 追加到末尾" },
        },
        required: ["content"],
      },
    },
  },
  execute: async (args: Record<string, unknown>, ctx?: ToolContext): Promise<string> => {
    const agentId = ctx?.agentId ?? "default";
    return writeTextFile(agentManager.memPath(agentId), String(args["content"] ?? ""), String(args["mode"] ?? "overwrite"), "MEM.md");
  },
});

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "memory_read_active",
      description:
        "读取当前 Agent 的 ACTIVE.md 活跃上下文文件内容。" +
        "用于在 session 内获取最新的近期活跃事项、短期未完成事项和生活/项目上下文。",
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
        "写入当前 Agent 的 ACTIVE.md 活跃上下文文件。" +
        "支持 overwrite(覆盖全文,默认)和 append(追加到末尾)两种模式。" +
        "无需 MFA,适合记录近期活跃话题、当前未完成事项和最新明确要求。",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "要写入的内容" },
          mode: { type: "string", enum: ["overwrite", "append"], description: "写入模式:overwrite 覆盖全文(默认),append 追加到末尾" },
        },
        required: ["content"],
      },
    },
  },
  execute: async (args: Record<string, unknown>, ctx?: ToolContext): Promise<string> => {
    const agentId = ctx?.agentId ?? "default";
    return writeTextFile(agentManager.activePath(agentId), String(args["content"] ?? ""), String(args["mode"] ?? "overwrite"), "ACTIVE.md");
  },
});

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "memory_append_card",
      description:
        "向当前 Agent 的 cards/ 目录追加一张结构化记忆卡片,并触发 cards collection 索引更新。" +
        "适合显式存储偏好、约束、关系、决策、open loop、任务状态等高价值记忆。",
      parameters: {
        type: "object",
        properties: {
          type: { type: "string", enum: [...CARD_TYPES], description: "卡片类型" },
          scope: { type: "string", description: "记忆范围,如 personal / project:tinyclaw" },
          facet: { type: "string", description: "主题面,如 communication / memory / reminder" },
          title: { type: "string", description: "卡片标题" },
          summary: { type: "string", description: "卡片正文摘要" },
          status: { type: "string", enum: [...CARD_STATUSES], description: "状态,默认 active" },
          importance: { type: "number", description: "重要性 0~1,默认 0.7" },
          ts: { type: "string", description: "ISO 时间,可选" },
          tags: { type: "array", items: { type: "string" }, description: "标签数组,可选" },
          supersedes: { type: "array", items: { type: "string" }, description: "覆盖的旧卡 ID,可选" },
        },
        required: ["type", "scope", "facet", "title", "summary"],
      },
    },
  },
  execute: async (args: Record<string, unknown>, ctx?: ToolContext): Promise<string> => {
    const agentId = ctx?.agentId ?? "default";
    const message = appendCard({
      id: String(args["id"] ?? ""),
      type: String(args["type"] ?? "") as typeof CARD_TYPES[number],
      scope: String(args["scope"] ?? "general"),
      facet: String(args["facet"] ?? "general"),
      status: String(args["status"] ?? "active") as typeof CARD_STATUSES[number],
      importance: Number(args["importance"] ?? 0.7),
      ts: String(args["ts"] ?? new Date().toISOString()),
      title: String(args["title"] ?? ""),
      summary: String(args["summary"] ?? ""),
      tags: Array.isArray(args["tags"]) ? args["tags"].filter((x): x is string => typeof x === "string") : [],
      supersedes: Array.isArray(args["supersedes"]) ? args["supersedes"].filter((x): x is string => typeof x === "string") : [],
    }, agentId);
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
        "在当前 Agent 的历史记忆中做语义向量搜索,返回相关片段。" +
        "适合在需要查询特定历史信息时手动调用,补充自动注入的记忆上下文。" +
        "无需 MFA,无需 read_file 权限。",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "搜索查询词(自然语言,支持中英文)" },
          limit: { type: "number", description: "最多返回条数,默认 5,最大 20" },
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
    const result = await searchMemory(query, agentId, limit);
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
        "主动追加一条记忆到当前 Agent 的历史存档(按日期归档的 .md 文件),并触发 QMD 向量索引更新。" +
        "适合在对话中主动存储重要结论、用户偏好等信息,无需等到对话压缩时自动归档。" +
        "无需 MFA,无需 write_file 权限。",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "要存储的记忆内容(支持 Markdown 格式)" },
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
        "读取指定项目的跨 session 记忆（NOTES.md）。" +
        "不传 project 时，列出所有已知项目名称。" +
        "适合在 code session 开始时，识别出当前项目后主动调用，了解历史约束和进度。",
      parameters: {
        type: "object",
        properties: {
          project: {
            type: "string",
            description:
              "项目 slug（如 _home_lyy_tinyclaw 或 ssh_m1saka.cc_opt_app）。" +
              "不传则返回所有已知项目列表。",
          },
        },
        required: [],
      },
    },
  },
  execute: async (args: Record<string, unknown>, ctx?: ToolContext): Promise<string> => {
    const agentId = ctx?.agentId ?? "default";
    const projectsDir = agentManager.codeProjectsDir(agentId);

    // 不传 project → 列出所有已知项目
    if (!args["project"]) {
      if (!fs.existsSync(projectsDir)) return "（暂无已知项目记忆，可通过 code_note 写入）";
      const dirs = fs.readdirSync(projectsDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
      if (dirs.length === 0) return "（暂无已知项目记忆）";
      return `已知项目列表：\n${dirs.map(d => `- ${d}`).join("\n")}`;
    }

    const project = String(args["project"]).trim();
    const noteFiles = agentManager.codeProjectNotesList(agentId, project);
    if (noteFiles.length === 0) {
      return `项目 "${project}" 暂无记忆,可通过 code_note 创建。`;
    }
    const recent = noteFiles.slice(-3);
    const parts: string[] = [];
    for (const f of recent) {
      const month = f.split("/").pop()!.replace(".md", "");
      parts.push(`# ${month}\n${fs.readFileSync(f, "utf-8").trim()}`);
    }
    const combined = parts.join("\n\n---\n\n").slice(0, 8000);
    return combined || `项目 "${project}" 的记忆为空。`;
  },
});

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "code_note",
      description:
        "向指定项目的跨 session 记忆（NOTES.md）写入或追加内容。\n" +
        "在以下情况立即调用（不要等 session 结束）：\n" +
        "1. 发现跨 session 有价值的约束（如\"此进程不能自行 kill\"）\n" +
        "2. 完成重要里程碑（如\"pathname 路由已完成\"）\n" +
        "3. 定位到非显而易见的根因\n" +
        "4. 任务完成（说\"已完成\"）前更新进度\n" +
        "mode=append 追加新行；mode=overwrite 全量覆写（谨慎使用）。",
      parameters: {
        type: "object",
        properties: {
          project: {
            type: "string",
            description:
              "项目 slug（如 _home_lyy_tinyclaw）。" +
              "根据当前操作的仓库/服务器语义自行命名，不确定时调用 code_clarify_project。",
          },
          content: { type: "string", description: "要写入的内容（Markdown 格式）" },
          mode: {
            type: "string",
            enum: ["append", "overwrite"],
            description: "append（默认）追加到末尾；overwrite 全量覆写",
          },
        },
        required: ["project", "content"],
      },
    },
  },
  execute: async (args: Record<string, unknown>, ctx?: ToolContext): Promise<string> => {
    const agentId = ctx?.agentId ?? "default";
    const project = String(args["project"] ?? "").trim();
    if (!project) return "错误：缺少 project 参数";
    const content = String(args["content"] ?? "").trim();
    if (!content) return "错误：缺少 content 参数";
    const mode = String(args["mode"] ?? "append");

    const notesPath = agentManager.codeProjectNotesPath(agentId, project);
    fs.mkdirSync(path.dirname(notesPath), { recursive: true });

    if (mode === "overwrite") {
      const ts0 = new Date().toISOString().slice(0, 10);
      fs.writeFileSync(notesPath, `<!-- overwrite ${ts0} -->\n${content}\n`, "utf-8");
      return `已覆写项目 "${project}" 当月记忆（${content.length} 字节）:${notesPath}`;
    }
    const ts = new Date().toISOString().slice(0, 10);
    const entry = `\n### ${ts}\n${content}\n`;
    fs.appendFileSync(notesPath, entry, "utf-8");
    // 写入后立即触发增量索引（fire-and-forget）
    import("../memory/qmd.js").then(({ updateStore }) => {
      updateStore("code_notes", agentId).catch((e) => {
        console.warn("[code_note] post-write index update failed:", e);
      });
    }).catch(() => {});
    return `已追加到项目 "${project}" 当月记忆（${content.length} 字节）:${notesPath}`;
  },
});

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "code_clarify_project",
      description:
        "当无法通过 workdir 路径或对话语义确定当前操作属于哪个项目时，调用此工具向用户确认。\n" +
        "会列出所有已知项目，并让用户选择或输入新项目名。\n" +
        "若提供了 ssh_host，会自动做 DNS 解析并与已有 IP 映射比对，找到已知项目直接返回，无需打扰用户。",
      parameters: {
        type: "object",
        properties: {
          hint: {
            type: "string",
            description: "当前操作的线索（如仓库名、服务描述），帮助用户做出判断",
          },
          ssh_host: {
            type: "string",
            description: "若当前操作涉及 SSH，传入 hostname（如 m1saka.cc），工具会自动 DNS 解析比对",
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
      try { aliases = JSON.parse(fs.readFileSync(aliasesPath, "utf-8")); } catch { /* ignore */ }
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
      knownProjects = fs.readdirSync(projectsDir, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => d.name);
    }

    const hint = String(args["hint"] ?? "").trim();
    const hintText = hint ? `\n当前操作线索：${hint}` : "";

    // 构建选项
    const options = [
      ...knownProjects.map(p => ({ label: p, description: "已有项目" })),
      { label: "（新建项目）", description: "输入新项目名（格式如 _home_lyy_myrepo 或 ssh_host_path）" },
    ];

    // 通过 ask_user 工具机制无法在这里直接调用，返回结构化信息让 AI 调用 ask_user
    return JSON.stringify({
      action: "ask_user",
      question: `请确认当前操作属于哪个项目？${hintText}`,
      options,
      instruction: "请调用 ask_user 工具，将上面的 question 和 options 展示给用户，获得确认后：\n1. 若用户选择已有项目，直接使用该 slug\n2. 若用户输入新项目名，用 code_note 写入初始记忆，并用下面的方式更新别名表",
      aliasesPath,
      resolvedIP: sshHost ? "（DNS 解析失败或未提供）" : undefined,
    });
  },
});
