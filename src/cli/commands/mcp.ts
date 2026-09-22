/**
 * CLI 命令：mcp
 *
 * 子命令：
 *   mcp status   查看 ~/.tinyclaw/mcp.toml 的载入结果（诊断 + server 定义）
 *
 * 说明：CLI 是独立进程，看不到**正在运行的服务**里 MCP 的连接状态；这里展示的是
 * "从磁盘载入的结果"，与 agent 侧 `mcp_list_servers` 的载入诊断口径一致。
 */

import { loadMcpConfigDetailed, mcpConfigPath } from "../../config/loader.js";
import { formatDiagnostics, summarizeLoad } from "../../mcp/load-report.js";
import { printTable, bold, dim, green, red, yellow, cyan, section } from "../ui.js";

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

function printHelp(): void {
  console.log(`
${bold("tinyclaw mcp")} — MCP server 配置管理

用法：
  tinyclaw mcp status           查看 mcp.toml 载入结果（诊断 + server 列表）
  tinyclaw mcp help             显示本帮助
`);
}

// ── 命令入口 ──────────────────────────────────────────────────────────────────

export const subcommands = ["status", "help"] as const;
export const description = "MCP server 配置：查看载入结果与诊断";
export const usage = "mcp <status|help>";

export async function run(args: string[]): Promise<void> {
  const sub = args[0] ?? "status";
  switch (sub) {
    case "status":
      return cmdStatus();
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
