/**
 * `config.toml` 写前校验（纯逻辑，不做写入）
 *
 * 三层：
 * 1. **语法**：`parse()` 失败 → error（TOML 写坏了）
 * 2. **schema**：`ConfigSchema.safeParse()`（与 `loadConfig()` 同一份真相）
 * 3. **交叉引用**：schema 表达不了的"能不能跑起来" —— 工具名拼写、路径绝对/存在、
 *    agentId 存在、`$SECRET` 占位符在 `secrets.toml` 里存在、后端引用的 provider 有没有凭证
 *
 * ⚠️ 与 `mcp.toml` 的载入诊断同一条安全口径：**诊断文本绝不回显字段原值**。
 * - Zod issue 只用 `path` + `code`（+ `expected`，那是 schema 侧信息），不用 `message`/`received`
 * - 语法错误消息会裁剪掉形似 token 的长串
 * 原因：`apiKey` 这类字段写错类型时，Zod 的 `received` 会把密钥带出来，而诊断会进日志/CLI/工具返回。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse } from "smol-toml";
import { ConfigSchema, type Config } from "./schema.js";

/** 一条配置诊断 */
export interface ConfigDiag {
  level: "error" | "warn";
  /** 配置路径，如 `auth.mfa.timeoutSecs`；文件级用 `(file)` */
  path: string;
  /** 已裁剪的安全文本 */
  message: string;
  /** 修法建议 */
  hint?: string;
}

export interface ValidateOptions {
  /**
   * 判断工具名是否存在（`tools/registry.ts` 的 `getTool`）。
   * 只在**工具注册表已加载**的上下文传（服务进程 / agent 工具）；CLI 独立进程里注册表是空的，
   * 传了会把所有工具名误判为不存在。
   */
  knownTool?: (name: string) => boolean;
  /** 判断 agentId 是否存在（`agentManager.listAgentIds()`） */
  knownAgent?: (id: string) => boolean;
  /** 注入 secrets.toml 的键名集合（测试用）；不传则实时读盘的**键名**（不读值） */
  secretKeys?: ReadonlySet<string>;
}

export interface ConfigValidation {
  /** 通过 schema 时的解析结果（含默认值）；语法/schema 失败时为 undefined */
  config?: Config;
  diagnostics: ConfigDiag[];
}

/** 诊断里是否存在 error */
export function hasConfigErrors(diags: ConfigDiag[]): boolean {
  return diags.some((d) => d.level === "error");
}

/** 构造一条诊断（exactOptionalPropertyTypes：按需展开可选字段） */
function diag(
  level: "error" | "warn",
  p: string,
  message: string,
  hint?: string
): ConfigDiag {
  return { level, path: p, message, ...(hint !== undefined ? { hint } : {}) };
}

/**
 * 裁剪可能含密钥的文本：把形似 token 的长串替换掉。
 * 语法错误消息里可能带出出错那一行的内容，而那一行可能就是 `apiKey = "..."`。
 */
export function redactSecretsInText(text: string): string {
  return text.replace(/[A-Za-z0-9_\-.]{20,}/g, "***");
}

/** `$NAME` 形式的密钥占位符（`connectors/qqbot/index.ts` 的 `resolveSecret` 认这个） */
const SECRET_PLACEHOLDER_RE = /^\$([A-Z][A-Z0-9_]*)$/;

/** 只读 secrets.toml 的**键名**（不读值、不触发 `loadConfig()`，避免与 fail-fast 互相拖累） */
export function readSecretKeys(): Set<string> {
  const p = path.join(os.homedir(), ".tinyclaw", "secrets.toml");
  const keys = new Set<string>();
  try {
    const raw = parse(fs.readFileSync(p, "utf-8")) as Record<string, unknown>;
    for (const k of Object.keys(raw)) keys.add(k);
  } catch {
    /* 文件不存在或不可读 → 空集合（占位符检查会按"缺失"处理） */
  }
  return keys;
}

/** 遍历配置里的所有字符串值：`path` → 值 */
function collectStrings(node: unknown, prefix: string, out: Array<[string, string]>): void {
  if (typeof node === "string") {
    out.push([prefix, node]);
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((v, i) => collectStrings(v, `${prefix}[${i}]`, out));
    return;
  }
  if (node !== null && typeof node === "object") {
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      collectStrings(v, prefix === "" ? k : `${prefix}.${k}`, out);
    }
  }
}

/** 内置 provider 名（`ProvidersSchema` 的键） */
const KNOWN_PROVIDERS = new Set(["openai", "copilot", "openrouter", "deepseek", "mimo", "google"]);

/**
 * 找出"原始 TOML 里有、但 schema 解析结果里没有"的键路径。
 *
 * Zod 的 object 默认是 strip：拼错的 section/键会被**静默丢掉**（如历史上
 * `[channels.qqbot]` 而 schema 只认 `channels.qqbots`）→ 用户以为改生效了，其实没有。
 */
export function collectUnknownPaths(raw: unknown, parsed: unknown, prefix: string): string[] {
  const out: string[] = [];
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return out;
  const p = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const child = (p as Record<string, unknown>)[k];
    const childPath = prefix === "" ? k : `${prefix}.${k}`;
    if (child === undefined) {
      out.push(childPath);
      continue;
    }
    out.push(...collectUnknownPaths(v, child, childPath));
  }
  return out;
}

/**
 * 校验一份 `config.toml` 文本。
 *
 * 不读盘、不 exit、不抛错：调用方决定"拒绝写入"还是"只提示"。
 */
export function validateConfigText(text: string, opts: ValidateOptions = {}): ConfigValidation {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message.split("\n")[0] ?? "" : String(err);
    return {
      diagnostics: [
        diag("error", "(file)", `TOML 语法错误：${redactSecretsInText(msg)}`, "修好语法后重试"),
      ],
    };
  }

  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    // 只用 path + code（+ expected），绝不带 received/message —— 见文件头注释
    const diagnostics = result.error.issues.map((i) => {
      const p = i.path.length > 0 ? i.path.join(".") : "(root)";
      const expected = "expected" in i && typeof i.expected === "string" ? `（期望 ${i.expected}）` : "";
      return diag("error", p, `${i.code}${expected}`);
    });
    return { diagnostics };
  }

  const cfg = result.data;
  const diagnostics: ConfigDiag[] = [];
  const secretKeys = opts.secretKeys ?? readSecretKeys();

  // ── 0. schema 不认识的键（Zod 默认 strip → 会被**静默忽略**） ──
  for (const p of collectUnknownPaths(raw, cfg, "")) {
    diagnostics.push(
      diag("warn", p, "schema 不认识这个键，运行时会被静默忽略", "检查拼写；对照 config.example.toml / schema.ts")
    );
  }

  // ── 1. 后端引用的 provider 是否有凭证（warn：本地/别名场景可能有意为之） ──
  for (const role of ["daily", "code", "summarizer"] as const) {
    const model = cfg.llm.backends[role]?.model ?? "";
    const provider = model.includes("/") ? model.split("/")[0]! : "";
    if (provider === "" || !KNOWN_PROVIDERS.has(provider)) continue;
    const prov = (cfg.providers as Record<string, unknown>)[provider];
    if (prov === undefined) {
      diagnostics.push(
        diag(
          "warn",
          `llm.backends.${role}.model`,
          `后端 ${role} 用 provider "${provider}"，但 [providers.${provider}] 未配置`,
          `补上 [providers.${provider}] 或改用已配置的 provider`
        )
      );
    }
  }

  // ── 2. `$SECRET` 占位符必须在 secrets.toml 里存在（warn：运行时才会抛错） ──
  const strings: Array<[string, string]> = [];
  collectStrings(cfg, "", strings);
  for (const [p, value] of strings) {
    const m = SECRET_PLACEHOLDER_RE.exec(value.trim());
    if (m === null) continue;
    const key = m[1]!;
    if (!secretKeys.has(key)) {
      diagnostics.push(
        diag("warn", p, `引用了 secrets.toml 中不存在的键 $${key}（运行到该处会报错）`, `在 secrets.toml 里加 ${key}`)
      );
    }
  }

  // ── 3. 工具名拼写（需要注册表；只在服务/agent 上下文传 knownTool） ──
  if (opts.knownTool) {
    const known = opts.knownTool;
    const toolLists: Array<[string, string[]]> = [
      ["auth.mfa.tools", cfg.auth.mfa?.tools ?? []],
      ["sandbox.unattended.allowedTools", cfg.sandbox.unattended.allowedTools],
    ];
    for (const [p, names] of toolLists) {
      names.forEach((name, i) => {
        if (!known(name)) {
          diagnostics.push(
            diag(
              "error",
              `${p}[${i}]`,
              `工具 "${name}" 不存在（疑似拼写错误）`,
              "写错的名字不会生效：无人值守白名单里写错 = 该工具被静默拒绝"
            )
          );
        }
      });
    }
  }

  // ── 4. 可写路径必须是绝对路径；存在性只 warn（挂载点可能后到） ──
  cfg.sandbox.extraRwPaths.forEach((p, i) => {
    const expanded = p.startsWith("~") ? path.join(os.homedir(), p.slice(1)) : p;
    if (!path.isAbsolute(expanded)) {
      diagnostics.push(
        diag("error", `sandbox.extraRwPaths[${i}]`, `"${p}" 不是绝对路径`, "写绝对路径（可用 ~ 开头）")
      );
      return;
    }
    if (!fs.existsSync(expanded)) {
      diagnostics.push(diag("warn", `sandbox.extraRwPaths[${i}]`, `路径不存在：${p}`, "沙箱绑定会失败"));
    }
  });

  // ── 5. 授权列表里的 agentId 是否存在（warn：可能是先配置后创建 agent） ──
  if (opts.knownAgent) {
    const knownAgent = opts.knownAgent;
    const agentLists: Array<[string, string[]]> = [
      ["selfAccess.grantedAgents", cfg.selfAccess.grantedAgents],
      ["sandbox.elevation.allowedAgents", cfg.sandbox.elevation.allowedAgents],
    ];
    for (const [p, ids] of agentLists) {
      ids.forEach((id, i) => {
        if (id === "*") return;
        if (!knownAgent(id)) {
          diagnostics.push(
            diag("warn", `${p}[${i}]`, `agent "${id}" 不存在`, "该条授权不会生效")
          );
        }
      });
    }
  }

  return { config: cfg, diagnostics };
}

/** 展示层：诊断 → 可打印行（CLI / 工具 / 日志共用） */
export function formatConfigDiags(diags: ConfigDiag[]): string[] {
  if (diags.length === 0) return [];
  const errors = diags.filter((d) => d.level === "error").length;
  const lines = [`## ${errors > 0 ? "⚠️ 配置校验未通过" : "ℹ️ 配置校验提示"} (${diags.length})`];
  for (const d of diags) {
    lines.push(`- [${d.level}] ${d.path}: ${d.message}`);
    if (d.hint !== undefined) lines.push(`  → ${d.hint}`);
  }
  return lines;
}
