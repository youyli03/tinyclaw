/**
 * tinyclaw 进程守护（supervisor）
 *
 * 职责：
 * 1. 启动 main.ts 子进程
 * 2. 若子进程以非 0 退出码崩溃，按退避策略重启
 * 3. 收到 SIGTERM / SIGINT 时，将信号转发给子进程并随之优雅退出
 *
 * start.ts 启动的是此 supervisor，不是直接启动 main.ts。
 * PID 文件写入此 supervisor 自身的 PID，使 `tinyclaw restart` 能正确终止整个进程树。
 */

import { createLogger } from "./utils/logger.js";

const log = createLogger("supervisor");

// ── 全局 console → Logger 桥接(仅在 supervisor 进程内生效)─────────────────
{
  const _log = console.log.bind(console);
  const _err = console.error.bind(console);
  const _warn = console.warn.bind(console);
  const _info = console.info.bind(console);
  const _debug = console.debug.bind(console);
  (console as unknown as Record<string, unknown>)["_orig"] = { log: _log, error: _err, warn: _warn, info: _info, debug: _debug };
  console.log = (...a: unknown[]) => log.info(a.map(String).join(" "));
  console.error = (...a: unknown[]) => log.error(a.map(String).join(" "));
  console.warn = (...a: unknown[]) => log.warn(a.map(String).join(" "));
  console.info = (...a: unknown[]) => log.info(a.map(String).join(" "));
  console.debug = (...a: unknown[]) => log.debug(a.map(String).join(" "));
}

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  bumpBootAttempt,
  restoreLastGoodConfig,
  shouldRollbackConfig,
} from "./config/state.js";

const SERVICE_PID_FILE = path.join(os.homedir(), ".tinyclaw", ".service_pid");
const MAIN_SCRIPT = new URL("./main.ts", import.meta.url).pathname;

const RESTART_DELAYS_MS = [2_000, 5_000, 10_000, 30_000, 60_000];
const MAX_RESTARTS = 20;
/** 连续崩溃达到此次数时，触发 git 自动回退（只回退一次） */
const ROLLBACK_TRIGGER_COUNT = 5;
/**
 * quick-fail 窗口：子进程启动后这么短时间内退出，视为"起不来"（配置坏掉的典型表现是启动期就抛错）。
 * 配置类崩溃**第 1 次**就回退，不必等 ROLLBACK_TRIGGER_COUNT 次退避（那要 ~107s）。
 */
const QUICK_FAIL_MS = 60_000;

const ROLLBACK_STATE_FILE = path.join(os.homedir(), ".tinyclaw", ".rollback_state.json");
const ROLLBACK_NOTIFY_FILE = path.join(os.homedir(), ".tinyclaw", ".rollback_notify.json");

let restartCount = 0;
/** 本进程生命周期内是否已执行过一次 git 回退（只回退一次） */
let hasRolledBack = (() => {
  try {
    if (fs.existsSync(ROLLBACK_STATE_FILE)) {
      const s = JSON.parse(fs.readFileSync(ROLLBACK_STATE_FILE, "utf-8")) as {
        rolledBack?: boolean;
      };
      return s.rolledBack === true;
    }
  } catch {
    /* ignore */
  }
  return false;
})();
let child: ChildProcess | null = null;
let shuttingDown = false;

// 启动前检查并清理残留的旧实例（防止多个 supervisor 并行运行）
async function killStaleInstance(): Promise<void> {
  if (!fs.existsSync(SERVICE_PID_FILE)) return;
  let stalePid: number;
  try {
    stalePid = parseInt(fs.readFileSync(SERVICE_PID_FILE, "utf-8").trim(), 10);
  } catch {
    return;
  }
  if (!stalePid || isNaN(stalePid) || stalePid === process.pid) return;
  try {
    process.kill(stalePid, 0);
  } catch {
    return;
  } // 进程不存在，无需清理

  console.log(`[supervisor] 发现残留实例（PID ${stalePid}），正在终止…`);
  try {
    process.kill(stalePid, "SIGTERM");
  } catch {
    return;
  }

  // 等待最多 5s 让旧进程优雅退出
  for (let i = 0; i < 25; i++) {
    await new Promise<void>((r) => setTimeout(r, 200));
    try {
      process.kill(stalePid, 0);
    } catch {
      return;
    } // 已退出
  }

  // 超时：强制终止
  console.warn(`[supervisor] 旧实例未在 5s 内退出，强制终止（SIGKILL）`);
  try {
    process.kill(stalePid, "SIGKILL");
  } catch {
    /* already gone */
  }
  await new Promise<void>((r) => setTimeout(r, 300));
}

await killStaleInstance();

// 写入 supervisor 自身的 PID（restart 命令 kill 此 PID → supervisor 转发给 main → 优雅退出）
try {
  fs.mkdirSync(path.dirname(SERVICE_PID_FILE), { recursive: true });
  fs.writeFileSync(SERVICE_PID_FILE, String(process.pid), "utf-8");
} catch {
  /* ignore */
}

/**
 * 执行代码回退：`git stash` + `git checkout HEAD~1 -- .`
 *
 * ⚠️ 为什么不是 `git checkout HEAD~1`：那会让仓库进入 **detached HEAD**，之后任何提交都落在游离
 * HEAD 上，仓库静默分叉。`checkout <rev> -- .` 只把上一个 commit 的文件内容取回工作区/索引，
 * HEAD 不动、分支不动，语义就是"把代码退回上一个 commit"，坏改动仍安全躺在 stash 里。
 */
async function tryGitRollback(): Promise<{ ok: boolean; prevHead: string; currentHead: string }> {
  const cwd = path.dirname(path.dirname(MAIN_SCRIPT)); // project root

  const execGit = (args: string[]): Promise<{ ok: boolean; out: string }> =>
    new Promise((resolve) => {
      const p = spawn("git", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
      const chunks: Buffer[] = [];
      p.stdout.on("data", (d: Buffer) => chunks.push(d));
      p.stderr.on("data", (d: Buffer) => chunks.push(d));
      p.on("close", (code) => {
        resolve({ ok: code === 0, out: Buffer.concat(chunks).toString("utf-8").trim() });
      });
      p.on("error", (e) => resolve({ ok: false, out: e.message }));
    });

  // 当前 HEAD commit hash（回退**不移动**它，只作为记录）
  const headRes = await execGit(["rev-parse", "--short", "HEAD"]);
  const currentHead = headRes.out.slice(0, 8);

  // 被取回的那个版本（HEAD~1）
  const prevRes = await execGit(["rev-parse", "--short", "HEAD~1"]);
  const prevHead = prevRes.out.slice(0, 8);
  if (!prevRes.ok) {
    console.error(`[supervisor] 取 HEAD~1 失败（仓库只有一个 commit？）：${prevRes.out}`);
    return { ok: false, prevHead: "", currentHead };
  }

  // 先把当前改动收进 stash（保留证据，且让 checkout 干净）
  const stashRes = await execGit(["stash", "push", "-u", "-m", `supervisor-rollback-${Date.now()}`]);
  if (!stashRes.ok) {
    console.warn(`[supervisor] git stash 失败（继续尝试回退）: ${stashRes.out}`);
  }

  // 只取回文件内容，不动 HEAD
  const checkoutRes = await execGit(["checkout", "HEAD~1", "--", "."]);
  if (!checkoutRes.ok) {
    console.error(`[supervisor] git checkout HEAD~1 -- . 失败: ${checkoutRes.out}`);
    await execGit(["stash", "pop"]);
    return { ok: false, prevHead: "", currentHead };
  }

  console.log(
    `[supervisor] 已回退代码: 工作区取回 ${prevHead}（HEAD 仍为 ${currentHead}，未脱离分支；原改动在 stash 里）`
  );
  return { ok: true, prevHead, currentHead };
}

/** 本进程生命周期内是否已执行过一次**配置**回退（只回退一次，防循环） */
let hasRolledBackConfig = false;
/** 上次拉起子进程的时间（quick-fail 判定用） */
let lastSpawnAt = 0;

function startChild(): void {
  if (shuttingDown) return;

  lastSpawnAt = Date.now();
  const attempts = bumpBootAttempt();
  child = spawn("node", ["--import", "tsx/esm", MAIN_SCRIPT], {
    stdio: "inherit",
    env: { ...process.env },
    cwd: path.dirname(path.dirname(MAIN_SCRIPT)), // src/ → project root
  });
  if (attempts > 1) {
    console.warn(`[supervisor] 这是配置变更后的第 ${attempts} 次启动尝试`);
  }

  child.on("exit", (code, signal) => {
    child = null;

    // 正常退出（主动 SIGTERM/SIGINT 或 exit(0)）→ supervisor 也退出
    if (shuttingDown || code === 0) {
      cleanup();
      process.exit(code ?? 0);
    }

    // 主动重启请求（exit code 75）：立即重启，不计入崩溃次数
    if (code === 75) {
      console.log("[supervisor] 收到主动重启请求，立即重启...");
      setTimeout(startChild, 100);
      return;
    }

    console.error(
      `[supervisor] main.ts 异常退出（code=${code ?? "null"}, signal=${signal ?? "null"}）`
    );

    // ── 配置类 quick-fail：启动后 60s 内退出，且磁盘配置与 LKG 不一致 → 立刻回退配置 ──
    const quickFail = Date.now() - lastSpawnAt < QUICK_FAIL_MS;
    if (quickFail && !hasRolledBackConfig && shouldRollbackConfig()) {
      hasRolledBackConfig = true;
      console.warn("[supervisor] 启动后迅速退出且配置与上一份可用版本不同，回退配置...");
      const res = restoreLastGoodConfig(
        `启动后 ${Math.round((Date.now() - lastSpawnAt) / 1000)}s 内退出（quick-fail）`
      );
      if (res.ok) {
        console.log(
          `[supervisor] 配置已回退：${res.record?.fromHash.slice(0, 8)} → ` +
            `${res.record?.toHash.slice(0, 8)}，立即重启（坏配置已留证）`
        );
        restartCount = 0;
        setTimeout(startChild, 500);
        return;
      }
      console.error(`[supervisor] 配置回退失败：${res.reason ?? "未知原因"}，继续正常退避重启`);
    }
    if (quickFail && hasRolledBackConfig && shouldRollbackConfig()) {
      console.error(
        "[supervisor] 回退后配置仍与 LKG 不一致且继续快速退出 —— 可能是 LKG 本身有问题，" +
          "不再自动回退（等人工介入 / safe mode）"
      );
    }

    if (restartCount >= MAX_RESTARTS) {
      console.error(`[supervisor] 已重启 ${MAX_RESTARTS} 次，放弃重启`);
      cleanup();
      process.exit(1);
    }

    // 连续崩溃达到 ROLLBACK_TRIGGER_COUNT 次，触发 git 回退（只回退一次）
    if (restartCount >= ROLLBACK_TRIGGER_COUNT && !hasRolledBack) {
      hasRolledBack = true;
      console.warn(`[supervisor] 连续崩溃 ${restartCount} 次，尝试 git 自动回退...`);
      void tryGitRollback().then(({ ok, prevHead, currentHead }) => {
        if (ok) {
          // 写状态文件（下次进程启动时读取，防止二次回退）
          try {
            fs.writeFileSync(
              ROLLBACK_STATE_FILE,
              JSON.stringify({
                rolledBack: true,
                originalHead: currentHead,
                prevHead,
                rollbackAt: new Date().toISOString(),
              }),
              "utf-8"
            );
          } catch {
            /* ignore */
          }
          // 写通知文件（main.ts 启动后发 QQ 消息）
          try {
            fs.writeFileSync(
              ROLLBACK_NOTIFY_FILE,
              JSON.stringify({
                originalHead: currentHead,
                prevHead,
                rollbackAt: new Date().toISOString(),
              }),
              "utf-8"
            );
          } catch {
            /* ignore */
          }
          // 重置崩溃计数，立即重启
          restartCount = 0;
          console.log("[supervisor] 回退完成，立即重启...");
          setTimeout(startChild, 500);
        } else {
          console.error("[supervisor] git 回退失败，继续正常退避重启");
          const delay =
            RESTART_DELAYS_MS[Math.min(restartCount, RESTART_DELAYS_MS.length - 1)] ??
            RESTART_DELAYS_MS[RESTART_DELAYS_MS.length - 1]!;
          restartCount++;
          console.log(`[supervisor] ${delay / 1000}s 后重启(第 ${restartCount} 次)...`);
          setTimeout(startChild, delay);
        }
      });
      return;
    }

    const delay =
      RESTART_DELAYS_MS[Math.min(restartCount, RESTART_DELAYS_MS.length - 1)] ??
      RESTART_DELAYS_MS[RESTART_DELAYS_MS.length - 1]!;
    restartCount++;
    console.log(`[supervisor] ${delay / 1000}s 后重启（第 ${restartCount} 次）…`);
    setTimeout(startChild, delay);
  });
}

function cleanup(): void {
  try {
    fs.unlinkSync(SERVICE_PID_FILE);
  } catch {
    /* ignore */
  }
}

function handleSignal(signal: "SIGTERM" | "SIGINT"): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[supervisor] 收到 ${signal}，转发给子进程…`);
  if (child) {
    child.kill(signal);
    // 若子进程 5s 内未退出，强制终止
    setTimeout(() => {
      if (child) {
        console.warn("[supervisor] 子进程超时未退出，强制终止");
        child.kill("SIGKILL");
      }
    }, 5_000).unref();
  } else {
    cleanup();
    process.exit(0);
  }
}

process.on("SIGTERM", () => handleSignal("SIGTERM"));
process.on("SIGINT", () => handleSignal("SIGINT"));

startChild();
