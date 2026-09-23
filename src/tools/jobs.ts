/**
 * 后台 Job 工具（对齐 DSH 的 job 概念）
 *
 * 与 Sub-Agent 的区别：Job 跑的是**进程/命令**（长编译、批量下载、爬取、训练、监听），
 * 不是"再开一个 LLM agent"。你拿到 job id 后可以继续对话，用 `job_output` 增量读输出。
 *
 * - `job_start`（`detach=true` ≈ `&`/`nohup`：服务重启后继续跑）
 * - `job_list` / `job_status` / `job_output` / `job_kill`
 *
 * 隔离：job 记发起它的 `agentId`，只有它自己（或没有 agent 上下文的 CLI/cron）能读/杀。
 * env：`process.env`（含 `~/.tinyclaw/env`）< `agents/<id>/env` < 本次 `env`；值用 spawn 的 env 传，
 * **不拼命令行**，所以 `ps -ef` 看不到值。
 * 无人值守：`job_start` 在 ReAct 通道被硬拒绝（后台进程会活过这一轮，等于绕过监督窗口）。
 */

import { registerTool, type ToolContext } from "./registry.js";
import {
  getJob,
  killJob,
  listJobs,
  readJobOutput,
  startJob,
  type JobMeta,
  type JobStatus,
} from "../core/job-manager.js";

/** 只能操作"自己的" job（无 agent 上下文时不限制） */
function assertOwnJob(meta: JobMeta | undefined, ctx: ToolContext | undefined): string | null {
  if (meta === undefined) return null;
  const me = ctx?.agentId;
  if (me === undefined || me === "") return null;
  if (meta.agentId === undefined || meta.agentId === me) return null;
  return `已拒绝：job ${meta.id} 属于 agent "${meta.agentId}"，当前 agent "${me}" 不能操作它。`;
}

function describe(meta: JobMeta): string {
  const dur =
    meta.endedAt !== undefined
      ? `${Math.round((new Date(meta.endedAt).getTime() - new Date(meta.startedAt).getTime()) / 1000)}s`
      : `已跑 ${Math.round((Date.now() - new Date(meta.startedAt).getTime()) / 1000)}s`;
  return (
    `- \`${meta.id}\` ${meta.status}${meta.detached ? " · detached" : ""} · ${dur}` +
    `${meta.pid !== undefined ? ` · pid=${meta.pid}` : ""}${
      meta.exitCode !== undefined && meta.exitCode !== null ? ` · exit=${meta.exitCode}` : ""
    }\n  命令：${meta.command.length > 120 ? meta.command.slice(0, 120) + "…" : meta.command}` +
    `${meta.note !== undefined ? `\n  备注：${meta.note}` : ""}`
  );
}

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "job_start",
      description:
        "Start a BACKGROUND process job and return immediately with its job id (this is not a sub-agent: " +
        "no LLM runs inside). Use it for long tasks (builds, downloads, scraping, training, watchers) " +
        "while you keep talking to the user; read progress later with job_output. Environment: the job " +
        "inherits process.env (which already includes ~/.tinyclaw/env) plus this agent's own variables " +
        "(env_set) plus the explicit env passed here; values are passed through the spawn environment, " +
        "never on the command line, so `ps -ef` does not show them. Values support the ${SECRET:NAME} " +
        "reference form. With detach=true the job survives a tinyclaw restart (like & / nohup); " +
        "otherwise it dies with the service. Runs inside the sandbox when [sandbox] says so; declare " +
        "secrets: [...] to let the job read exactly those keys from secrets.toml.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "Shell command to run (bash -c)" },
          name: { type: "string", description: "Optional human-readable label" },
          cwd: { type: "string", description: "Working directory (default: agent workspace)" },
          env: {
            type: "object",
            additionalProperties: { type: "string" },
            description: 'Extra variables for this job only, e.g. { "LOG_LEVEL": "debug" }',
          },
          secrets: {
            type: "array",
            items: { type: "string" },
            description:
              "Names in secrets.toml this job may read (sandbox binds a filtered copy back to the " +
              "original path, so scripts keep reading ~/.tinyclaw/secrets.toml unchanged)",
          },
          timeout_secs: {
            type: "number",
            description: "Kill the job after N seconds (0/omitted = no timeout)",
          },
          detach: {
            type: "boolean",
            description: "true = survive service restart (like & / nohup); default false",
          },
        },
        required: ["command"],
      },
    },
  },
  execute: async (args, ctx) => {
    const command = String(args["command"] ?? "");
    const env = args["env"];
    const secrets = Array.isArray(args["secrets"]) ? args["secrets"].map(String) : undefined;
    const rawTimeout = args["timeout_secs"];
    const timeoutSecs = typeof rawTimeout === "number" ? rawTimeout : undefined;

    const res = await startJob({
      command,
      ...(args["name"] !== undefined ? { name: String(args["name"]) } : {}),
      ...(args["cwd"] !== undefined ? { cwd: String(args["cwd"]) } : {}),
      ...(env !== undefined && typeof env === "object" && !Array.isArray(env)
        ? {
            env: Object.fromEntries(
              Object.entries(env as Record<string, unknown>).map(([k, v]) => [k, String(v)])
            ),
          }
        : {}),
      ...(secrets !== undefined ? { secrets } : {}),
      ...(timeoutSecs !== undefined ? { timeoutSecs } : {}),
      ...(args["detach"] === true ? { detach: true } : {}),
      ...(ctx?.agentId !== undefined ? { agentId: ctx.agentId } : {}),
      ...(ctx?.sessionId !== undefined ? { sessionId: ctx.sessionId } : {}),
      ...(ctx?.origin !== undefined ? { origin: ctx.origin } : {}),
      ...(ctx?.sandboxExtraRwPaths !== undefined
        ? {
            extraRwPaths: [
              ...ctx.sandboxExtraRwPaths,
              ...(ctx.masterSession?.listWriteGrants?.() ?? []),
            ],
          }
        : {}),
      // 完成时推一条通知（不触发新一轮推理；agent 可用 job_output 取增量输出）
      onExit: (meta) => {
        const icon = meta.status === "succeeded" ? "✅" : meta.status === "killed" ? "🛑" : "❌";
        void ctx?.onNotify?.(
          `${icon} 后台任务 ${meta.id}${meta.name !== undefined ? `（${meta.name}）` : ""} ${meta.status}` +
            `${meta.exitCode !== undefined && meta.exitCode !== null ? `（exit=${meta.exitCode}）` : ""}` +
            `${meta.note !== undefined ? `\n${meta.note}` : ""}\n用 job_output 查看输出。`
        );
      },
    });

    if (!res.ok) return res.reason;
    const m = res.meta;
    return [
      `已启动后台 job \`${m.id}\`${m.detached ? "（detached：服务重启后继续跑）" : ""}`,
      `pid=${m.pid ?? "?"}${m.note !== undefined ? ` · ${m.note}` : ""}`,
      `注入的变量（只列键名）：${m.envKeys.length > 0 ? m.envKeys.join(", ") : "（无额外）"}`,
      m.secretNames.length > 0 ? `按任务声明的密钥：${m.secretNames.join(", ")}` : "",
      "",
      `用 \`job_output({ job_id: "${m.id}" })\` 读输出，\`job_kill\` 终止。`,
    ]
      .filter((s) => s !== "")
      .join("\n");
  },
});

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "job_list",
      description: "List this agent's background jobs (running and finished), newest first.",
      parameters: {
        type: "object",
        properties: {
          status: {
            type: "string",
            enum: ["running", "succeeded", "failed", "killed", "interrupted"],
            description: "Only show jobs in this state",
          },
        },
        required: [],
      },
    },
  },
  execute: async (args, ctx) => {
    const status = args["status"] === undefined ? undefined : (String(args["status"]) as JobStatus);
    const metas = listJobs({
      ...(ctx?.agentId !== undefined ? { agentId: ctx.agentId } : {}),
      ...(status !== undefined ? { status } : {}),
    });
    if (metas.length === 0) {
      return status !== undefined ? `没有处于 ${status} 状态的后台 job。` : "还没有后台 job。";
    }
    return [`## 后台 Job（${metas.length}）`, "", ...metas.map(describe)].join("\n");
  },
});

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "job_status",
      description: "Show one background job in detail (status, pid, exit code, byte counts, note).",
      parameters: {
        type: "object",
        properties: { job_id: { type: "string", description: "Job id, e.g. job_1a2b3c4d" } },
        required: ["job_id"],
      },
    },
  },
  execute: async (args, ctx) => {
    const id = String(args["job_id"] ?? "");
    const meta = getJob(id);
    if (meta === undefined) return `错误：未找到 job ${id}。`;
    const denied = assertOwnJob(meta, ctx);
    if (denied !== null) return denied;
    return [
      "## Job " + meta.id,
      describe(meta),
      `开始：${meta.startedAt}${meta.endedAt !== undefined ? ` · 结束：${meta.endedAt}` : ""}`,
      `输出字节：stdout=${meta.bytes.stdout} stderr=${meta.bytes.stderr}`,
      `注入变量：${meta.envKeys.join(", ") || "（无）"}`,
    ].join("\n");
  },
});

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "job_output",
      description:
        "Read a background job's output INCREMENTALLY (from where you last read). Returns the new text " +
        "plus the cursor, so repeated calls show only fresh output. Finished jobs keep their logs on " +
        "disk, so you can still read them after a restart.",
      parameters: {
        type: "object",
        properties: {
          job_id: { type: "string", description: "Job id" },
          stream: {
            type: "string",
            enum: ["stdout", "stderr", "both"],
            description: "default both",
          },
          max_bytes: {
            type: "number",
            description: "Max bytes to return this call (default 65536)",
          },
        },
        required: ["job_id"],
      },
    },
  },
  execute: async (args, ctx) => {
    const id = String(args["job_id"] ?? "");
    const meta = getJob(id);
    const denied = assertOwnJob(meta, ctx);
    if (denied !== null) return denied;
    const stream =
      args["stream"] === undefined
        ? "both"
        : (String(args["stream"]) as "stdout" | "stderr" | "both");
    const maxBytes = typeof args["max_bytes"] === "number" ? args["max_bytes"] : undefined;
    const res = readJobOutput(id, stream, undefined, maxBytes);
    if (!res.ok) return `错误：${res.reason ?? "读取失败"}`;
    const text = res.text ?? "";
    const head =
      `[${id} ${res.meta?.status ?? "?"}] 增量输出 ${text.length} 字节` +
      `（游标 stdout=${res.cursor?.stdout ?? 0} stderr=${res.cursor?.stderr ?? 0}）`;
    return text === "" ? `${head}\n（暂无新输出）` : `${head}\n\n${text}`;
  },
});

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "job_kill",
      description:
        "Terminate a background job (kills the whole process group, so child processes die too). " +
        "Sends SIGTERM by default; pass signal=SIGKILL to force.",
      parameters: {
        type: "object",
        properties: {
          job_id: { type: "string", description: "Job id" },
          signal: { type: "string", enum: ["SIGTERM", "SIGKILL"], description: "default SIGTERM" },
        },
        required: ["job_id"],
      },
    },
  },
  execute: async (args, ctx) => {
    const id = String(args["job_id"] ?? "");
    const meta = getJob(id);
    const denied = assertOwnJob(meta, ctx);
    if (denied !== null) return denied;
    const signal = args["signal"] === "SIGKILL" ? "SIGKILL" : "SIGTERM";
    const res = killJob(id, signal);
    if (!res.ok) return `错误：${res.reason ?? "kill 失败"}`;
    return `已向 job ${id} 发送 ${signal}（进程组）。用 job_status 确认是否退出。`;
  },
});
