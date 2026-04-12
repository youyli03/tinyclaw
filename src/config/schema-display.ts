/**
 * Config 展示元数据与通用渲染函数
 *
 * DISPLAY_META：与 schema 平行的展示描述（不修改 schema.ts）
 * renderConfig：遍历 ConfigSchema.shape，按 sectionTitle 分块自动展示所有字段
 */

import { z } from "zod";
import { ConfigSchema, type Config } from "./schema.js";
import { bold, dim, green, cyan, section } from "../cli/ui.js";

// ── 展示元数据 ────────────────────────────────────────────────────────────────

export interface FieldMeta {
  /** 顶级字段作为 section 时的中文标题（仅顶级字段使用） */
  sectionTitle?: string;
  /** 是否脱敏显示（密钥等）*/
  sensitive?: boolean;
  /** 值后追加的额外说明（如 "(0 = 不限制)"） */
  hint?: string;
  /** 在 config show 中跳过（已有专门展示的字段，或不需要展示的字段）*/
  skip?: boolean;
}

export const DISPLAY_META: Record<string, FieldMeta> = {
  // ── 顶级 section 标题 ──────────────────────────────────────────────────────
  providers:                              { sectionTitle: "Providers（凭证）" },
  llm:                                    { sectionTitle: "LLM 配置" },
  auth:                                   { sectionTitle: "Auth / MFA" },
  channels:                               { sectionTitle: "Channels" },
  memory:                                 { sectionTitle: "Memory" },
  submitter:                              { sectionTitle: "Submitter（自动提交）" },
  tools:                                  { sectionTitle: "Tools" },
  agent:                                  { sectionTitle: "Agent 行为" },
  concurrency:                            { sectionTitle: "Concurrency（并发控制）" },
  voice:                                  { sectionTitle: "Voice（语音识别）" },
  retry:                                  { sectionTitle: "Retry（重试策略）" },
  web:                                    { sectionTitle: "Web Dashboard" },

  // ── 敏感字段 ────────────────────────────────────────────────────────────────
  "providers.copilot.githubToken":        { sensitive: true },
  "providers.openai.apiKey":              { sensitive: true },
  "channels.qqbot.appId":                { sensitive: true },
  "channels.qqbot.clientSecret":          { sensitive: true },
  "auth.mfa.tenantId":                    { sensitive: true },
  "auth.mfa.clientId":                    { sensitive: true },
  "web.token":                            { sensitive: true },

  // ── 数值补充说明 ────────────────────────────────────────────────────────────
  "retry.maxAttempts":                    { hint: "(-1 = 无限)" },
  "retry.max5xxAttempts":                 { hint: "(-1 = 无限)" },
  "retry.maxTransportAttempts":           { hint: "(-1 = 无限)" },
  "retry.maxRetryDurationMs":             { hint: "(0 = 不限制)" },
  "retry.streamIdleTimeoutMs":            { hint: "(0 = 禁用)" },
  "concurrency.maxConcurrentLLMRequests": { hint: "(0 = 不限制)" },
  "agent.heartbeatIntervalSecs":          { hint: "(0 = 关闭心跳)" },
  "tools.maxCodeToolRounds":              { hint: "(0 = 不限制)" },
  "tools.maxChatToolRounds":              { hint: "(0 = 不限制)" },
  "memory.tokenThreshold":               { hint: "(0.1-0.99)" },
  "submitter.intervalSecs":              { hint: "(秒；默认 14400 = 4h)" },
};

// ── 脱敏辅助 ─────────────────────────────────────────────────────────────────

function mask(s: string): string {
  if (s.length <= 8) return "***";
  return s.slice(0, 4) + "..." + s.slice(-4);
}

// ── 通用值渲染 ────────────────────────────────────────────────────────────────

function renderValue(
  value: unknown,
  dotPath: string,
  indent: string
): string {
  const meta = DISPLAY_META[dotPath];

  // null/undefined 最先处理（包括敏感字段也可能是未设置）
  if (value === null || value === undefined) {
    return dim("(未设置)");
  }

  // 脱敏字段
  if (meta?.sensitive) {
    const str = typeof value === "string" ? value : JSON.stringify(value) ?? String(value);
    const hint = meta.hint ? `  ${dim(meta.hint)}` : "";
    return `${dim(mask(str))}${hint}`;
  }

  // 布尔
  if (typeof value === "boolean") {
    const hint = meta?.hint ? `  ${dim(meta.hint)}` : "";
    return (value ? green("true") : dim("false")) + hint;
  }

  // 数字
  if (typeof value === "number") {
    const hint = meta?.hint ? `  ${dim(meta.hint)}` : "";
    return cyan(String(value)) + hint;
  }

  // 字符串
  if (typeof value === "string") {
    const hint = meta?.hint ? `  ${dim(meta.hint)}` : "";
    return cyan(value) + hint;
  }

  // 数组
  if (Array.isArray(value)) {
    if (value.length === 0) return dim("[]");
    // 简单类型数组单行
    if (value.every((v) => typeof v !== "object" || v === null)) {
      const hint = meta?.hint ? `  ${dim(meta.hint)}` : "";
      return `[${value.map((v) => cyan(String(v))).join(", ")}]` + hint;
    }
    // 对象数组多行
    const lines = value.map((item, i) => {
      if (typeof item === "object" && item !== null) {
        const entries = Object.entries(item as Record<string, unknown>)
          .map(([k, v]) => `${k} = ${renderValue(v, `${dotPath}[${i}].${k}`, indent + "    ")}`)
          .join(`, `);
        return `${indent}  { ${entries} }`;
      }
      return `${indent}  ${String(item)}`;
    });
    return "\n" + lines.join("\n");
  }

  // 对象（不应到这里，对象由 renderObject 处理）
  if (typeof value === "object") {
    return dim(JSON.stringify(value));
  }

  return String(value);
}

/**
 * 递归渲染一个对象（按 schema 字段顺序）。
 *
 * @param schema    对应的 Zod schema（ZodObject）
 * @param value     实际配置值（已解析，含默认值）
 * @param dotPath   当前对象的 dot-path 前缀
 * @param indent    缩进字符串
 */
function renderObject(
  schema: z.ZodTypeAny,
  value: unknown,
  dotPath: string,
  indent: string
): void {
  // unwrap 包装层
  while (true) {
    const tn = schema._def?.typeName as string | undefined;
    if (tn === "ZodDefault" || tn === "ZodOptional" || tn === "ZodNullable") {
      schema = schema._def.innerType as z.ZodTypeAny;
    } else {
      break;
    }
  }

  const tn = schema._def?.typeName as string | undefined;
  if (tn !== "ZodObject") return;

  const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
  const obj = (typeof value === "object" && value !== null ? value : {}) as Record<string, unknown>;

  for (const [key, childSchema] of Object.entries(shape)) {
    const childPath = dotPath ? `${dotPath}.${key}` : key;
    const meta = DISPLAY_META[childPath];
    if (meta?.skip) continue;

    const childValue = obj[key];

    // 判断子 schema 是否是对象类型（需要递归）
    let unwrapped = childSchema as z.ZodTypeAny;
    while (true) {
      const ctn = unwrapped._def?.typeName as string | undefined;
      if (ctn === "ZodDefault" || ctn === "ZodOptional" || ctn === "ZodNullable") {
        unwrapped = unwrapped._def.innerType as z.ZodTypeAny;
      } else {
        break;
      }
    }
    const isObj = unwrapped._def?.typeName === "ZodObject";

    if (isObj && typeof childValue === "object" && childValue !== null) {
      console.log(`${indent}${bold(key)}:`);
      renderObject(childSchema as z.ZodTypeAny, childValue, childPath, indent + "  ");
    } else {
      const rendered = renderValue(childValue, childPath, indent);
      const keyPad = key.padEnd(28);
      console.log(`${indent}${dim(keyPad)} = ${rendered}`);
    }
  }
}

/**
 * 完整渲染 config show 的所有 schema 字段。
 *
 * 遍历 ConfigSchema.shape 的顶级字段，按 DISPLAY_META 里的 sectionTitle 分 section 展示。
 * MCP Servers / MemStores（独立 toml 文件）不在此函数中处理，由调用方在末尾追加。
 *
 * @param cfg   已解析的 Config（含所有默认值）
 */
export function renderConfig(cfg: Config): void {
  const topShape = ConfigSchema.shape;

  for (const [key, schema] of Object.entries(topShape)) {
    const meta = DISPLAY_META[key];
    if (meta?.skip) continue;

    const title = meta?.sectionTitle ?? key;
    section(title);

    const value = (cfg as unknown as Record<string, unknown>)[key];
    renderObject(schema as z.ZodTypeAny, value, key, "  ");
    console.log();
  }
}
