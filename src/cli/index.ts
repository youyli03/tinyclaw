#!/usr/bin/env bun
/**
 * tinyclaw CLI 全局配置入口
 *
 * 用法：bun run cli [command] [subcommand] [args...]
 *
 *   model show/list/set   LLM 模型管理
 *   config show/edit/set  配置文件管理
 *   auth github/status    认证管理
 *   status                运行状态概览
 *   restart               重启主服务
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
  model:   { description: modelDesc,   usage: modelUsage,   run: modelRun },
  config:  { description: configDesc,  usage: configUsage,  run: configRun },
  auth:    { description: authDesc,    usage: authUsage,    run: authRun },
  status:  { description: statusDesc,  usage: statusUsage,  run: statusRun },
  restart: { description: restartDesc, usage: restartUsage, run: restartRun },
};

// ── 帮助 ──────────────────────────────────────────────────────────────────────

function printHelp(): void {
  const maxUsage = Math.max(...Object.values(COMMANDS).map((c) => c.usage.length));

  console.log(`
${bold("tinyclaw CLI")}  —  配置与管理工具

${bold("用法：")}
  bun run cli <command> [subcommand] [args...]

${bold("命令：")}`,
  );

  for (const [name, cmd] of Object.entries(COMMANDS)) {
    const padded = cmd.usage.padEnd(maxUsage + 2);
    console.log(`  ${cyan(padded)} ${dim(cmd.description)}`);
  }

  console.log(`
${bold("示例：")}
  bun run cli model list              # 列出 Copilot 可用模型
  bun run cli model set daily         # 交互式选择 daily 后端模型
  bun run cli config show             # 显示当前配置（密钥脱敏）
  bun run cli config set llm.backends.daily.model gpt-4o
  bun run cli auth github             # 重新授权 GitHub Copilot
  bun run cli status                  # 服务运行状态
  bun run cli restart                 # 重启 tinyclaw

${dim("每个命令支持 `help` 子命令查看详细说明，如：bun run cli model help")}
  `);
}

// ── 主入口 ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const [, , cmdName, ...rest] = process.argv;

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
