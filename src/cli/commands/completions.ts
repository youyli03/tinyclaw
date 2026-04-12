/**
 * CLI 命令：completions
 *
 * 生成并安装 shell tab 补全脚本。
 *
 * 子命令：
 *   completions bash              打印 bash 补全代码（eval 用）
 *   completions zsh               打印 zsh 补全代码（eval 用）
 *   completions fish              打印 fish 补全代码
 *   completions install [shell]   自动检测 shell，追加 eval 行到 rc 文件
 *
 * 用户安装示例：
 *   tinyclaw completions install
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { bold, dim, green, red, yellow, cyan, confirm } from "../ui.js";

// 项目根目录（相对于本文件：src/cli/commands/ → ../../..）
const PROJECT_ROOT = path.resolve(
  import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
  "../../.."
);

// CLI 入口脚本绝对路径
const CLI_ENTRY = path.join(PROJECT_ROOT, "src", "cli", "index.ts");

// ── 脚本模板 ──────────────────────────────────────────────────────────────────

/**
 * Bash 补全脚本。
 * 通过 `bun <entry> --complete <words>` 动态获取候选词。
 */
function bashScript(): string {
  return `# tinyclaw bash completion
# 由 \`tinyclaw completions bash\` 生成
# 安装：在 ~/.bashrc 末尾添加：
#   eval "$(tinyclaw completions bash)"

_tinyclaw_complete() {
    local cur="\${COMP_WORDS[COMP_CWORD]}"
    local -a words=("\${COMP_WORDS[@]:1}")
    local IFS=$'\\n'
    COMPREPLY=($(compgen -W "$(bun "${CLI_ENTRY}" --complete "\${words[@]}" 2>/dev/null)" -- "$cur"))
}

complete -o nosort -F _tinyclaw_complete tinyclaw
alias tinyclaw='bun "${CLI_ENTRY}"'
`;
}

/**
 * Zsh 补全脚本。
 * 通过 `compdef` 注册，candidate 仍走 --complete 机制。
 */
function zshScript(): string {
  return `# tinyclaw zsh completion
# 由 \`tinyclaw completions zsh\` 生成
# 安装：在 ~/.zshrc 末尾添加：
#   eval "$(tinyclaw completions zsh)"

_tinyclaw_complete() {
    local -a words=(\${words[2,-1]})
    local -a completions
    completions=(\${(f)"$(bun "${CLI_ENTRY}" --complete \${words[@]} 2>/dev/null)"})
    compadd -a completions
}

compdef _tinyclaw_complete tinyclaw
alias tinyclaw='bun "${CLI_ENTRY}"'
`;
}

/**
 * Fish shell 补全脚本。
 * Fish 使用 `complete -c` 声明式注册；通过 `--complete` 标志实现动态补全。
 */
function fishScript(): string {
  return `# tinyclaw fish completion
# 由 \`tinyclaw completions fish\` 生成
# 安装：保存到 ~/.config/fish/completions/tinyclaw.fish
# 或运行：tinyclaw completions fish > ~/.config/fish/completions/tinyclaw.fish

alias tinyclaw='bun "${CLI_ENTRY}"'

function __tinyclaw_complete
    set -l words (commandline -opc)
    set -l cur (commandline -ct)
    set -e words[1]  # 移除 'tinyclaw'
    bun "${CLI_ENTRY}" --complete $words $cur 2>/dev/null
end

complete -c tinyclaw -f -a '(__tinyclaw_complete)'
`;
}

// ── 安装逻辑 ──────────────────────────────────────────────────────────────────

type ShellType = "bash" | "zsh" | "fish";

function detectShell(): ShellType {
  const shell = process.env["SHELL"] ?? "";
  if (shell.includes("zsh")) return "zsh";
  if (shell.includes("fish")) return "fish";
  return "bash";
}

function getRcFile(shell: ShellType): string {
  const home = os.homedir();
  switch (shell) {
    case "zsh":  return path.join(home, ".zshrc");
    case "fish": return path.join(home, ".config", "fish", "completions", "tinyclaw.fish");
    default:     return path.join(home, ".bashrc");
  }
}

function getEvalLine(shell: ShellType): string {
  const flag = shell === "bash" ? "bash" : shell === "zsh" ? "zsh" : "fish";
  return `eval "$(tinyclaw completions ${flag})"`;
}

async function install(shellArg: string | undefined): Promise<void> {
  const shell: ShellType = (shellArg as ShellType | undefined) ?? detectShell();
  if (!["bash", "zsh", "fish"].includes(shell)) {
    console.error(red(`不支持的 shell："${shell}"，可选：bash / zsh / fish`));
    return;
  }

  const rcFile = getRcFile(shell as ShellType);

  if (shell === "fish") {
    // Fish: 直接写独立文件，而非 eval
    const dir = path.dirname(rcFile);
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(rcFile)) {
      const skip = !(await confirm(`${rcFile} 已存在，覆盖？`, false));
      if (skip) { console.log(dim("已取消")); return; }
    }
    fs.writeFileSync(rcFile, fishScript(), "utf-8");
    console.log(`${green("✓")} 已写入 ${rcFile}`);
    console.log(dim("  重新打开终端后生效，或运行：source ~/.config/fish/config.fish"));
    return;
  }

  // Bash / Zsh: 追加 eval 行
  const evalLine = getEvalLine(shell as ShellType);
  const marker = "# tinyclaw completion";

  let existing = "";
  if (fs.existsSync(rcFile)) {
    existing = fs.readFileSync(rcFile, "utf-8");
  }

  if (existing.includes(evalLine) || existing.includes("tinyclaw completion")) {
    console.log(yellow(`${rcFile} 中已存在 tinyclaw 补全配置，跳过安装`));
    console.log(dim(`  若需更新，请手动编辑 ${rcFile}`));
    return;
  }

  const append = `\n${marker}\n${evalLine}\n`;
  fs.appendFileSync(rcFile, append, "utf-8");
  console.log(`${green("✓")} 已将补全配置追加到 ${rcFile}`);
  console.log(dim(`\n  执行以下命令立即生效（或重新打开终端）：`));
  console.log(`  ${cyan(`source ${rcFile}`)}`);
}

// ── 子命令 ────────────────────────────────────────────────────────────────────

/** 第二层：只列子命令 */
function printHelp(): void {
  console.log(`
${bold("tinyclaw completions")}  —  Shell Tab 补全

${bold("子命令：")}
  ${cyan("bash")}              输出 bash 补全脚本
  ${cyan("zsh")}               输出 zsh 补全脚本
  ${cyan("fish")}              输出 fish 补全脚本
  ${cyan("install")}           自动安装到 shell rc 文件

${dim("运行 tinyclaw completions <sub> -h 查看子命令详细说明")}
`);
}

/** 第三层：显示指定子命令的完整参数说明 */
function printSubHelp(sub: string): void {
  switch (sub) {
    case "bash":
      console.log(`
${bold("tinyclaw completions bash")}

  输出 bash 补全脚本（用于 eval 安装）。

${bold("手动安装：")}
  在 ~/.bashrc 末尾添加：
    eval "$(tinyclaw completions bash)"
  然后运行：source ~/.bashrc
`);
      break;
    case "zsh":
      console.log(`
${bold("tinyclaw completions zsh")}

  输出 zsh 补全脚本（用于 eval 安装）。

${bold("手动安装：")}
  在 ~/.zshrc 末尾添加：
    eval "$(tinyclaw completions zsh)"
  然后运行：source ~/.zshrc
`);
      break;
    case "fish":
      console.log(`
${bold("tinyclaw completions fish")}

  输出 fish 补全脚本。

${bold("手动安装：")}
  tinyclaw completions fish > ~/.config/fish/completions/tinyclaw.fish
`);
      break;
    case "install":
      console.log(`
${bold("tinyclaw completions install")} [bash|zsh|fish]

${bold("参数：")}
  shell    目标 shell（可省略，省略时根据 \$SHELL 自动检测）
           可选：bash | zsh | fish

${bold("说明：")}
  bash/zsh：将 eval 行追加到 ~/.bashrc 或 ~/.zshrc
  fish：将脚本写入 ~/.config/fish/completions/tinyclaw.fish
  安装后重新打开终端或 source rc 文件即可生效。
`);
      break;
    default:
      console.error(red(`未知子命令 "${sub}"`));
      printHelp();
  }
}

// ── 命令入口 ──────────────────────────────────────────────────────────────────

export const subcommands = ["bash", "zsh", "fish", "install", "help"] as const;
export const description = "生成并安装 shell tab 补全脚本（bash/zsh/fish）";
export const usage = "completions <bash|zsh|fish|install>";

export async function run(args: string[]): Promise<void> {
  const sub = args[0];

  if (!sub || sub === "--help" || sub === "-h" || sub === "help") {
    printHelp(); return;
  }

  const rest = args.slice(1);
  const wantsHelp = rest.includes("-h") || rest.includes("--help");

  switch (sub) {
    case "bash":
      if (wantsHelp) { printSubHelp("bash"); return; }
      process.stdout.write(bashScript()); return;
    case "zsh":
      if (wantsHelp) { printSubHelp("zsh"); return; }
      process.stdout.write(zshScript()); return;
    case "fish":
      if (wantsHelp) { printSubHelp("fish"); return; }
      process.stdout.write(fishScript()); return;
    case "install":
      if (wantsHelp) { printSubHelp("install"); return; }
      return install(args[1]);
    default:
      console.error(red(`未知子命令 "${sub}"`));
      printHelp();
  }
}
