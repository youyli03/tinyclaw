/**
 * Memory Tools —— 无 MFA 的记忆操作工具集
 *
 * 所有工具通过 ctx.agentId 自动路由到当前 agent 的目录,无法操作其他 agent 的记忆。
 *
 * - memory_read_mem     : 读取当前 agent 的 MEM.md
 * - memory_write_mem    : 覆写或追加当前 agent 的 MEM.md
 * - memory_read_active  : 读取当前 agent 的 ACTIVE.md
 * - memory_write_active : 覆写或追加当前 agent 的 ACTIVE.md
 * - memory_search       : 手动触发 QMD 向量搜索历史记忆
 * - memory_append       : 主动追加一条记忆到当日历史存档并触发 QMD 索引更新
 */

import * as fs from "node:fs";
import { registerTool, type ToolContext } from "./registry.js";
import { agentManager } from "../core/agent-manager.js";
import { searchMemory } from "../memory/qmd.js";
import { persistSummary } from "../memory/store.js";

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

// ── memory_read_mem ───────────────────────────────────────────────────────────

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "memory_read_mem",
      description:
        "读取当前 Agent 的 MEM.md 持久记忆文件内容。" +
        "用于在 session 内获取最新的 MEM.md 内容(session 初始化后若 MEM.md 被更新过,需调用本工具刷新)。",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
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

// ── memory_write_mem ──────────────────────────────────────────────────────────

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
          content: {
            type: "string",
            description: "要写入的内容",
          },
          mode: {
            type: "string",
            enum: ["overwrite", "append"],
            description: "写入模式:overwrite 覆盖全文(默认),append 追加到末尾",
          },
        },
        required: ["content"],
      },
    },
  },
  execute: async (args: Record<string, unknown>, ctx?: ToolContext): Promise<string> => {
    const agentId = ctx?.agentId ?? "default";
    const content = String(args["content"] ?? "");
    const mode = String(args["mode"] ?? "overwrite");
    return writeTextFile(agentManager.memPath(agentId), content, mode, "MEM.md");
  },
});

// ── memory_read_active ────────────────────────────────────────────────────────

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "memory_read_active",
      description:
        "读取当前 Agent 的 ACTIVE.md 活跃上下文文件内容。" +
        "用于在 session 内获取最新的近期活跃事项、短期未完成事项和生活/项目上下文。",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
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

// ── memory_write_active ───────────────────────────────────────────────────────

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
          content: {
            type: "string",
            description: "要写入的内容",
          },
          mode: {
            type: "string",
            enum: ["overwrite", "append"],
            description: "写入模式:overwrite 覆盖全文(默认),append 追加到末尾",
          },
        },
        required: ["content"],
      },
    },
  },
  execute: async (args: Record<string, unknown>, ctx?: ToolContext): Promise<string> => {
    const agentId = ctx?.agentId ?? "default";
    const content = String(args["content"] ?? "");
    const mode = String(args["mode"] ?? "overwrite");
    return writeTextFile(agentManager.activePath(agentId), content, mode, "ACTIVE.md");
  },
});

// ── memory_search ─────────────────────────────────────────────────────────────

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
          query: {
            type: "string",
            description: "搜索查询词(自然语言,支持中英文)",
          },
          limit: {
            type: "number",
            description: "最多返回条数,默认 5,最大 20",
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

    const result = await searchMemory(query, agentId, limit);
    if (result === null) return "记忆功能未启用(memory.enabled = false)";
    if (!result) return "未找到相关历史记忆";
    return result;
  },
});

// ── memory_append ─────────────────────────────────────────────────────────────

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
          content: {
            type: "string",
            description: "要存储的记忆内容(支持 Markdown 格式)",
          },
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
