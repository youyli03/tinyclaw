/**
 * 模型别名(alias)解析。
 *
 * 别名让用户在 QQ 内用短名(如 `opus`、`mimo`、`free`)切换模型,
 * 而非每次输入完整的 `provider/model-id`。
 *
 * 解析优先级:
 *   1. config.llm.aliases 中的用户自定义别名(可覆盖内置)
 *   2. 内置 BUILTIN_ALIASES
 *   3. 若输入本身就是 `provider/model-id`(含 "/"),原样视为完整 symbol
 */

import { loadConfig } from "../config/loader.js";

/**
 * 内置默认别名。键为短名,值为完整 model symbol。
 * 与当前常用模型对齐,用户可在 config.toml 的 [llm.aliases] 覆盖或扩展。
 */
export const BUILTIN_ALIASES: Record<string, string> = {
  // Copilot
  opus: "copilot/claude-opus-4.8",
  sonnet: "copilot/claude-sonnet-4.6",
  prime: "copilot/oswe-vscode-prime",
  "gpt4o": "copilot/gpt-4o",
  "auto": "copilot/auto",
  // MiMo
  mimo: "mimo/mimo-v2.5",
  "mimo-pro": "mimo/mimo-v2.5-pro",
  // OpenRouter
  free: "openrouter/auto-free",
  // Google Gemini
  gemini: "google/gemini-2.5-flash",
  flash: "google/gemini-2.5-flash",
};

/**
 * 合并内置别名与 config.llm.aliases(config 覆盖内置),返回完整别名表。
 */
export function getAliases(): Record<string, string> {
  let userAliases: Record<string, string> = {};
  try {
    userAliases = loadConfig().llm.aliases ?? {};
  } catch {
    /* config 加载失败时仅用内置 */
  }
  return { ...BUILTIN_ALIASES, ...userAliases };
}

/**
 * 解析别名或完整 symbol。
 * @returns 解析出的完整 model symbol;无法解析时返回 undefined。
 */
export function resolveAlias(input: string): string | undefined {
  const key = input.trim();
  if (!key) return undefined;
  const aliases = getAliases();
  // 1. 别名命中(大小写不敏感)
  const lower = key.toLowerCase();
  for (const [name, symbol] of Object.entries(aliases)) {
    if (name.toLowerCase() === lower) return symbol;
  }
  // 2. 本身就是完整 symbol(含 "/")
  if (key.includes("/")) return key;
  return undefined;
}

/**
 * 反查:给定完整 symbol,返回匹配的别名(用于展示)。无匹配返回 undefined。
 */
export function aliasForSymbol(symbol: string): string | undefined {
  const aliases = getAliases();
  for (const [name, sym] of Object.entries(aliases)) {
    if (sym === symbol) return name;
  }
  return undefined;
}
