#!/usr/bin/env bun
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
import { bold, dim, cyan, red, closeRl } from "./ui.js";

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
  logs:        { description: logsDesc,        usage: logsUsage,        run: logsRun },
  completions: { description: completionsDesc, usage: completionsUsage, run: completionsRun },
};

// ── Tab 补全候选词表 ──────────────────────────────────────────────────────────

/** 每个命令的子命令列表，供 --complete 模式使用 */
const SUBCOMMANDS: Record<string, string[]> = {
  model:       ["show", "list", "set", "--all", "-a", "help"],
  config:      ["show", "edit", "path", "set", "help"],
  auth:        ["github", "status", "help"],
  status:      [],
  restart:     [],
  start:       [],
  chat:        ["list", "new"],
  agent:       ["list", "new", "show", "edit", "delete"],
  logs:        ["-f", "--follow", "-n", "help"],
  completions: ["bash", "zsh", "fish", "install", "help"],
};

const BACKENDS = ["daily", "code", "summarizer"];

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
  } else if (cmd === "completions" && sub === "install") {
    candidates = ["bash", "zsh", "fish"];
  } else {
    candidates = [];
  }

  if (candidates.length > 0) {
    process.stdout.write(candidates.join("\n") + "\n");
  }
}

// ── 帮助 ──────────────────────────────────────────────────────────────────────

function printHelp(): void {
  const maxUsage = Math.max(...Object.values(COMMANDS).map((c) => c.usage.length));

  console.log(`
${bold("tinyclaw CLI")}  —  配置与管理工具

${bold("用法：")}
  tinyclaw <command> [subcommand] [args...]

${bold("命令：")}`,
  );

  for (const [name, cmd] of Object.entries(COMMANDS)) {
    const padded = cmd.usage.padEnd(maxUsage + 2);
    console.log(`  ${cyan(padded)} ${dim(cmd.description)}`);
  }

  console.log(`
${bold("示例：")}
  tinyclaw model list              # 列出 Copilot 可用模型
  tinyclaw model set daily         # 交互式选择 daily 后端模型
  tinyclaw config show             # 显示当前配置（密钥脱敏）
  tinyclaw config set llm.backends.daily.model gpt-4o
  tinyclaw auth github             # 重新授权 GitHub Copilot
  tinyclaw status                  # 服务运行状态
  tinyclaw restart                 # 重启 tinyclaw
  tinyclaw completions install     # 安装 tab 补全（bash/zsh/fish）

${dim("每个命令支持 `help` 子命令查看详细说明，如：tinyclaw model help")}
  `);
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
