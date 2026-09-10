/**
 * 保留工具参数 `__purpose`
 *
 * 模型可以在**任意**工具调用（内置 / MCP / 自定义）的参数里附带一个短旁白，
 * 说明"此刻在做什么"。框架在执行前把它剥掉（工具实现永远看不到这个字段），
 * 并交给 purpose-arbiter 决定何时把它作为进度提示展示给用户。
 *
 * 本模块只做三件事，全部为纯函数：
 *   - injectPurposeParam：给每个工具的 parameters.properties 追加可选 `__purpose`（深拷贝，绝不改原对象）
 *   - stripReservedArgs：执行前剥离保留字段
 *   - normalizePurpose：归一化 + 按"10 个单位"截断（emoji 不计长度，且按字素簇切，不会切碎 emoji）
 */

import type { ChatCompletionTool } from "openai/resources/chat/completions";
import { createLogger } from "../utils/logger.js";

const log = createLogger("tool-args");

/** 保留参数名：`__` 前缀避免与任何真实工具参数撞名 */
export const PURPOSE_PARAM = "__purpose";

/** purpose 的默认长度上限（单位数，见 normalizePurpose 的计数规则） */
const DEFAULT_MAX_UNITS = 10;

/** 追加到每个工具 schema 里的 `__purpose` 定义（每次注入都新建一个对象，避免共享引用） */
function purposePropertySchema(): Record<string, unknown> {
  return {
    type: "string",
    description:
      "可选。一句面向用户的短旁白，说明你此刻在做什么；会在用户等待时作为进度提示展示给他。" +
      "10 个中文字以内或 10 个英文词以内（emoji 随意、不计长度）。只在会让他等的关键节点填。" +
      "例：「🔍 正在查你最近三个月的持仓」。",
  };
}

/** 深拷贝（优先 structuredClone，失败则回退到 JSON 往返）；只用于纯 JSON 的工具 schema */
function deepClone<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch (err) {
    log.debug("structuredClone 失败，回退 JSON 往返", err);
    return JSON.parse(JSON.stringify(value)) as T;
  }
}

/** 取出已存在的 properties（非纯对象则忽略） */
function readProperties(params: Record<string, unknown>): Record<string, unknown> | undefined {
  const props = params["properties"];
  if (props !== null && typeof props === "object" && !Array.isArray(props)) {
    return props as Record<string, unknown>;
  }
  return undefined;
}

/**
 * 给每个工具的参数 schema 追加可选 `__purpose`。
 *
 * 关键：getAllToolSpecs() 返回的是注册表里**同一个对象引用**。
 * 若原地修改，每一轮 Agent 循环都会再追加一次，schema 会无限膨胀并污染所有 session。
 * 因此这里始终返回全新的 tool / parameters / properties 对象，绝不改动入参。
 * 每轮对"新的数组"调用本函数即可，不保证幂等（每次都会构造新对象），但必须是纯函数。
 */
export function injectPurposeParam(tools: ChatCompletionTool[]): ChatCompletionTool[] {
  return tools.map((tool) => {
    const fn = tool.function;
    const sourceParams = (fn.parameters ?? {}) as Record<string, unknown>;
    const params = deepClone(sourceParams);
    const props = readProperties(params) ?? {};

    // 已存在则不覆盖（尊重调用方/其它插件注入的定义）
    if (!(PURPOSE_PARAM in props)) {
      props[PURPOSE_PARAM] = purposePropertySchema();
    }

    params["type"] = typeof params["type"] === "string" ? params["type"] : "object";
    params["properties"] = props;

    return {
      ...tool,
      function: { ...fn, parameters: params },
    };
  });
}

/**
 * 执行前剥离保留字段。
 *
 * - 返回 args 的浅拷贝（不改动入参）
 * - `purpose` 仅在原值为字符串时返回，且保持**原样**（不做归一化），否则整个 key 不出现
 *   （exactOptionalPropertyTypes 下不允许显式赋 undefined）
 * - args 不是普通对象时返回 `{ args: {} }`
 */
export function stripReservedArgs(args: Record<string, unknown>): {
  args: Record<string, unknown>;
  purpose?: string;
} {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    return { args: {} };
  }

  const rest: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (key === PURPOSE_PARAM) continue;
    rest[key] = value;
  }

  const raw = args[PURPOSE_PARAM];
  return typeof raw === "string" ? { args: rest, purpose: raw } : { args: rest };
}

/** 按字素簇切分（Node 20.11 有 Intl.Segmenter；失败回退 Array.from，保证不切碎代理对） */
function graphemes(text: string): string[] {
  try {
    const segmenter = new Intl.Segmenter("zh", { granularity: "grapheme" });
    const out: string[] = [];
    for (const part of segmenter.segment(text)) out.push(part.segment);
    if (out.length > 0) return out;
    // 全空白等场景可能得到空数组，下方返回 text 保证语义不变
    if (text.length === 0) return out;
  } catch (err) {
    log.debug("Intl.Segmenter 不可用，回退 Array.from 切分", err);
  }
  return Array.from(text);
}

/** CJK 表意 / 假名 / 谚文（含扩展区），每个算 1 个单位 */
function isCjkCodePoint(cp: number): boolean {
  return (
    (cp >= 0x3040 && cp <= 0x30ff) || // 平假名 + 片假名
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK 扩展 A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK 基本区
    (cp >= 0xac00 && cp <= 0xd7af) || // 谚文音节
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容表意
    (cp >= 0x20000 && cp <= 0x2fa1f) // CJK 扩展 B~F + 兼容补充
  );
}

/** ASCII 字母 / 数字：连续一段算 1 个单位（`API`=1、`deepseek-v4`=2） */
function isAsciiAlnum(cp: number): boolean {
  return (cp >= 48 && cp <= 57) || (cp >= 65 && cp <= 90) || (cp >= 97 && cp <= 122);
}

/**
 * 逐个字素簇统计单位数，并在恰好首次超标时停在"上一个字素簇"。
 *
 * 计数规则（与需求一致）：
 *   - CJK 字符 = 1 单位
 *   - 连续 ASCII 字母/数字 = 1 单位（任何非字母数字 ASCII 都是分隔符）
 *   - 空白 / 标点 / emoji / 其它非 ASCII 符号 = 0 单位，但会被原样保留
 *
 * 返回：`units` = 清理后字符串的完整单位数；`truncated` = 是否超标；
 * `keptFrom` = 未越界的字素簇个数（截断时的安全切点）。
 */
function walkUnits(
  text: string,
  maxUnits: number
): { units: number; truncated: boolean; keptFrom: number } {
  const parts = graphemes(text);
  let keptFrom = 0;
  let inAsciiRun = false;
  let count = 0;

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i] ?? "";
    let hasAscii = false;
    let hasCjk = false;
    for (const ch of part) {
      const cp = ch.codePointAt(0) ?? 0;
      if (isAsciiAlnum(cp)) {
        hasAscii = true;
      } else if (isCjkCodePoint(cp)) {
        hasCjk = true;
      }
    }

    let add = 0;
    if (hasCjk) {
      add = 1;
      inAsciiRun = false;
    } else if (hasAscii) {
      // 一段连续的字母/数字只算 1 个单位
      add = inAsciiRun ? 0 : 1;
      inAsciiRun = true;
    } else {
      inAsciiRun = false;
    }

    if (add > 0 && count + add > maxUnits) {
      return { units: count + add, truncated: true, keptFrom };
    }

    count += add;
    keptFrom = i + 1;
  }

  return { units: count, truncated: false, keptFrom };
}

/**
 * 归一化 purpose 并限制长度。
 *
 * - 仅接受字符串，其它类型返回 undefined
 * - 折叠内部换行 / 制表符 / 连续空格为单个空格，并 trim；空串 → undefined
 * - 单位数 ≤ maxUnits 时原样返回清理后的字符串（emoji 与原有空格都保留）
 * - 超出时按**字素簇**边界截断（emoji / 代理对永不被切碎），去掉尾部空格后追加 "…"
 * - maxUnits <= 0 表示不限长
 * - 发生截断时打 warn，附带原始单位数
 */
export function normalizePurpose(raw: unknown, maxUnits = DEFAULT_MAX_UNITS): string | undefined {
  if (typeof raw !== "string") return undefined;

  const cleaned = raw.replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) return undefined;

  const limit = Number.isFinite(maxUnits) ? Math.floor(maxUnits) : DEFAULT_MAX_UNITS;
  if (limit <= 0) return cleaned;

  const { units, truncated, keptFrom } = walkUnits(cleaned, limit);
  if (!truncated) return cleaned;

  const parts = graphemes(cleaned);
  let kept = parts.slice(0, keptFrom).join("");
  // 字素簇整体保留，可能留下尾部空格
  while (kept.endsWith(" ")) kept = kept.slice(0, -1);

  log.warn(
    `purpose 超长已截断：原 ${units} 单位 / 上限 ${limit} 单位`,
    JSON.stringify(cleaned.slice(0, 60))
  );
  return `${kept}…`;
}
