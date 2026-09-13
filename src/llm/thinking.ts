/**
 * DeepSeek thinking / reasoning_effort 档位（单一真相）
 *
 * 为什么单独一个文件：同一套档位要被三处共用——
 *  1. `config/schema.ts`（后端默认档位校验）
 *  2. `llm/client.ts`（**两个** 请求构造点：非流式 + 流式）
 *  3. `commands/builtin.ts` 的 `/think` 命令（用户可见的取值列表）
 * 散在三处必然漂移，所以解析逻辑只写在这里。
 *
 * ⚠️ 实测事实（2026-09-13，`tmp/probe-reasoning-effort-20260913.ts`）：
 * `https://api.deepseek.com/v1` 接受的 `reasoning_effort` 是
 * `none | minimal | low | medium | high | xhigh | max`；
 * DSH 内部用的 `off` **不是**合法线级取值（发 `off` 直接 400：
 * `unknown variant "off", expected one of none, minimal, low, medium, high, xhigh, max`）。
 * 真正"关闭思考"只有一条路：`{thinking:{type:"disabled"}}`（不带 reasoning_effort）。
 * 另外 `reasoning_effort: "none"` **不等于**关闭思考——实测同一道题仍产出 ~142 reasoning tokens。
 */

/** 线级合法的思考档位（按强度递增）。 */
export const THINKING_LEVELS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/**
 * 会话/请求级思考设置 = 线级档位 + `off`（框架侧别名）。
 * `off` 不发 `reasoning_effort`，而是发 `{thinking:{type:"disabled"}}`。
 */
export type ThinkingSetting = "off" | ThinkingLevel;

export const THINKING_SETTINGS: readonly ThinkingSetting[] = ["off", ...THINKING_LEVELS];

/** 用户输入的别名（中文/缩写）→ 规范档位 */
const THINKING_ALIASES: Record<string, ThinkingSetting> = {
  off: "off",
  disable: "off",
  disabled: "off",
  none: "none",
  no: "none",
  min: "minimal",
  minimal: "minimal",
  low: "low",
  med: "medium",
  mid: "medium",
  medium: "medium",
  high: "high",
  xhigh: "xhigh",
  extra: "xhigh",
  max: "max",
  maximum: "max",
};

export function isThinkingLevel(v: string): v is ThinkingLevel {
  return (THINKING_LEVELS as readonly string[]).includes(v);
}

export function isThinkingSetting(v: string): v is ThinkingSetting {
  return isThinkingLevel(v) || v === "off";
}

/** 规范化用户输入（别名 → 档位）；无法识别时返回 undefined。 */
export function normalizeThinkingSetting(raw: string): ThinkingSetting | undefined {
  return THINKING_ALIASES[raw.trim().toLowerCase()];
}

/** 该 provider 的线级 thinking 参数是否接线（与 `llm/registry.ts` 的 deepseek 分支一致）。 */
export function providerSupportsThinking(provider: string): boolean {
  return provider === "deepseek";
}

/**
 * 解析最终要发给 API 的 thinking 参数。
 *
 * 优先级（高 → 低）：
 *  1. `setting`                          会话/请求级覆盖（`/think` 写入）
 *  2. `backendDisabled`                  后端配置 `disableThinking: true`
 *  3. `backendEffort`                    后端配置的 `reasoningEffort`
 *  4. `enableThinking && thinkingBudget` 旧 budget_tokens 路径
 *  5. 什么都不发
 * （2 高于 3 是既有的"互斥"语义：`disableThinking` 设了就压过 `reasoningEffort`。）
 *
 * ⚠️ `setting` 只有在后端声明 `thinkingControl`（见 `ChatOptions.thinking` 的调用点）时才应传入，
 * 否则会把 DeepSeek 专有字段发给 Copilot/OpenRouter 等不认它的端点。
 */
export function resolveThinkingParams(opts: {
  setting?: ThinkingSetting;
  backendEffort?: ThinkingLevel;
  backendDisabled?: boolean;
  enableThinking?: boolean;
  thinkingBudget?: number;
}): Record<string, unknown> {
  const chosen: ThinkingSetting | undefined =
    opts.setting ?? (opts.backendDisabled ? "off" : opts.backendEffort);
  if (chosen !== undefined) {
    return chosen === "off"
      ? { thinking: { type: "disabled" } }
      : { thinking: { type: "enabled" }, reasoning_effort: chosen };
  }
  if (opts.enableThinking && opts.thinkingBudget) {
    return { thinking: { type: "enabled", budget_tokens: opts.thinkingBudget } };
  }
  return {};
}
