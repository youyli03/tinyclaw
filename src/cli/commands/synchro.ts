/**
 * tinyclaw synchro — 实时跟踪指定 session 的 AI 活动
 *
 * 用法:
 *   synchro <sessionId 或后缀>   订阅并实时输出
 *   synchro list                 列出所有活跃 session
 *
 * Flags:
 *   --no-chunk    隐藏 LLM chunk 流式输出，只显示工具调用/结果
 */

import { connect, type Socket } from "net";
import { existsSync } from "node:fs";
import { IPC_SOCKET_PATH, type IpcResponse, type ActivityEvent } from "../../ipc/protocol.js";
import { bold, dim, red, yellow } from "../ui.js";
import { listSessions } from "../../ipc/client.js";
import { highlight as cliHighlight, supportsLanguage } from "cli-highlight";

export const subcommands = ["list", "help"] as const;
export const description = "实时跟踪指定 session 的 AI 活动(LLM chunk + 工具调用)";
export const usage = "synchro <sessionId 或后缀> [--no-chunk]";

function printHelp(): void {
  console.log(`
${bold("tinyclaw synchro")}  —  实时跟踪 session 活动

${bold("用法:")}
  synchro list                   列出所有活跃 session（含最后一条消息）
  synchro <sessionId>            完整 session ID
  synchro <suffix>               session ID 的末尾子串（如后 8 位）

${bold("Flags:")}
  --no-chunk                     隐藏 LLM chunk，只显示工具调用 / 结果

${bold("输出色彩:")}
  白色    LLM 流式 chunk
  亮黄    ▶ 工具调用（含参数展开）
  亮绿    ◀ 工具结果（含前 5 行）
  亮青    ◼ done
  亮红    ✗ error

按 ${bold("Ctrl-C")} 退出（服务重启时自动重连）。
`);
}

export async function run(args: string[]): Promise<void> {
  if (args.length === 0 || args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
    printHelp();
    return;
  }

  // `synchro list` — 打印所有 session 及最后一条消息
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
      const suffix  = brightCyan(s.sessionId.slice(-8));
      const tag     = s.running ? yellow("● 运行中") : dim("○ 空闲");
      const lastMsg = s.lastUserMessage
        ? dim(`  "${s.lastUserMessage.slice(0, 60).replace(/\n/g, "↵")}"`)
        : "";
      console.log(`  ${tag}  ${s.sessionId}`);
      console.log(`         ${dim("后缀:")} ${suffix}${lastMsg}`);
    }
    console.log();
    return;
  }

  // 解析 flags
  const noChunk = args.includes("--no-chunk");
  const idOrSuffix = args.find(a => !a.startsWith("--"))!;

  if (!idOrSuffix) { printHelp(); return; }

  if (!existsSync(IPC_SOCKET_PATH)) {
    console.error(red("tinyclaw 服务未运行，请先执行 tinyclaw start"));
    process.exit(1);
  }

  let inChunk = false;

  function connectAndSubscribe(): Promise<"reconnect" | "exit"> {
    return new Promise<"reconnect" | "exit">((resolve) => {
      let buf = "";
      let subscribed = false;
      let sigintRegistered = false;

      const socket: Socket = connect(IPC_SOCKET_PATH, () => {
        socket.write(JSON.stringify({ type: "subscribe", idOrSuffix }) + "\n");
      });

      if (!sigintRegistered) {
        sigintRegistered = true;
        process.on("SIGINT", () => {
          socket.destroy();
          process.exit(0);
        });
      }

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
            console.log(dim(`按 Ctrl-C 退出${noChunk ? "  (--no-chunk 模式: 不显示 chunk)" : ""}\n`));
          } else if (resp.type === "error") {
            if (!subscribed) {
              socket.destroy();
              resolve("reconnect");
            } else {
              console.error(red(`\n错误: ${resp.message}`));
              socket.destroy();
              resolve("exit");
            }
          } else if (resp.type === "activity") {
            printEvent(resp.event, noChunk, { inChunk: () => inChunk, setInChunk: (v) => { inChunk = v; } });
          }
        }
      });

      socket.on("error", () => {
        resolve("reconnect");
      });

      socket.on("close", () => {
        if (subscribed) {
          if (inChunk) { process.stdout.write("\n"); inChunk = false; }
        }
        resolve("reconnect");
      });
    });
  }

  // 自动重连循环（带倒计时）
  while (true) {
    // 等待 sock 文件就绪
    if (!existsSync(IPC_SOCKET_PATH)) {
      await waitWithCountdown("服务启动", 10, 500, () => existsSync(IPC_SOCKET_PATH));
      continue;
    }

    const result = await connectAndSubscribe();
    if (result === "exit") break;

    // 断线后等待重连
    const sockWait = !existsSync(IPC_SOCKET_PATH);
    if (sockWait) {
      const ok = await waitWithCountdown("等待重连", 15, 500, () => existsSync(IPC_SOCKET_PATH));
      if (!ok) {
        console.log(red("重连超时，退出。"));
        break;
      }
    }
    // 等待 session 恢复（服务刚重启时 session 还未加载）
    await new Promise(r => setTimeout(r, 900));
    console.log(dim("[重连中...]"));
  }
}

/**
 * 等待条件满足，期间每秒打印 "label N 秒..." 倒计时。
 * @returns 是否在超时前满足条件
 */
async function waitWithCountdown(label: string, maxSecs: number, pollMs: number, cond: () => boolean): Promise<boolean> {
  let elapsed = 0;
  const max = maxSecs * 1000;
  while (elapsed < max) {
    if (cond()) return true;
    const remaining = Math.ceil((max - elapsed) / 1000);
    process.stdout.write(`\r${dim(`${label}... ${remaining}s`)}`);
    await new Promise(r => setTimeout(r, pollMs));
    elapsed += pollMs;
  }
  process.stdout.write("\n");
  return cond();
}

function printEvent(
  event: ActivityEvent,
  noChunk: boolean,
  chunkState: { inChunk: () => boolean; setInChunk: (v: boolean) => void }
): void {
  const ts = dim(new Date().toLocaleTimeString());

  switch (event.kind) {
    case "user_input": {
      if (chunkState.inChunk()) { process.stdout.write("\n"); chunkState.setInChunk(false); }
      const preview = event.message.length > 120 ? event.message.slice(0, 120) + "…" : event.message;
      console.log(`${ts} ${brightMagenta("❯")} ${bold(brightMagenta("user"))}  ${preview}`);
      break;
    }

    case "chunk":
      if (noChunk) return;
      process.stdout.write(event.delta);
      chunkState.setInChunk(!event.delta.endsWith("\n"));
      break;

    case "tool_call": {
      const argsLines = formatArgs(event.argsSummary, 200);
      if (chunkState.inChunk()) { process.stdout.write("\n"); chunkState.setInChunk(false); }
      console.log(`${ts} ${brightYellow("▶")} ${bold(brightYellow(event.name))}`);
      for (const line of argsLines) {
        console.log(`   ${brightBlue("·")} ${line}`);
      }
      break;
    }

    case "tool_result": {
      const resultDisplay = event.resultSummary.length > 400
        ? event.resultSummary.slice(0, 400) + "…"
        : event.resultSummary;
      console.log(`${ts} ${brightGreen("◀")} ${bold(brightGreen(event.name))}`);
      const lines = resultDisplay.split("\n").slice(0, 8);
      for (const l of lines) {
        if (l.trim()) console.log(`   ${dim("·")} ${dim(l)}`);
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

// 亮色系列（适合深色背景终端）
const brightYellow = (s: string) => `\x1b[93m${s}\x1b[0m`;
const brightGreen  = (s: string) => `\x1b[92m${s}\x1b[0m`;
const brightCyan   = (s: string) => `\x1b[96m${s}\x1b[0m`;
const brightRed     = (s: string) => `\x1b[91m${s}\x1b[0m`;
const brightMagenta = (s: string) => `\x1b[95m${s}\x1b[0m`;
const brightBlue    = (s: string) => `\x1b[94m${s}\x1b[0m`;
const brightWhite   = (s: string) => `\x1b[97m${s}\x1b[0m`;

/**
 * 将 JSON 参数字符串转为可读多行摘要。
 * - command: bash 语法高亮
 * - content/code/new_str/old_str: 检测语言后语法高亮（前 6 行）
 * - 其他字符串: 截断
 */
function formatArgs(raw: string, _maxLen: number): string[] {
  let parsed: Record<string, unknown>;
  try { parsed = JSON.parse(raw) as Record<string, unknown>; } catch {
    return [raw.length > 200 ? raw.slice(0, 200) + "…" : raw];
  }

  const lines: string[] = [];
  for (const [k, v] of Object.entries(parsed)) {
    let valStr: string;
    if (typeof v === "string") {
      if (k === "command") {
        const firstLine = v.split("\n")[0]?.slice(0, 200) ?? v;
        const hl = tryHighlight(firstLine, "bash");
        valStr = hl + (v.includes("\n") ? dim(" [↵…]") : "");
      } else if (["content", "code", "new_str", "old_str"].includes(k)) {
        const srcLines = v.split("\n").slice(0, 6);
        const lang = detectLang(v);
        const highlighted = srcLines.map((l: string) => tryHighlight(l, lang));
        valStr = "\n" + highlighted.map((l: string) => `        ${l}`).join("\n");
        if (v.split("\n").length > 6) valStr += `\n        ${dim("…更多行")}`;
      } else {
        const firstLine = v.split("\n")[0] ?? v;
        const hasMore = v.includes("\n");
        valStr = firstLine.length > 140 ? firstLine.slice(0, 140) + "…" : firstLine;
        if (hasMore) valStr += dim(" [↵…]");
      }
    } else if (v === null || typeof v !== "object") {
      valStr = String(v);
    } else {
      const compact = JSON.stringify(v);
      valStr = compact.length > 140 ? compact.slice(0, 140) + "…" : compact;
    }
    lines.push(`${dim(k + ":")} ${valStr}`);
  }
  return lines.length ? lines : [raw.slice(0, 200)];
}

/** 尝试 cli-highlight 语法高亮，失败则原样返回 */
function tryHighlight(code: string, lang: string): string {
  try {
    if (!supportsLanguage(lang)) return code;
    return cliHighlight(code, { language: lang, ignoreIllegals: true }).trimEnd();
  } catch {
    return code;
  }
}

/** 根据内容首行猜测语言 */
function detectLang(content: string): string {
  const first = content.trimStart().slice(0, 100);
  if (/^(import |const |let |var |function |class |export |interface |type )/.test(first)) return "typescript";
  if (/^(def |import |class |async def |from )/.test(first)) return "python";
  if (/^(package |func |import )/.test(first)) return "go";
  if (/^#!|^\$/.test(first)) return "bash";
  if (/^(#include|#define|#pragma|void |int |char |struct |typedef )/.test(first)) return "c";
  if (/^(#include<|template<|namespace |std::)/.test(first)) return "cpp";
  return "plaintext";
}
