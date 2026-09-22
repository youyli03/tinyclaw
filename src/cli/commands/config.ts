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
import { CONFIG_PATH, patchTomlField, readRawConfig, writeConfigText } from "../../config/writer.js";
import { formatConfigDiags, validateConfigText, type ConfigDiag } from "../../config/validate.js";
import {
  configStatePaths,
  readConfigState,
  currentConfigDigest,
  noteConfigWritten,
} from "../../config/state.js";
import { isSafeModeEnabled, safeModeFlagPath, setSafeMode } from "../../config/safe-mode.js";
import { reloadConfig } from "../../config/reload.js";
import { runOfflineHealthChecks, formatHealthReport } from "../../health/config-health.js";
import { agentManager } from "../../core/agent-manager.js";
import { loadMemStoresConfig, loadMcpConfigDetailed } from "../../config/loader.js";
import { formatDiagnostics, summarizeLoad } from "../../mcp/load-report.js";
import { printTable, prompt, bold, dim, green, red, yellow, cyan, section } from "../ui.js";
import { renderConfig } from "../../config/schema-display.js";
import { getFieldType } from "../../config/schema-keys.js";

// ── 脱敏辅助 ──────────────────────────────────────────────────────────────────

function mask(s: string): string {
  if (s.length <= 8) return "***";
  return s.slice(0, 4) + "…" + s.slice(-4);
}

/** 判断 agentId 是否存在（校验 `selfAccess.grantedAgents` 之类的授权列表用） */
function isKnownAgent(id: string): boolean {
  try {
    return agentManager.listAgentIds().includes(id);
  } catch {
    return true; // 读不到就当存在，避免误报
  }
}

/** 写入被校验拒绝时的统一输出 */
function reportWriteRejected(res: { diagnostics: ConfigDiag[]; rejectedPath: string }): void {
  console.error(red("✗ 配置未通过校验，已拒绝写入（config.toml 未被改动）："));
  for (const line of formatConfigDiags(res.diagnostics)) console.error(`  ${line}`);
  console.error(dim(`  被拒内容已留证：${res.rejectedPath}`));
}

/** 写入成功但有提示（warn）时统一输出 */
function reportWriteWarnings(res: { diagnostics: ConfigDiag[] }): void {
  for (const line of formatConfigDiags(res.diagnostics)) console.log(yellow(`  ${line}`));
}

// ── 子命令 ────────────────────────────────────────────────────────────────────

async function cmdShow(): Promise<void> {
  if (!fs.existsSync(CONFIG_PATH)) {
    console.log(red(`配置文件不存在:${CONFIG_PATH}`));
    console.log(dim("请先运行 tinyclaw 以自动生成,或从 config.example.toml 复制"));
    return;
  }

  let raw: unknown;
  try {
    raw = parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
  } catch (e) {
    console.log(red(`配置解析失败:${e}`));
    return;
  }

  const parsed = ConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  ${red("✗")} ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    console.log(`\n${yellow("⚠ 配置验证失败")}(以下字段有问题):\n${issues}`);
    console.log(dim("\n显示默认值填充后的配置:"));
  }

  // schema 驱动渲染：自动展示所有字段（含默认值）
  if (parsed.success) {
    renderConfig(parsed.data);
  } else {
    // 解析失败时也尝试显示（用空对象填充）
    const fallback = ConfigSchema.parse({
      llm: { backends: { daily: { model: "(读取失败)" } } },
      providers: {},
    } as never);
    renderConfig(fallback);
  }

  // ── MCP Servers ───────────────────────────────────────────────────────────
  const mcpTomlPath = path.join(os.homedir(), ".tinyclaw", "mcp.toml");
  section(`MCP Servers  ${dim(`(${mcpTomlPath})`)}`);
  if (!fs.existsSync(mcpTomlPath)) {
    console.log(`  ${dim("(mcp.toml 不存在,无 MCP server 配置)")}`);
  } else {
    const report = loadMcpConfigDetailed();
    const servers = Object.entries(report.config.servers);
    console.log(`  ${dim("载入结果：")}${summarizeLoad(report.diagnostics, servers.length)}`);
    const mcpDiagLines = formatDiagnostics(report.diagnostics, "all");
    if (mcpDiagLines.length > 0) {
      console.log();
      for (const line of mcpDiagLines) {
        console.log(`  ${line.startsWith("- [error]") ? red(line) : yellow(line)}`);
      }
    }
    if (servers.length === 0) {
      console.log(`  ${dim("(无 server 定义)")}`);
    } else {
      const rows = servers.map(([name, srv]) => {
        const tag = srv.enabled !== false ? green("enabled") : dim("disabled");
        const transport = srv.transport;
        const endpoint =
          srv.transport === "stdio"
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
  }
  console.log();

  // ── MemStores ─────────────────────────────────────────────────────────────
  const memstoresTomlPath = path.join(os.homedir(), ".tinyclaw", "memstores.toml");
  section(`MemStores  ${dim(`(${memstoresTomlPath})`)}`);
  if (!fs.existsSync(memstoresTomlPath)) {
    console.log(`  ${dim("(memstores.toml 不存在,无额外知识库配置)")}`);
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
      console.log(`  ${red(`读取 memstores.toml 失败:${e}`)}`);
    }
  }

  console.log(`\n${dim(`主配置文件:${CONFIG_PATH}`)}`);
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
  // 解析 --append / --remove 标志
  let mode: "set" | "append" | "remove" = "set";
  if (args[0] === "--append") {
    mode = "append";
    args = args.slice(1);
  } else if (args[0] === "--remove") {
    mode = "remove";
    args = args.slice(1);
  }

  if (args.length < 2) {
    console.log(red("用法:config set [--append|--remove] <dotted.key> <value>"));
    console.log(dim("示例:config set llm.backends.daily.model copilot/gpt-4o"));
    console.log(dim("     config set --append auth.mfa.tools edit_file"));
    console.log(dim("     config set --remove auth.mfa.tools edit_file"));
    return;
  }

  const dotPath = args[0]!;
  const rawVal = args[1]!;

  // dot-path 拆分为 sectionPath + key
  const parts = dotPath.split(".");
  if (parts.length < 2) {
    console.error(red("key 路径至少需要包含 section 和字段名，如 llm.backends.daily.model"));
    return;
  }
  const key = parts.pop()!;
  const sectionPath = parts;

  // 获取 schema 中的字段类型（用于类型验证和枚举提示）
  const fieldType = getFieldType(dotPath);

  // ── 数组追加 / 删除模式 ──────────────────────────────────────────────────
  if (mode === "append" || mode === "remove") {
    if (fieldType.kind !== "array") {
      console.error(
        red(
          `字段 "${dotPath}" 不是数组类型（实际类型：${fieldType.kind}），无法使用 --append/--remove`
        )
      );
      return;
    }

    // 读取当前值
    let currentArr: unknown[] = [];
    try {
      const raw = parse(readRawConfig()) as Record<string, unknown>;
      let cur: unknown = raw;
      for (const p of dotPath.split(".")) {
        if (cur === null || typeof cur !== "object") {
          cur = undefined;
          break;
        }
        cur = (cur as Record<string, unknown>)[p];
      }
      if (Array.isArray(cur)) currentArr = cur;
    } catch {
      // 读取失败，从空数组开始
    }

    if (mode === "append") {
      if (!currentArr.includes(rawVal)) {
        currentArr.push(rawVal);
      } else {
        console.log(yellow(`"${rawVal}" 已存在于 ${dotPath}，无需重复添加`));
        return;
      }
    } else {
      const before = currentArr.length;
      currentArr = currentArr.filter((v) => String(v) !== rawVal);
      if (currentArr.length === before) {
        console.log(yellow(`"${rawVal}" 不在 ${dotPath} 中`));
        return;
      }
    }

    // 序列化为 TOML 数组格式
    const tomlArr = "[" + currentArr.map((v) => JSON.stringify(v)).join(", ") + "]";
    const arrRes = patchTomlField(sectionPath, key, tomlArr, { knownAgent: isKnownAgent });
    if (!arrRes.ok) return reportWriteRejected(arrRes);
    const verb = mode === "append" ? "追加" : "移除";
    console.log(`${green("✓")} ${verb} "${cyan(rawVal)}" → ${dotPath} = ${dim(tomlArr)}`);
    reportWriteWarnings(arrRes);
    return;
  }

  // ── 普通 set 模式 ──────────────────────────────────────────────────────────

  // 枚举类型：检查合法性并提示
  if (fieldType.kind === "enum") {
    if (!fieldType.values.includes(rawVal)) {
      console.error(red(`"${rawVal}" 不是 ${dotPath} 的合法值`));
      console.log(dim(`可选值：${fieldType.values.map((v) => cyan(v)).join(" | ")}`));
      return;
    }
  }

  // 自动推断 TOML 值类型
  let tomlValue: string;
  if (rawVal === "true" || rawVal === "false") {
    tomlValue = rawVal;
  } else if (/^-?\d+(\.\d+)?$/.test(rawVal)) {
    // 整数或小数
    tomlValue = rawVal;
  } else if (rawVal.startsWith("[") && rawVal.endsWith("]")) {
    // JSON 数组语法，直接传入（TOML 数组格式兼容）
    try {
      const parsed = JSON.parse(rawVal) as unknown[];
      tomlValue = "[" + parsed.map((v) => JSON.stringify(v)).join(", ") + "]";
    } catch {
      console.error(red(`数组格式不正确，请使用 JSON 格式：["a", "b", "c"]`));
      return;
    }
  } else {
    tomlValue = JSON.stringify(rawVal);
  }

  const setRes = patchTomlField(sectionPath, key, tomlValue, { knownAgent: isKnownAgent });
  if (!setRes.ok) return reportWriteRejected(setRes);
  console.log(`${green("✓")} [${sectionPath.join(".")}] ${key} = ${cyan(tomlValue)}`);
  for (const line of formatConfigDiags(setRes.diagnostics)) console.log(yellow(`  ${line}`));

  // 枚举类型成功后显示其他可选值
  if (fieldType.kind === "enum" && fieldType.values.length > 1) {
    const others = fieldType.values.filter((v) => v !== rawVal);
    console.log(dim(`  其他可选值：${others.join(" | ")}`));
  }
}

// ── status / check ────────────────────────────────────────────────────────────

/** `config status`：配置自愈状态（LKG / pending / 最近回退 / 留证文件 / 健康日志） */
async function cmdStatus(): Promise<void> {
  const paths = configStatePaths();
  const st = readConfigState();
  const short = (h: string | undefined) => (h ? h.slice(0, 8) : "?");

  section(`配置状态  ${dim(`(${paths.statePath})`)}`);
  console.log(
    `  当前配置   ${cyan(short(currentConfigDigest() ?? undefined))}  ${
      st.current?.at !== undefined ? dim(st.current.at) : dim("(状态未记录)")
    }`
  );
  if (st.lastGood === null) {
    console.log(
      `  可用版本   ${yellow("尚未记录")} ${dim("（启动成功一次后才会写入 config.toml.lkg）")}`
    );
  } else {
    console.log(`  可用版本   ${green(short(st.lastGood.hash))}  ${dim(st.lastGood.at)}`);
    console.log(`             ${dim(st.lastGood.backup)}`);
  }
  if (st.pending === null) {
    console.log(`  待确认     ${dim("无")}`);
  } else {
    console.log(
      `  待确认     ${yellow(short(st.pending.hash))} ${dim(`启动尝试 ${st.pending.bootAttempts} 次`)}`
    );
  }
  if (st.lastRollback !== null) {
    console.log(
      `  ${yellow("最近回退")}   ${dim(st.lastRollback.at)}：${short(st.lastRollback.fromHash)} → ` +
        `${short(st.lastRollback.toHash)}`
    );
    console.log(`             原因：${st.lastRollback.reason}`);
    if (st.lastRollback.rejectedPath !== undefined) {
      console.log(`             坏配置留证：${dim(st.lastRollback.rejectedPath)}`);
    }
  } else {
    console.log(`  最近回退   ${dim("无")}`);
  }

  // 备份 / 留证文件（只列文件名，不打印内容 —— 里面可能含密钥）
  const dir = paths.dir;
  const listByPrefix = (suffix: string): string[] => {
    try {
      return fs
        .readdirSync(dir)
        .filter((f) => f.startsWith(`config.toml.${suffix}-`))
        .sort()
        .slice(-5);
    } catch {
      return [];
    }
  };
  const backups = listByPrefix("bak");
  const rejected = listByPrefix("rejected");
  console.log(`  备份       ${dim(backups.length > 0 ? backups.join(", ") : "无")}`);
  console.log(`  留证       ${rejected.length > 0 ? yellow(rejected.join(", ")) : dim("无")}`);

  // 最近一次健康自检结论
  const healthFiles = (() => {
    try {
      return fs
        .readdirSync(path.join(dir, "logs"))
        .filter((f) => f.startsWith("health-") && f.endsWith(".jsonl"))
        .sort();
    } catch {
      return [];
    }
  })();
  const lastHealth = healthFiles[healthFiles.length - 1];
  if (lastHealth !== undefined) {
    try {
      const lines = fs
        .readFileSync(path.join(dir, "logs", lastHealth), "utf-8")
        .trim()
        .split("\n");
      const last = JSON.parse(lines[lines.length - 1] ?? "{}") as {
        at?: string;
        ok?: boolean;
        checks?: Array<{ name: string; level: string }>;
      };
      const bad = (last.checks ?? []).filter((c) => c.level !== "ok");
      console.log(
        `  健康自检   ${last.ok ? green("通过") : red("有问题")} ${dim(last.at ?? "")}` +
          (bad.length > 0 ? ` ${dim(bad.map((b) => b.name).join(", "))}` : "")
      );
    } catch {
      /* 读不动就跳过 */
    }
  } else {
    console.log(`  健康自检   ${dim("尚无记录（服务下次启动时写入 logs/health-*.jsonl）")}`);
  }

  console.log();
  console.log(dim(`  回退日志：${paths.logPath}`));
  console.log(dim("  提示：`tinyclaw config check` 可对当前文件跑一遍校验与离线自检。"));
  console.log();
}

/** `config check`：对当前 config.toml 跑写前校验 + 离线健康检查（不回退、不改文件） */
async function cmdCheck(): Promise<void> {
  const rawText = readRawConfig();
  const validation = validateConfigText(rawText, { knownAgent: isKnownAgent });

  section("配置校验");
  if (validation.diagnostics.length === 0) {
    console.log(`  ${green("✓")} 语法与 schema 均通过，无诊断`);
  } else {
    for (const line of formatConfigDiags(validation.diagnostics)) {
      const colored =
        line.startsWith("- [error]")
          ? red(line)
          : line.startsWith("- [warn]")
            ? yellow(line)
            : line;
      console.log(`  ${colored}`);
    }
  }

  if (validation.config === undefined) {
    console.log();
    console.log(red("  ✗ 配置无法解析：离线自检已跳过（服务会用 fail-fast 拒绝启动）"));
    console.log();
    process.exitCode = 1;
    return;
  }

  section("离线自检");
  const health = runOfflineHealthChecks({
    cfg: validation.config,
    rawText,
    knownAgent: isKnownAgent,
  });
  for (const line of formatHealthReport(health)) console.log(`  ${line}`);
  console.log();
  if (!health.ok) process.exitCode = 1;
}

/** `config reload`：校验 + 分级 + 提示如何生效（CLI 是独立进程，不能把改动热应用进正在跑的服务） */
async function cmdReload(): Promise<void> {
  const res = await reloadConfig("cli", {
    knownAgent: isKnownAgent,
    // CLI 的工具注册表是空的，别拿它判"工具名不存在"
  });
  section("配置热重载");
  for (const line of res.message.split("\n")) {
    const colored =
      line.startsWith("已拒绝") || line.startsWith("错误")
        ? red(line)
        : line.startsWith("⚠️")
          ? yellow(line)
          : line;
    console.log(`  ${colored}`);
  }
  if (res.needsRestart) {
    console.log();
    console.log(dim("  需要重启才生效：tinyclaw restart（运行中的服务也会自行监听文件变更）"));
  }
  console.log();
  if (!res.ok) process.exitCode = 1;
}

/** `config rollback`：把配置恢复到 LKG 或某个 `.bak-*` 备份 */
async function cmdRollback(args: string[]): Promise<void> {
  const paths = configStatePaths();
  const dir = paths.dir;
  const listBackups = (): string[] => {
    try {
      return fs
        .readdirSync(dir)
        .filter((f) => f.startsWith("config.toml.bak-"))
        .sort()
        .reverse();
    } catch {
      return [];
    }
  };

  if (args.includes("--list") || args.length === 0) {
    section("可回退的配置版本");
    const lkgExists = fs.existsSync(paths.lkgPath);
    console.log(
      `  ${lkgExists ? green("✓") : dim("·")} ${cyan("--lkg")}            ` +
        `${lkgExists ? paths.lkgPath : dim("（尚未记录：服务成功启动过一次才有）")}`
    );
    for (const b of listBackups()) {
      console.log(`  ${cyan("--to")} ${b}`);
    }
    console.log();
    console.log(dim("  用法：tinyclaw config rollback --lkg | --to <备份文件名>"));
    console.log();
    if (args.length === 0 && !lkgExists && listBackups().length === 0) {
      console.error(red("  没有可回退的版本"));
      process.exitCode = 1;
    }
    return;
  }

  const toIdx = args.indexOf("--to");
  const useLkg = args.includes("--lkg");
  let source: string;
  let label: string;
  if (toIdx >= 0) {
    const name = args[toIdx + 1];
    if (name === undefined) {
      console.error(red("  ✗ --to 需要一个备份文件名（先 tinyclaw config rollback --list）"));
      process.exitCode = 1;
      return;
    }
    // 只允许仓库内的备份文件，避免变成"任意文件写入 config.toml"
    if (!/^config\.toml\.bak-[\w.-]+$/.test(name)) {
      console.error(red(`  ✗ 只接受 config.toml.bak-* 备份文件（收到 "${name}"）`));
      process.exitCode = 1;
      return;
    }
    source = path.join(dir, name);
    label = name;
  } else if (useLkg) {
    source = paths.lkgPath;
    label = "config.toml.lkg (LKG)";
  } else {
    console.error(red("  ✗ 用法：tinyclaw config rollback --lkg | --to <备份文件名> | --list"));
    process.exitCode = 1;
    return;
  }

  if (!fs.existsSync(source)) {
    console.error(red(`  ✗ 源文件不存在：${source}`));
    process.exitCode = 1;
    return;
  }
  let text: string;
  try {
    text = fs.readFileSync(source, "utf-8");
  } catch (err) {
    console.error(red(`  ✗ 读取失败：${err instanceof Error ? err.message : String(err)}`));
    process.exitCode = 1;
    return;
  }

  section("配置回退");
  console.log(`  源：${dim(label)}`);
  const res = writeConfigText(text, { knownAgent: isKnownAgent });
  if (!res.ok) {
    console.error(red("  ✗ 该版本未通过校验，未覆盖当前配置（免得越回越坏）："));
    for (const line of formatConfigDiags(res.diagnostics)) console.error(`    ${line}`);
    console.error(dim(`  被拒内容已留证：${res.rejectedPath}`));
    process.exitCode = 1;
    return;
  }
  noteConfigWritten(text, dir);
  console.log(green(`  ✓ 已恢复（当前配置的旧版本已备份：${res.backupPath ?? "无"}）`));
  console.log(dim("  生效：tinyclaw restart（运行中的服务也会监听文件变更自动热重载）"));
  console.log();
}

/** `config safe-mode on|off`：LKG 也起不来时的最后手段 */
async function cmdSafeMode(args: string[]): Promise<void> {
  const action = args[0] ?? "status";
  if (action === "status") {
    const on = isSafeModeEnabled();
    console.log();
    console.log(`  SAFE MODE：${on ? yellow("已开启") : dim("关闭")}  ${dim(safeModeFlagPath())}`);
    console.log(
      dim("  开启后服务只用 providers / llm 段启动（不接 QQBot、不跑 cron/loop、不写 LKG），供你修配置。")
    );
    console.log();
    return;
  }
  if (action !== "on" && action !== "off") {
    console.error(red("  ✗ 用法：tinyclaw config safe-mode [on|off|status]"));
    process.exitCode = 1;
    return;
  }
  const ok = setSafeMode(action === "on");
  if (!ok) {
    console.error(red("  ✗ 写入标记文件失败"));
    process.exitCode = 1;
    return;
  }
  console.log(
    action === "on"
      ? yellow("  ✓ SAFE MODE 已开启：执行 tinyclaw restart 后生效（服务会用最小配置启动）")
      : green("  ✓ SAFE MODE 已关闭：执行 tinyclaw restart 后按 config.toml 启动")
  );
}

// ── 帮助 ──────────────────────────────────────────────────────────────────────

/** 第二层：只列子命令 */
function printHelp(): void {
  console.log(`
${bold("tinyclaw config")}  —  配置管理

${bold("子命令：")}
  ${cyan("show")}              格式化显示当前配置（密钥脱敏）
  ${cyan("get")}               读取指定配置项（dot path）
  ${cyan("edit")}              用 \$EDITOR 打开配置文件
  ${cyan("path")}              打印配置文件路径
  ${cyan("set")}               修改单个配置字段
  ${cyan("status")}            配置自愈状态（可用版本 LKG / 待确认 / 最近回退 / 留证文件 / 健康日志）
  ${cyan("check")}             对当前配置跑写前校验 + 离线自检（不改文件，出错返回码 1）
  ${cyan("reload")}            校验 + 变更分级，提示 hot/soft/restart 与如何生效
  ${cyan("rollback")}          回退到 LKG 或某个 .bak-* 备份（--list 看候选）
  ${cyan("safe-mode")}         SAFE MODE 开关（LKG 也起不来时用最小配置启动）

${dim("运行 tinyclaw config <sub> -h 查看子命令详细参数")}
`);
}

/** 第三层：显示指定子命令的完整参数说明 */
function printSubHelp(sub: string): void {
  switch (sub) {
    case "show":
      console.log(`
${bold("tinyclaw config show")}

  格式化显示当前配置文件内容，敏感字段（apiKey、token 等）自动脱敏。
  无需额外参数。
`);
      break;
    case "get":
      console.log(`
${bold("tinyclaw config get")} <key>

${bold("参数：")}
  key    配置项的 dot path，如 llm.backends.daily.model

${bold("示例：")}
  config get llm.backends.daily.model
  config get channels.qqbot.appId
`);
      break;
    case "edit":
      console.log(`
${bold("tinyclaw config edit")}

  用 \$EDITOR（或 \$VISUAL / nano / vi）打开配置文件直接编辑。
  无需额外参数。
`);
      break;
    case "path":
      console.log(`
${bold("tinyclaw config path")}

  打印配置文件的完整路径及文件大小、修改时间。
  无需额外参数。
`);
      break;
    case "set":
      console.log(`
${bold("tinyclaw config set")} <key> <value>

${bold("参数：")}
  key      配置项的 dot path（至少两段，如 llm.backends.daily.model）
  value    新值；类型自动推断：
             "true"/"false" → 布尔
             纯整数          → 数字
             其他            → 字符串

${bold("示例：")}
  config set llm.backends.daily.model gpt-4o
  config set llm.backends.daily.maxTokens 8192
  config set channels.qqbot.markdownSupport false
`);
      break;
    default:
      console.error(red(`未知子命令 "${sub}"`));
      printHelp();
  }
}

// ── 命令入口 ──────────────────────────────────────────────────────────────────

export const subcommands = [
  "show",
  "get",
  "edit",
  "path",
  "set",
  "status",
  "check",
  "reload",
  "rollback",
  "safe-mode",
  "help",
] as const;
export const description = "配置管理：查看/读取/编辑/改字段/自愈状态/校验/热重载/回退/安全模式";
export const usage = "config <show|get|edit|path|set|status|check|reload|rollback|safe-mode> [args]";

export async function run(args: string[]): Promise<void> {
  const sub = args[0] ?? "show";
  const rest = args.slice(1);

  switch (sub) {
    case "show":
      if (rest.includes("-h") || rest.includes("--help")) {
        printSubHelp("show");
        return;
      }
      return cmdShow();
    case "get":
      if (rest.includes("-h") || rest.includes("--help")) {
        printSubHelp("get");
        return;
      }
      return cmdGet(rest);
    case "edit":
      if (rest.includes("-h") || rest.includes("--help")) {
        printSubHelp("edit");
        return;
      }
      return cmdEdit();
    case "path":
      if (rest.includes("-h") || rest.includes("--help")) {
        printSubHelp("path");
        return;
      }
      return cmdPath();
    case "set":
      if (rest.includes("-h") || rest.includes("--help")) {
        printSubHelp("set");
        return;
      }
      return cmdSet(rest);
    case "status":
      return cmdStatus();
    case "check":
      return cmdCheck();
    case "reload":
      return cmdReload();
    case "rollback":
      return cmdRollback(rest);
    case "safe-mode":
      return cmdSafeMode(rest);
    case "--help":
    case "-h":
    case "help":
      printHelp();
      return;
    default:
      console.error(red(`未知子命令 "${sub}"`));
      printHelp();
  }
}
