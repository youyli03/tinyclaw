/**
 * Prompt Injection 检测器
 *
 * 扫描工具返回值中是否含有提示词注入特征。
 * 检测到注入时返回 DetectionResult（含净化后的文本），否则返回 null。
 */

import type { Config } from "../config/schema.js";

export interface DetectionResult {
  /** 命中的规则描述 */
  pattern: string;
  /** 可疑片段（最多 120 字符，供日志/报警显示） */
  snippet: string;
  /** 将注入片段替换为占位符后的安全文本 */
  sanitized: string;
}

interface InjectionRule {
  id: string;
  description: string;
  regex: RegExp;
}

/**
 * 规则库。
 * flags: i = 大小写不敏感；可叠加 m 多行匹配。
 */
const RULES: InjectionRule[] = [
  // ── 角色 / 指令覆盖 ──────────────────────────────────────────────────
  {
    id: "ignore_instructions",
    description: "忽略之前指令",
    regex: /ignore\s+(all|previous|above|prior|any|the\s+above)\s+instructions?/i,
  },
  {
    id: "disregard_instructions",
    description: "无视系统指令",
    regex: /disregard\s+(all|previous|above|prior|your|the)\s+(instructions?|directives?|rules?|prompt)/i,
  },
  {
    id: "forget_instructions",
    description: "遗忘指令",
    regex: /forget\s+(everything|all|your\s+(previous\s+)?instructions?|what\s+(i|you|we)\s+(told|said|wrote))/i,
  },
  // ── 身份覆盖 ────────────────────────────────────────────────────────
  {
    id: "you_are_now",
    description: "身份替换",
    regex: /you\s+are\s+now\s+(?:a|an|the)\s+\w/i,
  },
  {
    id: "act_as",
    description: "角色扮演注入",
    regex: /\bact\s+as\s+(?:a|an|the)\s+\w/i,
  },
  {
    id: "pretend_to_be",
    description: "伪装注入",
    regex: /pretend\s+(you\s+are|to\s+be)\s+(?:a|an|the)?\s*\w/i,
  },
  // ── 系统提示伪造 ─────────────────────────────────────────────────────
  {
    id: "fake_system_tag",
    description: "伪造系统消息标签",
    regex: /^\s*<\s*(system|SYSTEM|SYS)\s*>/m,
  },
  {
    id: "fake_system_bracket",
    description: "伪造方括号系统标签",
    regex: /\[(SYSTEM|INST|SYS|PROMPT)\]/,
  },
  // ── 新指令注入 ───────────────────────────────────────────────────────
  {
    id: "new_instructions",
    description: "注入新指令",
    regex: /new\s+(system\s+)?instructions?\s*[:：]/i,
  },
  {
    id: "new_prompt",
    description: "覆盖提示词",
    regex: /new\s+(?:system\s+)?prompt\s*[:：]/i,
  },
  {
    id: "override_prompt",
    description: "覆盖原始提示",
    regex: /override\s+(the\s+)?(original\s+)?(system\s+)?prompt/i,
  },
  // ── 越狱关键词 ───────────────────────────────────────────────────────
  {
    id: "jailbreak_dan",
    description: "DAN/越狱模式",
    regex: /\b(DAN|jailbreak|do\s+anything\s+now|developer\s+mode)\b/i,
  },
  {
    id: "no_restrictions",
    description: "要求取消限制",
    regex: /without\s+(any\s+)?(restrictions?|limitations?|filters?|guidelines?)/i,
  },
  // ── 中文变体 ─────────────────────────────────────────────────────────
  {
    id: "zh_ignore",
    description: "中文：忽略指令",
    regex: /忽略(之前|所有|上面|上述|前面|原来|原始)的?(指令|规则|系统提示|提示词|设定|限制)/,
  },
  {
    id: "zh_you_are",
    description: "中文：身份替换",
    regex: /你(现在是|是一个|作为一个|扮演|现在扮演).{0,20}(AI|助手|机器人|模型|GPT|Claude)/,
  },
  {
    id: "zh_forget",
    description: "中文：遗忘指令",
    regex: /忘记(所有|之前|上面|你的)(指令|规则|提示|设定|限制)/,
  },
  {
    id: "zh_override",
    description: "中文：覆盖提示",
    regex: /(覆盖|替换|重写)(原来的|原始的|之前的|系统的)?(提示词|指令|系统提示|规则)/,
  },
];

/**
 * 检测单段文本。
 * 返回第一个命中的 DetectionResult，若干净则返回 null。
 */
function detectOne(text: string): DetectionResult | null {
  for (const rule of RULES) {
    const match = rule.regex.exec(text);
    if (!match) continue;

    // 提取上下文片段（命中位置前后各 60 字符）
    const start = Math.max(0, match.index - 60);
    const end   = Math.min(text.length, match.index + match[0].length + 60);
    const snippet = text.slice(start, end).replace(/\n/g, " ").slice(0, 120);

    // 替换：将命中的完整匹配替换为安全占位符
    const sanitized = text.replace(
      rule.regex,
      `[⚠️BLOCKED:${rule.id}]`
    );

    return { pattern: `${rule.id} — ${rule.description}`, snippet, sanitized };
  }
  return null;
}

/**
 * 公开入口：接受工具名称、结果文本和当前配置。
 * - 若配置中 `tools.security.injectionDetect.enabled = false`，直接返回 null。
 * - 否则对文本进行检测，返回 DetectionResult | null。
 */
export function detectPromptInjection(
  toolName: string,
  result: string,
  config: Config
): DetectionResult | null {
  if (!config.tools.security?.injectionDetect?.enabled) return null;

  // 跳过内部工具（避免误报自身系统消息）
  const SKIP_TOOLS = new Set(["notify_user", "send_report", "ask_user", "exit_plan_mode"]);
  if (SKIP_TOOLS.has(toolName)) return null;

  return detectOne(result);
}
