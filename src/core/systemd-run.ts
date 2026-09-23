/**
 * detached job 的 systemd 载体：把一个后台 job 变成**独立的 transient unit**。
 *
 * 为什么必须这样：`systemctl --user restart tinyclaw` 用的是默认 `KillMode=control-group`，
 * 它按 **cgroup** 杀进程 —— `setsid`/`unref` 只换了会话与进程组，**没换 cgroup**，所以"detached 也照样被杀"。
 * 把 job 放进它自己的 transient unit（独立 cgroup），就不再受父 unit 停止的连坐。
 * 取证：`tmp/probe-cgroup-detach-20260923.sh`（同 cgroup → 被杀）、
 * `tmp/probe-systemd-run-20260923.sh`（独立 unit → 存活，且 `--wait` 传回退出码）。
 *
 * 三条硬约束（都实测过）：
 * 1. **值绝不进 argv / unit 属性**：`--setenv` / `--property=Environment=` 会把明文写进 unit 属性
 *    （同 UID 一条 `systemctl show` 就能读到），所以 env 走 **0600 的 env 文件**，由启动器脚本 source 后**立即删除**。
 * 2. transient service **不继承调用方的 env**（实测 `FOO` 为空），所以 env 文件里必须放**完整**的合并环境。
 * 3. `--wait` 让我们拿到 job 的退出码（= 我们自己子进程的退出码）；`--collect` 让 unit 用完自动回收。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

/** unit 名前缀（一条 job 一个 unit） */
const UNIT_PREFIX = "tinyclaw-job-";

/** 只允许能 `export` 的键名进 env 文件（bash 对非法键名会直接报错） */
const ENV_KEY_OK = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** job id → unit 名（`job_1a2b3c4d` → `tinyclaw-job-1a2b3c4d`） */
export function jobUnitName(jobId: string): string {
  const slug = jobId
    .replace(/^job[_-]/, "")
    .replace(/[^A-Za-z0-9_.-]/g, "-")
    .slice(0, 120);
  return `${UNIT_PREFIX}${slug}`;
}

/** 在 `$PATH` 里找一个可执行文件（不 spawn，避免为此付一次进程开销） */
function findInPath(name: string): string | null {
  const dirs = (process.env["PATH"] ?? "").split(path.delimiter).filter((d) => d !== "");
  for (const dir of dirs) {
    const p = path.join(dir, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      if (fs.statSync(p).isFile()) return p;
    } catch {
      /* 不存在或不可执行，继续找 */
    }
  }
  return null;
}

let availableCache: boolean | undefined;

/** 本机是否能用 `systemd-run --user`（探到即缓存；只在 detached 启动路径用） */
export function systemdRunAvailable(): boolean {
  if (availableCache === undefined) {
    availableCache =
      typeof process.env["XDG_RUNTIME_DIR"] === "string" &&
      process.env["XDG_RUNTIME_DIR"] !== "" &&
      findInPath("systemd-run") !== null;
  }
  return availableCache;
}

/** POSIX shell 单引号转义（`'` → `'\''`），保证值原样还原 */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * 写 0600 的 env 文件（`KEY='value'`，可被 bash `source`）。
 *
 * @returns 写进去的键数（非法键名会被跳过 —— bash 也无法 export 它们）
 */
export function writeJobEnvFile(file: string, env: Record<string, string>): number {
  const lines = ["# 由 tinyclaw 生成：detached job 的环境变量（启动器 source 之后立即删除本文件）"];
  let written = 0;
  for (const [k, v] of Object.entries(env)) {
    if (!ENV_KEY_OK.test(k)) continue;
    lines.push(`${k}=${shellQuote(v)}`);
    written++;
  }
  fs.writeFileSync(file, lines.join("\n") + "\n", { mode: 0o600 });
  fs.chmodSync(file, 0o600); // 文件已存在时 mode 不生效，补一次
  return written;
}

/**
 * 写启动器脚本（0700）：source env → **删 env** → 落 started 标记 → cd → 跑 argv → 写 rc。
 *
 * 程序与其参数通过 **argv** 传进来（`systemd-run … run.sh <program> <args…>`），所以值不进 argv、
 * 命令本身照旧可见（与 `spawn` 的语义一致）。stdout/stderr 追加进该 job 的日志文件。
 *
 * @returns 启动器脚本路径
 */
export function writeJobLauncher(dir: string): string {
  const script = `#!/usr/bin/env bash
# 由 tinyclaw 生成（detached job 的 systemd unit 入口）；手工改动会在下一条 job 生成时被覆盖。
umask 077
dir="$(dirname "$0")"
if [ ! -f "$dir/env" ]; then
  echo "启动失败：env 文件缺失（$dir/env）—— 拒绝在没有注入环境的情况下空跑" >&2
  echo 127 > "$dir/rc"
  exit 127
fi
set -a
. "$dir/env"
set +a
rm -f "$dir/env"
: > "$dir/started"
if [ -n "\${__JOB_CWD:-}" ]; then
  cd "$__JOB_CWD" || { echo "启动失败：工作目录不存在 $__JOB_CWD" >&2; echo 127 > "$dir/rc"; exit 127; }
fi
{
  "$@"
} >> "$dir/stdout.log" 2>> "$dir/stderr.log"
rc=$?
echo "$rc" > "$dir/rc"
exit "$rc"
`;
  const file = path.join(dir, "run.sh");
  fs.writeFileSync(file, script, { mode: 0o700 });
  fs.chmodSync(file, 0o700);
  return file;
}

export interface UnitProbe {
  /** unit 处于 active/activating（= job 还在跑） */
  active: boolean;
  /** unit 的主进程 pid（拿不到就不带这个字段） */
  mainPid?: number;
  /**
   * systemd 不认这个 unit（`LoadState=not-found`）。
   * 两种情况都会是它：unit 从没建起来，**或** job 已结束且被 `--collect` 回收 ——
   * 对调用方而言都等于"unit 不在了，改看启动器写的 rc 文件"。
   */
  notFound: boolean;
}

/** 查一个 transient unit 的状态（`systemctl --user show`） */
export function probeUnit(unit: string): UnitProbe {
  const r = spawnSync(
    "systemctl",
    ["--user", "show", "-p", "LoadState", "-p", "ActiveState", "-p", "MainPID", `${unit}.service`],
    { encoding: "utf-8", timeout: 5_000 }
  );
  const out = typeof r.stdout === "string" ? r.stdout : "";
  const fields = new Map<string, string>();
  for (const line of out.split("\n")) {
    const eq = line.indexOf("=");
    if (eq > 0) fields.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  const state = fields.get("ActiveState") ?? "";
  const pid = Number(fields.get("MainPID") ?? "0");
  return {
    active: state === "active" || state === "activating" || state === "reloading",
    notFound: fields.get("LoadState") !== "loaded",
    ...(Number.isInteger(pid) && pid > 0 ? { mainPid: pid } : {}),
  };
}

/** 停掉 unit（KillMode=control-group → 整个 job cgroup 一起终止）并清掉它的残留状态 */
function stopUnit(unit: string): { ok: boolean; reason?: string } {
  const r = spawnSync("systemctl", ["--user", "stop", `${unit}.service`], {
    encoding: "utf-8",
    timeout: 10_000,
  });
  cleanupUnit(unit);
  if (r.status === 0) return { ok: true };
  const err = (typeof r.stderr === "string" ? r.stderr : "").trim();
  return { ok: false, reason: err === "" ? `systemctl stop ${unit} 失败` : err };
}

/**
 * 按信号终止 unit：`SIGTERM` 走 `stop`（systemd 自己会升级到 SIGKILL），`SIGKILL` 走 `kill -KILL`
 * 立刻强杀整个 cgroup。
 */
export function killUnit(
  unit: string,
  signal: "SIGTERM" | "SIGKILL"
): { ok: boolean; reason?: string } {
  if (signal === "SIGTERM") return stopUnit(unit);
  const r = spawnSync("systemctl", ["--user", "kill", "--signal=SIGKILL", `${unit}.service`], {
    encoding: "utf-8",
    timeout: 10_000,
  });
  // 强杀后 unit 处于 failed，`--collect` 会回收；再补一次 stop 让它尽快收敛
  spawnSync("systemctl", ["--user", "stop", `${unit}.service`], {
    encoding: "utf-8",
    timeout: 10_000,
  });
  cleanupUnit(unit);
  if (r.status === 0) return { ok: true };
  const err = (typeof r.stderr === "string" ? r.stderr : "").trim();
  return { ok: false, reason: err === "" ? `systemctl kill ${unit} 失败` : err };
}

/** 清掉 unit 的 failed 状态（避免残留 unit 影响下次同名启动）；失败无所谓 */
export function cleanupUnit(unit: string): void {
  try {
    spawnSync("systemctl", ["--user", "reset-failed", `${unit}.service`], {
      encoding: "utf-8",
      timeout: 5_000,
    });
  } catch {
    /* 尽力而为 */
  }
}
