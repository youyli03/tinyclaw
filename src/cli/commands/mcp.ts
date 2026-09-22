/**
 * CLI 命令：mcp
 *
 * 子命令：
 *   mcp status                 查看 ~/.tinyclaw/mcp.toml 的载入结果（诊断 + server 定义）
 *   mcp add <name> --stdio …   新增/覆盖一个 server（--stdio <cmd> / --sse <url>）
 *   mcp remove <name>          删除一个 server
 *   mcp enable|disable <name>  改该 server 的 enabled 开关
 *
 * 说明：
 * - CLI 是独立进程，看不到**正在运行的服务**里 MCP 的连接状态；`status` 展示的是"从磁盘载入的结果"。
 * - 写操作走 `src/mcp/config-writer.ts`：写前全量校验 → `.bak-<ts>` 备份 → `.tmp` + rename 原子落盘。
 *   运行中的服务由 `mcp.toml` 文件监听（`src/mcp/watcher.ts`）自动重载，无需重启；
 *   让 agent 调 `mcp_reload` 或 `tinyclaw restart` 也能立刻生效。
 */

import { loadMcpConfigDetailed, mcpConfigPath } from "../../config/loader.js";
import { formatDiagnostics, summarizeLoad } from "../../mcp/load-report.js";
import { sanitizeMcpName } from "../../mcp/client.js";
import {
  MCP_SERVER_NAME_RE,
  readMcpTomlText,
  removeServerBlock,
  renderServerBlock,
  setServerEnabled,
  upsertServerBlock,
  writeMcpTomlText,
  type McpServerSpec,
} from "../../mcp/config-writer.js";
import { printTable, bold, dim, green, red, yellow, cyan, section } from "../ui.js";

// ── 辅助 ──────────────────────────────────────────────────────────────────────

/** 按诊断行前缀着色 */
function colorDiag(line: string): string {
  if (line.startsWith("- [error]")) return red(line);
  if (line.startsWith("- [info]")) return dim(line);
  return yellow(line);
}

/** 打印 server 需要哪些 env / headers 的 **键名**（值永不回显） */
function printKeyNames(label: string, keys: string[]): void {
  if (keys.length === 0) return;
  console.log(`  ${dim(`${label}：`)}${keys.map((k) => cyan(k)).join(", ")} ${dim("(值不显示)")}`);
}

/** 写盘后统一提示（含备份路径与"如何生效"） */
function reportWrite(action: string, backupPath: string | null): void {
  console.log(green(`  ✓ ${action}`));
  console.log(dim(`  备份：${backupPath ?? "无（文件原本不存在）"}`));
  console.log(dim("  生效：运行中的服务由文件监听自动重载（约 1s）；也可让 agent 调 mcp_reload 或 tinyclaw restart"));
}

/** 写盘错误统一出口 */
function reportWriteError(err: unknown): void {
  console.error(red(`  ✗ ${err instanceof Error ? err.message : String(err)}`));
}

// ── status ────────────────────────────────────────────────────────────────────

async function cmdStatus(): Promise<void> {
  const p = mcpConfigPath();
  const report = loadMcpConfigDetailed();
  const servers = Object.entries(report.config.servers);

  section(`MCP Servers  ${dim(`(${p})`)}`);
  if (!report.fileExists) {
    console.log(`  ${dim("mcp.toml 不存在：未配置任何 MCP server")}`);
    console.log();
    return;
  }

  console.log(`  ${dim("载入结果：")}${summarizeLoad(report.diagnostics, servers.length)}`);
  const diagLines = formatDiagnostics(report.diagnostics, "all");
  if (diagLines.length > 0) {
    console.log();
    for (const line of diagLines) console.log(`  ${colorDiag(line)}`);
  }
  console.log();

  if (servers.length === 0) {
    console.log(`  ${dim("(无 server 定义)")}`);
    console.log();
    return;
  }

  const rows = servers.map(([name, srv]) => {
    const tag = srv.enabled !== false ? green("enabled") : dim("disabled");
    const endpoint =
      srv.transport === "stdio"
        ? `${srv.command} ${srv.args.join(" ")}`.trim()
        : srv.url;
    return [cyan(name), `[${tag}]`, srv.transport, dim(endpoint.slice(0, 60))];
  });
  printTable(["Name", "Status", "Transport", "Command / URL"], rows);

  for (const [name, srv] of servers) {
    if (srv.transport === "stdio") {
      printKeyNames(`${name} env`, Object.keys(srv.env ?? {}));
    } else {
      printKeyNames(`${name} headers`, Object.keys(srv.headers ?? {}));
    }
  }
  if (servers.some(([, s]) => s.description)) {
    console.log();
    for (const [name, srv] of servers) {
      if (srv.description) console.log(`  ${cyan(name)}: ${dim(srv.description.slice(0, 80))}`);
    }
  }
  console.log();
  console.log(dim("  提示：这里只反映磁盘上的配置；正在运行的服务里 MCP 的连接状态请用 mcp_list_servers。"));
  console.log();
}

// ── add ───────────────────────────────────────────────────────────────────────

interface AddFlags {
  name: string;
  stdio?: string;
  sse?: string;
  args: string[];
  env: Record<string, string>;
  headers: Record<string, string>;
  description?: string;
  disabled: boolean;
}

/** `K=V` → [K, V] */
function splitPair(raw: string): [string, string] | null {
  const idx = raw.indexOf("=");
  if (idx <= 0) return null;
  return [raw.slice(0, idx), raw.slice(idx + 1)];
}

function parseAddArgs(args: string[]): { ok: true; flags: AddFlags } | { ok: false; error: string } {
  const flags: AddFlags = { name: "", args: [], env: {}, headers: {}, disabled: false };
  let sawName = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i] ?? "";
    const next = (): string | null => {
      const v = args[i + 1];
      if (v === undefined) return null;
      i++;
      return v;
    };
    if (a === "--stdio" || a === "--sse") {
      const v = next();
      if (v === null) return { ok: false, error: `${a} 需要一个值` };
      if (a === "--stdio") flags.stdio = v;
      else flags.sse = v;
      continue;
    }
    if (a === "--arg" || a === "--args") {
      const v = next();
      if (v === null) return { ok: false, error: `${a} 需要一个值` };
      flags.args.push(v);
      continue;
    }
    if (a === "--env" || a === "--header") {
      const v = next();
      if (v === null) return { ok: false, error: `${a} 需要一个 K=V` };
      const pair = splitPair(v);
      if (pair === null) return { ok: false, error: `${a} 的取值必须是 K=V 形式` };
      if (a === "--env") flags.env[pair[0]] = pair[1];
      else flags.headers[pair[0]] = pair[1];
      continue;
    }
    if (a === "--desc" || a === "--description") {
      const v = next();
      if (v === null) return { ok: false, error: `${a} 需要一个值` };
      flags.description = v;
      continue;
    }
    if (a === "--disabled") {
      flags.disabled = true;
      continue;
    }
    if (a.startsWith("-")) return { ok: false, error: `未知参数 ${a}` };
    if (sawName) return { ok: false, error: `多余的位置参数 ${a}` };
    flags.name = a;
    sawName = true;
  }

  if (flags.name === "") return { ok: false, error: "缺少 server 名" };
  if (!MCP_SERVER_NAME_RE.test(flags.name)) {
    return { ok: false, error: `server 名 "${flags.name}" 非法（只允许字母/数字/下划线/连字符，1-32 字符）` };
  }
  if (flags.stdio !== undefined && flags.sse !== undefined) {
    return { ok: false, error: "--stdio 与 --sse 只能给一个" };
  }
  if (flags.stdio === undefined && flags.sse === undefined) {
    return { ok: false, error: "必须给 --stdio <command> 或 --sse <url>" };
  }
  if (flags.sse !== undefined) {
    if (!/^https?:\/\//.test(flags.sse)) return { ok: false, error: "--sse 的 url 必须以 http:// 或 https:// 开头" };
    if (flags.args.length > 0) return { ok: false, error: "--arg 只对 stdio 有效" };
    if (Object.keys(flags.env).length > 0) return { ok: false, error: "--env 只对 stdio 有效" };
  } else {
    if (Object.keys(flags.headers).length > 0) return { ok: false, error: "--header 只对 sse 有效" };
  }
  return { ok: true, flags };
}

async function cmdAdd(args: string[]): Promise<void> {
  const parsed = parseAddArgs(args);
  if (!parsed.ok) {
    console.error(red(`  ✗ ${parsed.error}`));
    printHelp();
    return;
  }
  const f = parsed.flags;

  const text = readMcpTomlText();
  const existing = Object.keys(loadMcpConfigDetailed().config.servers);
  const conflict = existing.find(
    (other) => other !== f.name && sanitizeMcpName(other) === sanitizeMcpName(f.name)
  );
  if (conflict !== undefined) {
    console.error(
      red(
        `  ✗ server 名 "${f.name}" 与已有的 "${conflict}" 在工具名前缀上冲突` +
          `（sanitize 后同为 "${sanitizeMcpName(f.name)}"），会导致工具重复注册`
      )
    );
    return;
  }

  const spec: McpServerSpec =
    f.stdio !== undefined
      ? {
          transport: "stdio",
          command: f.stdio,
          args: f.args,
          ...(Object.keys(f.env).length > 0 ? { env: f.env } : {}),
          ...(f.description !== undefined ? { description: f.description } : {}),
          ...(f.disabled ? { enabled: false } : {}),
        }
      : {
          transport: "sse",
          url: f.sse ?? "",
          ...(Object.keys(f.headers).length > 0 ? { headers: f.headers } : {}),
          ...(f.description !== undefined ? { description: f.description } : {}),
          ...(f.disabled ? { enabled: false } : {}),
        };

  try {
    const { backupPath } = writeMcpTomlText(upsertServerBlock(text, f.name, renderServerBlock(f.name, spec)));
    reportWrite(`${existing.includes(f.name) ? "已更新" : "已新增"} MCP server "${f.name}"`, backupPath);
  } catch (err) {
    reportWriteError(err);
    return;
  }

  const plaintext = Object.entries(f.stdio !== undefined ? f.env : f.headers)
    .filter(([, v]) => !/^\$\{SECRET:[A-Za-z0-9_]+\}$/.test(v))
    .map(([k]) => k);
  if (plaintext.length > 0) {
    console.log(
      yellow(
        `  ⚠️ ${plaintext.join(", ")} 是明文写入 mcp.toml 的。更安全的写法是把值放进 secrets.toml，` +
          `这里写 '${plaintext[0]}="\${SECRET:${plaintext[0]}}"'（注意用单引号，避免 shell 展开）`
      )
    );
  }
}

// ── remove / enable / disable ─────────────────────────────────────────────────

async function cmdRemove(args: string[]): Promise<void> {
  const name = args[0] ?? "";
  if (name === "") {
    console.error(red("  ✗ 用法：tinyclaw mcp remove <name>"));
    return;
  }
  const result = removeServerBlock(readMcpTomlText(), name);
  if (!result.removed) {
    console.error(red(`  ✗ mcp.toml 里没有 [servers.${name}]，未做任何改动`));
    return;
  }
  try {
    const { backupPath } = writeMcpTomlText(result.content);
    reportWrite(`已删除 MCP server "${name}"`, backupPath);
  } catch (err) {
    reportWriteError(err);
  }
}

async function cmdSetEnabled(args: string[], enabled: boolean): Promise<void> {
  const name = args[0] ?? "";
  if (name === "") {
    console.error(red(`  ✗ 用法：tinyclaw mcp ${enabled ? "enable" : "disable"} <name>`));
    return;
  }
  const result = setServerEnabled(readMcpTomlText(), name, enabled);
  if (!result.found) {
    console.error(red(`  ✗ mcp.toml 里没有 [servers.${name}]，未做任何改动`));
    return;
  }
  try {
    const { backupPath } = writeMcpTomlText(result.content);
    reportWrite(`已把 [servers.${name}] 的 enabled 设为 ${String(enabled)}`, backupPath);
  } catch (err) {
    reportWriteError(err);
  }
}

// ── help / 入口 ───────────────────────────────────────────────────────────────

function printHelp(): void {
  console.log(`
${bold("tinyclaw mcp")} — MCP server 配置管理

用法：
  tinyclaw mcp status                              查看 mcp.toml 载入结果（诊断 + server 列表）
  tinyclaw mcp add <name> --stdio <cmd> [--arg <a>]... [--env K=V]... [--desc <text>] [--disabled]
  tinyclaw mcp add <name> --sse <url> [--header K=V]... [--desc <text>] [--disabled]
  tinyclaw mcp remove <name>                       删除一个 server 定义
  tinyclaw mcp enable <name>                       允许启用该 server
  tinyclaw mcp disable <name>                      禁止启用该 server
  tinyclaw mcp help                                显示本帮助

密钥不要写明文：值写成 \${SECRET:NAME}，连接时从 ~/.tinyclaw/secrets.toml 读取。
  ${dim("（shell 里请用单引号：--env 'EXA_API_KEY=${SECRET:EXA_API_KEY}'）")}

写操作会先校验整份文件、备份成 mcp.toml.bak-<时间戳>，再原子替换；运行中的服务会自动重载。
`);
}

export const subcommands = ["status", "add", "remove", "enable", "disable", "help"] as const;
export const description = "MCP server 配置：查看载入结果与诊断、增删启停";
export const usage = "mcp <status|add|remove|enable|disable|help> [args]";

export async function run(args: string[]): Promise<void> {
  const sub = args[0] ?? "status";
  const rest = args.slice(1);
  switch (sub) {
    case "status":
      return cmdStatus();
    case "add":
      return cmdAdd(rest);
    case "remove":
    case "rm":
      return cmdRemove(rest);
    case "enable":
      return cmdSetEnabled(rest, true);
    case "disable":
      return cmdSetEnabled(rest, false);
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
