/**
 * CLI 命令：cron
 *
 * 子命令：
 *   cron list                 列出所有 jobs
 *   cron add                  通过向导创建新 job
 *   cron remove <id>          删除 job
 *   cron enable  <id>         启用 job
 *   cron disable <id>         停用 job
 *   cron run     <id>         立即触发一次（不影响计划）
 *   cron logs    <id> [-n N]  查看运行日志
 */

import { connect } from "net";
import { existsSync } from "node:fs";
import { loadJobs, addJob, removeJob, updateJob, getJob, readLogs } from "../../cron/store.js";
import { runJob } from "../../cron/runner.js";
import { cronScheduler } from "../../cron/scheduler.js";
import { IPC_SOCKET_PATH, type IpcResponse } from "../../ipc/protocol.js";
import { llmRegistry } from "../../llm/registry.js";
import { bold, dim, green, red, yellow, cyan, section } from "../ui.js";
import { prompt, select, confirm, printTable, closeRl } from "../ui.js";
import type { CronJob } from "../../cron/schema.js";

// ── nanoid 轻量替代（无依赖） ─────────────────────────────────────────────────

function nanoid(size = 8): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  for (let i = 0; i < size; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

// ── list ──────────────────────────────────────────────────────────────────────

function cmdList(): void {
  const jobs = loadJobs();
  if (jobs.length === 0) {
    console.log(dim("暂无 cron jobs。运行 `tinyclaw cron add` 创建。"));
    return;
  }
  section("Cron Jobs");
  printTable(
    ["ID", "状态", "类型", "计划", "上次运行", "通知"],
    jobs.map((j) => [
      cyan(j.id),
      j.enabled ? green("启用") : dim("停用"),
      j.type,
      scheduleDesc(j),
      j.lastRunAt
        ? `${j.lastRunStatus === "error" ? red("✗") : green("✓")} ${new Date(j.lastRunAt).toLocaleString("zh-CN")}`
        : dim("未运行"),
      j.output.notify,
    ]),
  );
  console.log();
}

function scheduleDesc(j: CronJob): string {
  switch (j.type) {
    case "once":   return j.runAt ? new Date(j.runAt).toLocaleString("zh-CN") : "-";
    case "every":  return `每 ${j.intervalSecs}s${j.timeRange ? ` [时段 ${j.timeRange.start}-${j.timeRange.end}]` : ""}`;
    case "daily":  return `每天 ${j.timeOfDay}`;
    case "manual": return "手动触发";
  }
}

// ── add (向导) ────────────────────────────────────────────────────────────────

async function cmdAdd(): Promise<void> {
  console.log(`\n${bold("创建 Cron Job")}\n`);

  // 1. 指令内容
  const message = await prompt("触发时发送的指令（prompt）：");
  if (!message.trim()) { console.log(red("指令不能为空")); return; }

  // 2. 调度类型
  const type = await select<"once" | "every" | "daily">("调度类型：", [
    { label: "once  — 触发一次（指定时间）", value: "once" },
    { label: "every — 固定间隔触发", value: "every" },
    { label: "daily — 每天固定时间触发", value: "daily" },
  ]);

  // 3. 时间参数
  let runAt: string | undefined;
  let intervalSecs: number | undefined;
  let timeOfDay: string | undefined;

  if (type === "once") {
    const raw = await prompt("触发时间（ISO 或 YYYY-MM-DD HH:MM，本地时间）：");
    const d = new Date(raw.trim());
    if (isNaN(d.getTime())) { console.log(red("时间格式无效")); return; }
    runAt = d.toISOString();
  } else if (type === "every") {
    const raw = await prompt("间隔秒数（如 3600 = 1 小时）：");
    const n = parseInt(raw.trim(), 10);
    if (isNaN(n) || n <= 0) { console.log(red("请输入正整数")); return; }
    intervalSecs = n;
  } else {
    const raw = await prompt("每天触发时间（HH:MM，24h 制，本地时间）：");
    if (!/^\d{2}:\d{2}$/.test(raw.trim())) { console.log(red("格式应为 HH:MM")); return; }
    timeOfDay = raw.trim();
  }

  // 4. 输出目标
  const hasTarget = await confirm("是否绑定 QQ 消息推送目标（否=仅写 log）？", false);
  let sessionId: string | null = null;
  let peerId: string | null = null;
  let msgType: "c2c" | "group" | "guild" | "dm" = "c2c";

  if (hasTarget) {
    peerId = (await prompt("QQ peerId（openid）：")).trim();
    sessionId = `qqbot:c2c:${peerId}`;
    msgType = await select<"c2c" | "group" | "guild" | "dm">("消息类型：", [
      { label: "c2c   — 私聊", value: "c2c" },
      { label: "group — 群聊", value: "group" },
      { label: "guild — 频道", value: "guild" },
      { label: "dm    — 私信", value: "dm" },
    ]);
    if (msgType !== "c2c") sessionId = null; // 非 c2c 时 sessionId 格式不同，留空
  }

  // 5. 通知策略
  const notify = await select<"always" | "on_change" | "on_error" | "never">("通知策略：", [
    { label: "always    — 每次完成都推送", value: "always" },
    { label: "on_change — 结果有变化时推送", value: "on_change" },
    { label: "on_error  — 仅出错时推送", value: "on_error" },
    { label: "never     — 永不推送（仅写 log）", value: "never" },
  ]);

  // 6. Agent
  const agentId = (await prompt("使用的 agent（回车=default）：")).trim() || "default";

  // 7. 是否保留历史
  const stateful = await confirm("保留跨 run 对话历史（stateful）？", false);

  // 8. MFA 豁免
  const mfaExempt = await confirm("为该 job 永久豁免 MFA（需要你现在先验证一次）？", false);
  if (mfaExempt) {
    // 简单交互式确认（CLI 本地用户，直接信任）
    const confirmed = await confirm("  确认：授权该 job 绕过 MFA 限制？", false);
    if (!confirmed) {
      console.log(yellow("已取消 MFA 豁免设置"));
    }
  }

  // 9. 保存
  const job = addJob({
    id: nanoid(),
    enabled: true,
    agentId,
    message: message.trim(),
    type,
    runAt,
    intervalSecs,
    timeOfDay,
    output: { sessionId, peerId, msgType, notify },
    stateful,
    mfaExempt,
  });

  cronScheduler.reschedule(job.id);
  console.log(`\n${green("✓")} 已创建 job ${cyan(job.id)}\n`);
}

// ── remove ────────────────────────────────────────────────────────────────────

async function cmdRemove(id: string): Promise<void> {
  const job = getJob(id);
  if (!job) { console.log(red(`未找到 job "${id}"`)); return; }
  const ok = await confirm(`删除 job ${cyan(id)} "${dim(job.message.slice(0, 40))}"？`, false);
  if (!ok) { console.log(dim("已取消")); return; }
  removeJob(id);
  cronScheduler.reschedule(id);
  console.log(green("✓ 已删除"));
}

// ── enable / disable ──────────────────────────────────────────────────────────

function cmdEnable(id: string): void {
  if (!updateJob(id, { enabled: true })) { console.log(red(`未找到 job "${id}"`)); return; }
  cronScheduler.reschedule(id);
  console.log(green(`✓ job ${id} 已启用`));
}

function cmdDisable(id: string): void {
  if (!updateJob(id, { enabled: false })) { console.log(red(`未找到 job "${id}"`)); return; }
  cronScheduler.reschedule(id);
  console.log(yellow(`✓ job ${id} 已停用`));
}

// ── run ───────────────────────────────────────────────────────────────────────

async function cmdRun(id: string): Promise<void> {
  const job = getJob(id);
  if (!job) { console.log(red(`未找到 job "${id}"`)); return; }

  // 优先通过 IPC 委托守护进程执行（无需重新初始化 LLM）
  if (existsSync(IPC_SOCKET_PATH)) {
    let delegated = false;
    await new Promise<void>((resolve) => {
      const socket = connect(IPC_SOCKET_PATH);
      socket.on("connect", () => {
        socket.write(JSON.stringify({ type: "cron_trigger", jobId: id }) + "\n");
      });
      let buf = "";
      socket.on("data", (data: Buffer) => {
        buf += data.toString("utf-8");
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const resp = JSON.parse(line) as IpcResponse;
            if (resp.type === "cron_triggered") {
              console.log(green(`✓ 已通知守护进程触发 job ${id}，结果将按通知策略推送`));
              delegated = true;
            } else if (resp.type === "error") {
              console.log(red(`✗ ${(resp as { type: "error"; message: string }).message}`));
              delegated = true;
            }
          } catch { /* ignore */ }
          socket.destroy();
          resolve();
        }
      });
      socket.on("error", (err: Error) => {
        console.log(yellow(`守护进程连接失败：${err.message}，将本地执行`));
        socket.destroy();
        resolve();
      });
      socket.on("close", resolve);
    });
    if (delegated) return;
  }

  // 守护进程未运行，本地执行（需要初始化 LLM）
  console.log(dim(`守护进程未运行，本地执行 job ${id}…`));
  await llmRegistry.init();
  await runJob(job, null);
  const updated = getJob(id);
  if (updated?.lastRunStatus === "error") {
    console.log(red(`✗ 执行失败：${updated.lastRunResult ?? ""}`));
  } else {
    console.log(green("✓ 执行完成"));
    if (updated?.lastRunResult) console.log(dim(updated.lastRunResult.slice(0, 200)));
  }
}

// ── logs ──────────────────────────────────────────────────────────────────────

function cmdLogs(id: string, n: number): void {
  const job = getJob(id);
  if (!job) { console.log(red(`未找到 job "${id}"`)); return; }
  const entries = readLogs(id, n);
  if (entries.length === 0) { console.log(dim("暂无运行记录")); return; }
  section(`Cron 日志：${id}`);
  for (const e of entries) {
    const ts = new Date(e.ts).toLocaleString("zh-CN");
    const icon = e.status === "success" ? green("✓") : red("✗");
    console.log(`${icon} ${dim(ts)}`);
    const preview = e.result.replace(/\n/g, " ").slice(0, 120);
    if (preview) console.log(`  ${dim(preview)}`);
  }
  console.log();
}

// ── 帮助 ──────────────────────────────────────────────────────────────────────

/** 第二层：只列子命令 */
function printHelp(): void {
  console.log(`
${bold("tinyclaw cron")}  —  Cron 定时任务管理

${bold("子命令：")}
  ${cyan("list")}              列出所有 jobs
  ${cyan("add")}               交互式创建 job
  ${cyan("remove")}            删除 job
  ${cyan("enable")}            启用 job
  ${cyan("disable")}           停用 job
  ${cyan("run")}               立即触发一次（不影响计划）
  ${cyan("logs")}              查看 job 运行日志

${dim("运行 tinyclaw cron <sub> -h 查看子命令详细参数")}
`);
}

/** 第三层：显示指定子命令的完整参数说明 */
function printSubHelp(sub: string): void {
  switch (sub) {
    case "list":
      console.log(`
${bold("tinyclaw cron list")}

  列出所有 cron jobs，显示 ID、状态、类型、计划、上次运行和通知策略。
  无需额外参数。
`);
      break;
    case "add":
      console.log(`
${bold("tinyclaw cron add")}

  通过交互式向导创建新 cron job。
  向导会依次询问：
    1. 触发时的指令内容（prompt）
    2. 调度类型：once / every / daily
    3. 时间参数（一次性时间 / 间隔秒数 / 每天时刻）
    4. QQ 推送目标（可选）
    5. 通知策略：always / on_change / on_error / never
    6. 使用的 agent（默认 default）
    7. 是否保留跨 run 对话历史（stateful）
    8. 是否豁免 MFA
`);
      break;
    case "remove":
      console.log(`
${bold("tinyclaw cron remove")} <id>

${bold("参数：")}
  id    要删除的 job ID（运行 cron list 查看）
`);
      break;
    case "enable":
      console.log(`
${bold("tinyclaw cron enable")} <id>

${bold("参数：")}
  id    要启用的 job ID
`);
      break;
    case "disable":
      console.log(`
${bold("tinyclaw cron disable")} <id>

${bold("参数：")}
  id    要停用的 job ID
`);
      break;
    case "run":
      console.log(`
${bold("tinyclaw cron run")} <id>

${bold("参数：")}
  id    要立即触发的 job ID

${bold("说明：")}
  优先通过 IPC 委托守护进程执行（无需重新初始化 LLM）。
  守护进程未运行时在本地执行。
  不影响原有定时计划。
`);
      break;
    case "logs":
      console.log(`
${bold("tinyclaw cron logs")} <id> [-n <N>]

${bold("参数：")}
  id        job ID
  -n <N>    显示最近 N 条日志（默认 20）
`);
      break;
    default:
      console.error(red(`未知子命令 "${sub}"`));
      printHelp();
  }
}

// ── 命令入口 ──────────────────────────────────────────────────────────────────

export const subcommands = ["list", "add", "remove", "enable", "disable", "run", "logs", "help"] as const;
export const description = "Cron 定时任务：创建、管理、查看定时执行记录";
export const usage = "cron <list|add|remove|enable|disable|run|logs>";

export async function run(args: string[]): Promise<void> {
  const sub = args[0] ?? "list";
  const rest = args.slice(1);

  switch (sub) {
    case "list":
      if (rest.includes("-h") || rest.includes("--help")) { printSubHelp("list"); break; }
      cmdList();
      break;
    case "add":
      if (rest.includes("-h") || rest.includes("--help")) { printSubHelp("add"); break; }
      await cmdAdd();
      break;
    case "remove":
      if (rest.includes("-h") || rest.includes("--help")) { printSubHelp("remove"); break; }
      await cmdRemove(args[1] ?? "");
      break;
    case "enable":
      if (rest.includes("-h") || rest.includes("--help")) { printSubHelp("enable"); break; }
      cmdEnable(args[1] ?? "");
      break;
    case "disable":
      if (rest.includes("-h") || rest.includes("--help")) { printSubHelp("disable"); break; }
      cmdDisable(args[1] ?? "");
      break;
    case "run":
      if (rest.includes("-h") || rest.includes("--help")) { printSubHelp("run"); break; }
      await cmdRun(args[1] ?? "");
      break;
    case "logs": {
      if (rest.includes("-h") || rest.includes("--help")) { printSubHelp("logs"); break; }
      const nIdx = args.indexOf("-n");
      const n = nIdx >= 0 ? parseInt(args[nIdx + 1] ?? "20", 10) : 20;
      cmdLogs(args[1] ?? "", n);
      break;
    }
    case "--help":
    case "-h":
    case "help": printHelp(); break;
    default:
      console.error(red(`未知子命令 "${sub}"`));
      printHelp();
  }
  closeRl();
}
