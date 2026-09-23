/**
 * 后台 Job 管理器（对齐 DSH 的 job 概念，但与 Sub-Agent 不同）
 *
 * - **Sub-Agent（`agent_fork`/Slave）**：在后台跑一个 **LLM agent**（自己的会话与工具循环）。
 * - **Job（本模块）**：在后台跑一个**进程/命令**，agent 立即拿回 job id，用 `job_output` 增量读输出、
 *   `job_kill` 杀进程组。适合长编译、批量下载、爬取、训练、监听类任务。
 *
 * 设计要点：
 * 1. **持久化**：`~/.tinyclaw/jobs/<id>/{meta.json,stdout.log,stderr.log}`（0600/0700）。
 *    服务重启后输出仍可查；非 detached 的 running job 在启动时标记为 `interrupted`。
 * 2. **两种存活语义**：
 *    - 默认（`detach=false`）：进程随 tinyclaw 退出而终止（服务 shutdown 时杀整组）；
 *    - `detach=true`（类似 `&`/`nohup`）：`detached + unref`，服务重启后 job 继续跑，日志同一路径。
 * 3. **env 注入**：`process.env`（已含 `~/.tinyclaw/env`）< `agents/<id>/env` < 本次显式 `env`；
 *    值支持 `${SECRET:NAME}`（注入前解析）。**只通过 spawn 的 env 传递，绝不拼进命令行** ——
 *    所以 `ps -ef` 看不到值（argv 里没有）；`/proc/<pid>/environ` 仍是同 UID 可读（见文档的说明与对策）。
 * 4. **沙箱**：跟随 `[sandbox]`（`enabled && execShell==="sandbox"` 时复用 `buildSandboxPlan`），
 *    可用 `secrets: [...]` 按任务声明密钥（复用方案 B 的物化器，脚本照旧读 `secrets.toml`）。
 * 5. **日志上限**：非 detached 走管道，每路输出最多留 `MAX_LOG_BYTES`，超出后继续 drain（不阻塞子进程）
 *    但不再落盘并记一次标记；detached 的 stdio 直接落文件（不经过本进程），**不设上限**。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { loadConfig } from "../config/loader.js";
import { buildJobEnvBase } from "../config/agent-env.js";
import { atomicWriteText } from "../config/safe-write.js";
import { buildSandboxPlan, sandboxAvailable } from "../sandbox/bwrap.js";
import { cleanupFilteredSecrets, materializeFilteredSecrets } from "../sandbox/secrets-filter.js";
import { resolveSecretRefs } from "../mcp/secret-ref.js";
import { auditToolCall } from "../auth/tool-policy.js";
import {
  cleanupUnit,
  jobUnitName,
  killUnit,
  probeUnit,
  systemdRunAvailable,
  writeJobEnvFile,
  writeJobLauncher,
} from "./systemd-run.js";
import type { RunOrigin } from "../security/audit.js";

export type JobStatus = "running" | "succeeded" | "failed" | "killed" | "interrupted";

export interface JobMeta {
  id: string;
  name?: string;
  command: string;
  cwd?: string;
  /** 是否脱离服务存活（`detach=true`，类似 `&`/`nohup`） */
  detached: boolean;
  /**
   * detached job 的 systemd transient unit 名（有它 = 独立 cgroup，能活过 `systemctl restart`）。
   * 没这个字段的 detached job 是"普通 detach"（`setsid`+`unref`），只活过前台重启。
   */
  systemdUnit?: string;
  /** 发起它的 agent / 会话（用于隔离与通知） */
  agentId?: string;
  sessionId?: string;
  pid?: number;
  startedAt: string;
  endedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  status: JobStatus;
  /** 注入过的 env **键名**（绝不落值） */
  envKeys: string[];
  /** 按任务声明的密钥名（绝不落值） */
  secretNames: string[];
  timeoutSecs?: number;
  /** 已落盘字节数 */
  bytes: { stdout: number; stderr: number };
  /** 人类可读备注（超时 / 重启 / 输出截断 …） */
  note?: string;
}

/** 每路输出最多落盘多少字节（超出继续 drain 但不落盘；仅非 detached，走管道的那条路） */
export const MAX_LOG_BYTES = 8 * 1024 * 1024;
/** 同一 agent 同时可跑的 job 上限（后台作业无 MFA，用硬上限防"跑飞"） */
export const MAX_RUNNING_PER_AGENT = 8;
/** 全进程同时可跑的 job 上限 */
export const MAX_RUNNING_TOTAL = 32;
/** SIGTERM 后多久 SIGKILL */
const KILL_GRACE_MS = 5_000;
/** 等 systemd unit 真正起来的时限（见到 `started` 标记就算起来了） */
const SYSTEMD_START_TIMEOUT_MS = 2_000;

interface JobRuntime {
  meta: JobMeta;
  child?: ChildProcess;
  /** 每路输出的读取游标（供 `job_output` 增量读） */
  cursor: { stdout: number; stderr: number };
  killTimer?: NodeJS.Timeout;
  timeoutTimer?: NodeJS.Timeout;
  secretsFile?: string | null;
  /** 用户已经请求过 kill（退出事件到达时定状态用 `killed` 而不是 `failed`） */
  killedIntent?: boolean;
}

const jobs = new Map<string, JobRuntime>();

/** jobs 根目录 */
export function jobsRoot(): string {
  return path.join(os.homedir(), ".tinyclaw", "jobs");
}

function jobDir(id: string): string {
  return path.join(jobsRoot(), id);
}

function metaPath(id: string): string {
  return path.join(jobDir(id), "meta.json");
}

function logPath(id: string, stream: "stdout" | "stderr"): string {
  return path.join(jobDir(id), `${stream}.log`);
}

function newJobId(): string {
  return `job_${randomBytes(4).toString("hex")}`;
}

/** 追加一条备注（不覆盖已有的：超时 / carrier 说明 / 上次 kill 都要留着），重复内容只记一次 */
function appendNote(meta: JobMeta, text: string): void {
  if (meta.note === undefined || meta.note === "") {
    meta.note = text;
    return;
  }
  if (meta.note.includes(text)) return;
  meta.note = `${meta.note} · ${text}`;
}

function persist(meta: JobMeta): void {
  try {
    fs.mkdirSync(jobDir(meta.id), { recursive: true, mode: 0o700 });
    atomicWriteText(metaPath(meta.id), JSON.stringify(meta, null, 2), 0o600);
  } catch (err) {
    console.warn(`[jobs] 写 meta 失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 读单条 meta（内存优先，其次磁盘；磁盘上的 systemd job 顺带与 unit 真实状态对齐） */
export function getJob(id: string): JobMeta | undefined {
  const rt = jobs.get(id);
  if (rt) return rt.meta;
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath(id), "utf-8")) as JobMeta;
    return refreshSystemdJob(meta);
  } catch {
    return undefined;
  }
}

/** 列出 job（内存 + 磁盘），按开始时间倒序 */
export function listJobs(filter: { agentId?: string; status?: JobStatus } = {}): JobMeta[] {
  const seen = new Map<string, JobMeta>();
  for (const rt of jobs.values()) seen.set(rt.meta.id, rt.meta);
  try {
    for (const entry of fs.readdirSync(jobsRoot(), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (seen.has(entry.name)) continue;
      const meta = getJob(entry.name);
      if (meta) seen.set(meta.id, meta);
    }
  } catch {
    /* 目录不存在 = 还没有 job */
  }
  return [...seen.values()]
    .filter((m) => (filter.agentId === undefined ? true : m.agentId === filter.agentId))
    .filter((m) => (filter.status === undefined ? true : m.status === filter.status))
    .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}

export interface StartJobOptions {
  command: string;
  cwd?: string;
  name?: string;
  /** 显式覆盖的 env（优先级最高） */
  env?: Record<string, string>;
  /** 按任务声明的密钥（沙箱内 bind 回 secrets.toml 的原路径） */
  secrets?: string[];
  timeoutSecs?: number;
  /** 脱离服务存活（类似 `&`/`nohup`） */
  detach?: boolean;
  agentId?: string;
  sessionId?: string;
  origin?: RunOrigin;
  /** 沙箱内额外可写路径（来自 job 配置 / fs_grant） */
  extraRwPaths?: string[];
  /** 进程退出后的回调（用于通知发起会话） */
  onExit?: (meta: JobMeta) => void;
}

export type StartJobResult = { ok: true; meta: JobMeta } | { ok: false; reason: string };

/** 启动一个后台 job */
export async function startJob(opts: StartJobOptions): Promise<StartJobResult> {
  const command = opts.command.trim();
  if (command === "") return { ok: false, reason: "已拒绝：command 不能为空。" };

  // 防跑飞：后台 job 不需要 MFA，用并发上限兜住
  const running = listJobs({ status: "running" });
  if (running.length >= MAX_RUNNING_TOTAL) {
    return {
      ok: false,
      reason: `已拒绝：本进程同时运行的后台 job 已达上限 ${MAX_RUNNING_TOTAL} 个，先 job_kill 或等它们结束。`,
    };
  }
  if (opts.agentId !== undefined) {
    const mine = running.filter((m) => m.agentId === opts.agentId).length;
    if (mine >= MAX_RUNNING_PER_AGENT) {
      return {
        ok: false,
        reason: `已拒绝：agent "${opts.agentId}" 同时运行的后台 job 已达上限 ${MAX_RUNNING_PER_AGENT} 个，先 job_kill 或等它们结束。`,
      };
    }
  }

  const id = newJobId();
  const agentId = opts.agentId;
  const sessionId = opts.sessionId;

  // ── env 组装：process.env（含 ~/.tinyclaw/env） < agents/<id>/env < 显式 env ──
  const built = buildJobEnvBase(process.env, agentId, opts.env);
  const resolved = resolveSecretRefs(built.env);
  if (resolved.missing.length > 0) {
    console.warn(`[jobs] ${id}: secrets.toml 缺少 ${resolved.missing.join(", ")}，对应 env 未注入`);
  }
  const jobEnv = resolved.values;

  // ── 沙箱决策（与 exec_shell 同口径） ──
  const cfg = loadConfig().sandbox;
  const wantSandbox = cfg.enabled && cfg.execShell === "sandbox";
  let spawnCmd = "bash";
  let spawnArgs = ["-c", command];
  let spawnEnv: NodeJS.ProcessEnv = jobEnv;
  let sandboxNote: string | undefined;
  let secretsFile: string | null = null;

  if (wantSandbox) {
    const availability = sandboxAvailable();
    if (!availability.available) {
      if (cfg.onUnavailable === "deny") {
        return {
          ok: false,
          reason: `已拒绝：沙箱不可用（${availability.reason ?? "bwrap 未安装"}），[sandbox].onUnavailable = "deny"。`,
        };
      }
      sandboxNote = "沙箱不可用，按配置退回宿主机执行";
      console.warn(`[jobs] ${sandboxNote}`);
    } else {
      // 沙箱会把 agent 目录 bind 进来并 chdir 到 workspace：目录不存在时 bwrap 只会吐
      // "Can't chdir"，这里提前给出人话错误（否则用户只看到 job failed）
      const workspace = path.join(
        os.homedir(),
        ".tinyclaw",
        "agents",
        agentId ?? "default",
        "workspace"
      );
      if (!fs.existsSync(workspace)) {
        return {
          ok: false,
          reason:
            `已拒绝：agent "${agentId ?? "default"}" 的 workspace 不存在（${workspace}），` +
            "沙箱需要它作为工作目录。请先创建该 agent，或用 cwd 指定一个已存在的目录。",
        };
      }
      if (opts.secrets !== undefined && opts.secrets.length > 0) {
        secretsFile = materializeFilteredSecrets({
          names: opts.secrets,
          label: `job-${id}`,
          origin: opts.origin,
          agentId: agentId ?? "default",
          ...(sessionId ? { sessionId } : {}),
        });
      }
      const plan = buildSandboxPlan({
        command,
        agentId: agentId ?? "default",
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        ...(opts.extraRwPaths && opts.extraRwPaths.length > 0
          ? { extraRwPaths: opts.extraRwPaths }
          : {}),
        ...(secretsFile ? { filteredSecretsFile: secretsFile } : {}),
        cfg,
      });
      const [head, ...tail] = plan.argv;
      spawnCmd = head ?? "bwrap";
      spawnArgs = tail;
      // 沙箱可能按配置收敛继承环境；显式管理的 agent/job 变量仍然注入（用户要求"env 都要能注入"）
      spawnEnv = plan.env ? { ...plan.env, ...jobEnv } : jobEnv;
      sandboxNote = plan.env ? "沙箱内（环境已按配置收敛 + 显式 env）" : "沙箱内";
    }
  }

  const meta: JobMeta = {
    id,
    command,
    detached: opts.detach === true,
    startedAt: new Date().toISOString(),
    status: "running",
    envKeys: [...new Set([...built.agentKeys, ...built.overrideKeys])].sort(),
    secretNames: [...(opts.secrets ?? [])],
    bytes: { stdout: 0, stderr: 0 },
    ...(opts.name !== undefined ? { name: opts.name } : {}),
    ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
    ...(agentId !== undefined ? { agentId } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(opts.timeoutSecs !== undefined && opts.timeoutSecs > 0
      ? { timeoutSecs: opts.timeoutSecs }
      : {}),
    ...(sandboxNote !== undefined ? { note: sandboxNote } : {}),
  };

  fs.mkdirSync(jobDir(id), { recursive: true, mode: 0o700 });

  let child: ChildProcess;
  let systemdUnit: string | undefined;
  let earlyExit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
  try {
    if (meta.detached) {
      const started = await launchDetached({
        id,
        program: spawnCmd,
        programArgs: spawnArgs,
        env: spawnEnv,
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
      });
      if (!started.ok) {
        cleanupFilteredSecrets(secretsFile);
        return { ok: false, reason: started.reason };
      }
      child = started.child;
      if (started.systemdUnit !== undefined) {
        systemdUnit = started.systemdUnit;
        meta.systemdUnit = systemdUnit;
        appendNote(
          meta,
          `systemd 独立 unit ${systemdUnit}.service（独立 cgroup：能活过 systemctl restart）`
        );
      } else {
        // 回落路径：只活过前台重启，活不过 `systemctl restart`（父 unit 是 KillMode=control-group）
        appendNote(meta, "普通 detach（无 systemd）：活不过 systemctl restart");
      }
      if (started.mainPid !== undefined) meta.pid = started.mainPid;
      earlyExit = started.alreadyExited ?? null;
    } else {
      child = spawn(spawnCmd, spawnArgs, {
        detached: true, // 进程组 leader：kill 时用 -pid 杀整组
        stdio: ["ignore", "pipe", "pipe"],
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        env: spawnEnv,
      });
    }
  } catch (err) {
    cleanupFilteredSecrets(secretsFile);
    return { ok: false, reason: `启动失败：${err instanceof Error ? err.message : String(err)}` };
  }

  const rt: JobRuntime = { meta, child, cursor: { stdout: 0, stderr: 0 }, secretsFile };
  jobs.set(id, rt);
  if (systemdUnit === undefined && child.pid !== undefined) meta.pid = child.pid;
  persist(meta);

  auditToolCall({
    event: "policy",
    origin: opts.origin,
    agentId: agentId ?? "default",
    ...(sessionId ? { sessionId } : {}),
    tool: "job_start",
    decision: "allow",
    reason: `后台 job：${meta.detached ? "detached " : ""}pid=${meta.pid ?? "?"}${
      sandboxNote ? `（${sandboxNote}）` : ""
    }`,
    args: { command, envKeys: meta.envKeys, secretNames: meta.secretNames },
  });

  const finish = (status: JobStatus, code: number | null, signal: NodeJS.Signals | null) => {
    if (meta.status !== "running") return;
    meta.status = status;
    meta.exitCode = code;
    meta.signal = signal;
    meta.endedAt = new Date().toISOString();
    if (rt.timeoutTimer) clearTimeout(rt.timeoutTimer);
    if (rt.killTimer) clearTimeout(rt.killTimer);
    cleanupFilteredSecrets(rt.secretsFile);
    rt.secretsFile = null;
    persist(meta);
    try {
      opts.onExit?.(meta);
    } catch (err) {
      console.warn(`[jobs] onExit 回调失败：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  // 超时：先 SIGTERM 整组，宽限后 SIGKILL
  if (meta.timeoutSecs !== undefined && meta.timeoutSecs > 0) {
    rt.timeoutTimer = setTimeout(() => {
      appendNote(meta, `超时 ${meta.timeoutSecs}s，已终止`);
      killJob(id, "SIGTERM");
      rt.killTimer = setTimeout(() => killJob(id, "SIGKILL"), KILL_GRACE_MS);
    }, meta.timeoutSecs * 1000);
  }

  if (!meta.detached && child.stdout && child.stderr) {
    let stdoutDone = false;
    let stderrDone = false;
    child.stdout.on("data", (d: Buffer) => {
      if (meta.bytes.stdout >= MAX_LOG_BYTES) {
        if (!stdoutDone) {
          stdoutDone = true;
          appendLog(id, "stdout", `\n[jobs] 输出超过 ${MAX_LOG_BYTES} 字节，后续内容不再落盘\n`);
          appendNote(meta, "输出超限，已停止落盘（进程继续运行）");
        }
        return; // 继续 drain，避免子进程被管道阻塞
      }
      meta.bytes.stdout += d.length;
      appendLog(id, "stdout", d.toString("utf-8"));
    });
    child.stderr.on("data", (d: Buffer) => {
      if (meta.bytes.stderr >= MAX_LOG_BYTES) {
        if (!stderrDone) {
          stderrDone = true;
          appendLog(id, "stderr", `\n[jobs] 输出超过 ${MAX_LOG_BYTES} 字节，后续内容不再落盘\n`);
        }
        return;
      }
      meta.bytes.stderr += d.length;
      appendLog(id, "stderr", d.toString("utf-8"));
    });
  }

  /** 退出码 → 最终状态（我们主动杀过就是 killed，而不是 failed） */
  const statusFor = (code: number | null): JobStatus =>
    rt.killedIntent === true ? "killed" : code === 0 ? "succeeded" : "failed";

  child.on("exit", (code, signal) => {
    // systemd 载体：这个 child 只是 `systemd-run --wait` 的等待进程，**不是 job 本体**。
    // 我们要重启时 systemd 会给整个 cgroup 发 SIGTERM（等待进程也在里面），
    // 而 job 在它自己的 unit/cgroup 里照旧跑 —— 那时候把 job 判死就错了（实测踩到过）。
    if (meta.systemdUnit !== undefined && rt.killedIntent !== true) {
      const active = probeUnit(meta.systemdUnit).active;
      if (!waiterExitFinalizesJob(meta, active, false)) {
        jobs.delete(id); // 之后由读盘路径的 refreshSystemdJob 负责探活/收敛
        appendNote(
          meta,
          "启动它的服务进程退出了；job 仍在自己的 unit 里运行（不再有等待进程监听退出码）"
        );
        persist(meta);
        return;
      }
    }
    finish(statusFor(code), code, signal);
  });
  child.on("error", (err) => {
    appendNote(meta, `spawn 错误：${err.message}`);
    finish("failed", null, null);
  });

  // systemd 载体的极短任务：启动判定期间就已经退出，'exit' 事件不会再补发
  if (earlyExit !== null) finish(statusFor(earlyExit.code), earlyExit.code, earlyExit.signal);

  return { ok: true, meta };
}

/** 日志文件先建好并设成 0600（启动器脚本里的 `>>` 不会自己设权限） */
function touchLogFile(id: string, stream: "stdout" | "stderr"): void {
  try {
    const fd = fs.openSync(logPath(id, stream), "a", 0o600);
    fs.closeSync(fd);
  } catch (err) {
    console.warn(
      `[jobs] ${id}: 建日志文件失败：${err instanceof Error ? err.message : String(err)}`
    );
  }
}

type DetachedResult =
  | {
      ok: true;
      child: ChildProcess;
      systemdUnit?: string;
      mainPid?: number;
      /** 启动判定期间子进程就已经退出（极短任务）：'exit' 事件不会再补发，调用方要自己收敛状态 */
      alreadyExited?: { code: number | null; signal: NodeJS.Signals | null };
    }
  | { ok: false; reason: string };

interface DetachedArgs {
  id: string;
  program: string;
  programArgs: string[];
  env: NodeJS.ProcessEnv;
  cwd?: string;
}

/**
 * detached 启动：优先放进**独立的 transient systemd unit**（独立 cgroup ⇒ 能活过 `systemctl restart`），
 * `systemd-run` 不可用或启动失败时回落到 `setsid`+`unref` 的普通 detach（只活过前台重启）。
 *
 * 为什么需要它、以及为什么 env 走 0600 文件而不是 `--setenv`：见 `core/systemd-run.ts` 的模块注释。
 */
async function launchDetached(args: DetachedArgs): Promise<DetachedResult> {
  if (systemdRunAvailable()) {
    const unit = jobUnitName(args.id);
    const viaSystemd = await launchSystemdUnit({ ...args, unit });
    if (viaSystemd.ok) return viaSystemd;
    console.warn(`[jobs] ${args.id}: systemd 载体不可用（${viaSystemd.reason}），回落普通 detach`);
  }
  return spawnDetachedPlain(args);
}

/** 普通 detach：新会话 + 新进程组 + stdio 直接落文件（活不过 `systemctl restart`，见模块注释） */
function spawnDetachedPlain(args: DetachedArgs): DetachedResult {
  touchLogFile(args.id, "stdout");
  touchLogFile(args.id, "stderr");
  const out = fs.openSync(logPath(args.id, "stdout"), "a", 0o600);
  const err = fs.openSync(logPath(args.id, "stderr"), "a", 0o600);
  try {
    const child = spawn(args.program, args.programArgs, {
      detached: true,
      stdio: ["ignore", out, err],
      ...(args.cwd ? { cwd: args.cwd } : {}),
      env: args.env,
    });
    child.unref();
    return { ok: true, child };
  } finally {
    fs.closeSync(out); // 子进程已各自持有副本，父进程这份要关掉（否则每条 detached job 漏 2 个 fd）
    fs.closeSync(err);
  }
}

/** systemd 载体：写 env 文件 + 启动器 → `systemd-run --wait --collect` → 等 `started` 标记确认真的起来了 */
async function launchSystemdUnit(args: DetachedArgs & { unit: string }): Promise<DetachedResult> {
  const dir = jobDir(args.id);
  touchLogFile(args.id, "stdout");
  touchLogFile(args.id, "stderr");

  const envForFile: Record<string, string> = {};
  for (const [k, v] of Object.entries(args.env)) if (typeof v === "string") envForFile[k] = v;
  if (args.cwd !== undefined) envForFile["__JOB_CWD"] = args.cwd;
  writeJobEnvFile(path.join(dir, "env"), envForFile);
  const launcher = writeJobLauncher(dir);

  const child = spawn(
    "systemd-run",
    [
      "--user",
      "--wait", // 拿 job 的退出码（= 这个子进程的退出码）
      "--collect", // unit 用完自动回收，不留垃圾
      `--unit=${args.unit}`,
      `--description=tinyclaw job ${args.id}`,
      launcher,
      args.program,
      ...args.programArgs,
    ],
    { stdio: ["ignore", "ignore", "ignore"] }
  );
  child.unref(); // 不拦住服务退出；'exit' 事件照旧会来

  const spawnErrors: Error[] = [];
  const onError = (err: Error): void => {
    spawnErrors.push(err);
  };
  child.once("error", onError);

  // 等"启动器真的跑起来了"的证据（started 标记），而不是靠 sleep 猜
  const startedFile = path.join(dir, "started");
  const deadline = Date.now() + SYSTEMD_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (
      fs.existsSync(startedFile) ||
      spawnErrors.length > 0 ||
      child.exitCode !== null ||
      child.signalCode !== null
    ) {
      break;
    }
    await new Promise<void>((r) => setTimeout(r, 50));
  }
  child.removeListener("error", onError);

  const spawnError = spawnErrors[0];
  if (spawnError !== undefined) {
    cleanupUnit(args.unit);
    dropEnvFile(dir); // 启动失败：env 文件（含注入的值）绝不能留在盘上
    return { ok: false, reason: `无法执行 systemd-run：${spawnError.message}` };
  }
  const started = fs.existsSync(startedFile);
  const exited = child.exitCode !== null || child.signalCode !== null;
  if (!started && exited && (child.exitCode ?? 1) !== 0) {
    cleanupUnit(args.unit);
    dropEnvFile(dir);
    return { ok: false, reason: `systemd-run 未能启动 unit（退出码 ${child.exitCode ?? "?"}）` };
  }

  const probe = started ? probeUnit(args.unit) : null;
  return {
    ok: true,
    child,
    systemdUnit: args.unit,
    ...(probe?.mainPid !== undefined ? { mainPid: probe.mainPid } : {}),
    ...(exited ? { alreadyExited: { code: child.exitCode, signal: child.signalCode } } : {}),
  };
}

/** 删掉 job 目录里的 env 文件（含注入的值）；systemd 启动失败的路径必须调用 */
function dropEnvFile(dir: string): void {
  try {
    fs.rmSync(path.join(dir, "env"), { force: true });
  } catch (err) {
    console.warn(`[jobs] 删除 env 文件失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

function appendLog(id: string, stream: "stdout" | "stderr", text: string): void {
  try {
    fs.appendFileSync(logPath(id, stream), text, { encoding: "utf-8", mode: 0o600 });
  } catch {
    /* 落盘失败不影响 job 运行 */
  }
}

export interface JobOutputResult {
  ok: boolean;
  reason?: string;
  meta?: JobMeta;
  text?: string;
  cursor?: { stdout: number; stderr: number };
}

/**
 * 增量读输出（自上次读取以来）。
 *
 * @param cursor 可选：显式给游标则无状态读取（返回新的游标）；不给则用**本进程内**该 job 的游标
 */
export function readJobOutput(
  id: string,
  stream: "stdout" | "stderr" | "both" = "both",
  cursor?: { stdout?: number; stderr?: number },
  maxBytes = 64 * 1024
): JobOutputResult {
  const meta = getJob(id);
  if (!meta) return { ok: false, reason: `未找到 job ${id}` };

  const rt = jobs.get(id);
  const from = {
    stdout: cursor?.stdout ?? rt?.cursor.stdout ?? 0,
    stderr: cursor?.stderr ?? rt?.cursor.stderr ?? 0,
  };

  const readFrom = (s: "stdout" | "stderr", offset: number): { text: string; next: number } => {
    try {
      const fd = fs.openSync(logPath(id, s), "r");
      try {
        const stat = fs.fstatSync(fd);
        if (offset >= stat.size) return { text: "", next: stat.size };
        const len = Math.min(maxBytes, stat.size - offset);
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, offset);
        return { text: buf.toString("utf-8"), next: offset + len };
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return { text: "", next: offset };
    }
  };

  const outParts: string[] = [];
  const next = { stdout: from.stdout, stderr: from.stderr };
  if (stream === "stdout" || stream === "both") {
    const r = readFrom("stdout", from.stdout);
    next.stdout = r.next;
    if (r.text !== "") outParts.push(r.text);
  }
  if (stream === "stderr" || stream === "both") {
    const r = readFrom("stderr", from.stderr);
    next.stderr = r.next;
    if (r.text !== "")
      outParts.push(
        stream === "both" && outParts.length > 0 ? `\n--- stderr ---\n${r.text}` : r.text
      );
  }
  if (rt) rt.cursor = next;
  return { ok: true, meta, text: outParts.join(""), cursor: next };
}

/**
 * `systemd-run --wait` 的等待进程退出时，要不要据此给 job 落终态？
 *
 * - 非 systemd 载体（含普通 detach）：这个 child 就是 job 本体 → 要
 * - 我们主动杀过（`killedIntent`）：让 `finish()` 把状态收敛成 `killed` → 要
 * - systemd 载体且 unit 还活着：死的只是等待进程（服务自己在退出，systemd 给整个 cgroup
 *   发了 SIGTERM），job 在它自己的 cgroup 里照常跑 → **不要**
 */
export function waiterExitFinalizesJob(
  meta: JobMeta,
  unitActive: boolean,
  killedIntent: boolean
): boolean {
  if (meta.systemdUnit === undefined) return true;
  if (killedIntent) return true;
  return !unitActive;
}

/** 给整个进程组发信号（进程组 leader 的 pid 即组 id） */
function signalGroup(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    return false;
  }
}

/** 本进程不会再收到退出事件时，直接落终态（服务重启后从磁盘接管的 job 走这条路） */
function markKilledNow(meta: JobMeta, signal: NodeJS.Signals): void {
  meta.status = "killed";
  meta.exitCode = null;
  meta.signal = signal;
  meta.endedAt = meta.endedAt ?? new Date().toISOString();
}

/** 杀掉 job（整个进程组 / 整个 systemd unit）；返回是否发出了信号 */
export function killJob(
  id: string,
  signal: NodeJS.Signals = "SIGTERM"
): { ok: boolean; reason?: string; meta?: JobMeta } {
  const meta = getJob(id);
  if (!meta) return { ok: false, reason: `未找到 job ${id}` };
  if (meta.status !== "running")
    return { ok: false, reason: `job ${id} 已结束（${meta.status}）`, meta };

  const rt = jobs.get(id);
  // 有 runtime 时状态收敛交给退出事件（`finish()` 只在 running 时生效），这里只记"是我们杀的"；
  // 没有 runtime（重启后接管的历史 job）就没人能收到退出事件了 → 直接落终态
  const canObserveExit = rt !== undefined;
  if (rt) rt.killedIntent = true;

  // systemd 载体：停 unit（KillMode=control-group 会带走整个 job cgroup）
  if (meta.systemdUnit !== undefined) {
    appendNote(
      meta,
      `收到 kill（systemctl ${signal === "SIGKILL" ? "kill -KILL" : "stop"} ${
        meta.systemdUnit
      }.service）`
    );
    if (!canObserveExit) markKilledNow(meta, signal);
    persist(meta);
    const res = killUnit(meta.systemdUnit, signal === "SIGKILL" ? "SIGKILL" : "SIGTERM");
    if (!res.ok) return { ok: false, reason: `停 unit 失败：${res.reason}`, meta };
    return { ok: true, meta };
  }

  const pid = meta.pid;
  if (pid === undefined) return { ok: false, reason: `job ${id} 没有 pid（启动失败？）`, meta };

  appendNote(meta, `收到 kill（${signal}）`);
  persist(meta);

  if (signalGroup(pid, signal)) {
    if (!canObserveExit) {
      markKilledNow(meta, signal);
      persist(meta);
    }
    return { ok: true, meta };
  }
  try {
    rt?.child?.kill(signal);
    if (!canObserveExit) {
      markKilledNow(meta, signal);
      persist(meta);
    }
    return { ok: true, meta };
  } catch (err) {
    return {
      ok: false,
      reason: `kill 失败：${err instanceof Error ? err.message : String(err)}`,
      meta,
    };
  }
}

/**
 * 本进程没有 runtime、但 meta 说在跑的 systemd job：与 unit 的真实状态对齐。
 *
 * 重启后接管的历史 job 没人给它发退出事件 —— 它可能早就跑完了，也可能还在跑。
 * `job_status` / `job_list` / 并发上限判定都要看到真相，所以在读盘路径上补一次探活。
 */
function refreshSystemdJob(meta: JobMeta): JobMeta {
  if (meta.systemdUnit === undefined || meta.status !== "running" || jobs.has(meta.id)) return meta;
  const probe = probeUnit(meta.systemdUnit);
  if (probe.active) return meta;
  const { meta: next } = resolveStaleJob(meta, {
    kind: "systemd",
    active: false,
    exitCode: readJobRc(meta.id),
  });
  // unit 已被 systemd 回收（`--collect`）就没什么可 reset 的，省一次 systemctl
  if (!probe.notFound) cleanupUnit(meta.systemdUnit);
  persist(next);
  return next;
}

/** 残留 job 的探活结果（由 `initJobManager()` 采集，纯函数只负责判定） */
export type StaleProbe =
  { kind: "systemd"; active: boolean; exitCode: number | null } | { kind: "plain"; alive: boolean };

export interface StaleResolution {
  meta: JobMeta;
  /**
   * 非 detached 的残留进程还活着 → 按"随服务退出"的契约收掉它。
   * （systemd 部署下 systemd 已经连坐杀过一遍，这是给崩溃/非 systemd 场景兜底。）
   */
  killOrphan: boolean;
}

/**
 * 判断"上次运行残留的 running job"该变成什么状态（纯函数，便于单测）。
 *
 * - systemd 载体：unit 还在 → 保留 running（注明）；已结束 → 用启动器写的 rc 定 succeeded/failed；
 *   查不到 unit 也没 rc → `interrupted`
 * - 普通 detached：进程还活着 → 保留 running（注明）；死了 → `interrupted`
 * - 非 detached：进程还活着 → 收掉（`killOrphan`）并标 `interrupted`；死了 → `interrupted`
 */
export function resolveStaleJob(
  meta: JobMeta,
  probe: StaleProbe,
  now: string = new Date().toISOString()
): StaleResolution {
  const next: JobMeta = { ...meta, endedAt: meta.endedAt ?? now };

  if (probe.kind === "systemd") {
    if (probe.active) {
      next.note = `服务重启过；systemd unit ${meta.systemdUnit ?? "?"} 仍在运行（job_kill 可终止）`;
      return { meta: next, killOrphan: false };
    }
    if (probe.exitCode !== null) {
      next.status = probe.exitCode === 0 ? "succeeded" : "failed";
      next.exitCode = probe.exitCode;
      next.note = `服务重启期间已结束（退出码 ${probe.exitCode}，由启动器 rc 文件补记）`;
      return { meta: next, killOrphan: false };
    }
    next.status = "interrupted";
    next.note = "服务重启过；systemd unit 已不存在且没有退出码记录";
    return { meta: next, killOrphan: false };
  }

  if (meta.detached) {
    next.note = probe.alive
      ? `服务重启过；detached job 可能仍在运行（pid ${meta.pid ?? "?"}），可用 job_kill 终止`
      : "服务重启过；detached job 进程已不存在";
    if (!probe.alive) next.status = "interrupted";
    return { meta: next, killOrphan: false };
  }

  if (probe.alive) {
    next.status = "interrupted";
    next.note = `服务重启导致的残留进程（pid ${meta.pid ?? "?"}）已按"随服务退出"的约定收掉`;
    return { meta: next, killOrphan: true };
  }
  next.status = "interrupted";
  next.note = "服务重启导致中断（非 detached job 随服务退出）";
  return { meta: next, killOrphan: false };
}

/** 读启动器写的 `rc` 文件（systemd 载体在服务重启后靠它取回退出码） */
function readJobRc(id: string): number | null {
  try {
    const n = Number(fs.readFileSync(path.join(jobDir(id), "rc"), "utf-8").trim());
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

function isPidAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 启动时初始化：收敛上次运行残留的 running job。
 *
 * - systemd 载体的 job 用 `systemctl show` 探活（重启后它可能**仍在跑**，这正是 detach 的意义）
 * - 非 detached 的残留进程按契约**收掉**（否则它会变成没人认领的孤儿）
 */
export function initJobManager(): void {
  const stale = listJobs({ status: "running" });
  let cleaned = 0;
  for (const meta of stale) {
    const probe: StaleProbe =
      meta.systemdUnit !== undefined
        ? {
            kind: "systemd",
            active: probeUnit(meta.systemdUnit).active,
            exitCode: readJobRc(meta.id),
          }
        : { kind: "plain", alive: isPidAlive(meta.pid) };

    const { meta: next, killOrphan } = resolveStaleJob(meta, probe);
    if (killOrphan && next.pid !== undefined) {
      signalGroup(next.pid, "SIGTERM");
      cleaned++;
    }
    if (meta.systemdUnit !== undefined) cleanupUnit(meta.systemdUnit);
    persist(next);
  }
  if (stale.length > 0) {
    console.log(
      `[jobs] 启动清理：${stale.length} 个 running job 已收敛（interrupted/仍在运行），` +
        `其中 ${cleaned} 个残留进程已收掉`
    );
  }
}

/** 服务退出：杀掉未 detached 的 running job（detached 的按设计继续跑） */
export async function shutdownJobManager(): Promise<void> {
  for (const [id, rt] of jobs) {
    if (rt.meta.status !== "running" || rt.meta.detached) continue;
    killJob(id, "SIGTERM");
  }
  // 给子进程一点时间收尾
  await new Promise<void>((r) => setTimeout(r, 200));
}
