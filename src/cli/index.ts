#!/usr/bin/env -S node --import tsx/esm
/**
 * tinyclaw CLI 全局配置入口
 *
 * 用法：tinyclaw [command] [subcommand] [args...]
 *
 *   model show/list/set   LLM 模型管理
 *   config show/edit/set  配置文件管理
 *   auth github/status    认证管理
 *   status                运行状态概览
 *   restart               重启主服务
 *   completions install   安装 tab 补全
 *   help                  显示帮助
 *
 * 设计原则
 * ──────────
 * - 每个命令是独立模块，导出 { description, usage, run(args) }
 * - 注册新命令只需在 COMMANDS 表中添加一行，无需修改其他代码
 * - 每个子命令模块自行处理 --help / -h / help 子参数
 */

import { run as modelRun, description as modelDesc, usage as modelUsage, subcommands as modelSubs } from "./commands/model.js";
import { run as configRun, description as configDesc, usage as configUsage, subcommands as configSubs } from "./commands/config.js";
import { run as authRun, description as authDesc, usage as authUsage, subcommands as authSubs } from "./commands/auth.js";
import { run as statusRun, description as statusDesc, usage as statusUsage } from "./commands/status.js";
import { run as restartRun, description as restartDesc, usage as restartUsage } from "./commands/restart.js";
import { run as completionsRun, description as completionsDesc, usage as completionsUsage, subcommands as completionsSubs } from "./commands/completions.js";
import { run as chatRun, description as chatDesc, usage as chatUsage, subcommands as chatSubs } from "./commands/chat.js";
import { run as startRun, description as startDesc, usage as startUsage } from "./commands/start.js";
import { run as logsRun, description as logsDesc, usage as logsUsage, subcommands as logsSubs } from "./commands/logs.js";
import { run as agentRun, description as agentDesc, usage as agentUsage, subcommands as agentSubs } from "./commands/agent.js";
import { run as cronRun, description as cronDesc, usage as cronUsage, subcommands as cronSubs } from "./commands/cron.js";
import { run as memoryRun, description as memoryDesc, usage as memoryUsage, subcommands as memorySubs } from "./commands/memory.js";
import { run as sessionRun, description as sessionDesc, usage as sessionUsage, subcommands as sessionSubs } from "./commands/session.js";
import { run as dbRun, description as dbDesc, usage as dbUsage, subcommands as dbSubs } from "./commands/db.js";
import { run as webRun, description as webDesc, usage as webUsage, subcommands as webSubs } from "./commands/web.js";
import { readFileSync, existsSync } from "node:fs";
import { parse as parseToml } from "smol-toml";
import { bold, dim, cyan, red, closeRl } from "./ui.js";
import { CONFIG_PATH } from "../config/writer.js";
import { ALL_CONFIG_KEYS } from "../config/schema-keys.js";

// ── 命令注册表 ────────────────────────────────────────────────────────────────

interface CommandModule {
  description: string;
  usage: string;
  run: (args: string[]) => Promise<void>;
  /** 该命令支持的子命令列表，用于 tab 补全自动汇聚 */
  subcommands?: readonly string[];
}

/**
 * 注册表：key 为命令名，value 为命令模块。
 * 添加新命令只需在此处插入一行。
 */
const COMMANDS: Record<string, CommandModule> = {
  model:       { description: modelDesc,       usage: modelUsage,       run: modelRun,       subcommands: modelSubs },
  config:      { description: configDesc,      usage: configUsage,      run: configRun,      subcommands: configSubs },
  auth:        { description: authDesc,        usage: authUsage,        run: authRun,        subcommands: authSubs },
  status:      { description: statusDesc,      usage: statusUsage,      run: statusRun },
  restart:     { description: restartDesc,     usage: restartUsage,     run: restartRun },
  start:       { description: startDesc,       usage: startUsage,       run: startRun },
  chat:        { description: chatDesc,        usage: chatUsage,        run: chatRun,        subcommands: chatSubs },
  agent:       { description: agentDesc,       usage: agentUsage,       run: agentRun,       subcommands: agentSubs },
  cron:        { description: cronDesc,        usage: cronUsage,        run: cronRun,        subcommands: cronSubs },
  memory:      { description: memoryDesc,      usage: memoryUsage,      run: memoryRun,      subcommands: memorySubs },
  session:     { description: sessionDesc,     usage: sessionUsage,     run: sessionRun,     subcommands: sessionSubs },
  logs:        { description: logsDesc,        usage: logsUsage,        run: logsRun,        subcommands: logsSubs },
  db:          { description: dbDesc,          usage: dbUsage,          run: dbRun,          subcommands: dbSubs },
  web:         { description: webDesc,         usage: webUsage,         run: webRun,         subcommands: webSubs },
  completions: { description: completionsDesc, usage: completionsUsage, run: completionsRun, subcommands: completionsSubs },
};

// ── Tab 补全候选词表 ──────────────────────────────────────────────────────────

/**
 * 每个命令的子命令列表，从 COMMANDS 注册表自动汇聚。
 * 各命令模块通过 export const subcommands = [...] 声明，无需在此手动维护。
 */
function buildSubcommands(): Record<string, readonly string[]> {
  return Object.fromEntries(
    Object.entries(COMMANDS)
      .filter(([, m]) => m.subcommands && m.subcommands.length > 0)
      .map(([k, m]) => [k, m.subcommands!])
  );
}

const SUBCOMMANDS: Record<string, readonly string[]> = buildSubcommands();

const BACKENDS = ["daily", "code", "summarizer"];

/**
 * 返回所有 config 字段的 dot-path 列表（供 tab 补全用）。
 * 优先使用 ConfigSchema 生成的全量路径（含默认值字段），
 * 再合并 config.toml 里实际写入的键（可能有 schema 外的自定义键）。
 */
function flatConfigKeys(): string[] {
  // 从 schema 得到全量键（含未写入 TOML 的默认值字段）
  const keySet = new Set<string>(ALL_CONFIG_KEYS);

  // 合并 TOML 文件里已有的键
  try {
    if (existsSync(CONFIG_PATH)) {
      const raw = parseToml(readFileSync(CONFIG_PATH, "utf-8")) as Record<string, unknown>;

      function walk(obj: unknown, prefix: string): void {
        if (obj === null || Array.isArray(obj) || typeof obj !== "object") {
          if (prefix) keySet.add(prefix);
          return;
        }
        for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
          const full = prefix ? `${prefix}.${k}` : k;
          keySet.add(full);
          if (v !== null && typeof v === "object" && !Array.isArray(v)) {
            walk(v, full);
          }
        }
      }

      walk(raw, "");
    }
  } catch {
    // TOML 解析失败时退化为纯 schema 键
  }

  return [...keySet];
}

/**
 * --complete 模式：根据已输入的 words（不含 'tinyclaw'），输出补全候选词（每行一个）。
 * Shell 脚本通过 compgen -W 过滤前缀，此处输出全量候选即可。
 */
function outputCompletions(words: string[]): void {
  // 最后一个 word 是当前正在输入的（可能为空字符串）
  // 之前的 words 是已完成的上下文
  const prev = words.slice(0, -1);
  const cmd = prev[0];
  const sub = prev[1];

  let candidates: string[];

  if (!cmd) {
    // 补全命令名
    candidates = Object.keys(COMMANDS);
  } else if (!sub) {
    // 补全子命令
    candidates = [...(SUBCOMMANDS[cmd] ?? [])];
  } else if (cmd === "model" && (sub === "list" || sub === "set")) {
    // 补全 backend 名
    candidates = BACKENDS;
  } else if (cmd === "config" && (sub === "get" || sub === "set")) {
    // config get/set 第三个参数：补全 dot-path 配置键
    // （config set 第四个参数是值，不补全）
    const argIdx = prev.length - 2; // prev = [cmd, sub, ...args]
    if (argIdx === 0) {
      candidates = flatConfigKeys();
    } else {
      candidates = [];
    }
  } else if (cmd === "completions" && sub === "install") {
    candidates = ["bash", "zsh", "fish"];
  } else if (cmd === "chat" && sub === "loop") {
    candidates = ["list", "show", "enable", "disable", "trigger", "set"];
  } else if (cmd === "agent" && sub === "access") {
    candidates = ["show", "set", "add", "clear"];
  } else {
    candidates = [];
  }

  if (candidates.length > 0) {
    process.stdout.write(candidates.join("\n") + "\n");
  }
}

// ── 帮助 ──────────────────────────────────────────────────────────────────────

function printHelp(): void {
  const maxName = Math.max(...Object.keys(COMMANDS).map((n) => n.length));

  console.log(`
${bold("tinyclaw CLI")}  —  配置与管理工具

${bold("用法：")}
  tinyclaw <command> [subcommand] [args...]
  tinyclaw <command> -h            查看该命令的子命令列表
  tinyclaw <command> <sub> -h      查看子命令的完整参数说明

${bold("命令：")}`,
  );

  for (const [name, cmd] of Object.entries(COMMANDS)) {
    const padded = name.padEnd(maxName + 2);
    console.log(`  ${cyan(padded)} ${dim(cmd.description)}`);
  }

  console.log();
}

// ── 主入口 ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const [, , cmdName, ...rest] = process.argv;

  // ── --complete 模式（供 shell completion 调用，不打印 UI） ────────────────
  if (cmdName === "--complete") {
    outputCompletions(rest);
    return;
  }

  if (!cmdName || cmdName === "help" || cmdName === "--help" || cmdName === "-h") {
    printHelp();
    return;
  }

  const cmd = COMMANDS[cmdName];
  if (!cmd) {
    console.error(red(`未知命令 "${cmdName}"`));
    printHelp();
    process.exit(1);
  }

  try {
    await cmd.run(rest);
  } catch (err) {
    // 顶层异常：打印友好错误而不是崩溃
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n${red("✗ 错误：")} ${msg}`);
    if (process.env["DEBUG"]) {
      console.error(err);
    } else {
      console.error(dim("  设置 DEBUG=1 可查看完整堆栈"));
    }
    process.exitCode = 1;
  } finally {
    closeRl();
  }
}

main();
