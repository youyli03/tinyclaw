/**
 * CLI 命令：session
 *
 * 子命令：
 *   session list               列出所有活跃 session（含运行状态）
 *   session abort <id>         中断指定 session 的 runAgent() 循环
 *                              <id> 可为完整 sessionId 或末尾子串（如日志中 12 位短 ID）
 *   session memory [sessionId] 整理指定 session 的记忆（压缩 → 持久化 → 向量化）
 */

import { listSessions, abortSession, memorizeSession } from "../../ipc/client.js";
import { bold, dim, cyan, green, yellow, red, section, select } from "../ui.js";

export const description = "管理活跃 session（list / abort / memory）";
export const usage = "session <list|abort|memory> [id]";

export async function run(args: string[]): Promise<void> {
  const sub = args[0];

  if (!sub || sub === "help" || sub === "--help" || sub === "-h") {
    printHelp();
    return;
  }

  if (sub === "list") {
    await cmdList();
    return;
  }

  if (sub === "abort") {
    const id = args[1];
    if (!id) {
      console.error(red("用法：tinyclaw session abort <sessionId|suffix>"));
      process.exitCode = 1;
      return;
    }
    await cmdAbort(id);
    return;
  }

  if (sub === "memory") {
    await cmdMemory(args[1]);
    return;
  }

  console.error(red(`未知子命令 "${sub}"。运行 tinyclaw session help 查看帮助。`));
  process.exitCode = 1;
}

// ── list ──────────────────────────────────────────────────────────────────────

async function cmdList(): Promise<void> {
  let sessions;
  try {
    sessions = await listSessions();
  } catch (e) {
    console.error(red(`无法连接 tinyclaw 服务：${e instanceof Error ? e.message : String(e)}`));
    console.error(dim("  请先运行 `tinyclaw start` 启动服务"));
    process.exitCode = 1;
    return;
  }

  if (sessions.length === 0) {
    console.log(dim("暂无活跃 session。"));
    return;
  }

  console.log(`\n${bold("活跃 Session 列表")}\n`);
  const cols = [cyan("Session ID"), "状态", "消息数", "最后一条用户消息"];
  const colWidths: number[] = [50, 8, 6, 50];

  // 表头
  console.log(cols.map((c, i) => c.padEnd(colWidths[i]!)).join("  "));
  console.log("-".repeat(colWidths.reduce((a, b) => a + b + 2, 0)));

  for (const s of sessions) {
    const status = s.running ? green("运行中") : dim("空闲");
    const lastMsg = s.lastUserMessage
      ? (s.lastUserMessage.length > 48 ? s.lastUserMessage.slice(0, 45) + "…" : s.lastUserMessage)
      : dim("—");
    const row = [
      cyan(s.sessionId.length > 48 ? s.sessionId.slice(0, 45) + "…" : s.sessionId),
      status,
      String(s.messageCount),
      lastMsg,
    ];
    console.log(row.map((c, i) => (c + "").padEnd(colWidths[i]!)).join("  "));
  }
  console.log();
}

// ── abort ─────────────────────────────────────────────────────────────────────

async function cmdAbort(idOrSuffix: string): Promise<void> {
  let result;
  try {
    result = await abortSession(idOrSuffix);
  } catch (e) {
    console.error(red(`无法连接 tinyclaw 服务：${e instanceof Error ? e.message : String(e)}`));
    console.error(dim("  请先运行 `tinyclaw start` 启动服务"));
    process.exitCode = 1;
    return;
  }

  if (result.found) {
    console.log(yellow(`⚡ 已发送中断信号 → ${cyan(result.sessionId)}`));
  } else {
    console.error(red(`未找到 session "${idOrSuffix}"`));
    console.error(dim("  运行 `tinyclaw session list` 查看所有 session ID"));
    process.exitCode = 1;
  }
}

// ── memory ────────────────────────────────────────────────────────────────────

async function cmdMemory(sessionId?: string): Promise<void> {
  let sid = sessionId;

  if (!sid) {
    // 从服务获取 session 列表，交互选择
    let sessions;
    try {
      sessions = await listSessions();
    } catch (e) {
      console.error(red(`无法连接 tinyclaw 服务：${e instanceof Error ? e.message : String(e)}`));
      console.error(dim("  请先运行 `tinyclaw start` 启动服务"));
      process.exitCode = 1;
      return;
    }
    if (sessions.length === 0) {
      console.log(dim("当前没有活跃的 session。"));
      return;
    }
    sid = await select<string>(
      "选择要整理记忆的 session：",
      sessions.map((s) => ({
        label: `${cyan(s.sessionId.slice(-20))}  ${dim(s.lastUserMessage || "(无消息)")}  [${s.messageCount} 条]`,
        value: s.sessionId,
      }))
    );
  }

  console.log(`\n${dim("正在整理记忆...")} sessionId: ${cyan(sid)}\n`);

  let summary: string;
  try {
    summary = await memorizeSession(sid);
  } catch (e) {
    console.error(red(`记忆整理失败：${e instanceof Error ? e.message : String(e)}`));
    process.exitCode = 1;
    return;
  }

  section("记忆整理完成");
  console.log(summary);
  console.log();
}

// ── help ──────────────────────────────────────────────────────────────────────

function printHelp(): void {
  console.log(`
${bold("tinyclaw session")}  —  管理活跃 session

${bold("用法：")}
  tinyclaw session list
  tinyclaw session abort <id>
  tinyclaw session memory [sessionId]

${bold("子命令：")}
  ${cyan("list")}                  列出服务中所有活跃 session 及其运行状态
  ${cyan("abort <id>")}            向指定 session 发送中断信号，终止其正在执行的 runAgent() 循环
                          <id> 可为完整 sessionId 或末尾子串（如日志中显示的 12 位短 ID）
  ${cyan("memory [sessionId]")}    整理指定 session 的对话历史（压缩 → 持久化 → 向量化）
                          不指定时交互式选择

${bold("示例：")}
  tinyclaw session list
  tinyclaw session abort cron:9xpyhnmh
  tinyclaw session abort 773847979014
  tinyclaw session memory
  tinyclaw session memory qqbot:c2c:5E93DFF4A42AFE45D206DEA724E5ECD2
  `);
}
