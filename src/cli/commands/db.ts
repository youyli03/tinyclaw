/**
 * CLI 命令: db
 *
 * 管理 Dashboard 指标白名单（metric_keys 表）。
 *
 * 子命令:
 *   db list                              列出所有已注册指标
 *   db add <category>/<key> [描述]       注册新指标
 *   db remove <category>/<key>           删除指标及其历史数据
 */

import { bold, dim, green, red, cyan, section, printTable, closeRl } from "../ui.js";
import {
  addMetricKey,
  removeMetricKey,
  listRegisteredKeys,
} from "../../web/backend/db.js";

export const subcommands = ["list", "add", "remove", "help"] as const;
export const description = "管理 Dashboard 指标白名单";
export const usage = `tinyclaw db <subcommand> [args]

子命令:
  list                         列出所有已注册指标
  add <category>/<key> [描述]  注册新指标（允许 db_write 写入）
  remove <category>/<key>      删除指标及其全部历史数据

示例:
  tinyclaw db list
  tinyclaw db add electric/balance 电费余额
  tinyclaw db add stock/index 沪深300指数
  tinyclaw db remove stock/index`;

export async function run(args: string[]): Promise<void> {
  const sub = args[0]?.toLowerCase();

  if (!sub || sub === "list") {
    cmdList();
    closeRl();
    return;
  }

  if (sub === "add") {
    cmdAdd(args.slice(1));
    closeRl();
    return;
  }

  if (sub === "remove" || sub === "rm") {
    cmdRemove(args.slice(1));
    closeRl();
    return;
  }

  if (sub === "help" || sub === "--help" || sub === "-h") {
    console.log(usage);
    closeRl();
    return;
  }

  console.error(red(`未知子命令: ${sub}`));
  console.error(dim("用法: tinyclaw db list | add | remove"));
  process.exit(1);
}

// ── list ──────────────────────────────────────────────────────────────────────

function cmdList(): void {
  const keys = listRegisteredKeys();
  section("Dashboard 指标白名单");
  if (!keys.length) {
    console.log(dim("  暂无已注册指标"));
    console.log(dim("  使用 tinyclaw db add <category>/<key> [描述] 添加"));
    return;
  }
  printTable(
    ["分类", "指标键", "描述", "注册时间"],
    keys.map(k => [
      cyan(k.category),
      bold(k.key),
      k.description ?? dim("—"),
      new Date(k.created_at * 1000).toLocaleString("zh-CN"),
    ])
  );
  console.log(dim(`\n共 ${keys.length} 个指标`));
}

// ── add ───────────────────────────────────────────────────────────────────────

function cmdAdd(args: string[]): void {
  const slug = args[0];
  if (!slug) {
    console.error(red("缺少参数，用法: tinyclaw db add <category>/<key> [描述]"));
    process.exit(1);
  }
  if (!slug.includes("/")) {
    console.error(red(`格式错误: "${slug}"，需要 <category>/<key>（如 electric/balance）`));
    process.exit(1);
  }

  const slashIdx = slug.indexOf("/");
  const category = slug.slice(0, slashIdx);
  const key      = slug.slice(slashIdx + 1);
  const description = args.slice(1).join(" ") || undefined;

  if (!category || !key) {
    console.error(red("category 和 key 不能为空"));
    process.exit(1);
  }

  try {
    addMetricKey(category, key, description);
    console.log(green(`✓ 已注册指标 ${bold(`${category}/${key}`)}`) +
      (description ? dim(`  (${description})`) : ""));
  } catch (e) {
    console.error(red(`注册失败: ${String(e)}`));
    process.exit(1);
  }
}

// ── remove ────────────────────────────────────────────────────────────────────

function cmdRemove(args: string[]): void {
  const slug = args[0];
  if (!slug) {
    console.error(red("缺少参数，用法: tinyclaw db remove <category>/<key>"));
    process.exit(1);
  }
  if (!slug.includes("/")) {
    console.error(red(`格式错误: "${slug}"，需要 <category>/<key>`));
    process.exit(1);
  }

  const slashIdx = slug.indexOf("/");
  const category = slug.slice(0, slashIdx);
  const key      = slug.slice(slashIdx + 1);

  try {
    const { deleted } = removeMetricKey(category, key);
    console.log(green(`✓ 已删除指标 ${bold(`${category}/${key}`)}`) +
      (deleted > 0 ? dim(`，同时清除历史数据 ${deleted} 条`) : ""));
  } catch (e) {
    console.error(red(`删除失败: ${String(e)}`));
    process.exit(1);
  }
}
