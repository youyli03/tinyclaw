/**
 * MCP 配置写入器（`~/.tinyclaw/mcp.toml`）
 *
 * 设计约束：
 * - **块级文本补丁**，不用 `stringify` 整文件重写（那会丢掉用户的注释与未知键）
 * - **写前全量校验**：生成的文本必须先通过 `analyzeMcpTomlText()`，否则拒写
 * - **原子落盘**：写 `.tmp` → `rename`；每次覆盖前先备份 `mcp.toml.bak-<ts>`（保留最近 5 份）
 * - 权限 0600（mcp.toml 里可能含 env / headers 明文）
 *
 * 纯函数（`renderServerBlock` / `upsertServerBlock` / `removeServerBlock` / `setServerEnabled`）
 * 与 IO（`writeMcpTomlText`）分开，便于单测。
 */

import * as fs from "node:fs";
import { mcpConfigPath, analyzeMcpTomlText } from "../config/loader.js";
import { atomicWriteText, backupFile, DEFAULT_BACKUP_KEEP } from "../config/safe-write.js";

/** server 名允许的字符（与 `sanitizeMcpName` 的口径兼容） */
export const MCP_SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/;

/** 一个 MCP server 的定义（写盘用） */
export interface McpServerSpec {
  transport: "stdio" | "sse";
  /** transport=stdio 必填 */
  command?: string;
  args?: string[];
  /** transport=sse 必填 */
  url?: string;
  /** 值支持 `${SECRET:NAME}` 引用（连接时从 secrets.toml 解析） */
  env?: Record<string, string>;
  /** 值支持 `${SECRET:NAME}` 引用 */
  headers?: Record<string, string>;
  enabled?: boolean;
  description?: string;
}

/** TOML basic string 转义（JSON 转义是其子集，非 ASCII 原样输出） */
function tomlString(v: string): string {
  return JSON.stringify(v);
}

/** 内联表：键统一加引号，避免裸键字符集限制 */
function inlineTable(obj: Record<string, string>): string {
  const parts = Object.entries(obj).map(([k, v]) => `${tomlString(k)} = ${tomlString(v)}`);
  return `{ ${parts.join(", ")} }`;
}

/** 渲染一个 `[servers.<name>]` 块（含对齐的键） */
export function renderServerBlock(name: string, spec: McpServerSpec): string {
  const entries: Array<[string, string]> = [];
  entries.push(["enabled", spec.enabled === false ? "false" : "true"]);
  if (spec.description !== undefined) entries.push(["description", tomlString(spec.description)]);
  entries.push(["transport", tomlString(spec.transport)]);
  if (spec.transport === "stdio") {
    entries.push(["command", tomlString(spec.command ?? "")]);
    entries.push(["args", `[${(spec.args ?? []).map(tomlString).join(", ")}]`]);
    if (spec.env !== undefined && Object.keys(spec.env).length > 0) {
      entries.push(["env", inlineTable(spec.env)]);
    }
  } else {
    entries.push(["url", tomlString(spec.url ?? "")]);
    if (spec.headers !== undefined && Object.keys(spec.headers).length > 0) {
      entries.push(["headers", inlineTable(spec.headers)]);
    }
  }

  const width = Math.max(...entries.map(([k]) => k.length));
  const lines = [`[servers.${name}]`];
  for (const [k, v] of entries) lines.push(`${k.padEnd(width)} = ${v}`);
  return lines.join("\n");
}

/** 定位 `[servers.<name>]` 块的行范围（末行不含块尾空行；找不到返回 null） */
function findBlock(
  lines: string[],
  name: string
): { headerIdx: number; endIdx: number; tailIdx: number } | null {
  const header = `[servers.${name}]`;
  const headerIdx = lines.findIndex((l) => l.trim() === header);
  if (headerIdx < 0) return null;

  let tailIdx = lines.length;
  for (let i = headerIdx + 1; i < lines.length; i++) {
    if ((lines[i] ?? "").trim().startsWith("[")) {
      tailIdx = i;
      break;
    }
  }
  // 收缩块尾空行（保留空行由"下一 section 前插一行空行"承担）
  let endIdx = tailIdx;
  while (endIdx > headerIdx + 1 && (lines[endIdx - 1] ?? "").trim() === "") endIdx--;
  return { headerIdx, endIdx, tailIdx };
}

/** 去掉尾部空行（原地返回新数组） */
function stripTrailingBlanks(lines: string[]): string[] {
  const out = [...lines];
  while (out.length > 0 && (out[out.length - 1] ?? "").trim() === "") out.pop();
  return out;
}

/** 去掉头部空行 */
function stripLeadingBlanks(lines: string[]): string[] {
  let i = 0;
  while (i < lines.length && (lines[i] ?? "").trim() === "") i++;
  return lines.slice(i);
}

/** 新增或整块替换 `[servers.<name>]`；保留文件里其余内容与注释 */
export function upsertServerBlock(content: string, name: string, block: string): string {
  const lines = content.length > 0 ? content.split("\n") : [];
  const found = findBlock(lines, name);

  if (found === null) {
    const body = stripTrailingBlanks(lines);
    const head = body.length > 0 ? [...body, ""] : [];
    return [...head, ...block.split("\n"), ""].join("\n");
  }

  const before = stripTrailingBlanks(lines.slice(0, found.headerIdx));
  const after = stripLeadingBlanks(lines.slice(found.tailIdx));
  const mid = block.split("\n");
  const out = [...before, ...(before.length > 0 ? [""] : []), ...mid];
  if (after.length > 0) out.push("", ...after);
  return [...out, ""].join("\n");
}

/** 删除 `[servers.<name>]` 块；返回是否真的删除了 */
export function removeServerBlock(content: string, name: string): { content: string; removed: boolean } {
  const lines = content.length > 0 ? content.split("\n") : [];
  const found = findBlock(lines, name);
  if (found === null) return { content, removed: false };

  const before = stripTrailingBlanks(lines.slice(0, found.headerIdx));
  const after = stripLeadingBlanks(lines.slice(found.tailIdx));
  const out = [...before];
  if (before.length > 0 && after.length > 0) out.push("");
  out.push(...after);
  return { content: [...out, ""].join("\n"), removed: true };
}

/** 只改块内 `enabled` 行（保留该块里用户的其它注释与格式） */
export function setServerEnabled(
  content: string,
  name: string,
  enabled: boolean
): { content: string; found: boolean } {
  const lines = content.length > 0 ? content.split("\n") : [];
  const found = findBlock(lines, name);
  if (found === null) return { content, found: false };

  const out = [...lines];
  for (let i = found.headerIdx + 1; i < found.endIdx; i++) {
    const line = out[i] ?? "";
    if (/^\s*enabled\s*=/.test(line)) {
      const indent = line.slice(0, line.length - line.trimStart().length);
      out[i] = `${indent}enabled = ${enabled ? "true" : "false"}`;
      return { content: out.join("\n"), found: true };
    }
  }
  // 块里没有 enabled 行 → 插在 header 之后
  out.splice(found.headerIdx + 1, 0, `enabled = ${enabled ? "true" : "false"}`);
  return { content: out.join("\n"), found: true };
}

/** 读 mcp.toml 原文（不存在返回空串） */
export function readMcpTomlText(p: string = mcpConfigPath()): string {
  try {
    return fs.readFileSync(p, "utf-8");
  } catch {
    return "";
  }
}

/**
 * 校验并原子写入 mcp.toml。
 *
 * 备份/原子写/权限都走 `config/safe-write.ts`（与 `config.toml` 同一套实现）。
 *
 * @throws 生成的文本未通过校验时抛错（坏内容永不落盘）
 */
export function writeMcpTomlText(
  text: string,
  p: string = mcpConfigPath()
): { backupPath: string | null } {
  const errors = analyzeMcpTomlText(text).diagnostics.filter((d) => d.level === "error");
  if (errors.length > 0) {
    throw new Error(
      `已拒绝：生成的 mcp.toml 未通过校验 —— ${errors.map((e) => e.message).join("；")}`
    );
  }

  const backupPath = backupFile(p, DEFAULT_BACKUP_KEEP);
  atomicWriteText(p, text);
  return { backupPath };
}
