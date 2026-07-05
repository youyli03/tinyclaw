/**
 * restart_tool —— Code 模式专属重启工具
 *
 * 执行流程:
 *   1. 运行 `bun run typecheck`(tsc --noEmit),60s 超时
 *   2. typecheck 失败 → 直接返回错误信息,不重启
 *   3. typecheck 通过 →
 *      a. 若已有其他 session 在排队等重启(_restartQueue 非空):
 *         - 将自己加入排队队列
 *         - 提前写好 tool_result(防止 sanitizeMessages 删工具链)
 *         - 通过 onNotify 告知用户"排队中,重启后自动续接"
 *         - return(不 exit,等新进程重启后通过 marker 续接)
 *      b. 若是第一个触发重启的 session:
 *         - 将自己加入队列
 *         - await 其他正在运行的 session 完成(waitForOtherSessions)
 *         - 将队列中所有 session 写入 .restart_notify.json(含 additionalSessions)
 *         - 提前写好自身 tool_result
 *         - 延迟 500ms 后 process.exit(75)
 *
 * 重要:此工具仅在 code 模式下对 LLM 可见(agent.ts 中在非 code 模式下会过滤掉它)。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawn } from "node:child_process";
import { registerTool, type ToolContext } from "./registry.js";
import type { Session } from "../core/session.js";

/** 项目根目录(src/tools/restart.ts → ../../) */
const PROJECT_ROOT = new URL("../../", import.meta.url).pathname;

// ── 跨 session 共享状态 ──────────────────────────────────────────────────────

/** 由 main.ts 注入:全局 sessions Map */
let _activeSessions: Map<string, Session> | null = null;

export interface RestartQueueItem {
  sessionId: string;
  peerId: string;
  msgType: string;
  callId: string;
  taskId: string;
}

/** 排队等待重启的 session 列表(进程内,第一个触发者负责写 marker 并 exit) */
const _restartQueue: RestartQueueItem[] = [];

/** 注入全局 sessions 引用(main.ts 在初始化时调用) */
export function setActiveSessionsRef(m: Map<string, Session>): void {
  _activeSessions = m;
}

/**
 * 等待其他正在运行的 session 完成(排除自身)。
 * 供 restart_tool 和 /restart 命令共用。
 */
export function waitForOtherSessions(currentSessionId: string): Promise<void> {
  if (!_activeSessions) return Promise.resolve();
  const promises: Promise<unknown>[] = [];
  for (const [sid, session] of _activeSessions) {
    if (sid === currentSessionId) continue;
    if (session.running && session.currentRunPromise) {
      promises.push(session.currentRunPromise.catch(() => {}));
    }
  }
  if (promises.length === 0) return Promise.resolve();
  console.log(`[restart] 等待 ${promises.length} 个其他 session 完成后再重启...`);
  return Promise.all(promises).then(() => {});
}

// ── tsc --noEmit ──────────────────────────────────────────────────────────────

/** 运行 tsc --noEmit 检查,返回 {ok, output},60s 超时 */
export function runTypecheck(): Promise<{ ok: boolean; output: string }> {
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
      resolve({ ok: false, output: `启动 tsc 失败:${err.message}` });
    });
  });
}

// ── 工具实现 ──────────────────────────────────────────────────────────────────

async function restartToolImpl(_args: Record<string, unknown>, ctx?: ToolContext): Promise<string> {
  // ── 1. 类型检查 ──────────────────────────────────────────────────────────
  const { ok, output } = await runTypecheck();

  if (!ok) {
    const truncated =
      output.length > 1500 ? output.slice(0, 1500) + "\n...(输出已截断)" : output || "(无输出)";
    return `❌ 类型检查失败,已取消重启:\n\`\`\`\n${truncated}\n\`\`\``;
  }

  // ── 2. 构造本 session 的续接信息 ─────────────────────────────────────────
  const sessionId = ctx?.sessionId ?? "";
  let peerId = "";
  let msgType = "";
  if (sessionId.startsWith("qqbot:")) {
    const parts = sessionId.split(":");
    msgType = parts[1] ?? "";
    peerId = parts.slice(2).join(":");
  }

  const queueItem: RestartQueueItem = {
    sessionId,
    peerId,
    msgType,
    callId: ctx?.currentCallId ?? "",
    taskId: ctx?.masterSession?.currentAgentTaskId ?? ctx?.agentTaskId ?? "",
  };

  const pendingMsg = "⏳ 类型检查通过,正在重启服务,请等待自动续接...";

  // ── 3. 判断是否已有 session 在等待重启 ──────────────────────────────────
  if (_restartQueue.length > 0) {
    // 已有第一个 session 正在等待,本 session 排队
    _restartQueue.push(queueItem);
    console.log(`[restart] session "${sessionId}" 排队等待重启(队列长度:${_restartQueue.length})`);

    // 提前写 tool_result(防止 sanitizeMessages 删工具链)
    if (ctx?.masterSession && ctx.currentCallId) {
      try {
        ctx.masterSession.addToolResultMessage(ctx.currentCallId, pendingMsg);
      } catch {
        /* 写 JSONL 失败不影响 */
      }
    }

    // 通知用户
    if (ctx?.onNotify) {
      void ctx.onNotify("⏳ 已有重启任务排队中,重启完成后将自动续接当前任务...");
    }

    // 不 exit,由第一个 session 的 exit 触发新进程,新进程通过 marker 续接所有排队 session
    return pendingMsg;
  }

  // ── 4. 第一个触发重启的 session ──────────────────────────────────────────
  _restartQueue.push(queueItem);

  // 等待其他正在运行的 session 完成
  await waitForOtherSessions(sessionId);

  // ── 5. 写 .restart_notify.json marker ────────────────────────────────────
  const markerPath = path.join(os.homedir(), ".tinyclaw", ".restart_notify.json");
  if (sessionId.startsWith("qqbot:") && peerId) {
    // additionalSessions = 队列中除第一个外的其他 session
    const additionalSessions = _restartQueue.slice(1);
    try {
      fs.mkdirSync(path.dirname(markerPath), { recursive: true });
      fs.writeFileSync(
        markerPath,
        JSON.stringify({
          peerId,
          msgType,
          codeSessionId: sessionId,
          restartCallId: queueItem.callId,
          restartTaskId: queueItem.taskId,
          additionalSessions: additionalSessions.length > 0 ? additionalSessions : undefined,
        }),
        "utf-8"
      );
    } catch {
      /* 写失败不影响重启 */
    }
  }

  // ── 6. 提前将 tool result 写入 JSONL ─────────────────────────────────────
  if (ctx?.masterSession && ctx.currentCallId) {
    try {
      ctx.masterSession.addToolResultMessage(ctx.currentCallId, pendingMsg);
    } catch {
      /* 写 JSONL 失败不影响重启 */
    }
  }

  // ── 7. 延迟退出,给 FS 写操作留出缓冲时间 ────────────────────────────────
  setTimeout(() => process.exit(75), 500);

  return pendingMsg;
}

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "restart_tool",
      description:
        "【仅 Code 模式可用】对 tinyclaw 自身代码做出修改后,先进行 TypeScript 类型检查(tsc --noEmit)," +
        "检查通过后重启服务,重启完成后自动向本 session 注入续接消息,AI 可继续未完成的任务。" +
        "类型检查失败时不重启,直接返回错误信息供修复。",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  execute: restartToolImpl,
});
