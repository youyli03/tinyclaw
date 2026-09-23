/**
 * `${SECRET:NAME}` 引用解析
 *
 * mcp.toml 的 `env` / `headers` 值可以是引用式字符串 `${SECRET:NAME}`：
 * 真正的值在**连接 server 时**从 `~/.tinyclaw/secrets.toml` 读取。
 *
 * 为什么：stdio MCP server 是独立子进程，读不到 tinyclaw 的 secrets.toml；而把明文写进
 * mcp.toml 会让密钥同时出现在配置文件与会话历史（工具参数）里。引用式让 mcp.toml 只留名字。
 *
 * 非引用值原样透传（兼容手写明文的老配置）。
 */

import { loadSecretsConfig, type McpLoadDiagnostic } from "../config/loader.js";
import type { MCPConfig, SecretsConfig } from "../config/schema.js";

/** 整个值就是一个 `${SECRET:NAME}` 引用时才解析（不做插值，避免误伤普通文本） */
const SECRET_REF_RE = /^\$\{SECRET:([A-Za-z0-9_]+)\}$/;

/** 该值是否是 `${SECRET:NAME}` 引用 */
export function isSecretRef(value: string): boolean {
  return SECRET_REF_RE.test(value);
}

/** 取出引用名（不是引用则返回 null） */
export function secretRefName(value: string): string | null {
  const m = SECRET_REF_RE.exec(value);
  return m?.[1] ?? null;
}

/** secrets.toml 里一个 key 的取值（兼容对象格式与历史裸字符串格式） */
export function secretValue(secrets: SecretsConfig, name: string): string | undefined {
  const entry = secrets[name];
  if (entry === undefined) return undefined;
  if (typeof entry === "string") return entry;
  return entry.value;
}

export interface ResolveResult {
  /** 解析后的键值对（缺失引用的键会被跳过） */
  values: Record<string, string>;
  /** 引用了但 secrets.toml 中不存在的键名 */
  missing: string[];
}

/**
 * 解析一组 env / headers 值。
 *
 * @param values  原始键值对（值可能是 `${SECRET:NAME}`）
 * @param secrets 已加载的 secrets.toml（调用方可注入，默认实时读盘）
 */
export function resolveSecretRefs(
  values: Record<string, string> | undefined,
  secrets?: SecretsConfig
): ResolveResult {
  const resolved: Record<string, string> = {};
  const missing: string[] = [];
  const entries = Object.entries(values ?? {});
  if (entries.length === 0) return { values: resolved, missing };

  const table = secrets ?? loadSecretsConfig();
  for (const [key, raw] of entries) {
    const ref = secretRefName(raw);
    if (ref === null) {
      resolved[key] = raw;
      continue;
    }
    const val = secretValue(table, ref);
    if (val === undefined) {
      missing.push(ref);
      continue;
    }
    resolved[key] = val;
  }
  return { values: resolved, missing };
}

/**
 * 载入期检查：把"引用了不存在的 secret"变成一条可展示的 error 诊断。
 *
 * 只在**读配置**时用；**写配置时不要用**（先加引用、后补 secret 是合理顺序，
 * 否则 `writeMcpTomlText` 会因为一个尚未存在的 secret 拒绝落盘）。
 */
export function checkSecretRefs(config: MCPConfig, secrets?: SecretsConfig): McpLoadDiagnostic[] {
  const table = secrets ?? loadSecretsConfig();
  const diagnostics: McpLoadDiagnostic[] = [];
  for (const [name, srv] of Object.entries(config.servers)) {
    const fields: Array<[string, Record<string, string> | undefined]> =
      srv.transport === "stdio" ? [["env", srv.env]] : [["headers", srv.headers]];
    for (const [field, values] of fields) {
      for (const [key, raw] of Object.entries(values ?? {})) {
        const ref = secretRefName(raw);
        if (ref === null) continue;
        if (secretValue(table, ref) !== undefined) continue;
        diagnostics.push({
          level: "error",
          code: "secret",
          scope: "server",
          server: name,
          message: `[servers.${name}] ${field}.${key} 引用了 \${SECRET:${ref}}，但 secrets.toml 里没有这个键`,
          hint: `在 ~/.tinyclaw/secrets.toml 里加 ${ref} = "..."（该 server 连接时会拿到空值）`,
        });
      }
    }
  }
  return diagnostics;
}
