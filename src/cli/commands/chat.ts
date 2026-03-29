/**
 * tinyclaw chat — 会话管理与消息发送
 *
 * 用法：
 *   chat list                              列出所有会话（只读）
 *   chat new [--agent <id>]               新建终端会话
 *   chat -s <sessionId> <消息>             发送消息到指定会话
 *   chat -s <sessionId> bind <agentId>    将会话绑定到 Agent
 *   chat loop <sub> [args...]             管理 loop session（list/show/enable/disable/trigger/set）
 */

import { existsSync, readdirSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { sendToAgent, listSessions, createSession, triggerLoop } from "../../ipc/client.js";
import { IPC_SOCKET_PATH } from "../../ipc/protocol.js";
import { bold, dim, red, cyan, green, yellow } from "../ui.js";
import { AgentManager } from "../../core/agent-manager.js";
import type { LoopSessionConfig } from "../../core/agent-manager.js";
import { agentManager } from "../../core/agent-manager.js";
import { patchTomlField } from "../../config/writer.js";
import type { SessionInfo } from "../../ipc/protocol.js";

export const description = "会话管理与消息发送";
export const usage = "chat <list|new|loop|-s <id> <msg>>";

/** 第二层：只列子命令 */
function printHelp(): void {
  console.log(`
${bold("tinyclaw chat")}  —  会话管理与消息发送

${bold("子命令：")}
  ${cyan("list")}              列出所有会话（只读）
  ${cyan("new")}               新建终端会话
  ${cyan("loop")}              管理 loop session（定时自主执行）
  ${cyan("-s <id> <消息>")}    发送消息到指定会话
  ${cyan("-s <id> bind")}      将会话绑定到指定 Agent

${dim("运行 tinyclaw chat <sub> -h 查看子命令详细参数")}
`);
}

/** 第三层：显示指定子命令的完整参数说明 */
function printSubHelp(sub: string): void {
  switch (sub) {
    case "list":
      console.log(`
${bold("tinyclaw chat list")}

  列出所有会话（持久化记录 + 内存中活跃 session）。
  显示状态（运行中/空闲）、消息数、最后一条用户消息。
  无需额外参数。

${bold("会话 ID 格式：")}
  ${cyan("cli:<uuid>")}               终端会话
  ${cyan("qqbot:c2c:<openid>")}       QQ 私聊会话
  ${cyan("qqbot:group:<openid>")}     QQ 群聊会话
`);
      break;
    case "new":
      console.log(`
${bold("tinyclaw chat new")} [qqbot | --agent <id>] [--loop [--interval <秒>]]

${bold("选项：")}
  --agent, -a <id>                        绑定到指定 Agent（默认 default）
  --loop                                  创建后立即启用 loop（定时自主执行）
  --interval <秒>                         loop 触发间隔，秒数（默认 60，需与 --loop 同用）

${bold("QQBot 子模式：")}
  chat new qqbot --app-id <id> --secret <secret>
    --app-id <id>     QQBot 应用 ID
    --secret <secret> QQBot ClientSecret
    写入 config.toml 后需重启服务：tinyclaw restart
`);
      break;
    case "send":
      console.log(`
${bold("tinyclaw chat -s <sessionId> <消息>")}

  向指定会话发送消息，等待并打印 Agent 回复。

${bold("参数：")}
  -s, --session <id>   目标会话 ID（运行 chat list 查看）
  <消息>               要发送的消息文本
`);
      break;
    case "bind":
      console.log(`
${bold("tinyclaw chat -s <sessionId> bind <agentId>")}

  将指定会话绑定到指定 Agent，后续消息将由该 Agent 处理。

${bold("参数：")}
  -s, --session <id>   目标会话 ID
  <agentId>            目标 Agent ID（运行 tinyclaw agent list 查看）
`);
      break;
    case "loop":
      console.log(`
${bold("tinyclaw chat loop")}  —  管理 loop session（定时自主执行）

${bold("子命令：")}
  ${cyan("list")}                          列出所有配置了 loop 的 session
  ${cyan("show")}  <sessionId>             查看指定 session 的 loop 配置
  ${cyan("enable")}  <sessionId>           启用（或新建）loop 配置
  ${cyan("disable")}  <sessionId>          禁用 loop（设 enabled=false）
  ${cyan("trigger")}  <sessionId>          立即触发一次 tick（通过 IPC）
  ${cyan("set")}  <sessionId> <key=value>  修改单个配置字段

${bold("配置字段（set 可用）：")}
  agentId        走哪个 agent 记忆（默认 default）
  tickSeconds    上次执行结束后等待的秒数（默认 60）
  taskFile       任务文件路径（绝对路径或相对 agentDir）
  enabled        是否启用（true / false）

${bold("配置文件位置：")}
  ~/.tinyclaw/sessions/<sessionId>.toml  中的 [loop] 块
`);
      break;
    default:
      console.error(red(`未知子命令 "${sub}"`));
      printHelp();
  }
}

export async function run(args: string[]): Promise<void> {
  if (!args[0] || args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
    printHelp();
    return;
  }

  // ── list 子命令 ─────────────────────────────────────────────────────────────
  if (args[0] === "list") {
    if (args.includes("-h") || args.includes("--help")) {
      printSubHelp("list");
      return;
    }
    await runList();
    return;
  }

  // ── new 子命令 ──────────────────────────────────────────────────────────────
  if (args[0] === "new") {
    if (args.includes("-h") || args.includes("--help")) {
      printSubHelp("new");
      return;
    }
    const rest = args.slice(1);
    // chat new qqbot --app-id <id> --secret <secret>
    if (rest[0] === "qqbot") {
      await runNewQQBot(rest.slice(1));
      return;
    }
    let agentId: string | undefined;
    let enableLoop = false;
    let loopInterval: number | undefined;
    for (let i = 0; i < rest.length; i++) {
      if ((rest[i] === "--agent" || rest[i] === "-a") && rest[i + 1]) {
        agentId = rest[++i];
      } else if (rest[i] === "--loop") {
        enableLoop = true;
      } else if (rest[i] === "--interval" && rest[i + 1]) {
        loopInterval = parseInt(rest[++i]!, 10);
      }
    }
    if (loopInterval !== undefined && !enableLoop) {
      console.error(red("错误：--interval 必须与 --loop 一起使用"));
      console.error(dim("  示例：tinyclaw chat new --loop --interval 300"));
      process.exit(1);
    }
    if (loopInterval !== undefined && (isNaN(loopInterval) || loopInterval < 1)) {
      console.error(red("错误：--interval 必须为正整数（秒）"));
      process.exit(1);
    }
    await runNew(agentId, enableLoop ? { interval: loopInterval ?? 60 } : undefined);
    return;
  }

  // ── loop 子命令 ─────────────────────────────────────────────────────────────
  if (args[0] === "loop") {
    if (args[1] === "-h" || args[1] === "--help" || !args[1]) {
      printSubHelp("loop");
      return;
    }
    await runLoopCmd(args.slice(1));
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
  if (sessionId && rest[0] === "bind") {
    if (rest.includes("-h") || rest.includes("--help")) { printSubHelp("bind"); return; }
    if (rest[1]) { runBind(sessionId, rest[1]); return; }
  }

  // ── 无 -s 时拒绝（不自动生成）────────────────────────────────────────────
  if (!sessionId) {
    if (rest.includes("-h") || rest.includes("--help")) { printSubHelp("send"); return; }
    console.error(red("错误：必须通过 -s 指定会话 ID"));
    console.error(dim("  新建会话：tinyclaw chat new"));
    console.error(dim("  查看会话：tinyclaw chat list"));
    printHelp();
    process.exit(1);
  }

  if (rest.includes("-h") || rest.includes("--help")) { printSubHelp("send"); return; }

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

async function runNew(agentId?: string, loopOpts?: { interval: number }): Promise<void> {
  if (!existsSync(IPC_SOCKET_PATH)) {
    console.error(red("错误：tinyclaw 主服务未运行，请先执行 tinyclaw start"));
    process.exit(1);
  }
  try {
    const sessionId = await createSession(agentId);
    console.log(green(`✓ 新会话已创建：${sessionId}`));
    if (agentId) console.log(dim(`  Agent：${agentId}`));
    if (loopOpts) {
      const resolvedAgentId = agentId ?? "default";
      const taskFile = `tasks/${sessionId}.md`;
      agentManager.writeSessionLoop(sessionId, {
        enabled: true,
        agentId: resolvedAgentId,
        tickSeconds: loopOpts.interval,
        taskFile,
      });
      // 自动创建任务文件
      createTaskFile(resolvedAgentId, sessionId, loopOpts.interval);
      console.log(green(`✓ loop 已启用（tickSeconds=${loopOpts.interval}）`));
      console.log(dim(`  配置文件：${agentManager.getSessionTomlPath(sessionId)}`));
      console.log(dim(`  任务文件：${join(agentManager.agentDir(resolvedAgentId), taskFile)}`));
      console.log(dim("  修改配置：tinyclaw chat loop set <sessionId> <key=value>"));
    }
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

// ── chat loop 子命令 ──────────────────────────────────────────────────────────

async function runLoopCmd(args: string[]): Promise<void> {
  const sub = args[0];

  switch (sub) {
    case "list":
      runLoopList();
      break;
    case "show":
      runLoopShow(args[1]);
      break;
    case "enable":
      runLoopEnable(args[1]);
      break;
    case "disable":
      runLoopDisable(args[1]);
      break;
    case "trigger":
      await runLoopTrigger(args[1]);
      break;
    case "set":
      runLoopSet(args[1], args[2]);
      break;
    default:
      console.error(red(`未知 loop 子命令 "${sub ?? ""}"`));
      printSubHelp("loop");
      process.exit(1);
  }
}

/** chat loop list */
function runLoopList(): void {
  const loops = agentManager.listSessionLoops();
  if (loops.length === 0) {
    console.log(dim("暂无启用的 loop session"));
    console.log(dim("  启用：tinyclaw chat loop enable <sessionId>"));
    return;
  }
  console.log(`\n${bold("Loop Session 列表")}\n`);
  for (const { sessionId, cfg } of loops) {
    console.log(`  ${cyan(sessionId)}`);
    console.log(`    Agent: ${cfg.agentId}  间隔: ${cfg.tickSeconds}s`);
    console.log(`    任务文件: ${cfg.taskFile}`);
  }
  console.log();
}

/** chat loop show <sessionId> */
function runLoopShow(sessionId: string | undefined): void {
  if (!sessionId) {
    console.error(red("错误：请提供 sessionId"));
    console.error(dim("  用法：tinyclaw chat loop show <sessionId>"));
    process.exit(1);
  }
  const cfg = agentManager.readSessionLoop(sessionId);
  const tomlPath = agentManager.getSessionTomlPath(sessionId);
  console.log(`\n${bold(`Loop 配置：${sessionId}`)}`);
  console.log(dim("─".repeat(48)));
  console.log(`  配置文件：${tomlPath}`);
  if (!cfg) {
    console.log(dim("  未启用（[loop] 块不存在或 enabled = false）"));
    console.log(dim("  启用：tinyclaw chat loop enable <sessionId>"));
  } else {
    console.log(`  ${green("✓ 已启用")}`);
    console.log(`  agentId     : ${cfg.agentId}`);
    console.log(`  tickSeconds : ${cfg.tickSeconds}`);
    console.log(`  taskFile    : ${cfg.taskFile}`);
  }
  console.log();
}

/** chat loop enable <sessionId> */
function runLoopEnable(sessionId: string | undefined): void {
  if (!sessionId) {
    console.error(red("错误：请提供 sessionId"));
    console.error(dim("  用法：tinyclaw chat loop enable <sessionId>"));
    process.exit(1);
  }
  // 读取已有配置（若有），以保留已有字段
  const existing = agentManager.readSessionLoop(sessionId);
  const isNew = !existing;
  const taskFile = isNew ? `tasks/${sessionId}.md` : (existing.taskFile ?? `tasks/${sessionId}.md`);
  const cfg: LoopSessionConfig = existing ?? {
    enabled: true,
    agentId: "default",
    tickSeconds: 60,
    taskFile,
  };
  cfg.enabled = true;
  agentManager.writeSessionLoop(sessionId, cfg);
  // 首次启用时自动创建任务文件
  if (isNew) {
    createTaskFile(cfg.agentId, sessionId, cfg.tickSeconds);
    console.log(dim(`  任务文件：${join(agentManager.agentDir(cfg.agentId), taskFile)}`));
  }
  console.log(green(`✓ loop 已启用：${sessionId}`));
  console.log(dim(`  配置文件：${agentManager.getSessionTomlPath(sessionId)}`));
  console.log(dim(`  默认每 ${cfg.tickSeconds}s 执行一次 ${cfg.taskFile}`));
  console.log(dim("  修改配置：tinyclaw chat loop set <sessionId> <key=value>"));
  console.log(dim("  重启服务后生效：tinyclaw restart"));
}

/** chat loop disable <sessionId> */
function runLoopDisable(sessionId: string | undefined): void {
  if (!sessionId) {
    console.error(red("错误：请提供 sessionId"));
    console.error(dim("  用法：tinyclaw chat loop disable <sessionId>"));
    process.exit(1);
  }
  const cfg = agentManager.readSessionLoop(sessionId);
  if (!cfg) {
    // 即使没有 loop 配置，也写入一个 enabled=false 的文件，防止误触
    agentManager.writeSessionLoop(sessionId, {
      enabled: false,
      agentId: "default",
      tickSeconds: 60,
      taskFile: "TASK.md",
    });
  } else {
    cfg.enabled = false;
    agentManager.writeSessionLoop(sessionId, cfg);
  }
  console.log(green(`✓ loop 已禁用：${sessionId}`));
  console.log(dim("  重启服务后生效：tinyclaw restart"));
}

/** chat loop trigger <sessionId> */
async function runLoopTrigger(sessionId: string | undefined): Promise<void> {
  if (!sessionId) {
    console.error(red("错误：请提供 sessionId"));
    console.error(dim("  用法：tinyclaw chat loop trigger <sessionId>"));
    process.exit(1);
  }
  if (!existsSync(IPC_SOCKET_PATH)) {
    console.error(red("错误：tinyclaw 主服务未运行，请先执行 tinyclaw start"));
    process.exit(1);
  }
  try {
    const { found } = await triggerLoop(sessionId);
    if (found) {
      console.log(green(`✓ loop tick 已触发：${sessionId}（后台执行中）`));
    } else {
      console.error(red(`触发失败：session "${sessionId}" 无有效 loop 配置（或未启用）`));
      console.error(dim("  先启用：tinyclaw chat loop enable <sessionId>"));
      process.exit(1);
    }
  } catch (err) {
    console.error(red(`触发失败：${err instanceof Error ? err.message : String(err)}`));
    process.exit(1);
  }
}

/** chat loop set <sessionId> <key=value> */
function runLoopSet(sessionId: string | undefined, kvPair: string | undefined): void {
  if (!sessionId || !kvPair) {
    console.error(red("错误：请提供 sessionId 和 key=value"));
    console.error(dim("  用法：tinyclaw chat loop set <sessionId> <key=value>"));
    console.error(dim("  示例：tinyclaw chat loop set cli:abc123 tickSeconds=120"));
    process.exit(1);
  }
  const eqIdx = kvPair.indexOf("=");
  if (eqIdx < 1) {
    console.error(red(`格式错误："${kvPair}"，应为 key=value`));
    process.exit(1);
  }
  const key = kvPair.slice(0, eqIdx).trim();
  const value = kvPair.slice(eqIdx + 1).trim();

  // 读取现有配置（若无则用默认值）
  const cfg: LoopSessionConfig = agentManager.readSessionLoop(sessionId) ?? {
    enabled: false,
    agentId: "default",
    tickSeconds: 60,
    taskFile: "TASK.md",
  };

  const validKeys = ["agentId", "tickSeconds", "taskFile", "enabled"];
  if (!validKeys.includes(key)) {
    console.error(red(`未知配置字段 "${key}"`));
    console.error(dim(`  可用字段：${validKeys.join(", ")}`));
    process.exit(1);
  }

  // 类型转换
  switch (key) {
    case "tickSeconds":
      cfg.tickSeconds = parseInt(value, 10);
      if (isNaN(cfg.tickSeconds) || cfg.tickSeconds < 1) {
        console.error(red("tickSeconds 必须为正整数"));
        process.exit(1);
      }
      break;
    case "enabled":
      cfg.enabled = value === "true" || value === "1";
      break;
    case "agentId":
      cfg.agentId = value;
      break;
    case "taskFile":
      cfg.taskFile = value;
      break;
  }

  agentManager.writeSessionLoop(sessionId, cfg);
  console.log(green(`✓ ${sessionId} [loop].${key} = ${value}`));
  console.log(dim("  重启服务后生效：tinyclaw restart"));
}

// ── 辅助函数 ──────────────────────────────────────────────────────────────────

/** 在 agentDir/tasks/<sessionId>.md 创建任务文件模板（若已存在则跳过） */
function createTaskFile(agentId: string, sessionId: string, tickSeconds: number): void {
  const tasksDir = join(agentManager.agentDir(agentId), "tasks");
  const taskPath = join(tasksDir, `${sessionId}.md`);
  if (existsSync(taskPath)) return;
  mkdirSync(tasksDir, { recursive: true });
  const template = `# Loop Task — ${sessionId}

此文件每隔 ${tickSeconds} 秒被读取一次，内容将作为用户消息发送给 Agent（${agentId}）执行。
修改此文件后无需重启服务，下次 tick 时自动生效。

## 任务

在这里描述你希望 Agent 定期执行的任务。
`;
  writeFileSync(taskPath, template, "utf-8");
}
