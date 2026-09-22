/**
 * MCP 自管理工具（写 `~/.tinyclaw/mcp.toml`）
 *
 * 1. mcp_server_add        — 新增 / 覆盖一个 [servers.<name>] 块（写前全量校验 + 备份 + 原子落盘）
 * 2. mcp_server_remove     — 删除一个 [servers.<name>] 块
 * 3. mcp_server_set_enabled— 只改块内 enabled 行
 * 4. mcp_reload            — 重新读盘并热重载（改完立刻生效，不必重启服务）
 *
 * 安全边界（与 `AGENTS.md` §7.1 一致）：
 * - `mcp.toml` 仍是**密钥文件**：通用文件工具（read_file / write_file / self_runtime_*）继续拒绝它。
 *   这里是"被认可的接口"（同 memory_* / write_report），因此不调用 `checkWritePath`。
 * - 三个写工具的 `requiresMFA: true`：新增 server 的 `command` 是任意可执行程序，属特权变更。
 * - 无人值守（cron / loop）一律硬拒绝（`auth/tool-policy.ts` 的 HARD_DENY_REACT_UNATTENDED）。
 * - 返回给模型的文本**永不回显** env / headers 的值，只列键名。
 */

import { registerTool } from "./registry.js";
import { mcpManager, sanitizeMcpName } from "../mcp/client.js";
import { analyzeMcpTomlText, mcpConfigPath } from "../config/loader.js";
import { formatDiagnostics } from "../mcp/load-report.js";
import { isSecretRef } from "../mcp/secret-ref.js";
import {
  MCP_SERVER_NAME_RE,
  readMcpTomlText,
  renderServerBlock,
  removeServerBlock,
  setServerEnabled,
  upsertServerBlock,
  writeMcpTomlText,
  type McpServerSpec,
} from "../mcp/config-writer.js";

/** args 里的对象 → `Record<string, string>`（值统一转字符串，忽略非对象输入） */
function toStringRecord(v: unknown): Record<string, string> | undefined {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (val === null || val === undefined) continue;
    out[k] = typeof val === "string" ? val : JSON.stringify(val);
  }
  return out;
}

/** args 里的数组 → string[] */
function toStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.map((x) => (typeof x === "string" ? x : JSON.stringify(x)));
}

/** 明文值提醒（密钥建议用 ${SECRET:NAME}，避免落进 mcp.toml 与会话历史） */
function plaintextHint(values: Record<string, string> | undefined, field: string): string {
  if (values === undefined) return "";
  const plain = Object.keys(values).filter((k) => !isSecretRef(values[k] ?? ""));
  if (plain.length === 0) return "";
  return (
    `\n⚠️ ${field} 的 ${plain.join(", ")} 是**明文**写入 mcp.toml 的（也会留在本次对话历史里）。` +
    `更安全的写法是引用 secrets.toml：${field} = { ${plain[0]} = "\${SECRET:${plain[0]}}" } —— ` +
    "连接时才会去 secrets.toml 取值。"
  );
}

/** 名字 sanitize 后与已有 server 冲突则返回那个名字 */
function findNameConflict(existing: string[], name: string): string | null {
  const target = sanitizeMcpName(name);
  for (const other of existing) {
    if (other !== name && sanitizeMcpName(other) === target) return other;
  }
  return null;
}

// ── 1. add ────────────────────────────────────────────────────────────────────

registerTool({
  requiresMFA: true,
  spec: {
    type: "function",
    function: {
      name: "mcp_server_add",
      description:
        "Add (or overwrite) an MCP server definition in ~/.tinyclaw/mcp.toml and hot-reload the " +
        "MCP config so it takes effect immediately. The file is validated before writing, a " +
        "timestamped backup is kept, and the write is atomic. For stdio servers pass command/args; " +
        "for sse servers pass url. Secret-looking env/headers values should be written as the " +
        "reference ${SECRET:NAME} (resolved from ~/.tinyclaw/secrets.toml at connect time) instead " +
        "of plaintext.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description:
              "Server key, i.e. the NAME in [servers.NAME]. Allowed characters: letters, digits, " +
              "underscore, hyphen (1-32 chars).",
          },
          transport: {
            type: "string",
            enum: ["stdio", "sse"],
            description: "stdio spawns a local child process; sse connects to a remote HTTP/SSE URL.",
          },
          command: {
            type: "string",
            description: "stdio only: executable to launch (e.g. node, python3, uvx).",
          },
          args: {
            type: "array",
            items: { type: "string" },
            description: "stdio only: command-line arguments.",
          },
          url: {
            type: "string",
            description: "sse only: the SSE endpoint URL.",
          },
          env: {
            type: "object",
            additionalProperties: { type: "string" },
            description:
              "stdio only: environment variables for the child process. A value may be a plaintext " +
              "string or the whole-value reference ${SECRET:NAME} (resolved from secrets.toml when " +
              "the server connects; no string interpolation).",
          },
          headers: {
            type: "object",
            additionalProperties: { type: "string" },
            description:
              "sse only: HTTP headers for the SSE connection (and its POSTs). A value may be a " +
              "plaintext string or the whole-value reference ${SECRET:NAME}; for an Authorization " +
              "header store the entire value (e.g. \"Bearer xxx\") in the secret.",
          },
          description: {
            type: "string",
            description: "Human-readable description shown by mcp_list_servers.",
          },
          enabled: {
            type: "boolean",
            description: "Whether the server may be enabled (default true).",
          },
        },
        required: ["name", "transport"],
      },
    },
  },
  execute: async (args) => {
    const name = String(args["name"] ?? "").trim();
    if (!MCP_SERVER_NAME_RE.test(name)) {
      return `已拒绝：server 名 "${name}" 非法（只允许字母/数字/下划线/连字符，长度 1-32）。`;
    }
    const transport = String(args["transport"] ?? "");
    if (transport !== "stdio" && transport !== "sse") {
      return '已拒绝：transport 必须是 "stdio" 或 "sse"。';
    }
    const command = args["command"] === undefined ? "" : String(args["command"]);
    const url = args["url"] === undefined ? "" : String(args["url"]);
    if (transport === "stdio" && command.trim() === "") {
      return "已拒绝：stdio server 必须提供非空的 command。";
    }
    if (transport === "sse" && url.trim() === "") {
      return "已拒绝：sse server 必须提供非空的 url。";
    }

    const env = toStringRecord(args["env"]);
    const headers = toStringRecord(args["headers"]);
    const description = args["description"] === undefined ? undefined : String(args["description"]);
    const enabled = args["enabled"] === undefined ? undefined : args["enabled"] === true;
    const opt: Partial<McpServerSpec> = {
      ...(env !== undefined ? { env } : {}),
      ...(headers !== undefined ? { headers } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(enabled !== undefined ? { enabled } : {}),
    };
    const spec: McpServerSpec =
      transport === "stdio"
        ? { transport, command, args: toStringArray(args["args"]) ?? [], ...opt }
        : { transport, url, ...opt };

    const text = readMcpTomlText();
    const existing = Object.keys(analyzeMcpTomlText(text).config.servers);
    const conflict = findNameConflict(existing, name);
    if (conflict !== null) {
      return (
        `已拒绝：server 名 "${name}" 与已有的 "${conflict}" 在工具名前缀上冲突` +
        `（sanitize 后同为 "${sanitizeMcpName(name)}"），会导致工具重复注册。请换一个名字。`
      );
    }

    const next = upsertServerBlock(text, name, renderServerBlock(name, spec));
    let backupPath: string | null;
    try {
      backupPath = writeMcpTomlText(next).backupPath;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }

    const summary = await mcpManager.reload("tool");
    const verb = existing.includes(name) ? "已更新" : "已新增";
    return [
      `${verb} MCP server "${name}"（${transport}），配置：${mcpConfigPath()}`,
      `备份：${backupPath ?? "无（文件原本不存在）"}`,
      summary,
      plaintextHint(transport === "stdio" ? env : headers, transport === "stdio" ? "env" : "headers"),
    ]
      .filter((s) => s !== "")
      .join("\n");
  },
});

// ── 2. remove ─────────────────────────────────────────────────────────────────

registerTool({
  requiresMFA: true,
  spec: {
    type: "function",
    function: {
      name: "mcp_server_remove",
      description:
        "Remove an MCP server definition from ~/.tinyclaw/mcp.toml and hot-reload the config. Its " +
        "registered tools are unregistered. A timestamped backup is kept.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Server key to remove." },
        },
        required: ["name"],
      },
    },
  },
  execute: async (args) => {
    const name = String(args["name"] ?? "").trim();
    if (name === "") return "已拒绝：缺少 name 参数。";

    const text = readMcpTomlText();
    const result = removeServerBlock(text, name);
    if (!result.removed) {
      return `错误：mcp.toml 里没有 [servers.${name}]，未做任何改动。`;
    }
    let backupPath: string | null;
    try {
      backupPath = writeMcpTomlText(result.content).backupPath;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    const summary = await mcpManager.reload("tool");
    return `已删除 MCP server "${name}"。备份：${backupPath ?? "无"}\n${summary}`;
  },
});

// ── 3. set enabled ────────────────────────────────────────────────────────────

registerTool({
  requiresMFA: true,
  spec: {
    type: "function",
    function: {
      name: "mcp_server_set_enabled",
      description:
        "Set the `enabled` flag of an existing MCP server in ~/.tinyclaw/mcp.toml and hot-reload " +
        "the config. A disabled server cannot be enabled by mcp_enable_server; enabling one that " +
        "was disabled widens the set of tools that can be reached.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Server key." },
          enabled: { type: "boolean", description: "true to allow enabling, false to forbid it." },
        },
        required: ["name", "enabled"],
      },
    },
  },
  execute: async (args) => {
    const name = String(args["name"] ?? "").trim();
    if (name === "") return "已拒绝：缺少 name 参数。";
    if (typeof args["enabled"] !== "boolean") return "已拒绝：enabled 必须是布尔值。";
    const enabled = args["enabled"];

    const result = setServerEnabled(readMcpTomlText(), name, enabled);
    if (!result.found) {
      return `错误：mcp.toml 里没有 [servers.${name}]，未做任何改动。`;
    }
    let backupPath: string | null;
    try {
      backupPath = writeMcpTomlText(result.content).backupPath;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    const summary = await mcpManager.reload("tool");
    return `已把 [servers.${name}] 的 enabled 设为 ${String(enabled)}。备份：${backupPath ?? "无"}\n${summary}`;
  },
});

// ── 4. reload ─────────────────────────────────────────────────────────────────

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "mcp_reload",
      description:
        "Re-read ~/.tinyclaw/mcp.toml and hot-reload the MCP configuration (connect/disconnect " +
        "differences, unregister removed tools, re-enable servers that were enabled, and refresh " +
        "the load report). Use it after editing mcp.toml by hand.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  execute: async () => {
    const summary = await mcpManager.reload("tool");
    const report = mcpManager.getLoadReport();
    const diagLines = formatDiagnostics(report.diagnostics, "error");
    return [summary, ...(diagLines.length > 0 ? ["", ...diagLines] : [])].join("\n");
  },
});
