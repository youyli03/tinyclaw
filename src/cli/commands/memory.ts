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

export const description = "管理 Agent 长期记忆（摘要、搜索、向量索引）";
export const usage = "memory <save|list|search|index> [options]";

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

// ── help ─────────────────────────────────────────────────────────────────────

function printHelp(): void {
  console.log(`
${bold("用法：")}
  memory save [sessionId]            整理并向量化指定 session 的历史对话
  memory list [-a <agentId>]         列出所有记忆文件及条目数
  memory search <query> [-a <agentId>] [-n <N>]  搜索记忆（验证 QMD 工作正常）
  memory index [-a <agentId>]        手动重建 QMD 向量索引

${bold("选项：")}
  -a, --agent <id>    指定 agent（默认 default）
  -n <N>              search 结果数量（默认 5）

${bold("说明：")}
  save 命令连接运行中的 tinyclaw 服务，对指定 session 执行：
    LLM 摘要 → memory/YYYY-MM/YYYY-MM-DD.md → QMD 增量索引
  同时向 qqbot session 绑定的 QQ 用户发送开始/完成通知。
`);
}

// ── 命令入口 ──────────────────────────────────────────────────────────────────

export async function run(args: string[]): Promise<void> {
  const sub = args[0] ?? "help";

  switch (sub) {
    case "save":  await cmdSave(args.slice(1)); break;
    case "list":  cmdList(args.slice(1)); break;
    case "search": await cmdSearch(args.slice(1)); break;
    case "index": await cmdIndex(args.slice(1)); break;
    case "--help":
    case "-h":
    case "help":
    default:
      printHelp();
  }
  closeRl();
}
