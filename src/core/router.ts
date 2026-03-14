/**
 * 意图路由：判断用户消息是否属于代码任务，
 * 代码类消息 → dispatch 给 codex/copilot 工具，
 * 日常消息   → 由 daily Agent 直接回复。
 */

const CODE_PATTERNS = [
  /写[一个]?代码/,
  /帮.*实现/,
  /debug|调试/i,
  /重构|refactor/i,
  /写.*函数|写.*类|写.*脚本/,
  /修复.*bug|fix.*bug/i,
  /生成.*代码/,
  /codex|copilot/i,
];

export type RouteKind = "code" | "daily";

/**
 * 根据用户消息判断路由类型。
 * 简单规则匹配，实际 Agent 循环中 LLM 会通过 tool_call 做更精确的判断。
 */
export function routeMessage(userContent: string): RouteKind {
  for (const pattern of CODE_PATTERNS) {
    if (pattern.test(userContent)) return "code";
  }
  return "daily";
}
