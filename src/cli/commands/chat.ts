/**
 * tinyclaw chat — 向 agent 发送消息，支持会话路由
 *
 * 用法：
 *   tinyclaw chat <message>                         # 全新终端会话
 *   tinyclaw chat -s <sessionId> <message>          # 复用指定会话
 *   tinyclaw chat -s qqbot:c2c:<openid> <message>   # 注入 QQBot 私聊，同时推送至 QQ
 *   tinyclaw chat -s qqbot:group:<openid> <message> # 注入 QQBot 群消息
 */

import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { randomUUID } from "crypto";
import { sendToAgent, listSessions } from "../../ipc/client.js";
import { IPC_SOCKET_PATH } from "../../ipc/protocol.js";
import { bold, dim, red, cyan, green } from "../ui.js";
import { select, prompt, closeRl } from "../ui.js";
import type { SessionInfo } from "../../ipc/protocol.js";

export const description = "向 agent 发送消息（支持 QQBot 会话路由）";
export const usage = "chat [-s <sessionId>] <message>";

function printHelp(): void {
  console.log(`
${bold("用法：")}
  chat list                               列出所有活跃会话
  chat <message>                          新建终端会话，发送消息
  chat -s <sessionId> <message>           复用指定会话
  chat -s qqbot:c2c:<openid> <message>    注入 QQBot C2C 会话（同时推送到 QQ）
  chat -s qqbot:group:<openid> <message>  注入 QQBot 群会话（同时推送到 QQ 群）

${bold("说明：")}
  tinyclaw 主服务必须正在运行（bun src/main.ts）。
  会话 ID 格式：
    ${cyan("cli:<uuid>")}                  终端会话（不指定 -s 时自动生成）
    ${cyan("qqbot:c2c:<openid>")}          QQ 私聊会话
    ${cyan("qqbot:group:<openid>")}        QQ 群会话
    ${cyan("qqbot:guild:<channelId>")}     QQ 频道会话

${bold("选项：")}
  -s, --session <sessionId>   指定或恢复会话
  -h, --help                  显示此帮助
`);
}

export async function run(args: string[]): Promise<void> {
  if (args.includes("--help") || args.includes("-h") || args.includes("help")) {
    printHelp();
    return;
  }

  // ── list 子命令 ─────────────────────────────────────────────────────────────
  if (args[0] === "list") {
    await runList();
    return;
  }

  // 解析 -s / --session
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

  const message = rest.join(" ").trim();
  if (!message) {
    console.error(red("错误：请提供消息内容"));
    printHelp();
    process.exit(1);
  }

  // 未指定会话时自动生成 CLI 会话 ID
  if (!sessionId) {
    sessionId = `cli:${randomUUID()}`;
  }

  // 检查主服务是否运行
  if (!existsSync(IPC_SOCKET_PATH)) {
    console.error(red("错误：tinyclaw 主服务未运行，请先执行 bun src/main.ts"));
    process.exit(1);
  }

  const isQQBot = sessionId.startsWith("qqbot:");
  console.log(dim(`Session: ${sessionId}`));
  if (isQQBot) {
    console.log(dim("回复将同时推送至对应 QQ 频道"));
  }
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

// ── chat list 实现 ────────────────────────────────────────────────────────────

interface DiskSession {
  sessionId: string;
  messageCount: number;
  lastUserMessage: string;
}

/** 将 JSONL 文件名（已去掉 .jsonl 后缀）还原为 sessionId */
function filenameToSessionId(basename: string): string {
  // 已知前缀 → 需要替换的前导下划线数量
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
        } catch { /* skip malformed line */ }
      }
    } catch { /* skip unreadable file */ }
    return { sessionId, messageCount, lastUserMessage };
  });
}

async function runList(): Promise<void> {
  // 1. 扫描磁盘持久化的会话
  const disk = scanDiskSessions();
  const diskMap = new Map<string, DiskSession>(disk.map((s) => [s.sessionId, s]));

  // 2. 尝试从运行中的服务器获取内存会话（可选，服务不在则跳过）
  let memory: SessionInfo[] = [];
  const serverRunning = existsSync(IPC_SOCKET_PATH);
  if (serverRunning) {
    try {
      memory = await listSessions();
    } catch { /* ignore */ }
  }
  const memoryMap = new Map<string, SessionInfo>(memory.map((s) => [s.sessionId, s]));

  // 3. 合并所有会话 ID
  const allIds = [
    // 优先展示 QQ 会话，再是终端会话
    ...[...new Set([...diskMap.keys(), ...memoryMap.keys()])].filter((id) =>
      id.startsWith("qqbot:")
    ).sort(),
    ...[...new Set([...diskMap.keys(), ...memoryMap.keys()])].filter((id) =>
      id.startsWith("cli:")
    ).sort(),
    ...[...new Set([...diskMap.keys(), ...memoryMap.keys()])].filter(
      (id) => !id.startsWith("qqbot:") && !id.startsWith("cli:")
    ).sort(),
  ];

  // 4. 构建选择菜单
  type Choice = { type: "session"; id: string } | { type: "new" };

  const items: { label: string; value: Choice; note?: string }[] = [
    {
      label: green("+ 新建终端会话"),
      value: { type: "new" },
      ...(serverRunning ? {} : { note: dim("（服务未运行，将启动失败）") }),
    },
    ...allIds.map((id) => {
      const mem = memoryMap.get(id);
      const disk2 = diskMap.get(id);
      const msgCount = mem?.messageCount ?? disk2?.messageCount ?? 0;
      const lastMsg = mem?.lastUserMessage || disk2?.lastUserMessage || "";
      let statusTag: string;
      if (mem?.running) statusTag = green("⚡运行中");
      else if (mem) statusTag = "空闲";
      else statusTag = dim("持久化");
      const note = [
        statusTag,
        `${msgCount}条消息`,
        lastMsg ? `"${lastMsg.slice(0, 50)}${lastMsg.length > 50 ? "…" : ""}"` : "",
      ]
        .filter(Boolean)
        .join("  ");
      return { label: cyan(id), value: { type: "session" as const, id }, note };
    }),
  ];

  const choice = await select<Choice>("选择会话（或新建）", items);
  closeRl();

  const sessionId =
    choice.type === "new" ? `cli:${randomUUID()}` : choice.id;

  if (!serverRunning) {
    console.error(red("\n错误：tinyclaw 主服务未运行，请先执行 tinyclaw start"));
    process.exit(1);
  }

  await runRepl(sessionId);
}

/** 交互式 REPL：在指定会话中持续收发消息，直到用户 Ctrl-C 或 /quit */
async function runRepl(sessionId: string): Promise<void> {
  const isQQBot = sessionId.startsWith("qqbot:");
  console.log();
  console.log(dim(`会话: ${sessionId}`));
  if (isQQBot) {
    console.log(dim("回复将同时推送至对应 QQ 频道"));
  }
  console.log(dim("输入消息后回车发送，Ctrl-C 或输入 /quit 退出\n"));

  while (true) {
    let input: string;
    try {
      input = await prompt(cyan("> "));
    } catch {
      // Ctrl-C / readline closed
      break;
    }
    const msg = input.trim();
    if (!msg) continue;
    if (msg === "/quit" || msg === "/exit" || msg === "/q") break;

    try {
      await sendToAgent({
        sessionId,
        message: msg,
        onChunk: (delta) => process.stdout.write(delta),
      });
      process.stdout.write("\n\n");
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(red(`发送失败：${errMsg}\n`));
    }
  }

  closeRl();
}
