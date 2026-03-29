/**
 * CLI 命令：memory
 *
 * 用法：
 *   memory save [sessionId]      手动触发 session 摘要 → 持久化 → QMD 向量化
 *   memory list [-a <agentId>]   列出所有记忆文件（memory/YYYY-MM/）
 *   memory search <query>        [-a <agentId>] [-n <N>]  搜索记忆（验证 QMD）
 *   memory index [-a <agentId>]  手动重建 QMD 向量索引
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { bold, dim, green, red, cyan, yellow, section } from "../ui.js";
import { listSessions, memorizeSession } from "../../ipc/client.js";
import { searchMemory, updateMemoryIndex, rebuildMemoryIndex, type UpdateProgress, type EmbedProgress } from "../../memory/qmd.js";
import { loadConfig } from "../../config/loader.js";
import { select, closeRl } from "../ui.js";
import { memoryMaintenance } from "../../core/memory-maintenance.js";
import { agentManager } from "../../core/agent-manager.js";

export const description = "管理 Agent 长期记忆（摘要、搜索、向量索引）";
export const usage = "memory <save|list|search|index|maintain> [options]";

function parseAgent(args: string[]): { agentId: string; rest: string[] } {
  const idx = args.findIndex((a) => a === "-a" || a === "--agent");
  if (idx !== -1 && args[idx + 1]) {
    const agentId = args[idx + 1]!;
    const rest = args.filter((_, i) => i !== idx && i !== idx + 1);
    return { agentId, rest };
  }
  return { agentId: "default", rest: args };
}

function memoryBaseDir(agentId: string): string {
  return path.join(os.homedir(), ".tinyclaw", "agents", agentId, "memory");
}

// ── save ─────────────────────────────────────────────────────────────────────

async function cmdSave(args: string[]): Promise<void> {
  let sessionId = args[0];

  if (!sessionId) {
    // 从服务获取 session 列表，交互选择
    let sessions;
    try {
      sessions = await listSessions();
    } catch {
      console.error(red("无法连接到 tinyclaw 服务，请先运行 tinyclaw start"));
      return;
    }
    if (sessions.length === 0) {
      console.log(yellow("当前没有活跃的 session。"));
      return;
    }
    sessionId = await select<string>(
      "选择要整理的 session：",
      sessions.map((s) => ({
        label: `${cyan(s.sessionId.slice(-20))}  ${dim(s.lastUserMessage || "(无消息)")}  [${s.messageCount} 条]`,
        value: s.sessionId,
      }))
    );
  }

  console.log(`\n${dim("正在整理记忆...")} sessionId: ${cyan(sessionId)}\n`);

  let summary: string;
  try {
    summary = await memorizeSession(sessionId);
  } catch (err) {
    console.error(red(`记忆整理失败：${err instanceof Error ? err.message : String(err)}`));
    return;
  }

  section("记忆整理完成");
  console.log(summary);
  console.log();
}

// ── list ─────────────────────────────────────────────────────────────────────

function cmdList(args: string[]): void {
  const { agentId, rest } = parseAgent(args);
  void rest;
  const baseDir = memoryBaseDir(agentId);

  if (!fs.existsSync(baseDir)) {
    console.log(yellow(`暂无记忆文件。（路径：${baseDir}）`));
    return;
  }

  section(`记忆文件 — agent: ${agentId}`);

  // 遍历 YYYY-MM 子目录
  const months = fs.readdirSync(baseDir)
    .filter((d) => /^\d{4}-\d{2}$/.test(d))
    .sort();

  if (months.length === 0) {
    console.log(dim("暂无记忆文件。"));
    return;
  }

  let total = 0;
  for (const month of months) {
    const monthDir = path.join(baseDir, month);
    const files = fs.readdirSync(monthDir).filter((f) => f.endsWith(".md")).sort();
    console.log(`\n${bold(month)}`);
    for (const file of files) {
      const fullPath = path.join(monthDir, file);
      const content = fs.readFileSync(fullPath, "utf-8");
      // 粗估条目数：以 "## " 开头的行数
      const count = (content.match(/^## /gm) ?? []).length;
      total += count;
      console.log(`  ${green("✓")} ${file}  ${dim(`${count} 条摘要`)}`);
    }
  }

  console.log(`\n${dim(`共 ${total} 条摘要记录`)}\n`);
}

// ── search ───────────────────────────────────────────────────────────────────

async function cmdSearch(args: string[]): Promise<void> {
  const { agentId, rest } = parseAgent(args);

  const nIdx = rest.findIndex((a) => a === "-n");
  let limit = 5;
  let queryArgs = rest;
  if (nIdx !== -1 && rest[nIdx + 1]) {
    limit = parseInt(rest[nIdx + 1]!, 10) || 5;
    queryArgs = rest.filter((_, i) => i !== nIdx && i !== nIdx + 1);
  }

  const query = queryArgs.join(" ").trim();
  if (!query) {
    console.error(red("用法：memory search <query> [-a agentId] [-n N]"));
    return;
  }

  console.log(`\n${dim(`搜索：${query}  agent: ${agentId}  top-${limit}`)}\n`);

  const result = await searchMemory(query, agentId, limit);
  if (result === null || result === undefined) {
    console.log(yellow("向量记忆功能未启用，请在 config.toml 中设置 [memory] enabled = true"));
    return;
  }
  if (result === "") {
    console.log(yellow("没有找到相关记忆（索引可能为空，请先运行 memory index 或 memory save）"));
    return;
  }

  section("搜索结果");
  console.log(result);
  console.log();
}

// ── index ────────────────────────────────────────────────────────────────────

async function cmdIndex(args: string[]): Promise<void> {
  const { agentId } = parseAgent(args);
  if (!loadConfig().memory.enabled) {
    console.log(yellow("向量记忆功能未启用，请在 config.toml 中设置 [memory] enabled = true"));
    return;
  }
  console.log(`\n${dim(`重建向量索引... agent: ${agentId}`)}\n`);
  const t0 = Date.now();

  // 阶段 1：扫描文件
  process.stdout.write(`${dim("阶段 1/2  扫描文件...")}\n`);
  let lastUpdateTotal = 0;
  const onUpdate = (info: UpdateProgress) => {
    lastUpdateTotal = info.total;
    const pct = info.total > 0 ? Math.round((info.current / info.total) * 100) : 0;
    const filled = Math.floor(pct / 5);
    const bar = "█".repeat(filled) + "░".repeat(20 - filled);
    process.stdout.write(
      `\r  ${bar} ${String(info.current).padStart(String(info.total).length)}/${info.total}  ${dim(info.file.slice(-50))}`
    );
  };

  // 阶段 2：生成 embedding（首次回调时打印标题）
  let embedHeaderPrinted = false;
  const onEmbed = (info: EmbedProgress) => {
    if (!embedHeaderPrinted) {
      embedHeaderPrinted = true;
      process.stdout.write(`\n${dim("阶段 2/2  生成向量...")}\n`);
    }
    const pct = info.totalChunks > 0 ? Math.round((info.chunksEmbedded / info.totalChunks) * 100) : 100;
    const filled = Math.floor(pct / 5);
    const bar = "█".repeat(filled) + "░".repeat(20 - filled);
    process.stdout.write(
      `\r  ${bar} ${info.chunksEmbedded}/${info.totalChunks} chunks  ${dim(Math.round(info.bytesProcessed / 1024) + "KB")}`
    );
  };

  const result = await rebuildMemoryIndex(agentId, onUpdate, onEmbed);

  if (!result) {
    console.log(yellow("向量记忆功能未启用"));
    return;
  }

  if (lastUpdateTotal > 0) process.stdout.write("\n");
  if (embedHeaderPrinted) process.stdout.write("\n");

  const ms = Date.now() - t0;
  console.log(`\n${green("✅ 索引已更新")}  耗时 ${ms}ms`);
  console.log(
    dim(`  文件：已索引 ${result.update.indexed}  更新 ${result.update.updated}  未变 ${result.update.unchanged}  移除 ${result.update.removed}`)
  );
  console.log(
    dim(`  向量：${result.embed.chunksEmbedded} chunks  文档 ${result.embed.docsProcessed}  耗时 ${result.embed.durationMs}ms`)
  );
  console.log();
}

// ── maintain ──────────────────────────────────────────────────────────────────

async function cmdMaintain(args: string[]): Promise<void> {
  // 解析 --all flag 和 --agent/-a <id>
  const hasAll = args.includes("--all");
  const { agentId, rest } = parseAgent(args.filter((a) => a !== "--all"));
  void rest;

  // 若显式指定了 -a <id>（且无 --all），只处理该 agent；否则处理全部
  const hasAgentFlag = args.some((a) => a === "-a" || a === "--agent");
  const targetId: string | undefined = (!hasAll && hasAgentFlag) ? agentId : undefined;

  if (targetId) {
    section(`记忆维护 — agent: ${targetId}`);
    console.log(dim("Step 1: 重建向量索引..."));
    console.log(dim("Step 2: 提炼 diary → MEM.md..."));
    console.log();
    await memoryMaintenance.runNow(targetId);
    console.log(`\n${green("✅ 维护完成")}  agent: ${cyan(targetId)}\n`);
  } else {
    const agents = agentManager.loadAll();
    section(`记忆维护 — 全部 agent（${agents.length} 个）`);
    console.log(dim(`处理：${agents.map((a) => a.id).join(", ")}\n`));
    await memoryMaintenance.runNow();
    console.log(`\n${green("✅ 全部维护完成")}\n`);
  }
}

// ── help ─────────────────────────────────────────────────────────────────────

/** 第二层：只列子命令 */
function printHelp(): void {
  console.log(`
${bold("tinyclaw memory")}  —  Agent 长期记忆管理

${bold("子命令：")}
  ${cyan("save")}              整理并向量化指定 session 的历史对话
  ${cyan("list")}              列出所有记忆文件及条目数
  ${cyan("search")}            搜索记忆内容（验证 QMD）
  ${cyan("index")}             手动重建 QMD 向量索引
  ${cyan("maintain")}          立即执行一次记忆维护（索引重建 + diary 提炼）

${dim("运行 tinyclaw memory <sub> -h 查看子命令详细参数")}
`);
}

/** 第三层：显示指定子命令的完整参数说明 */
function printSubHelp(sub: string): void {
  switch (sub) {
    case "save":
      console.log(`
${bold("tinyclaw memory save")} [sessionId]

${bold("参数：")}
  sessionId    要整理的 session ID（可省略，省略时交互式选择）

${bold("说明：")}
  连接运行中的 tinyclaw 服务，对指定 session 执行：
    LLM 摘要 → memory/YYYY-MM/YYYY-MM-DD.md → QMD 增量索引
  同时向绑定的 QQ 用户发送开始/完成通知。
`);
      break;
    case "list":
      console.log(`
${bold("tinyclaw memory list")} [-a <agentId>]

${bold("选项：")}
  -a, --agent <id>    指定 agent（默认 default）

${bold("说明：")}
  遍历 memory/YYYY-MM/ 目录，列出所有记忆文件及摘要条目数。
`);
      break;
    case "search":
      console.log(`
${bold("tinyclaw memory search")} <query> [-a <agentId>] [-n <N>]

${bold("参数：")}
  query               搜索关键词（支持自然语言）

${bold("选项：")}
  -a, --agent <id>    指定 agent（默认 default）
  -n <N>              返回结果数量（默认 5）
`);
      break;
    case "index":
      console.log(`
${bold("tinyclaw memory index")} [-a <agentId>]

${bold("选项：")}
  -a, --agent <id>    指定 agent（默认 default）

${bold("说明：")}
  全量重建 QMD 向量索引，分两阶段：
    阶段 1：扫描文件，检测变更
    阶段 2：生成 embedding（增量，跳过未变更文件）
  需在 config.toml 中设置 [memory] enabled = true。
`);
      break;
    case "maintain":
      console.log(`
${bold("tinyclaw memory maintain")} [-a <agentId> | --all]

${bold("选项：")}
  -a, --agent <id>    只处理指定 agent
  --all               处理全部 agent（与不传 -a 等价）

${bold("说明：")}
  在 CLI 进程中直接执行（无需 tinyclaw 服务运行）：
    Step 1：QMD 向量索引全量重建
    Step 2：近期 diary → MEM.md 增量知识提炼（summarizer LLM）
`);
      break;
    default:
      console.error(red(`未知子命令 "${sub}"`));
      printHelp();
  }
}

// ── 命令入口 ──────────────────────────────────────────────────────────────────

export async function run(args: string[]): Promise<void> {
  const sub = args[0] ?? "help";
  const rest = args.slice(1);

  switch (sub) {
    case "save":
      if (rest.includes("-h") || rest.includes("--help")) { printSubHelp("save"); break; }
      await cmdSave(rest);
      break;
    case "list":
      if (rest.includes("-h") || rest.includes("--help")) { printSubHelp("list"); break; }
      cmdList(rest);
      break;
    case "search":
      if (rest.includes("-h") || rest.includes("--help")) { printSubHelp("search"); break; }
      await cmdSearch(rest);
      break;
    case "index":
      if (rest.includes("-h") || rest.includes("--help")) { printSubHelp("index"); break; }
      await cmdIndex(rest);
      break;
    case "maintain":
      if (rest.includes("-h") || rest.includes("--help")) { printSubHelp("maintain"); break; }
      await cmdMaintain(rest);
      break;
    case "--help":
    case "-h":
    case "help":
    default:
      printHelp();
  }
  closeRl();
}
