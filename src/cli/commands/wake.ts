/**
 * CLI 命令：wake
 *
 * 用法：
 *   wake [-s <sessionId>] [-a <agentId>] [--source <label>] <消息>
 *
 * 唤醒 LLM：把消息注入指定会话并触发一轮 agent（**受理即返回**，不等回复）。
 * 典型用法是后台 job / cron 步骤 / 外部脚本干完活之后"叫醒"agent 去做判断与汇报：
 *
 *   tinyclaw wake -s "qqbot:c2c:<openid>" --source "train-job" "训练跑完了，看看日志尾部并汇报"
 *
 * ⚠️ 被唤醒那一轮的**权限跟着目标会话**：目标会话有可交互通道（如 qqbot 会话）时按该会话的普通
 * 对话权限跑（全量工具；需要审批时提示发到该通道并等回复）；目标没有交互路径（`cli:` / 无常驻连接）
 * 时退回无人值守规则（工具走 `[sandbox.unattended]` 白名单、MFA 一律拒绝）。
 * agent 的最终回复由服务端推给该会话绑定的通道（QQ 会推到对应聊天）。
 * 只需要"一次纯 LLM 调用、不要工具与历史"时请用 `tinyclaw send`。
 */

import { existsSync } from "node:fs";
import { IPC_SOCKET_PATH } from "../../ipc/protocol.js";
import { wakeSession } from "../../ipc/client.js";
import { bold, dim, cyan, green, red } from "../ui.js";

export const subcommands = ["-s", "-a", "--source", "help"] as const;
export const description = "唤醒 LLM（向指定会话注入消息并触发一轮 agent，受理即返回）";
export const usage = "wake [-s <sessionId>] [-a <agentId>] [--source <label>] <消息>";

function printHelp(): void {
  console.log(`
${bold("tinyclaw wake")}  —  唤醒 LLM

${bold("用法：")}
  ${cyan("wake")} [-s <sessionId>] [-a <agentId>] [--source <label>] <消息>

${bold("选项：")}
  -s <sessionId>     目标会话（给 sessionId 就注入该会话）
  -a <agentId>       目标 agent（复用其最近活跃会话，没有则新建）
  --source <label>   来源标签，只进日志与审计（如 job id / 脚本名）

${bold("说明：")}
  注入的文本会带 [wake from <label>] 前缀，让模型知道这不是用户在说话。
  被唤醒那一轮的权限跟着目标会话：有可交互通道（qqbot 会话）时按该会话的普通
  对话权限跑，需要审批会发到该通道等你回复；目标没有交互路径（如 cli 会话）时
  退回无人值守规则（工具白名单、MFA 一律拒绝）。
  其最终回复由服务端推给该会话绑定的通道。受理即返回，不等回复。
  只要一次纯 LLM 调用（无工具、无历史）请用 ${cyan("tinyclaw send")}。
`);
}

export async function run(args: string[]): Promise<void> {
  if (args.includes("-h") || args.includes("--help") || args[0] === "help") {
    printHelp();
    return;
  }

  let sessionId: string | undefined;
  let agentId: string | undefined;
  let source: string | undefined;
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if ((a === "-s" || a === "--session") && args[i + 1]) {
      sessionId = args[++i];
    } else if ((a === "-a" || a === "--agent") && args[i + 1]) {
      agentId = args[++i];
    } else if (a === "--source" && args[i + 1]) {
      source = args[++i];
    } else if (a !== undefined) {
      rest.push(a);
    }
  }

  const message = rest.join(" ").trim();
  if (!sessionId && !agentId) {
    console.error(red("错误：-s <sessionId> 与 -a <agentId> 至少要给一个"));
    printHelp();
    return;
  }
  if (!message) {
    console.error(red("错误：消息不能为空"));
    printHelp();
    return;
  }
  if (!existsSync(IPC_SOCKET_PATH)) {
    console.error(red("无法连接到 tinyclaw 服务（IPC socket 不存在），请先运行 tinyclaw start"));
    return;
  }

  try {
    const res = await wakeSession({
      ...(sessionId ? { sessionId } : {}),
      ...(agentId ? { agentId } : {}),
      message,
      ...(source ? { source } : {}),
    });
    console.log(`${green("✅ 已唤醒")} session ${cyan(res.sessionId)}`);
    console.log(dim(res.note));
  } catch (err) {
    console.error(red(`唤醒失败：${err instanceof Error ? err.message : String(err)}`));
  }
}
