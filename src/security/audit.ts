/**
 * 审计流 —— 把"agent 做了什么决定"落成 append-only 记录。
 *
 * 为什么需要：现在只有 `console.log`，而日志会轮转、会被 `service.log` 清空、
 * 也无法回答"昨天有没有人试图读密钥"。审计流回答三个问题：
 *   1. 谁（origin/agentId/sessionId）在什么时候（ts）
 *   2. 想干什么（tool + args 摘要 + 模型自述的 `__purpose`）
 *   3. 结果如何（decision: allow/deny/confirm + reason + 耗时/错误）
 *
 * 设计约束：
 * - **追加写**，按月分片：`~/.tinyclaw/audit/YYYY-MM.jsonl`（目录 0700 / 文件 0600）
 * - **绝不落明文密钥**：参数先截断再走 `redactKnownSecrets()`，并对 key/token/secret 命名的值做掩码
 * - **永不抛错**：审计失败不能导致 agent 任务失败（首次失败打一条 warn）
 * - agent 不可改：文件路径不在 `[selfAccess]` 的可写集合里（见 `isRuntimeSecretPath` 的扩展点）
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { redactKnownSecrets } from "../utils/redact.js";

/** 一次运行的来源 —— 决定它算不算"无人值守" */
/**
 * 一次运行的**来源**（审计里的出处）。
 *
 * ⚠️ 它与"权限等级"是两件事，别混：
 * - 权限等级由 `isUnattendedOrigin()` 判定（cron / loop = 无人值守）；
 * - `wake` = 由唤醒通道（job / cron 脚本调 `tinyclaw wake`、IPC wake、agent 工具 wake）注入的一轮。
 *   它**不是**无人值守：目标会话若能把审批送到人（如 qqbot 会话），这一轮就按该会话的普通对话权限跑
 *   （全量工具 + 真 MFA），出处仍由本字段与 wake 审计条目保留 —— 见 `main.ts` 的 `wakeSession`。
 */
export type RunOrigin = "chat" | "cron" | "loop" | "slave" | "cli" | "wake" | "unknown";

export type AuditEvent = "tool" | "policy" | "mfa" | "sandbox" | "self";

export type AuditDecision = "allow" | "deny" | "confirm" | "info";

export interface AuditEntry {
  ts: string;
  event: AuditEvent;
  origin: RunOrigin;
  agentId: string;
  sessionId?: string;
  tool: string;
  decision: AuditDecision;
  reason?: string;
  /** 参数摘要（已截断 + 脱敏） */
  args?: string;
  /** 模型自述的动作意图（`__purpose`） */
  purpose?: string;
  durationMs?: number;
  error?: string;
}

/** 审计目录（可用 `[sandbox.audit].dir` 覆盖） */
export function auditDir(customDir?: string): string {
  return customDir && customDir.trim().length > 0
    ? customDir.replace(/^~/, os.homedir())
    : path.join(os.homedir(), ".tinyclaw", "audit");
}

function currentAuditFile(dirOverride?: string): string {
  const month = new Date().toISOString().slice(0, 7); // YYYY-MM
  return path.join(auditDir(dirOverride), `${month}.jsonl`);
}

let warned = false;

/**
 * 追加一条审计记录（best-effort）。
 *
 * `dirOverride`/`enabled` 由调用方从配置传入，避免本模块依赖 `loadConfig()`
 * 造成 core → config 的隐式循环。
 */
export function writeAudit(entry: Omit<AuditEntry, "ts">, opts?: { dir?: string; enabled?: boolean }): void {
  if (opts?.enabled === false) return;
  try {
    const file = currentAuditFile(opts?.dir);
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
    fs.appendFileSync(file, line + "\n", { encoding: "utf-8", mode: 0o600 });
  } catch (err) {
    if (!warned) {
      warned = true;
      console.warn("[audit] 写入审计流失败（后续同类错误不再重复提示）:", err);
    }
  }
}

/** 值看起来像凭证 → 掩码 */
const SECRET_VALUE_RE =
  /^(sk-|ghp_|gho_|github_pat_|xox[baprs]-|eyJ[A-Za-z0-9_-]{8,}|AKIA[0-9A-Z]{8,})|^[A-Fa-f0-9]{32,}$|^[A-Za-z0-9+/]{40,}={0,2}$/;

/** 键名像凭证 → 掩码 */
const SECRET_KEY_RE = /(api[_-]?key|access[_-]?token|token|secret|password|passwd|credential|authorization|cookie)/i;

/** 单个字符串值在摘要里的最大长度 */
const VALUE_MAX = 200;

/**
 * 子串级擦除：即使凭证**嵌在长字符串里**（如 `curl -H "Authorization: Bearer eyJ..."`）也要抹掉。
 *
 * 与下面按"整值形态"判定的 `SECRET_VALUE_RE` 互补：那个只能识别"整个值就是凭证"的情况。
 * 刻意**不**擦除裸的 32+ 位 hex —— 那会把 git commit SHA 一起抹掉（本仓库高频出现）。
 */
const EMBEDDED_SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+)?/g, "***"],
  [/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{12,}/g, "***"],
  [/\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{10,}/g, "***"],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, "***"],
  [/\bAKIA[0-9A-Z]{12,}/g, "***"],
  [/(authorization\s*[:=]\s*)(?:bearer\s+)?\S+/gi, "$1***"],
  [/(--?(?:password|passwd|token|api[-_]?key|secret)\s*[= ]\s*)\S+/gi, "$1***"],
  [/\b(?:api[_-]?key|access[_-]?token|secret|password|passwd)\s*[:=]\s*("[^"]*"|'[^']*'|\S+)/gi, "$1***"],
];

function scrubEmbeddedSecrets(text: string): string {
  let out = text;
  for (const [re, rep] of EMBEDDED_SECRET_PATTERNS) {
    out = out.replace(re, rep);
  }
  return out;
}

function summarizeValue(key: string, value: unknown, depth: number): unknown {
  if (typeof value === "string") {
    if (SECRET_KEY_RE.test(key) || SECRET_VALUE_RE.test(value.trim())) return "***";
    const clipped = value.length > VALUE_MAX ? `${value.slice(0, VALUE_MAX)}…(共 ${value.length} 字符)` : value;
    return scrubEmbeddedSecrets(clipped);
  }
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) {
    return depth > 2 ? `[${value.length} 项]` : value.slice(0, 8).map((v) => summarizeValue(key, v, depth + 1));
  }
  if (typeof value === "object") {
    if (depth > 2) return "{…}";
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = summarizeValue(k, v, depth + 1);
    }
    return out;
  }
  return typeof value;
}

/**
 * 生成可安全落盘的参数摘要。
 *
 * 三层保护：截断 → 按命名/形态掩码 → `redactKnownSecrets()` 全文替换（与 secrets.toml 等真实值比对）。
 */
export function summarizeToolArgs(
  args: Record<string, unknown>,
  maxChars = 500
): string {
  let text: string;
  try {
    text = JSON.stringify(summarizeValue("", args, 0));
  } catch {
    text = "(参数无法序列化)";
  }
  if (text.length > maxChars) text = `${text.slice(0, maxChars)}…(截断)`;
  // 最后再兜一层：JSON 里可能残留拼接出来的凭证片段；redactKnownSecrets 会把与
  // secrets.toml / config.toml 中**真实值**相同的子串整体替换掉。
  text = scrubEmbeddedSecrets(text);
  try {
    return redactKnownSecrets(text);
  } catch {
    return text;
  }
}

/** 审计记录里区分"无人值守"路径（cron/loop）—— 与 policy 模块口径一致。
 *  注意 `wake` **不在**此列：唤醒那一轮的权限跟着目标会话走（见 RunOrigin 注释）。 */
export function isUnattendedOrigin(origin: RunOrigin): boolean {
  return origin === "cron" || origin === "loop";
}
