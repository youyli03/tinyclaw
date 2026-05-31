/**
 * tinyclaw push — 直推消息到 connector(QQ),不走 LLM、不走 runAgent
 *
 * 用法:
 *   push [--type c2c|group|guild|dm] [--bot <botId>] --peer <peerId> <消息>
 *   echo "长文本" | push --peer <peerId>           # stdin 管道传消息
 *
 * 本质是 IPC 的 qqbot_send:服务端收到后直接 connector.send(),
 * 完全不触发 LLM 推理,适合定时任务/外部程序(如 revert-trade 交易提醒)
 * 把现成文本投递到指定 QQ 会话。
 */

import { existsSync } from "node:fs";
import { IPC_SOCKET_PATH } from "../../ipc/protocol.js";
import { sendQQBotMessage } from "../../ipc/client.js";
import type { InboundMessage } from "../../connectors/base.js";
import { bold, dim, cyan, red } from "../ui.js";

export const subcommands = ["--peer", "--type", "--bot", "help"] as const;
export const description = "直推消息到 QQ(不走 LLM,供外部程序/定时任务投递)";
export const usage = "push [--type c2c|group|guild|dm] [--bot <id>] --peer <peerId> <消息>";

function printHelp(): void {
  console.log(`
${bold("tinyclaw push")}  —  直推消息到 connector(QQ),不走 LLM

${bold("用法:")}
  ${cyan("push --peer <peerId> <消息>")}                    私聊(c2c)直推
  ${cyan("push --type group --peer <groupId> <消息>")}      群聊直推
  ${cyan('echo "长文本" | push --peer <peerId>')}           stdin 管道传消息

${bold("参数:")}
  --peer <id>     ${dim("必填。目标 peerId(私聊=用户 openid,群=群 openid,频道=channelId)")}
  --type <t>      ${dim("会话类型:c2c(默认) | group | guild | dm")}
  --bot <id>      ${dim("指定 bot 实例(多 bot 时);省略用默认 bot")}

${bold("说明:")}
  - 纯转发:服务端收到后直接调 connector.send(),${bold("不触发任何 LLM 推理")}
  - 适合外部程序(如交易提醒)把现成文本投递到指定 QQ 会话
  - 消息内容可作为位置参数,或通过 stdin 管道传入(优先级:位置参数 > stdin)

${bold("示例:")}
  tinyclaw push --peer 5E93DFF4A42AFE45D206DEA724E5ECD2 "夜盘提醒:AAPL 触发超卖买点"
  cat alert.txt | tinyclaw push --type group --peer ABCDEF123
`);
}

/** 读取 stdin 全部内容(管道场景);非管道(TTY)时立即返回空串 */
async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

export async function run(args: string[]): Promise<void> {
  if (args[0] === "help" || args[0] === "--help" || args[0] === "-h") {
    printHelp();
    return;
  }

  let msgType: InboundMessage["type"] = "c2c";
  let peer = "";
  let botId: string | undefined;
  const rest: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--peer" && args[i + 1]) {
      peer = args[++i]!;
    } else if (arg === "--type" && args[i + 1]) {
      const t = args[++i]!;
      if (t === "c2c" || t === "group" || t === "guild" || t === "dm") {
        msgType = t;
      } else {
        console.error(red(`错误:不支持的 type "${t}",可选 c2c | group | guild | dm`));
        process.exit(1);
      }
    } else if (arg === "--bot" && args[i + 1]) {
      botId = args[++i]!;
    } else {
      rest.push(arg);
    }
  }

  // 消息内容:优先位置参数,其次 stdin 管道
  let text = rest.join(" ").trim();
  if (!text) {
    text = (await readStdin()).trim();
  }

  if (!peer) {
    console.error(red("错误:缺少 --peer <peerId>"));
    console.error(dim(`  用法:${usage}`));
    process.exit(1);
  }
  if (!text) {
    console.error(red("错误:消息内容为空(请用位置参数或 stdin 管道提供)"));
    console.error(dim(`  用法:${usage}`));
    process.exit(1);
  }

  if (!existsSync(IPC_SOCKET_PATH)) {
    console.error(red("错误:tinyclaw 主服务未运行,请先执行 tinyclaw start"));
    process.exit(1);
  }

  try {
    await sendQQBotMessage({
      peerId: peer,
      msgType,
      text,
      ...(botId ? { botId } : {}),
    });
    console.log(dim(`✓ 已推送到 ${msgType}:${peer}`));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(red(`推送失败:${msg}`));
    process.exit(1);
  }
}
