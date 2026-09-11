/**
 * fs_grant —— 路径级"无感提权"工具（agent 可调用）。
 *
 * 用途：agent 想写 `$HOME` 下但不在自己 agent 目录里的路径时，先申请一次授权；
 * 之后该路径对 `write_file` / `edit_file` / `exec_shell`（沙箱内也 bind 成可写）都生效，直到 TTL 过期。
 *
 * 设计取向：**不打扰用户**，但让 agent 多走一步并留下审计 —— 目的是让它"明白尽量别往外写"。
 * 硬边界：只允许 `$HOME` 内、非密钥、非 `~/.tinyclaw`、非受保护目录的路径；无人值守一律拒绝。
 */

import { registerTool, type ToolContext } from "./registry.js";
import { grantWritePath } from "../auth/fs-grant.js";

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "fs_grant",
      description:
        "申请**一个路径/目录**的写权限（路径级无感授权，不打扰用户）。\n" +
        "适用场景：你需要写用户家目录里、但不在你自己 agent 目录内的文件时（例如 ~/Documents、~/.config/xxx、某个项目目录）。\n" +
        "限制：只接受 $HOME 内、已存在、且非密钥/非受保护目录（如 ~/.ssh）的路径；其他 agent 的目录不能申请。" +
        "cron / loop 等无人值守运行**不能**使用本工具（它们的可写范围由任务配置声明）。\n" +
        "授权默认 1 小时有效，期间 write_file / edit_file / exec_shell 都可写该路径；每一次申请都会写入审计。" +
        "**请优先在当前工作目录内完成工作**，只有确实必要时才申请外部路径。",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "要申请写权限的绝对路径或 ~ 开头路径（目录或文件，必须已存在）",
          },
          reason: {
            type: "string",
            description: "为什么必须写这个路径（会记入审计，便于用户事后复核）",
          },
        },
        required: ["path"],
      },
    },
  },
  execute: async (args, ctx?: ToolContext): Promise<string> => {
    const raw = String(args["path"] ?? "");
    const reason = args["reason"] ? String(args["reason"]) : undefined;

    const result = grantWritePath({
      rawPath: raw,
      origin: ctx?.origin,
      agentId: ctx?.agentId ?? "default",
      ...(ctx?.sessionId ? { sessionId: ctx.sessionId } : {}),
      ...(ctx?.masterSession ? { session: ctx.masterSession } : {}),
    });

    if (!result.granted) return result.reason;

    const lines = [
      `已授权写路径：${result.absPath}（${result.ttlSecs}s 内有效${result.isNew ? "" : "，本次为续期"}）`,
      "现在可以直接用 write_file / edit_file 写该路径，或在 exec_shell 里写它。",
    ];
    if (reason) lines.push(`理由（已记入审计）：${reason}`);
    lines.push("提醒：优先在工作目录内完成工作；这只是「必要的例外」。");
    return lines.join("\n");
  },
});
