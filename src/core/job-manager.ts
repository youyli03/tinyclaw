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
import type { RunOrigin } from "../security/audit.js";

export type JobStatus = "running" | "succeeded" | "failed" | "killed" | "interrupted";

export interface JobMeta {
  id: string;
  name?: string;
  command: string;
  cwd?: string;
  /** 是否脱离服务存活（`detach=true`，类似 `&`/`nohup`） */
  detached: boolean;
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

interface JobRuntime {
  meta: JobMeta;
  child?: ChildProcess;
  /** 每路输出的读取游标（供 `job_output` 增量读） */
  cursor: { stdout: number; stderr: number };
  killTimer?: NodeJS.Timeout;
  timeoutTimer?: NodeJS.Timeout;
  secretsFile?: string | null;
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

function persist(meta: JobMeta): void {
  try {
    fs.mkdirSync(jobDir(meta.id), { recursive: true, mode: 0o700 });
    atomicWriteText(metaPath(meta.id), JSON.stringify(meta, null, 2), 0o600);
  } catch (err) {
    console.warn(`[jobs] 写 meta 失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 读单条 meta（内存优先，其次磁盘） */
export function getJob(id: string): JobMeta | undefined {
  const rt = jobs.get(id);
  if (rt) return rt.meta;
  try {
    return JSON.parse(fs.readFileSync(metaPath(id), "utf-8")) as JobMeta;
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
  try {
    if (meta.detached) {
      // 脱离服务：stdio 直接落文件，unref 让父进程可以退出而 job 继续
      const out = fs.openSync(logPath(id, "stdout"), "a", 0o600);
      const err = fs.openSync(logPath(id, "stderr"), "a", 0o600);
      child = spawn(spawnCmd, spawnArgs, {
        detached: true,
        stdio: ["ignore", out, err],
        ...(opts.cwd ? { cwd: opts.cwd } : {}),
        env: spawnEnv,
      });
      child.unref();
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
  if (child.pid !== undefined) meta.pid = child.pid;
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
      meta.note = `超时 ${meta.timeoutSecs}s，已终止`;
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
          meta.note = "输出超限，已停止落盘（进程继续运行）";
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

  child.on("exit", (code, signal) => {
    const status: JobStatus =
      meta.status === "killed" ? "killed" : code === 0 ? "succeeded" : "failed";
    finish(status, code, signal);
  });
  child.on("error", (err) => {
    meta.note = `spawn 错误：${err.message}`;
    finish("failed", null, null);
  });

  return { ok: true, meta };
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

/** 杀掉 job（整个进程组）；返回是否发出了信号 */
export function killJob(
  id: string,
  signal: NodeJS.Signals = "SIGTERM"
): { ok: boolean; reason?: string; meta?: JobMeta } {
  const meta = getJob(id);
  if (!meta) return { ok: false, reason: `未找到 job ${id}` };
  if (meta.status !== "running")
    return { ok: false, reason: `job ${id} 已结束（${meta.status}）`, meta };

  const rt = jobs.get(id);
  const pid = meta.pid;
  if (pid === undefined) return { ok: false, reason: `job ${id} 没有 pid（启动失败？）`, meta };

  meta.status = signal === "SIGKILL" ? "killed" : meta.status;
  if (signal === "SIGTERM") meta.note = meta.note ?? "收到 kill（SIGTERM）";
  else meta.status = "killed";
  persist(meta);

  try {
    process.kill(-pid, signal); // 进程组
    return { ok: true, meta };
  } catch {
    try {
      rt?.child?.kill(signal);
      return { ok: true, meta };
    } catch (err) {
      return {
        ok: false,
        reason: `kill 失败：${err instanceof Error ? err.message : String(err)}`,
        meta,
      };
    }
  }
}

/**
 * 判断"上次运行残留的 running job"该变成什么状态（纯函数，便于单测）。
 *
 * - 非 detached → `interrupted`（进程已随服务退出）
 * - detached → 进程可能仍在：活着就保留 running 并注明，死了标 `interrupted`
 */
export function markStaleJob(
  meta: JobMeta,
  isAlive: (pid: number) => boolean,
  now: string = new Date().toISOString()
): JobMeta {
  const next: JobMeta = { ...meta, endedAt: meta.endedAt ?? now };
  if (meta.detached && meta.pid !== undefined) {
    const alive = isAlive(meta.pid);
    next.note = alive
      ? `服务重启过；detached job 可能仍在运行（pid ${meta.pid}），可用 job_kill 终止`
      : "服务重启过；detached job 进程已不存在";
    if (!alive) next.status = "interrupted";
    return next;
  }
  next.status = "interrupted";
  next.note = "服务重启导致中断（非 detached job 随服务退出）";
  return next;
}

/**
 * 启动时初始化：把上次运行残留的 running job 标记掉。
 */
export function initJobManager(): void {
  const stale = listJobs({ status: "running" });
  for (const meta of stale) {
    const next = markStaleJob(meta, (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });
    persist(next);
  }
  if (stale.length > 0) {
    console.log(`[jobs] 启动清理：${stale.length} 个 running job 已标记（interrupted/可能仍在）`);
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
