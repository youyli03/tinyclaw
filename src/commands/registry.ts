/**
 * 斜杠命令注册表
 *
 * 用户消息以 "/" 开头时，由拦截层（main.ts / ipc/server.ts）在进入 runAgent 前处理。
 * 命令直接返回字符串结果，不消耗 LLM token，不记录到会话历史。
 */

import type { Session } from "../core/session.js";

// ── 类型定义 ──────────────────────────────────────────────────────────────────

export interface CommandContext {
  /** 当前会话 */
  session: Session;
  /** 命令参数（由 executeCommand 注入，调用方无需提供） */
  args?: string[];
}

export interface CommandDef {
  /** 命令名（不含 "/"，小写，如 "help"） */
  name: string;
  /** 在 /help 列表中显示的一行简介 */
  description: string;
  /** 用法示例（/help <name> 时显示） */
  usage?: string;
  /** 执行函数，返回要发送给用户的字符串 */
  execute(ctx: CommandContext & { args: string[] }): string | Promise<string>;
}

// ── 注册表 ────────────────────────────────────────────────────────────────────

const commands = new Map<string, CommandDef>();

export function registerCommand(def: CommandDef): void {
  const key = def.name.toLowerCase();
  if (commands.has(key)) {
    throw new Error(`Command "/${key}" is already registered`);
  }
  commands.set(key, def);
}

export function getCommand(name: string): CommandDef | undefined {
  return commands.get(name.toLowerCase());
}

export function listCommands(): CommandDef[] {
  return Array.from(commands.values());
}

// ── 解析 & 执行 ───────────────────────────────────────────────────────────────

/**
 * 解析以 "/" 开头的输入字符串。
 * 如果不是命令格式，返回 null。
 */
export function parseCommand(
  input: string
): { name: string; args: string[] } | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) return null;
  const parts = trimmed.slice(1).split(/\s+/).filter(Boolean);
  if (parts.length === 0) return null;
  return { name: parts[0]!.toLowerCase(), args: parts.slice(1) };
}

/**
 * 执行命令。
 * @returns 命令输出字符串；命令不存在时返回错误提示。
 */
export async function executeCommand(
  name: string,
  args: string[],
  ctx: CommandContext
): Promise<string> {
  const cmd = commands.get(name.toLowerCase());
  if (!cmd) {
    console.log(`[cmd] unknown /${name} (session: ${ctx.session?.sessionId ?? "?"})`);
    return (
      `❌ 未知命令 \`/${name}\`\n` +
      `发送 \`/help\` 查看所有可用命令。`
    );
  }
  console.log(`[cmd] /${name}${args.length ? " " + args.join(" ") : ""} (session: ${ctx.session?.sessionId ?? "?"})`);
  try {
    // args is always provided via spread; cast to satisfy the execute signature
    return await cmd.execute({ ...ctx, args } as CommandContext & { args: string[] });
  } catch (err) {
    console.error(`[cmd] /${name} error:`, err);
    return `❌ 命令 \`/${name}\` 执行失败：${err instanceof Error ? err.message : String(err)}`;
  }
}
