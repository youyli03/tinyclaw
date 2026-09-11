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
        "Request write access to **one path or directory** (path-level silent elevation; the user is not asked).\n" +
        "Use it when you need to write somewhere in the user's home directory that is outside your own workspace or " +
        "outside your agent directory (for example `~/Documents`, `~/.config/xxx`, `~/.tinyclaw/data`, or `memory/` " +
        "inside your own agent directory).\n" +
        "Limits: only paths under $HOME that already exist, are not secret (no `config.toml` / `secrets.toml` / " +
        "`*.key` / `~/.ssh` …) and do not belong to another agent. Unattended runs (cron / loop) cannot use this tool " +
        "at all — their writable scope comes from the task configuration.\n" +
        "The grant lasts 1 hour by default; during that time `write_file` / `edit_file` / `exec_shell` may write the " +
        "path, and every request is audited. **Prefer finishing the work inside your current workspace** and only " +
        "request access when it is genuinely necessary.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Absolute path (or `~`-prefixed path) of an existing directory or file you need to write",
          },
          reason: {
            type: "string",
            description: "Why you must write this path (recorded in the audit log for the user to review)",
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
