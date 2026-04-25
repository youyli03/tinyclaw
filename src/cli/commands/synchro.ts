/**
 * tinyclaw synchro — 实时跟踪指定 session 的 AI 活动
 *
 * 用法:
 *   synchro <sessionId 或后 12 位>
 *
 * 持续打印目标 session 的:
 *   - LLM 流式输出(灰色)
 *   - 工具调用(黄色,含参数摘要)
 *   - 工具结果(绿色,截断显示)
 *   - done / error 事件
 *
 * Ctrl-C 退出。
 */

import { connect, type Socket } from "net";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { IPC_SOCKET_PATH, type IpcResponse, type ActivityEvent } from "../../ipc/protocol.js";
import { bold, dim, cyan, red, yellow, green } from "../ui.js";
import { listSessions } from "../../ipc/client.js";

export const subcommands = ["list", "help"] as const;
export const description = "实时跟踪指定 session 的 AI 活动(LLM chunk + 工具调用)";
export const usage = "synchro <sessionId 或后缀>";

function printHelp(): void {
  console.log(`
${bold("tinyclaw synchro")}  —  实时跟踪 session 活动

${bold("用法:")}
  synchro <sessionId>          完整 session ID
  synchro <suffix>             session ID 的末尾子串(支持后 12 位短 ID)

${bold("输出:")}
  灰色    LLM 流式 chunk
  黄色    工具调用(工具名 + 参数摘要)
  绿色    工具结果(前 300 字符)
  蓝色    done 事件
  红色    error 事件

按 ${bold("Ctrl-C")} 退出。
`);
}

export async function run(args: string[]): Promise<void> {
  if (args.length === 0 || args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
    printHelp();
    return;
  }

  // `synchro list` — 打印所有 session 及其 ID（方便复制后缀）
  if (args[0] === "list") {
    if (!existsSync(IPC_SOCKET_PATH)) {
      console.error(red("tinyclaw 服务未运行，请先执行 tinyclaw start"));
      process.exit(1);
    }
    const sessions = await listSessions();
    if (sessions.length === 0) {
      console.log(dim("（没有活跃 session）"));
      return;
    }
    console.log(`\n${bold("活跃 session 列表：")}\n`);
    for (const s of sessions) {
      const suffix = dim(`(后缀: ${s.sessionId.slice(-8)})`);
      const tag = s.running ? yellow("● 运行中") : dim("○ 空闲");
      console.log(`  ${tag}  ${s.sessionId}  ${suffix}`);

    }
    console.log();
    return;
  }

  const idOrSuffix = args[0]!;

  if (!existsSync(IPC_SOCKET_PATH)) {
    console.error(red("tinyclaw 服务未运行，请先执行 tinyclaw start"));
    process.exit(1);
  }

  // 并发 tool_call / tool_result 可能交错，用 pendingLine 暂存未换行的状态
  let inChunk = false; // 当前是否处于 chunk 流式输出中（未换行）

  function connectAndSubscribe(idOrSuffix: string): Promise<void> {
    return new Promise<void>((resolve) => {
      let buf = "";
      let subscribed = false;

      const socket: Socket = connect(IPC_SOCKET_PATH, () => {
        socket.write(JSON.stringify({ type: "subscribe", idOrSuffix }) + "\n");
      });

      socket.on("data", (data) => {
        buf += data.toString("utf-8");
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.trim()) continue;
          let resp: IpcResponse;
          try { resp = JSON.parse(line) as IpcResponse; } catch { continue; }

          if (resp.type === "subscribed") {
            subscribed = true;
            console.log(dim(`✅ 已订阅 session: ${resp.sessionId}`));
            console.log(dim("按 Ctrl-C 退出\n"));
          } else if (resp.type === "error") {
            if (!subscribed) {
              // subscribe 失败 → 等待后重试（服务刚重启时 session 尚未恢复）
              socket.destroy();
              resolve(); // 触发外层重连
            } else {
              console.error(red(`\n错误: ${resp.message}`));
              socket.destroy();
              process.exit(1);
            }
          } else if (resp.type === "activity") {
            printEvent(resp.sessionId, resp.event, { inChunk: () => inChunk, setInChunk: (v) => { inChunk = v; } });
          }
        }
      });

      socket.on("error", (err) => {
        if (!subscribed) {
          resolve(); // 触发重连
        } else {
          console.error(red(`\n连接错误: ${err.message}`));
          process.exit(1);
        }
      });

      socket.on("close", () => {
        if (subscribed) {
          // 服务重启 → 自动重连
          if (inChunk) { process.stdout.write("\n"); inChunk = false; }
          console.log(dim("\n[服务重启，正在重连...]"));
          socket.destroy();
          resolve(); // 触发重连
        } else {
          resolve();
        }
      });

      // Ctrl-C 优雅退出
      process.on("SIGINT", () => {
        socket.destroy();
        process.exit(0);
      });
    });
  }

  // 自动重连循环
  while (true) {
    if (!existsSync(IPC_SOCKET_PATH)) {
      process.stdout.write(dim("."));
      await new Promise(r => setTimeout(r, 1000));
      continue;
    }
    await connectAndSubscribe(idOrSuffix);
    // 等待 sock 文件出现（服务重启期间）
    let waited = 0;
    while (!existsSync(IPC_SOCKET_PATH) && waited < 10000) {
      await new Promise(r => setTimeout(r, 500));
      waited += 500;
    }
    // 等待 session 恢复（服务刚重启时 session 还未加载）
    await new Promise(r => setTimeout(r, 800));
  }
}

function printEvent(sessionId: string, event: ActivityEvent, chunkState: { inChunk: () => boolean; setInChunk: (v: boolean) => void }): void {
  const ts = dim(new Date().toLocaleTimeString());

  switch (event.kind) {
    case "chunk":
      process.stdout.write(event.delta);
      chunkState.setInChunk(!event.delta.endsWith("\n"));
      break;

    case "tool_call": {
      // 格式化参数 JSON 为紧凑多字段摘要
      const argsDisplay = formatArgs(event.argsSummary, 200);
      const bar = brightYellow("▶");
      if (chunkState.inChunk()) { process.stdout.write("\n"); chunkState.setInChunk(false); }
      console.log(`${ts} ${bar} ${bold(brightYellow(event.name))}`);
      for (const line of argsDisplay) {
        console.log(`   ${dim("·")} ${line}`);
      }
      break;
    }

    case "tool_result": {
      const resultDisplay = event.resultSummary.length > 400
        ? event.resultSummary.slice(0, 400) + "…"
        : event.resultSummary;
      const bar = brightGreen("◀");
      console.log(`${ts} ${bar} ${bold(brightGreen(event.name))}`);
      // 结果可能是多行，直接缩进输出前 5 行
      const lines = resultDisplay.split("\n").slice(0, 5);
      for (const l of lines) {
        if (l.trim()) console.log(`   ${dim("·")} ${l}`);
      }
      break;
    }

    case "done":
      if (chunkState.inChunk()) { process.stdout.write("\n"); chunkState.setInChunk(false); }
      console.log(`${ts} ${bold(brightCyan("◼ done"))}\n`);
      break;

    case "error":
      if (chunkState.inChunk()) { process.stdout.write("\n"); chunkState.setInChunk(false); }
      console.log(`${ts} ${bold(brightRed("✗ error"))} ${event.message}`);
      break;
  }
}

// 亮色系列（比普通色更鲜艳，适合深色背景终端）
const brightYellow = (s: string) => `\x1b[93m${s}\x1b[0m`;
const brightGreen  = (s: string) => `\x1b[92m${s}\x1b[0m`;
const brightCyan   = (s: string) => `\x1b[96m${s}\x1b[0m`;
const brightRed    = (s: string) => `\x1b[91m${s}\x1b[0m`;

/**
 * 将 JSON 参数字符串转为可读多行摘要。
 * 每个顶级字段单独一行，长字符串截断，嵌套对象折叠。
 */
function formatArgs(raw: string, maxLen: number): string[] {
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(raw) as Record<string, unknown>; } catch {
    // 不是合法 JSON，直接截断返回
    return [raw.length > maxLen ? raw.slice(0, maxLen) + "…" : raw];
  }

  const lines: string[] = [];
  for (const [k, v] of Object.entries(parsed)) {
    let valStr: string;
    if (typeof v === "string") {
      // 字符串：保留换行前缀，截断超长部分
      const firstLine = v.split("\n")[0] ?? v;
      const hasMore = v.includes("\n");
      valStr = firstLine.length > 120 ? firstLine.slice(0, 120) + "…" : firstLine;
      if (hasMore) valStr += dim(" [↵…]");
    } else if (v === null || typeof v !== "object") {
      valStr = String(v);
    } else {
      // 对象/数组：紧凑 JSON，超长截断
      const compact = JSON.stringify(v);
      valStr = compact.length > 120 ? compact.slice(0, 120) + "…" : compact;
    }
    lines.push(`${dim(k + ":")} ${valStr}`);
  }
  return lines.length ? lines : [raw.slice(0, maxLen)];
}

