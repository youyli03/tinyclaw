/**
 * restart_tool —— Code 模式专属重启工具
 *
 * 执行流程：
 *   1. 运行 `bun run typecheck`（tsc --noEmit），60s 超时
 *   2. typecheck 失败 → 直接返回错误信息，不重启
 *   3. typecheck 通过 →
 *      a. 若 sessionId 是 qqbot: 格式，写 .restart_notify.json（含 codeSessionId）
 *      b. 提前通过 masterSession.addToolResultMessage 将 tool result 写入 JSONL，
 *         防止重启后 sanitizeMessages Pass 2 因 tool result 缺失而删掉该工具链
 *      c. 延迟 500ms 后 process.exit(75)，supervisor 收到后自动重启进程
 *
 * 重要：此工具仅在 code 模式下对 LLM 可见（agent.ts 中在非 code 模式下会过滤掉它）。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { registerTool, type ToolContext } from "./registry.js";

/** 项目根目录（src/tools/restart.ts → ../../） */
const PROJECT_ROOT = new URL("../../", import.meta.url).pathname;

/** 运行 tsc --noEmit 检查，返回 {ok, output}，60s 超时 */
function runTypecheck(): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const proc = spawn("bun", ["run", "typecheck"], {
      cwd: PROJECT_ROOT,
      stdio: ["ignore", "pipe", "pipe"],
    });
    proc.stdout.on("data", (d: Buffer) => chunks.push(d));
    proc.stderr.on("data", (d: Buffer) => chunks.push(d));

    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      resolve({ ok: false, output: "[超时] 类型检查超过 60 秒未完成" });
    }, 60_000);

    proc.on("close", (code) => {
      clearTimeout(timer);
      const output = Buffer.concat(chunks).toString("utf-8").trim();
      resolve({ ok: code === 0, output });
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, output: `启动 tsc 失败：${err.message}` });
    });
  });
}

async function restartToolImpl(
  _args: Record<string, unknown>,
  ctx?: ToolContext,
): Promise<string> {
  // ── 1. 类型检查 ──────────────────────────────────────────────────────────
  const { ok, output } = await runTypecheck();

  if (!ok) {
    const truncated =
      output.length > 1500 ? output.slice(0, 1500) + "\n…（输出已截断）" : output || "（无输出）";
    return `❌ 类型检查失败，已取消重启：\n\`\`\`\n${truncated}\n\`\`\``;
  }

  // ── 2. 写 .restart_notify.json marker ────────────────────────────────────
  const sessionId = ctx?.sessionId ?? "";
  if (sessionId.startsWith("qqbot:")) {
    const parts = sessionId.split(":");
    // qqbot:<msgType>:<peerId>
    const msgType = parts[1] as import("../connectors/base.js").InboundMessage["type"];
    const peerId = parts.slice(2).join(":");
    if (peerId) {
      const markerPath = path.join(os.homedir(), ".tinyclaw", ".restart_notify.json");
      try {
        fs.mkdirSync(path.dirname(markerPath), { recursive: true });
        fs.writeFileSync(
          markerPath,
          JSON.stringify({
            peerId,
            msgType,
            codeSessionId: sessionId,
            restartCallId: ctx?.currentCallId ?? "",
            restartTaskId: ctx?.masterSession?.currentAgentTaskId ?? ctx?.agentTaskId ?? "",
          }),
          "utf-8",
        );
      } catch {
        /* 写失败不影响重启 */
      }
    }
  }

  // ── 3. 提前将 tool result 写入 JSONL（关键：防止重启后工具链被 sanitize 删除）──
  //
  // agent.ts 的正常流程：
  //   execute() 返回 result → agent.ts 调用 session.addToolResultMessage(callId, result) → 写 JSONL
  //
  // 但本工具会在 execute() 中调用 process.exit()，永远不会返回，
  // 所以 agent.ts 的写入步骤永远不会执行。
  //
  // 解决方案：在 process.exit() 之前，借助 ctx.masterSession 和 ctx.currentCallId，
  // 手动调用 addToolResultMessage，同步落盘（内部是 appendFileSync）。
  const pendingMsg = "⏳ 类型检查通过，正在重启服务，请等待自动续接...";

  if (ctx?.masterSession && ctx.currentCallId) {
    try {
      ctx.masterSession.addToolResultMessage(ctx.currentCallId, pendingMsg);
    } catch {
      /* 写 JSONL 失败不影响重启 */
    }
  }

  // ── 4. 延迟退出，给 FS 写操作留出缓冲时间 ──────────────────────────────
  setTimeout(() => process.exit(75), 500);

  // execute() 函数永远不会到达此处（进程已退出），
  // 但 TypeScript 要求有返回值，且若因某种原因 process.exit 未能执行（测试环境等），
  // 返回此字符串可作为降级提示。
  return pendingMsg;
}

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "restart_tool",
      description:
        "【仅 Code 模式可用】对 tinyclaw 自身代码做出修改后，先进行 TypeScript 类型检查（tsc --noEmit），" +
        "检查通过后重启服务，重启完成后自动向本 session 注入续接消息，AI 可继续未完成的任务。" +
        "类型检查失败时不重启，直接返回错误信息供修复。",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  execute: restartToolImpl,
});
