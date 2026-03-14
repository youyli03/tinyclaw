/**
 * tinyclaw chat — 向 agent 发送消息，支持会话路由
 *
 * 用法：
 *   tinyclaw chat <message>                         # 全新终端会话
 *   tinyclaw chat -s <sessionId> <message>          # 复用指定会话
 *   tinyclaw chat -s qqbot:c2c:<openid> <message>   # 注入 QQBot 私聊，同时推送至 QQ
 *   tinyclaw chat -s qqbot:group:<openid> <message> # 注入 QQBot 群消息
 */

import { existsSync } from "fs";
import { randomUUID } from "crypto";
import { sendToAgent } from "../../ipc/client.js";
import { IPC_SOCKET_PATH } from "../../ipc/protocol.js";
import { bold, dim, red, cyan } from "../ui.js";

export const description = "向 agent 发送消息（支持 QQBot 会话路由）";
export const usage = "chat [-s <sessionId>] <message>";

function printHelp(): void {
  console.log(`
${bold("用法：")}
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
