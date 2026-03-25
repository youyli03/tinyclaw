/**
 * CLI 命令：config
 *
 * 子命令：
 *   config show           格式化显示当前配置（密钥脱敏）
 *   config edit           用 $EDITOR 打开配置文件（fallback: nano → vi）
 *   config path           打印配置文件路径
 *   config get <key>      读取指定配置项（dot path）
 *   config set <key> <v>  修改单个字段（dotted path，如 llm.backends.daily.model）
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { parse } from "smol-toml";
import { ConfigSchema } from "../../config/schema.js";
import { CONFIG_PATH, patchTomlField } from "../../config/writer.js";
import { loadMemStoresConfig, loadMcpConfig } from "../../config/loader.js";
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

  // 使用已解析并带默认值的数据（若解析失败则回退到 raw）
  const cfg = parsed.success ? parsed.data : undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r = raw as any;

  // ── Providers ─────────────────────────────────────────────────────────────
  section("Providers（凭证）");
  const providers = r?.providers ?? {};
  if (providers.openai) {
    const p = providers.openai;
    console.log(`  ${bold("[openai]")}`);
    console.log(`    baseUrl    = ${p.baseUrl ?? "https://api.openai.com/v1"}`);
    console.log(`    apiKey     = ${dim(mask(String(p.apiKey ?? "")))}`);
    console.log(`    maxTokens  = ${p.maxTokens ?? 4096}`);
    console.log(`    timeoutMs  = ${p.timeoutMs ?? 120000}`);
  }
  if (providers.copilot) {
    const p = providers.copilot;
    console.log(`  ${bold("[copilot]")}`);
    const tok = String(p.githubToken ?? "gh_cli");
    console.log(`    githubToken= ${tok === "gh_cli" || tok === "env" ? cyan(tok) : dim(mask(tok))}`);
    console.log(`    timeoutMs  = ${p.timeoutMs ?? 120000}`);
  }
  if (!providers.openai && !providers.copilot) {
    console.log(`  ${dim("(未配置任何 provider)")}`);
  }

  // ── LLM 后端 ────────────────────────────────────────────────────────────────
  section("LLM 后端");
  const backends = r?.llm?.backends ?? {};
  const roleNames = ["daily", "code", "summarizer"];
  for (const name of roleNames) {
    const b = backends[name];
    if (!b) {
      if (name !== "daily") {
        console.log(`\n  ${bold(`[${name}]`)} ${dim("(未配置，回退到 daily)")}`);
      }
      continue;
    }
    console.log(`\n  ${bold(`[${name}]`)}`);
    console.log(`    model          = ${cyan(String(b.model ?? "-"))}`);
    if (b.maxTokens !== undefined)  console.log(`    maxTokens      = ${b.maxTokens}`);
    if (b.timeoutMs !== undefined)  console.log(`    timeoutMs      = ${b.timeoutMs}`);
    if (b.supportsVision !== undefined) console.log(`    supportsVision = ${b.supportsVision}`);
  }

  // ── Auth / MFA ────────────────────────────────────────────────────────────
  section("Auth / MFA");
  const mfa = r?.auth?.mfa;
  if (mfa) {
    console.log(`  interface   = ${cyan(String(mfa.interface ?? "simple"))}`);
    console.log(`  timeoutSecs = ${mfa.timeoutSecs ?? 0}`);
    const mfaTools: string[] = mfa.tools ?? ["delete_file", "write_file"];
    console.log(`  tools       = [${mfaTools.join(", ")}]`);
    const patterns: string[] = mfa.exec_shell_patterns?.patterns ?? ["rm", "sudo", "chmod", "chown", "dd", "mv"];
    console.log(`  patterns    = [${patterns.join(", ")}]`);
    if (mfa.tenantId) console.log(`  tenantId    = ${dim(mask(String(mfa.tenantId)))}`);
    if (mfa.clientId) console.log(`  clientId    = ${dim(mask(String(mfa.clientId)))}`);
    if (mfa.totpSecretPath) console.log(`  totpSecretPath = ${mfa.totpSecretPath}`);
  } else {
    console.log(`  ${dim("(未配置 MFA，使用默认：interface=simple)")}`);
  }

  // ── Channels ─────────────────────────────────────────────────────────────
  section("Channels");
  const qqbot = r?.channels?.qqbot;
  if (qqbot) {
    console.log(`  ${bold("QQBot:")}`);
    console.log(`    appId            = ${dim(mask(String(qqbot.appId ?? "")))}`);
    console.log(`    clientSecret     = ${dim(mask(String(qqbot.clientSecret ?? "")))}`);
    console.log(`    allowFrom        = [${((qqbot.allowFrom as string[]) ?? []).join(", ")}]`);
    console.log(`    markdownSupport  = ${qqbot.markdownSupport ?? true}`);
    if (qqbot.imageServerBaseUrl) {
      console.log(`    imageServerBaseUrl = ${qqbot.imageServerBaseUrl}`);
      console.log(`    imageServerPort    = ${qqbot.imageServerPort ?? 18765}`);
    }
    if (qqbot.systemPrompt) {
      const preview = String(qqbot.systemPrompt).slice(0, 60);
      console.log(`    systemPrompt     = ${dim(preview + (qqbot.systemPrompt.length > 60 ? "…" : ""))}`);
    }
  } else {
    console.log(`  ${dim("(未配置)")}`);
  }

  // ── Memory ───────────────────────────────────────────────────────────────
  section("Memory");
  const mem = cfg?.memory ?? r?.memory;
  if (mem) {
    const enabledStr = mem.enabled ? green("true") : dim("false");
    console.log(`  enabled             = ${enabledStr}`);
    console.log(`  embedModel          = ${dim(String(mem.embedModel ?? "-"))}`);
    console.log(`  tokenThreshold      = ${mem.tokenThreshold ?? 0.8}`);
    console.log(`  contextWindow       = ${mem.contextWindow ?? 128000}`);
    console.log(`  hybridSearchEnabled = ${mem.hybridSearchEnabled ?? true}`);
    console.log(`  bm25Weight          = ${mem.bm25Weight ?? 0.3}`);
    console.log(`  decayHalfLifeDays   = ${mem.decayHalfLifeDays ?? 30}`);
    const eg: string[] = mem.evergreenPatterns ?? ["MEM.md", "MEMORY.md", "patterns.md"];
    console.log(`  evergreenPatterns   = [${eg.join(", ")}]`);
    console.log(`  mmrEnabled          = ${mem.mmrEnabled ?? true}`);
    console.log(`  mmrLambda           = ${mem.mmrLambda ?? 0.7}`);
    console.log(`  memorySafetyCheck   = ${mem.memorySafetyCheck ?? true}`);
  } else {
    console.log(`  ${dim("(使用默认值，memory 未在配置文件中定义)")}`);
  }

  // ── Tools ────────────────────────────────────────────────────────────────
  section("Tools");
  const tools = cfg?.tools ?? r?.tools;
  if (tools) {
    const ca = tools.code_assist ?? {};
    console.log(`  code_assist.backend        = ${cyan(String(ca.backend ?? "copilot"))}`);
    if (ca.model) console.log(`  code_assist.model          = ${ca.model}`);
    console.log(`  code_assist.maxCallsPerRun = ${ca.maxCallsPerRun ?? 5}`);
    console.log(`  maxCodeToolRounds          = ${tools.maxCodeToolRounds ?? 0}`);
    console.log(`  maxChatToolRounds          = ${tools.maxChatToolRounds ?? 0}`);
    console.log(`  maxToolResultChars         = ${tools.maxToolResultChars ?? 20000}`);
    console.log(`  maxToolCallArgChars        = ${tools.maxToolCallArgChars ?? 8000}`);
  } else {
    console.log(`  ${dim("(使用默认值)")}`);
  }

  // ── Agent 行为 ────────────────────────────────────────────────────────────
  section("Agent 行为");
  const agentCfg = cfg?.agent ?? r?.agent;
  if (agentCfg) {
    console.log(`  heartbeatIntervalSecs = ${agentCfg.heartbeatIntervalSecs ?? 120}`);
  } else {
    console.log(`  ${dim("(使用默认值：heartbeatIntervalSecs=120)")}`);
  }

  // ── Voice ─────────────────────────────────────────────────────────────────
  section("Voice（语音识别）");
  const voice = cfg?.voice ?? r?.voice;
  if (voice) {
    console.log(`  model    = ${cyan(String(voice.model ?? "small"))}`);
    console.log(`  language = ${voice.language ? String(voice.language) : dim("(自动检测)")}`);
  } else {
    console.log(`  ${dim("(使用默认值：model=small，自动检测语言)")}`);
  }

  // ── Retry ─────────────────────────────────────────────────────────────────
  section("Retry（重试策略）");
  const retry = cfg?.retry ?? r?.retry;
  if (retry) {
    console.log(`  maxAttempts         = ${retry.maxAttempts ?? -1}  ${dim("(-1 = 无限)")}`);
    console.log(`  max5xxAttempts      = ${retry.max5xxAttempts ?? 5}`);
    console.log(`  baseDelayMs         = ${retry.baseDelayMs ?? 1000}`);
    console.log(`  retry429            = ${retry.retry429 ?? true}`);
    console.log(`  retry5xx            = ${retry.retry5xx ?? true}`);
    console.log(`  retryTransport      = ${retry.retryTransport ?? true}`);
    console.log(`  retryTimeout        = ${retry.retryTimeout ?? false}`);
    console.log(`  streamIdleTimeoutMs = ${retry.streamIdleTimeoutMs ?? 60000}`);
    console.log(`  maxRetryDurationMs  = ${retry.maxRetryDurationMs ?? 0}  ${dim("(0 = 不限制)")}`);
  } else {
    console.log(`  ${dim("(使用默认值)")}`);
  }

  // ── MCP Servers ───────────────────────────────────────────────────────────
  const mcpTomlPath = path.join(os.homedir(), ".tinyclaw", "mcp.toml");
  section(`MCP Servers  ${dim(`(${mcpTomlPath})`)}`);
  if (!fs.existsSync(mcpTomlPath)) {
    console.log(`  ${dim("(mcp.toml 不存在，无 MCP server 配置)")}`);
  } else {
    try {
      const mcpCfg = loadMcpConfig();
      const servers = Object.entries(mcpCfg.servers);
      if (servers.length === 0) {
        console.log(`  ${dim("(无 server 定义)")}`);
      } else {
        const rows = servers.map(([name, srv]) => {
          const tag = srv.enabled !== false ? green("enabled") : dim("disabled");
          const transport = srv.transport;
          const endpoint = srv.transport === "stdio"
            ? dim(`${srv.command} ${srv.args?.join(" ") ?? ""}`.trim().slice(0, 60))
            : dim(srv.url ?? "");
          return [cyan(name), `[${tag}]`, transport, endpoint];
        });
        printTable(["Name", "Status", "Transport", "Command / URL"], rows);
        if (servers.some(([, s]) => s.description)) {
          console.log();
          for (const [name, srv] of servers) {
            if (srv.description) {
              console.log(`  ${cyan(name)}: ${dim(srv.description.slice(0, 80))}`);
            }
          }
        }
      }
    } catch (e) {
      console.log(`  ${red(`读取 mcp.toml 失败：${e}`)}`);
    }
  }

  // ── MemStores ─────────────────────────────────────────────────────────────
  const memstoresTomlPath = path.join(os.homedir(), ".tinyclaw", "memstores.toml");
  section(`MemStores  ${dim(`(${memstoresTomlPath})`)}`);
  if (!fs.existsSync(memstoresTomlPath)) {
    console.log(`  ${dim("(memstores.toml 不存在，无额外知识库配置)")}`);
  } else {
    try {
      const msCfg = loadMemStoresConfig();
      if (msCfg.stores.length === 0) {
        console.log(`  ${dim("(无 store 定义)")}`);
      } else {
        const rows = msCfg.stores.map((s) => {
          const tag = s.enabled ? green("enabled") : dim("disabled");
          return [cyan(s.name), `[${tag}]`, s.title, dim(s.path)];
        });
        printTable(["Name", "Status", "Title", "Path"], rows);
      }
    } catch (e) {
      console.log(`  ${red(`读取 memstores.toml 失败：${e}`)}`);
    }
  }

  console.log(`\n${dim(`主配置文件：${CONFIG_PATH}`)}`);
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

/** 敏感字段名，get 时自动隐藏 */
const SENSITIVE_KEYS = new Set(["apiKey", "clientSecret", "password", "secret", "githubToken"]);

/**
 * config get <dotted.key.path>
 *
 * 按 dot-path 读取已解析 config 的值，敏感字段自动脱敏。
 */
async function cmdGet(args: string[]): Promise<void> {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.log(red(`配置文件不存在：${CONFIG_PATH}`));
    return;
  }
  if (args.length === 0) {
    console.log(red("用法：config get <dotted.key>"));
    console.log(dim("示例：config get llm.backends.daily.model"));
    return;
  }

  const dotPath = args[0]!;
  const parts = dotPath.split(".");

  let raw: unknown;
  try {
    raw = parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  } catch (e) {
    console.log(red(`配置解析失败：${e}`));
    return;
  }

  // 按路径导航
  let cur: unknown = raw;
  for (const part of parts) {
    if (cur === null || typeof cur !== "object") {
      console.log(red(`配置项 "${dotPath}" 不存在（在 "${part}" 处路径断开）`));
      return;
    }
    cur = (cur as Record<string, unknown>)[part];
    if (cur === undefined) {
      console.log(red(`配置项 "${dotPath}" 不存在`));
      return;
    }
  }

  // 敏感字段脱敏
  const lastKey = parts[parts.length - 1]!;
  if (SENSITIVE_KEYS.has(lastKey)) {
    const str = typeof cur === "string" ? cur : JSON.stringify(cur);
    console.log(`${cyan(dotPath)} = ${dim(mask(str))}  ${yellow("(已脱敏)")}`);
    return;
  }

  // 对象类型展开显示
  if (typeof cur === "object" && cur !== null) {
    console.log(`${cyan(dotPath)} =`);
    console.log(JSON.stringify(cur, null, 2));
  } else {
    console.log(`${cyan(dotPath)} = ${green(String(cur))}`);
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
  config get <key>             读取指定配置项（dot path）
  config edit                  用 $EDITOR 打开配置文件
  config path                  打印配置文件路径
  config set <key> <value>     修改配置字段

${bold("示例：")}
  config get llm.backends.daily.model
  config set llm.backends.daily.model gpt-4o
  config set llm.backends.daily.maxTokens 8192
  config set channels.qqbot.markdownSupport false
`);
}

// ── 命令入口 ──────────────────────────────────────────────────────────────────

export const description = "配置管理：查看 / 读取 / 编辑 / 修改配置字段";
export const usage = "config <show|get|edit|path|set> [args]";

export async function run(args: string[]): Promise<void> {
  const sub = args[0] ?? "show";
  const rest = args.slice(1);

  switch (sub) {
    case "show":  return cmdShow();
    case "get":   return cmdGet(rest);
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
