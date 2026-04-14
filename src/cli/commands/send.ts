/**
 * tinyclaw send — 一次性 LLM 调用（无 session 历史，无工具权限）
 *
 * 用法:
 *   send [--json] [--backend daily|code|summarizer] <消息>
 *
 * 默认走 daily backend（oswe-vscode-prime），不消耗高级请求。
 * --json 时 stdout 输出 {"text":"..."} 格式，便于程序解析。
 */

import { existsSync } from "node:fs";
import { IPC_SOCKET_PATH } from "../../ipc/protocol.js";
import { sendOneshot } from "../../ipc/client.js";
import { bold, dim, cyan, red } from "../ui.js";

export const subcommands = ["--json", "--backend", "help"] as const;
export const description = "一次性 LLM 调用（无 session 历史，无工具权限）";
export const usage = "send [--json] [--backend daily|code] <消息>";

function printHelp(): void {
  console.log(`
${bold("tinyclaw send")}  —  一次性 LLM 调用

${bold("用法:")}
  ${cyan("send <消息>")}                        走 daily backend 回复（不消耗高级请求）
  ${cyan("send --json <消息>")}                 输出 JSON 格式 {"text":"..."}（供程序解析）
  ${cyan("send --backend code <消息>")}         指定使用 code backend

${bold("说明:")}
  - 不依赖任何 session，无对话历史，LLM 无法调用任何工具
  - 适合 TradeJournal-skill 等需要纯文本分析的场景
  - 默认使用 daily backend（oswe-vscode-prime），不消耗 Copilot Premium 请求

${bold("示例:")}
  tinyclaw send "请分析这笔交易的买卖时机"
  tinyclaw send --json "总结一下这段文字"
  tinyclaw send --backend code "解释这段 Python 代码"

${dim("嵌入 session 对话请使用: tinyclaw chat -s <id> [--json] <消息>")}
`);
}

export async function run(args: string[]): Promise<void> {
  if (!args[0] || args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
    printHelp();
    return;
  }

  // 解析参数
  let jsonMode = false;
  let backend: "daily" | "code" | "summarizer" = "daily";
  const rest: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--json" || arg === "-j") {
      jsonMode = true;
    } else if (arg === "--backend" && args[i + 1]) {
      const b = args[++i]!;
      if (b === "daily" || b === "code" || b === "summarizer") {
        backend = b;
      } else {
        console.error(red(`错误:不支持的 backend "${b}"，可选 daily | code | summarizer`));
        process.exit(1);
      }
    } else {
      rest.push(arg);
    }
  }

  const prompt = rest.join(" ").trim();
  if (!prompt) {
    console.error(red("错误:请提供消息内容"));
    console.error(dim(`  用法:tinyclaw send <消息>`));
    process.exit(1);
  }

  if (!existsSync(IPC_SOCKET_PATH)) {
    console.error(red("错误:tinyclaw 主服务未运行，请先执行 tinyclaw start"));
    process.exit(1);
  }

  let fullText = "";

  try {
    if (jsonMode) {
      // JSON 模式：等待完整响应再输出
      fullText = await sendOneshot({ prompt, backend });
      process.stdout.write(JSON.stringify({ text: fullText }) + "\n");
    } else {
      // 流式模式：直接输出文本
      await sendOneshot({
        prompt,
        backend,
        onChunk: (delta) => process.stdout.write(delta),
      });
      process.stdout.write("\n");
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (jsonMode) {
      process.stdout.write(JSON.stringify({ error: msg }) + "\n");
    } else {
      console.error(red(`\n发送失败:${msg}`));
    }
    process.exit(1);
  }
}
