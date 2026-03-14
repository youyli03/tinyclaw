/**
 * CLI 命令：config
 *
 * 子命令：
 *   config show           格式化显示当前配置（密钥脱敏）
 *   config edit           用 $EDITOR 打开配置文件（fallback: nano → vi）
 *   config path           打印配置文件路径
 *   config set <key> <v>  修改单个字段（dotted path，如 llm.backends.daily.model）
 */

import * as fs from "node:fs";
import * as os from "node:os";
import { execSync, spawnSync } from "node:child_process";
import { parse } from "smol-toml";
import { ConfigSchema } from "../../config/schema.js";
import { CONFIG_PATH, patchTomlField } from "../../config/writer.js";
import { printTable, prompt, bold, dim, green, red, yellow, cyan, section } from "../ui.js";

// ── 脱敏辅助 ──────────────────────────────────────────────────────────────────

function mask(s: string): string {
  if (s.length <= 8) return "***";
  return s.slice(0, 4) + "…" + s.slice(-4);
}

// ── 子命令 ────────────────────────────────────────────────────────────────────

async function cmdShow(): Promise<void> {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.log(red(`配置文件不存在：${CONFIG_PATH}`));
    console.log(dim("请先运行 tinyclaw 以自动生成，或从 config.example.toml 复制"));
    return;
  }

  let raw: unknown;
  try {
    raw = parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  } catch (e) {
    console.log(red(`配置解析失败：${e}`));
    return;
  }

  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${red("✗")} ${i.path.join(".")}: ${i.message}`).join("\n");
    console.log(`\n${yellow("⚠ 配置验证失败")}（以下字段有问题）：\n${issues}`);
    console.log(dim("\n以下为原始内容："));
  }

  // ── LLM 后端 ────────────────────────────────────────────────────────────────
  section("LLM 后端");
  const llm = (raw as any)?.llm?.backends ?? {};
  for (const [name, b] of Object.entries(llm) as [string, any][]) {
    if (!b) continue;
    console.log(`\n  ${bold(`[${name}]`)}`);
    if (b.provider === "copilot") {
      console.log(`    provider     = ${cyan("copilot")}`);
      console.log(`    githubToken  = ${dim(mask(String(b.githubToken ?? "")))}`);
      console.log(`    model        = ${cyan(String(b.model ?? "auto"))}`);
    } else {
      console.log(`    provider     = openai-compatible`);
      console.log(`    baseUrl      = ${b.baseUrl ?? "-"}`);
      console.log(`    apiKey       = ${dim(mask(String(b.apiKey ?? "")))}`);
      console.log(`    model        = ${cyan(String(b.model ?? "-"))}`);
      if (b.maxTokens) console.log(`    maxTokens    = ${b.maxTokens}`);
    }
  }

  // ── Auth ─────────────────────────────────────────────────────────────────────
  section("Auth");
  const mfa = (raw as any)?.auth?.mfa;
  if (mfa) {
    console.log(`  tenantId    = ${dim(mask(String(mfa.tenantId ?? "")))}`);
    console.log(`  clientId    = ${dim(mask(String(mfa.clientId ?? "")))}`);
    console.log(`  timeoutSecs = ${mfa.timeoutSecs ?? 60}`);
  }

  // ── Channels ─────────────────────────────────────────────────────────────────
  section("Channels");
  const qqbot = (raw as any)?.channels?.qqbot;
  if (qqbot) {
    console.log(`  QQBot:`);
    console.log(`    appId          = ${dim(mask(String(qqbot.appId ?? "")))}`);
    console.log(`    clientSecret   = ${dim(mask(String(qqbot.clientSecret ?? "")))}`);
    console.log(`    allowFrom      = [${((qqbot.allowFrom as string[]) ?? []).join(", ")}]`);
    console.log(`    markdownSupport= ${qqbot.markdownSupport ?? true}`);
  } else {
    console.log(`  ${dim("(未配置)")}`);
  }

  // ── Memory ───────────────────────────────────────────────────────────────────
  section("Memory");
  const mem = (raw as any)?.memory;
  if (mem) {
    console.log(`  embedModel     = ${String(mem.embedModel ?? "-")}`);
    console.log(`  tokenThreshold = ${mem.tokenThreshold ?? 0.8}`);
    console.log(`  contextWindow  = ${mem.contextWindow ?? 128000}`);
  }

  console.log(`\n${dim(`配置文件：${CONFIG_PATH}`)}`);
}

async function cmdEdit(): Promise<void> {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.log(red(`配置文件不存在：${CONFIG_PATH}`));
    return;
  }

  const editor =
    process.env["EDITOR"] ??
    process.env["VISUAL"] ??
    (spawnSync("which", ["nano"], { encoding: "utf-8" }).stdout.trim() ? "nano" : "vi");

  console.log(dim(`使用编辑器：${editor}`));
  spawnSync(editor, [CONFIG_PATH], { stdio: "inherit" });
}

async function cmdPath(): Promise<void> {
  console.log(CONFIG_PATH);
  if (fs.existsSync(CONFIG_PATH)) {
    const stat = fs.statSync(CONFIG_PATH);
    console.log(dim(`  大小：${stat.size} bytes  修改时间：${stat.mtime.toLocaleString()}`));
  } else {
    console.log(yellow("  （文件不存在）"));
  }
}

/**
 * config set <dotted.key.path> <value>
 *
 * 支持 dotted path，如：
 *   llm.backends.daily.model          → [llm.backends.daily] model
 *   llm.backends.daily.maxTokens      → [llm.backends.daily] maxTokens
 *   channels.qqbot.markdownSupport    → [channels.qqbot] markdownSupport
 *
 * value 类型自动推断：
 *   "true"/"false" → 布尔；纯整数 → 数字；其余 → 字符串（加引号写入 TOML）
 */
async function cmdSet(args: string[]): Promise<void> {
  if (args.length < 2) {
    console.log(red("用法：config set <dotted.key> <value>"));
    console.log(dim("示例：config set llm.backends.daily.model gpt-4o"));
    return;
  }

  const dotPath = args[0]!;
  const rawVal = args[1]!;

  // 将 dotted path 拆分为 sectionPath + key
  const parts = dotPath.split(".");
  if (parts.length < 2) {
    console.error(red("key 路径至少需要包含 section 和字段名，如 llm.backends.daily.model"));
    return;
  }

  const key = parts.pop()!;
  const sectionPath = parts;

  // 自动推断 TOML 值类型
  let tomlValue: string;
  if (rawVal === "true" || rawVal === "false") {
    tomlValue = rawVal;
  } else if (/^\d+$/.test(rawVal)) {
    tomlValue = rawVal;
  } else {
    tomlValue = JSON.stringify(rawVal);
  }

  patchTomlField(sectionPath, key, tomlValue);
  console.log(`${green("✓")} [${sectionPath.join(".")}] ${key} = ${cyan(tomlValue)}`);
}

// ── 帮助 ──────────────────────────────────────────────────────────────────────

function printHelp(): void {
  console.log(`
${bold("用法：")}
  config show                  格式化显示当前配置（密钥脱敏）
  config edit                  用 $EDITOR 打开配置文件
  config path                  打印配置文件路径
  config set <key> <value>     修改配置字段

${bold("示例：")}
  config set llm.backends.daily.model gpt-4o
  config set llm.backends.daily.maxTokens 8192
  config set channels.qqbot.markdownSupport false
`);
}

// ── 命令入口 ──────────────────────────────────────────────────────────────────

export const description = "配置管理：查看 / 编辑 / 修改配置字段";
export const usage = "config <show|edit|path|set> [args]";

export async function run(args: string[]): Promise<void> {
  const sub = args[0] ?? "show";
  const rest = args.slice(1);

  switch (sub) {
    case "show":  return cmdShow();
    case "edit":  return cmdEdit();
    case "path":  return cmdPath();
    case "set":   return cmdSet(rest);
    case "--help":
    case "-h":
    case "help":  printHelp(); return;
    default:
      console.error(red(`未知子命令 "${sub}"`));
      printHelp();
  }
}
