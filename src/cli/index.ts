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

import { run as modelRun, description as modelDesc, usage as modelUsage } from "./commands/model.js";
import { run as configRun, description as configDesc, usage as configUsage } from "./commands/config.js";
import { run as authRun, description as authDesc, usage as authUsage } from "./commands/auth.js";
import { run as statusRun, description as statusDesc, usage as statusUsage } from "./commands/status.js";
import { run as restartRun, description as restartDesc, usage as restartUsage } from "./commands/restart.js";
import { run as completionsRun, description as completionsDesc, usage as completionsUsage } from "./commands/completions.js";
import { run as chatRun, description as chatDesc, usage as chatUsage } from "./commands/chat.js";
import { run as startRun, description as startDesc, usage as startUsage } from "./commands/start.js";
import { run as logsRun, description as logsDesc, usage as logsUsage } from "./commands/logs.js";
import { run as agentRun, description as agentDesc, usage as agentUsage } from "./commands/agent.js";
import { run as cronRun, description as cronDesc, usage as cronUsage } from "./commands/cron.js";
import { run as memoryRun, description as memoryDesc, usage as memoryUsage } from "./commands/memory.js";
import { run as sessionRun, description as sessionDesc, usage as sessionUsage } from "./commands/session.js";
import { readFileSync, existsSync } from "node:fs";
import { parse as parseToml } from "smol-toml";
import { bold, dim, cyan, red, closeRl } from "./ui.js";
import { CONFIG_PATH } from "../config/writer.js";

// ── 命令注册表 ────────────────────────────────────────────────────────────────

interface CommandModule {
  description: string;
  usage: string;
  run: (args: string[]) => Promise<void>;
}

/**
 * 注册表：key 为命令名，value 为命令模块。
 * 添加新命令只需在此处插入一行。
 */
const COMMANDS: Record<string, CommandModule> = {
  model:       { description: modelDesc,       usage: modelUsage,       run: modelRun },
  config:      { description: configDesc,      usage: configUsage,      run: configRun },
  auth:        { description: authDesc,        usage: authUsage,        run: authRun },
  status:      { description: statusDesc,      usage: statusUsage,      run: statusRun },
  restart:     { description: restartDesc,     usage: restartUsage,     run: restartRun },
  start:       { description: startDesc,       usage: startUsage,       run: startRun },
  chat:        { description: chatDesc,        usage: chatUsage,        run: chatRun },
  agent:       { description: agentDesc,       usage: agentUsage,       run: agentRun },
  cron:        { description: cronDesc,        usage: cronUsage,        run: cronRun },
  memory:      { description: memoryDesc,      usage: memoryUsage,      run: memoryRun },
  session:     { description: sessionDesc,     usage: sessionUsage,     run: sessionRun },
  logs:        { description: logsDesc,        usage: logsUsage,        run: logsRun },
  completions: { description: completionsDesc, usage: completionsUsage, run: completionsRun },
};

// ── Tab 补全候选词表 ──────────────────────────────────────────────────────────

/** 每个命令的子命令列表，供 --complete 模式使用 */
const SUBCOMMANDS: Record<string, string[]> = {
  model:       ["show", "list", "set", "--all", "-a", "help"],
  config:      ["show", "get", "edit", "path", "set", "help"],
  auth:        ["github", "status", "mfa-setup", "help"],
  status:      [],
  restart:     [],
  start:       [],
  chat:        ["list", "new", "loop", "-s", "--agent", "-a", "help"],
  agent:       ["list", "new", "show", "edit", "delete", "repair", "perm", "access", "memoryonly"],
  cron:        ["list", "add", "remove", "enable", "disable", "run", "logs", "help"],
  memory:      ["save", "list", "search", "index", "maintain", "help"],
  session:     ["list", "abort", "memory", "help"],
  logs:        ["-f", "--follow", "-n", "help"],
  completions: ["bash", "zsh", "fish", "install", "help"],
};

const BACKENDS = ["daily", "code", "summarizer"];

/**
 * 读取 config.toml，返回所有叶子节点的 dot-path 列表（供 tab 补全用）。
 * 数组项不展开，仅返回 object 类型的叶子键。
 */
function flatConfigKeys(): string[] {
  try {
    if (!existsSync(CONFIG_PATH)) return [];
    const raw = parseToml(readFileSync(CONFIG_PATH, "utf-8")) as Record<string, unknown>;
    const keys: string[] = [];

    function walk(obj: unknown, prefix: string): void {
      if (obj === null || Array.isArray(obj) || typeof obj !== "object") {
        if (prefix) keys.push(prefix);
        return;
      }
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        const full = prefix ? `${prefix}.${k}` : k;
        if (v !== null && typeof v === "object" && !Array.isArray(v)) {
          // 中间路径（对象节点）也加入，方便 `get llm.backends` 等
          keys.push(full);
          walk(v, full);
        } else {
          keys.push(full);
        }
      }
    }

    walk(raw, "");
    return keys;
  } catch {
    return [];
  }
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
    candidates = SUBCOMMANDS[cmd] ?? [];
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
