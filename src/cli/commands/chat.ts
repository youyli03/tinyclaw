/**
 * tinyclaw chat — 会话管理与消息发送
 *
 * 用法：
 *   chat list                              列出所有会话（只读）
 *   chat new [--agent <id>]               新建终端会话
 *   chat -s <sessionId> <消息>             发送消息到指定会话
 *   chat -s <sessionId> bind <agentId>    将会话绑定到 Agent
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { sendToAgent, listSessions, createSession } from "../../ipc/client.js";
import { IPC_SOCKET_PATH } from "../../ipc/protocol.js";
import { bold, dim, red, cyan, green } from "../ui.js";
import { AgentManager } from "../../core/agent-manager.js";
import { patchTomlField } from "../../config/writer.js";
import type { SessionInfo } from "../../ipc/protocol.js";

export const description = "会话管理与消息发送";
export const usage = "chat <list|new|-s <id> <msg>>";

function printHelp(): void {
  console.log(`
${bold("用法：")}
  chat list                                               列出所有会话（只读）
  chat new [--agent <id>]                                 新建终端会话
  chat new qqbot --app-id <id> --secret <secret>          配置 QQBot 渠道
  chat -s <sessionId> <消息>                              发送消息到指定会话
  chat -s <sessionId> bind <agentId>                      将会话绑定到 Agent

${bold("示例：")}
  tinyclaw chat new                                       新建默认 Agent 的会话
  tinyclaw chat new --agent mywork                        新建绑定到 mywork Agent 的会话
  tinyclaw chat new qqbot --app-id 1234 --secret abc123   配置 QQBot 并写入 config.toml
  tinyclaw chat -s cli:<uuid> 你好                        向指定会话发送消息
  tinyclaw chat -s cli:<uuid> bind work                   将会话绑定到 work Agent
  tinyclaw chat list                                      查看所有会话

${bold("会话 ID 格式：")}
  ${cyan("cli:<uuid>")}                  终端会话（chat new 自动生成）
  ${cyan("qqbot:c2c:<openid>")}          QQ 私聊会话（QQ 用户主动发消息后自动出现）
  ${cyan("qqbot:group:<openid>")}        QQ 群聊会话

${bold("QQBot 说明：")}
  配置后需重启守护进程：${cyan("tinyclaw restart")}
  QQ 用户向机器人发消息后，会话将自动以 ${cyan("qqbot:c2c:<openid>")} 格式出现在 ${cyan("chat list")} 中。
`);
}

export async function run(args: string[]): Promise<void> {
  if (!args[0] || args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
    printHelp();
    return;
  }

  // ── list 子命令 ─────────────────────────────────────────────────────────────
  if (args[0] === "list") {
    if (args.includes("-h") || args.includes("--help")) {
      printHelp();
      return;
    }
    await runList();
    return;
  }

  // ── new 子命令 ──────────────────────────────────────────────────────────────
  if (args[0] === "new") {
    if (args.includes("-h") || args.includes("--help")) {
      printHelp();
      return;
    }
    const rest = args.slice(1);
    // chat new qqbot --app-id <id> --secret <secret>
    if (rest[0] === "qqbot") {
      await runNewQQBot(rest.slice(1));
      return;
    }
    let agentId: string | undefined;
    for (let i = 0; i < rest.length; i++) {
      if ((rest[i] === "--agent" || rest[i] === "-a") && rest[i + 1]) {
        agentId = rest[++i];
      }
    }
    await runNew(agentId);
    return;
  }

  // ── 解析 -s / --session ────────────────────────────────────────────────────
  let sessionId: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if ((arg === "-s" || arg === "--session") && i + 1 < args.length) {
      sessionId = args[++i];
    } else {
      rest.push(arg);
    }
  }

  // ── chat -s <id> bind <agentId> ────────────────────────────────────────────
  if (sessionId && rest[0] === "bind" && rest[1]) {
    runBind(sessionId, rest[1]);
    return;
  }

  // ── 无 -s 时拒绝（不自动生成）────────────────────────────────────────────
  if (!sessionId) {
    console.error(red("错误：必须通过 -s 指定会话 ID"));
    console.error(dim("  新建会话：tinyclaw chat new"));
    console.error(dim("  查看会话：tinyclaw chat list"));
    printHelp();
    process.exit(1);
  }

  const message = rest.join(" ").trim();
  if (!message) {
    console.error(red("错误：请提供消息内容"));
    console.error(dim(`  用法：tinyclaw chat -s ${sessionId} <消息>`));
    process.exit(1);
  }

  await runSend(sessionId, message);
}

// ── chat list（只读）─────────────────────────────────────────────────────────

interface DiskSession {
  sessionId: string;
  messageCount: number;
  lastUserMessage: string;
}

/** 将 JSONL 文件名（已去除 .jsonl 后缀）还原为 sessionId */
function filenameToSessionId(basename: string): string {
  const prefixes: [string, number][] = [
    ["qqbot_c2c_", 2],
    ["qqbot_group_", 2],
    ["qqbot_guild_", 2],
    ["cli_", 1],
  ];
  for (const [prefix, colons] of prefixes) {
    if (basename.startsWith(prefix)) {
      let s = basename;
      for (let i = 0; i < colons; i++) s = s.replace("_", ":");
      return s;
    }
  }
  return basename;
}

/** 扫描 ~/.tinyclaw/sessions/ 目录，返回所有持久化的会话摘要 */
function scanDiskSessions(): DiskSession[] {
  const dir = join(homedir(), ".tinyclaw", "sessions");
  if (!existsSync(dir)) return [];
  let files: string[];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return [];
  }
  return files.map((file) => {
    const sessionId = filenameToSessionId(file.slice(0, -6));
    let messageCount = 0;
    let lastUserMessage = "";
    try {
      const lines = readFileSync(join(dir, file), "utf-8").split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as { role?: string; content?: string };
          if (entry.role === "user" || entry.role === "assistant") messageCount++;
          if (entry.role === "user" && typeof entry.content === "string") {
            lastUserMessage = entry.content.slice(0, 80);
          }
        } catch { /* skip malformed */ }
      }
    } catch { /* skip unreadable */ }
    return { sessionId, messageCount, lastUserMessage };
  });
}

async function runList(): Promise<void> {
  const disk = scanDiskSessions();
  const diskMap = new Map<string, DiskSession>(disk.map((s) => [s.sessionId, s]));

  let memory: SessionInfo[] = [];
  const serverRunning = existsSync(IPC_SOCKET_PATH);
  if (serverRunning) {
    try {
      memory = await listSessions();
    } catch { /* ignore */ }
  }
  const memoryMap = new Map<string, SessionInfo>(memory.map((s) => [s.sessionId, s]));

  const allIds = [
    ...[...new Set([...diskMap.keys(), ...memoryMap.keys()])].filter((id) => id.startsWith("qqbot:")).sort(),
    ...[...new Set([...diskMap.keys(), ...memoryMap.keys()])].filter((id) => id.startsWith("cli:")).sort(),
    ...[...new Set([...diskMap.keys(), ...memoryMap.keys()])].filter(
      (id) => !id.startsWith("qqbot:") && !id.startsWith("cli:")
    ).sort(),
  ];

  if (allIds.length === 0) {
    console.log(dim("暂无会话记录"));
    console.log(dim("新建会话：tinyclaw chat new"));
    return;
  }

  const statusSuffix = serverRunning ? dim("（服务运行中）") : dim("（服务未运行，仅显示持久化记录）");
  console.log(`\n${bold("会话列表")}  ${statusSuffix}\n`);

  for (const id of allIds) {
    const mem = memoryMap.get(id);
    const disk2 = diskMap.get(id);
    const msgCount = mem?.messageCount ?? disk2?.messageCount ?? 0;
    const lastMsg = mem?.lastUserMessage ?? disk2?.lastUserMessage ?? "";

    let statusTag: string;
    if (mem?.running) statusTag = green("⚡运行中");
    else if (mem) statusTag = "空闲";
    else statusTag = dim("持久化");

    console.log(`  ${cyan(id)}`);
    const preview = lastMsg ? `  ${dim(`"${lastMsg.slice(0, 50)}${lastMsg.length > 50 ? "…" : ""}"`)}` : "";
    console.log(`    ${statusTag}  ${dim(`${msgCount} 条消息`)}${preview}`);
  }

  console.log();
  console.log(dim("新建会话：tinyclaw chat new [--agent <id>]"));
}

// ── chat new ──────────────────────────────────────────────────────────────────

async function runNew(agentId?: string): Promise<void> {
  if (!existsSync(IPC_SOCKET_PATH)) {
    console.error(red("错误：tinyclaw 主服务未运行，请先执行 tinyclaw start"));
    process.exit(1);
  }
  try {
    const sessionId = await createSession(agentId);
    console.log(green(`✓ 新会话已创建：${sessionId}`));
    if (agentId) console.log(dim(`  Agent：${agentId}`));
    console.log(dim(`  发送消息：tinyclaw chat -s ${sessionId} <消息>`));
  } catch (err) {
    console.error(red(`创建失败：${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }
}

// ── chat new qqbot ────────────────────────────────────────────────────────────

async function runNewQQBot(args: string[]): Promise<void> {
  let appId: string | undefined;
  let clientSecret: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--app-id" && args[i + 1]) appId = args[++i];
    else if (args[i] === "--secret" && args[i + 1]) clientSecret = args[++i];
  }
  if (!appId || !clientSecret) {
    console.error(red("错误：必须提供 --app-id 和 --secret"));
    console.error(dim("  用法：tinyclaw chat new qqbot --app-id <id> --secret <secret>"));
    process.exit(1);
  }
  patchTomlField(["channels", "qqbot"], "appId", JSON.stringify(appId));
  patchTomlField(["channels", "qqbot"], "clientSecret", JSON.stringify(clientSecret));
  console.log(green("✓ QQBot 已写入 config.toml"));
  console.log(dim(`  appId        = ${appId}`));
  console.log(dim(`  clientSecret = ${"*".repeat(4)}${clientSecret.slice(-4)}`));
  console.log(dim("  执行 tinyclaw restart 使配置生效"));
  console.log(dim("  QQ 用户向机器人发消息后，会话将自动出现在 tinyclaw chat list 中"));
}

// ── chat -s <id> bind <agentId> ───────────────────────────────────────────────

function runBind(sessionId: string, agentId: string): void {
  const mgr = new AgentManager();
  try {
    mgr.load(agentId);
  } catch {
    console.error(red(`错误：Agent "${agentId}" 不存在`));
    console.error(dim("  先创建：tinyclaw agent new <id>"));
    process.exit(1);
  }
  mgr.bindSession(sessionId, agentId);
  console.log(green(`✓ 会话 "${sessionId}" 已绑定到 Agent "${agentId}"`));
  console.log(dim("  下次在该会话收到消息时自动使用对应记忆空间与系统提示"));
}

// ── chat -s <id> <msg> ────────────────────────────────────────────────────────

async function runSend(sessionId: string, message: string): Promise<void> {
  if (!existsSync(IPC_SOCKET_PATH)) {
    console.error(red("错误：tinyclaw 主服务未运行，请先执行 tinyclaw start"));
    process.exit(1);
  }

  const isQQBot = sessionId.startsWith("qqbot:");
  console.log(dim(`Session: ${sessionId}`));
  if (isQQBot) console.log(dim("回复将同时推送至对应 QQ 频道"));
  process.stdout.write("\n");

  try {
    await sendToAgent({
      sessionId,
      message,
      onChunk: (delta) => process.stdout.write(delta),
    });
    process.stdout.write("\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(red(`\n发送失败：${msg}`));
    process.exit(1);
  }
}
