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

import { connect } from "net";
import { createInterface } from "node:readline";
import { existsSync } from "node:fs";
import { IPC_SOCKET_PATH, type IpcResponse, type ActivityEvent } from "../../ipc/protocol.js";
import { bold, dim, cyan, red, yellow, green } from "../ui.js";

export const subcommands = ["help"] as const;
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

  const idOrSuffix = args[0]!;

  if (!existsSync(IPC_SOCKET_PATH)) {
    console.error(red("tinyclaw 服务未运行，请先执行 tinyclaw start"));
    process.exit(1);
  }

  const socket = connect(IPC_SOCKET_PATH);
  let buf = "";
  let subscribed = false;

  socket.on("connect", () => {
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
        console.error(red(`错误: ${resp.message}`));
        socket.destroy();
        process.exit(1);
      } else if (resp.type === "activity") {
        printEvent(resp.sessionId, resp.event);
      }
    }
  });

  socket.on("error", (err) => {
    console.error(red(`连接错误: ${err.message}`));
    process.exit(1);
  });

  socket.on("close", () => {
    if (subscribed) {
      console.log(dim("\n[连接断开]"));
    }
    process.exit(0);
  });

  // Ctrl-C 优雅退出
  process.on("SIGINT", () => {
    socket.destroy();
    process.exit(0);
  });

  // 保持进程运行
  await new Promise<void>(() => {});
}

function printEvent(sessionId: string, event: ActivityEvent): void {
  const prefix = dim(`[${new Date().toLocaleTimeString()}]`);

  switch (event.kind) {
    case "chunk":
      process.stdout.write(dim(event.delta));
      break;

    case "tool_call": {
      const argsDisplay = event.argsSummary.length > 120
        ? event.argsSummary.slice(0, 120) + "…"
        : event.argsSummary;
      process.stdout.write("\n");
      console.log(`${prefix} ${yellow("⚡ tool_call")} ${bold(event.name)}  ${dim(argsDisplay)}`);
      break;
    }

    case "tool_result": {
      const resultDisplay = event.resultSummary.length > 200
        ? event.resultSummary.slice(0, 200) + "…"
        : event.resultSummary;
      // 结果可能有多行，压成一行预览
      const oneLiner = resultDisplay.replace(/\n/g, "↵ ");
      console.log(`${prefix} ${green("✅ tool_result")} ${bold(event.name)}  ${dim(oneLiner)}`);
      break;
    }

    case "done":
      process.stdout.write("\n");
      console.log(`${prefix} ${cyan("◼ done")}`);
      break;

    case "error":
      process.stdout.write("\n");
      console.log(`${prefix} ${red("✗ error")} ${event.message}`);
      break;
  }
}
