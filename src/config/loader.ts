import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { parse } from "smol-toml";
import {
  ConfigSchema,
  type Config,
  MCPConfigSchema,
  MCPServerSchema,
  type MCPConfig,
  type MCPServerConfig,
  type RetryConfig,
  MemStoresConfigSchema,
  type MemStoresConfig,
  SecretsConfigSchema,
  SecretEntrySchema,
  type SecretsConfig,
} from "./schema.js";
import { ensureSecureFilePerm } from "../utils/file-perm.js";

// ~/.tinyclaw/config.toml
const CONFIG_PATH = path.join(os.homedir(), ".tinyclaw", "config.toml");

// config.example.toml 与本文件同仓库根目录
const EXAMPLE_PATH = path.resolve(
  import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
  "../../config.example.toml"
);

let cached: Config | null = null;

/**
 * 加载并验证配置。首次调用读取磁盘，后续返回缓存。
 * 配置不合法时打印友好错误并退出进程（fail-fast）。
 */
export function loadConfig(): Config {
  if (cached) return cached;

  if (!fs.existsSync(CONFIG_PATH)) {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    if (fs.existsSync(EXAMPLE_PATH)) {
      fs.copyFileSync(EXAMPLE_PATH, CONFIG_PATH);
      console.error(
        `[tinyclaw] 配置文件不存在，已自动复制模板到：${CONFIG_PATH}\n` +
          `请编辑该文件填入真实配置后重新启动。`
      );
    } else {
      console.error(
        `[tinyclaw] 配置文件不存在：${CONFIG_PATH}\n` +
          `请复制 config.example.toml 到 ~/.tinyclaw/config.toml 并填入真实配置。`
      );
    }
    process.exit(1);
  }

  let raw: unknown;
  try {
    const content = fs.readFileSync(CONFIG_PATH, "utf-8");
    raw = parse(content);
  } catch (err) {
    console.error(`[tinyclaw] 配置文件解析失败（TOML 语法错误）：\n${err}`);
    process.exit(1);
  }

  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    console.error(`[tinyclaw] 配置验证失败：\n${issues}`);
    process.exit(1);
  }

  cached = result.data;

  // 敏感文件权限守卫:config.toml 含 provider apiKey,过宽则告警
  try {
    const guard = cached.auth.secret_guard;
    if (guard.enabled) {
      ensureSecureFilePerm(CONFIG_PATH, "config.toml", guard.autoChmod);
    }
  } catch {
    /* 守卫失败不阻塞启动 */
  }

  return cached;
}

/**
 * 返回 ~/.tinyclaw 下的子路径，自动创建目录。
 */
export function getDataPath(...segments: string[]): string {
  const dir = path.join(os.homedir(), ".tinyclaw", ...segments);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 返回 ~/.tinyclaw 下的文件路径（不创建目录）。
 */
export function getDataFile(...segments: string[]): string {
  return path.join(os.homedir(), ".tinyclaw", ...segments);
}

/** 仅在测试中用于重置单例缓存 */
export function _resetConfigCache(): void {
  cached = null;
}

/**
 * 返回当前配置中的重试策略（含默认值）。
 * 调用方无需关心 config.retry 是否已配置，本函数保证始终返回有效的 RetryConfig。
 */
export function getRetryPolicy(): RetryConfig {
  return loadConfig().retry;
}

/** 加载 ~/.tinyclaw/memstores.toml，文件不存在时返回空配置（非致命）。 */
export function loadMemStoresConfig(): MemStoresConfig {
  const p = path.join(os.homedir(), ".tinyclaw", "memstores.toml");
  let raw: unknown;
  try {
    raw = parse(fs.readFileSync(p, "utf-8"));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[tinyclaw] 无法读取 memstores.toml：${err}`);
    }
    return MemStoresConfigSchema.parse({});
  }
  const result = MemStoresConfigSchema.safeParse(raw);
  if (!result.success) {
    console.warn(`[tinyclaw] memstores.toml 验证失败，使用空配置：${result.error.message}`);
    return MemStoresConfigSchema.parse({});
  }
  return result.data;
}

// ── MCP 载入（含诊断）─────────────────────────────────────────────────────────

/** 载入诊断的类别 */
export type McpLoadDiagCode =
  | "unreadable" // 文件读不到（权限等）
  | "syntax" // TOML 语法错误 → 整份配置按空处理
  | "schema" // 单个 [servers.X] 非法，已跳过 / servers 段结构非法
  | "empty" // 文件合法但没有任何 [servers.X] 定义
  | "secret" // env / headers 里的 ${SECRET:NAME} 引用了 secrets.toml 中不存在的键
  | "disabled"; // enabled = false（不是错误，供 agent 知情）

/** 一条 MCP 载入诊断 */
export interface McpLoadDiagnostic {
  level: "info" | "error";
  code: McpLoadDiagCode;
  scope: "file" | "server";
  /** scope = "server" 时必填 */
  server?: string;
  /** 已裁剪的安全文本：**绝不含被校验字段的原值** */
  message: string;
  /** 修复建议 */
  hint?: string;
}

/** loadMcpConfigDetailed 的返回 */
export interface McpLoadReport {
  config: MCPConfig;
  diagnostics: McpLoadDiagnostic[];
  /** mcp.toml 是否存在 */
  fileExists: boolean;
}

/** mcp.toml 的绝对路径 */
export function mcpConfigPath(): string {
  return path.join(os.homedir(), ".tinyclaw", "mcp.toml");
}

/** 构造一条诊断（exactOptionalPropertyTypes 下按需展开可选字段） */
function diag(
  level: "info" | "error",
  code: McpLoadDiagCode,
  scope: "file" | "server",
  message: string,
  extra: { server?: string; hint?: string } = {}
): McpLoadDiagnostic {
  return {
    level,
    code,
    scope,
    message,
    ...(extra.server !== undefined ? { server: extra.server } : {}),
    ...(extra.hint !== undefined ? { hint: extra.hint } : {}),
  };
}

/**
 * 把 Zod issues 压成安全文本：**只用 path + code，不带任何值**。
 *
 * ⚠️ 绝不要改回 `JSON.stringify(issues)` 或输出 `issue.received`：env / headers 的值写错类型时，
 * Zod 会把原值放进 `received`，而这段文本会经启动日志、`mcp_list_servers`、CLI 三处外泄 token。
 */
export function describeZodIssues(
  issues: readonly { path: readonly (string | number)[]; code: string }[]
): string {
  return issues
    .map((i) => `${i.path.length > 0 ? i.path.join(".") : "(root)"}: ${i.code}`)
    .join("; ");
}

/** `analyzeMcpTomlText` 的结果（不含"文件是否存在"这一层） */
export interface McpTomlAnalysis {
  config: MCPConfig;
  diagnostics: McpLoadDiagnostic[];
}

/**
 * 解析 mcp.toml 的**文本**并给出诊断（纯函数，不碰文件系统）。
 *
 * 供 `loadMcpConfigDetailed()` 与写入器（`mcp/config-writer.ts` 的写前校验）共用：
 * 只要这里有 error 诊断，就不该把这份文本当成"可用配置"（也不该落盘）。
 */
export function analyzeMcpTomlText(text: string): McpTomlAnalysis {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (err: unknown) {
    return {
      config: MCPConfigSchema.parse({}),
      diagnostics: [
        diag(
          "error",
          "syntax",
          "file",
          `mcp.toml TOML 语法错误，整份配置已按空处理：${
            err instanceof Error ? err.message : String(err)
          }`,
          {
            hint: "修好语法后执行 tinyclaw mcp reload（或重启服务）；修复前所有 MCP server 都不可用",
          }
        ),
      ],
    };
  }

  // 快路径：整份解析成功（含默认值填充）
  const result = MCPConfigSchema.safeParse(raw);
  if (result.success) {
    const diagnostics: McpLoadDiagnostic[] = [];
    const names = Object.keys(result.data.servers);
    if (names.length === 0) {
      diagnostics.push(
        diag(
          "info",
          "empty",
          "file",
          "mcp.toml 里没有 [servers.<name>] 定义，未加载任何 MCP server",
          { hint: "每个 server 写成一个 [servers.NAME] 块，字段参考 mcp.example.toml" }
        )
      );
    }
    for (const [name, srv] of Object.entries(result.data.servers)) {
      if (srv.enabled === false) {
        diagnostics.push(
          diag(
            "info",
            "disabled",
            "server",
            `[servers.${name}] enabled = false（已配置但不可启用）`,
            { server: name }
          )
        );
      }
    }
    return { config: result.data, diagnostics };
  }

  // 慢路径：逐个 server 容错解析，避免单个坏配置让全部 MCP 失效
  const containers = raw as { servers?: unknown } | null;
  const rawServers = containers?.servers;
  if (
    rawServers === undefined ||
    rawServers === null ||
    typeof rawServers !== "object" ||
    Array.isArray(rawServers)
  ) {
    return {
      config: MCPConfigSchema.parse({}),
      diagnostics: [
        diag(
          "error",
          "schema",
          "file",
          "mcp.toml 里没有可用的 [servers.<name>] 定义，未加载任何 MCP server",
          { hint: "每个 server 写成一个 [servers.NAME] 块，字段参考 mcp.example.toml" }
        ),
      ],
    };
  }

  const servers: Record<string, MCPServerConfig> = {};
  const diagnostics: McpLoadDiagnostic[] = [];
  for (const [name, cfg] of Object.entries(rawServers as Record<string, unknown>)) {
    const sr = MCPServerSchema.safeParse(cfg);
    if (sr.success) {
      servers[name] = sr.data;
      if (sr.data.enabled === false) {
        diagnostics.push(
          diag(
            "info",
            "disabled",
            "server",
            `[servers.${name}] enabled = false（已配置但不可启用）`,
            { server: name }
          )
        );
      }
      continue;
    }
    diagnostics.push(
      diag(
        "error",
        "schema",
        "server",
        `[servers.${name}] 配置非法，已跳过：${describeZodIssues(sr.error.issues)}`,
        {
          server: name,
          hint: '合法 transport 只有 "stdio"（需 command）与 "sse"（需 url）；字段名参考 mcp.example.toml',
        }
      )
    );
  }
  return { config: { servers }, diagnostics };
}

/**
 * 加载 ~/.tinyclaw/mcp.toml，同时返回诊断。
 *
 * 与旧行为的差别：**TOML 语法错误不再被伪装成"文件读取失败"**，而是给出 `code: "syntax"`
 * 的 error 诊断 —— 调用方（agent 工具 / CLI / 日志）据此能告诉用户"整份配置都没生效"。
 * 文件不存在时返回空配置且无诊断（未配置 MCP 属正常状态）。
 *
 * @param filePath 仅供测试注入；默认 `~/.tinyclaw/mcp.toml`
 */
export function loadMcpConfigDetailed(filePath: string = mcpConfigPath()): McpLoadReport {
  let text: string;
  try {
    text = fs.readFileSync(filePath, "utf-8");
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { config: MCPConfigSchema.parse({}), diagnostics: [], fileExists: false };
    }
    return {
      config: MCPConfigSchema.parse({}),
      fileExists: true,
      diagnostics: [
        diag("error", "unreadable", "file", `无法读取 mcp.toml（${code ?? "未知错误"}）`, {
          hint: `检查文件权限：chmod 600 ${filePath}`,
        }),
      ],
    };
  }
  return { ...analyzeMcpTomlText(text), fileExists: true };
}

/** 加载 ~/.tinyclaw/mcp.toml（只要配置，忽略诊断）。 */
export function loadMcpConfig(): MCPConfig {
  return loadMcpConfigDetailed().config;
}

/** 加载 ~/.tinyclaw/secrets.toml，文件不存在时返回空对象（非致命）。
 *
 * **有意不缓存**：每次调用都实时读取磁盘，确保主人修改 token 后立即生效，
 * 无需重启服务。secrets.toml 文件通常很小，IO 开销可忽略。
 */
export function loadSecretsConfig(): SecretsConfig {
  const p = path.join(os.homedir(), ".tinyclaw", "secrets.toml");
  // 敏感文件权限守卫:secrets.toml 含全部第三方 token,过宽则告警
  try {
    const guard = loadConfig().auth.secret_guard;
    if (guard.enabled && fs.existsSync(p)) {
      ensureSecureFilePerm(p, "secrets.toml", guard.autoChmod);
    }
  } catch {
    /* 守卫失败不阻塞 */
  }
  let raw: unknown;
  try {
    raw = parse(fs.readFileSync(p, "utf-8"));
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(`[tinyclaw] 无法读取 secrets.toml：${err}`);
    }
    return {};
  }
  // 先尝试整体解析（快路径）
  const result = SecretsConfigSchema.safeParse(raw);
  if (result.success) {
    return result.data;
  }

  // 整体解析失败 → 逐条容错，避免单个格式错误使全部 secrets 丢失（如 QQBOT_MAIN）
  console.warn(
    `[tinyclaw] secrets.toml 验证失败，尝试逐条加载: ${JSON.stringify(result.error.issues)}`
  );
  const secrets: SecretsConfig = {};
  const rawRecord = raw as Record<string, unknown>;
  for (const [key, val] of Object.entries(rawRecord)) {
    const sr = SecretEntrySchema.safeParse(val);
    if (sr.success) {
      secrets[key] = sr.data;
    } else {
      console.warn(
        `[tinyclaw] secrets.toml [${key}] 格式无效，已跳过: ${JSON.stringify(sr.error.issues)}`
      );
    }
  }
  return secrets;
}
