/**
 * `config_set` 的可写白名单（**精确到字段**，不是前缀）
 *
 * 为什么必须精确：`config.toml` 里同时装着"模型的参数"和"管着模型的规则"。
 * 放开 `auth.*` / `sandbox.*` / `selfAccess.*` / `[health]` 等于让模型拆掉自己的护栏
 * （MFA 清单、无人值守白名单、提权开关、回退阈值）；放开 `tools.http_request.allowPrivateHosts`
 * 等于放开 SSRF 防护；放开 `llm.premiumAllowlist.*` 等于放开付费模型配额；放开 `memory.*`
 * 有触发重建/删除向量索引的风险（`qmd.ts` 维度不一致会直接删 `index.sqlite`）。
 *
 * 所以这里**只列明确安全、且改坏了也只影响"模型自己怎么跑"**的字段：
 * 换模型、别名、轮次上限、重试节奏、交互提醒频率。
 *
 * 纯函数、零依赖 —— 便于单测，也便于 CLI 复用同一份口径。
 */

/** 显式拒绝的前缀（给出"为什么"的提示，比笼统的"不允许"有用） */
const DENIED_PREFIXES: ReadonlyArray<{ prefix: string; why: string }> = [
  { prefix: "auth.", why: "MFA 与提示完整性防线，不能让被管的对象自己改" },
  { prefix: "sandbox.", why: "沙箱与无人值守白名单是管着 agent 的规则" },
  { prefix: "selfAccess.", why: "自指运行权限（整树可写/免 MFA/真删）是特权面" },
  { prefix: "health.", why: "健康自检与自动回退阈值是防呆机制" },
  { prefix: "channels.", why: "connector 凭据与对外发声渠道" },
  { prefix: "web.", why: "Dashboard 端口与 token" },
  { prefix: "providers.", why: "provider 里就是 apiKey（密钥）" },
  { prefix: "memory.", why: "改 embedModel/索引相关配置可能触发索引重建或删除" },
  { prefix: "submitter.", why: "自动提交调度器与通知目标" },
  { prefix: "agent.", why: "responseHooks 等会注入提示词，属提示注入面" },
  { prefix: "tools.http_request.", why: "SSRF 防护开关" },
  { prefix: "llm.premiumAllowlist.", why: "高级模型配额白名单是成本控制" },
];

/** 允许精确写入的字段（正则逐条匹配） */
const ALLOWED_PATTERNS: ReadonlyArray<{ re: RegExp; why: string }> = [
  {
    re: /^llm\.backends\.(daily|code|summarizer|vision)\.(model|maxTokens|timeoutMs|maxContextWindow|supportsVision|supportsToolCalls|disableThinking|reasoningEffort|thinkingBudget)$/,
    why: "模型与单后端参数：改坏了只是这个后端跑不好，且健康探针会发现",
  },
  { re: /^llm\.aliases\.[A-Za-z0-9_-]{1,32}$/, why: "模型别名表（纯映射）" },
  {
    re: /^tools\.(maxCodeToolRounds|maxChatToolRounds|maxToolResultChars|maxToolCallArgChars)$/,
    why: "轮次与截断上限（影响 token 消耗，不影响权限）",
  },
  {
    re: /^retry\.(maxAttempts|max5xxAttempts|max5xxDelayMs|maxTransportAttempts|baseDelayMs|retry429|retry5xx|retryTransport|retryTimeout|streamIdleTimeoutMs|maxRetryDurationMs)$/,
    why: "重试与超时节奏",
  },
  {
    re: /^interactive\.(remindAfterSecs|remindIntervalSecs|maxReminds)$/,
    why: "交互提醒频率",
  },
];

export interface PathPolicyResult {
  ok: boolean;
  /** 拒绝原因（面向模型/用户的中文说明） */
  reason?: string;
}

/** 该点路径是否允许 `config_set` 写入 */
export function isConfigSetPathAllowed(dotPath: string): PathPolicyResult {
  const p = dotPath.trim();

  const denied = DENIED_PREFIXES.find((d) => p === d.prefix.slice(0, -1) || p.startsWith(d.prefix));
  if (denied !== undefined) {
    return {
      ok: false,
      reason:
        `已拒绝：[${denied.prefix.slice(0, -1)}] 段不可由 agent 修改（${denied.why}）。` +
        "请人工用 tinyclaw config set 或直接编辑 ~/.tinyclaw/config.toml。",
    };
  }

  const allowed = ALLOWED_PATTERNS.find((a) => a.re.test(p));
  if (allowed !== undefined) return { ok: true };

  return {
    ok: false,
    reason:
      `已拒绝：字段 "${p}" 不在 config_set 的可写白名单里。` +
      "白名单只含模型/别名/轮次上限/重试节奏/交互提醒；其余配置（auth / sandbox / selfAccess / health / " +
      "channels / web / providers / memory / submitter / agent / tools.http_request / llm.premiumAllowlist）" +
      "请人工用 tinyclaw config set 或直接编辑 config.toml。",
  };
}

/** 白名单汇总（供文档/工具描述引用，避免两处不一致） */
export function describeSettablePaths(): string {
  return ALLOWED_PATTERNS.map((a) => a.re.source).join(" | ");
}
