/**
 * 提权通道（elevation）—— "沙箱默认，提权例外"。
 *
 * 模型看不到沙箱本身，只能表达意图：`exec_shell({ command, elevate: true })`。
 * 本模块负责把它变成一次**可见、可拒、可追溯**的审批：
 *
 * 1. 硬性前置：总开关开启、agent 在白名单、**无人值守路径一律不许提权**
 * 2. 风险分级：E1（只读类，可免批）/ E2（有副作用，每次确认）
 * 3. 一次性令牌：批准后 `{命令哈希, 过期}`，TTL 内同一条命令不再重复询问；**换命令即失效**
 * 4. 节流：同一条命令 5 分钟内最多请求 N 次（防模型被拒后疯狂重试刷屏）
 * 5. 审计 + 用户可见提示：提权必须在会话里出现一条消息，不能静默发生
 *
 * ⚠️ 提权 = 在宿主机（沙箱外）执行，密钥对这次执行是可见的。因此**默认关闭**，
 * 且只有被显式列进 `[sandbox.elevation].allowedAgents` 的 agent 能用。
 */

import { createHash } from "node:crypto";
import { loadConfig } from "../config/loader.js";
import type { SandboxConfig } from "../config/schema.js";
import type { RunOrigin } from "../security/audit.js";
import { auditToolCall } from "../auth/tool-policy.js";
import { isUnattended } from "../auth/tool-policy.js";

export type ElevationLevel = "E1" | "E2";

export interface ElevationRequest {
  command: string;
  origin: RunOrigin | undefined;
  agentId: string;
  sessionId?: string;
  /** 交互回调（来自 ToolContext） */
  onMFARequest?: (warningMessage: string, verifyCode?: (code: string) => boolean) => Promise<boolean>;
  onAskUser?: (
    question: string,
    options?: Array<{ label: string; description?: string; recommended?: boolean }>,
    allowFreeform?: boolean
  ) => Promise<{ answer: string; isFreeform: boolean }>;
  /** 用户可见提示（提权成功时告知"这次在沙箱外跑"） */
  onNotify?: (message: string) => Promise<void>;
  cfg?: SandboxConfig;
}

export interface ElevationResult {
  allowed: boolean;
  /** 拒绝原因（可直接回给模型） */
  reason?: string;
  level?: ElevationLevel;
  /** 是否走了令牌（未再次询问用户） */
  reusedToken?: boolean;
}

/** 规范化命令后取哈希（忽略首尾空白与多余空格，避免"改个空格就重问"） */
export function commandHash(command: string): string {
  const normalized = command.trim().replace(/\s+/g, " ");
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

/** E2 特征：写文件、改系统、装包、推送、启停服务等有副作用的动作 */
const E2_PATTERNS: RegExp[] = [
  /(^|\s|;|&|\|)>{1,2}\s*\S/, // 重定向写
  /\brm\b|\bmv\b|\bcp\b|\bdd\b|\btruncate\b|\bshred\b/,
  /\bsed\s+-i\b|\btee\b|\bchmod\b|\bchown\b|\bchgrp\b/,
  /\bapt(-get)?\b|\bpip3?\b[^|;&]*\binstall\b|\bnpm\b[^|;&]*\b(i|install|ci)\b|\bpnpm\b[^|;&]*\b(i|install|add)\b/,
  // 允许 flag 夹在中间：`git -C /repo push`、`systemctl --user restart tinyclaw`
  /\bgit\b[^|;&]*\b(push|commit|reset|checkout|clean|rm)\b/,
  /\bsystemctl\b[^|;&]*\b(start|stop|restart|enable|disable|mask)\b/,
  /\bservice\b[^|;&]*\b(start|stop|restart)\b/,
  /\bkill(all)?\b|\bpkill\b|\bsystemd-run\b|\bsudo\b|\bsu\b/,
  /\bmkdir\b|\btouch\b|\bln\s+-s\b|\bmount\b|\bumount\b/,
  /\bcrontab\b|\bat\s+\S/,
];

/** 风险分级：命中任一 E2 特征即 E2，否则 E1（只读类） */
export function classifyElevation(command: string): ElevationLevel {
  return E2_PATTERNS.some((re) => re.test(command)) ? "E2" : "E1";
}

/** 已签发的令牌：commandHash → 过期时间戳 */
const tokens = new Map<string, number>();
/** 提权请求时间戳（用于节流）：commandHash → 最近请求时间列表 */
const requestLog = new Map<string, number[]>();

/** 仅供测试：清空令牌与节流状态 */
export function _resetElevationState(): void {
  tokens.clear();
  requestLog.clear();
}

function pruneTokens(now: number): void {
  for (const [hash, exp] of tokens) {
    if (exp <= now) tokens.delete(hash);
  }
}

/** 5 分钟窗口内的请求次数是否已达上限 */
function throttled(hash: string, max: number, now: number): boolean {
  const window = 5 * 60 * 1000;
  const recent = (requestLog.get(hash) ?? []).filter((t) => now - t < window);
  requestLog.set(hash, recent);
  return recent.length >= max;
}

function recordRequest(hash: string, now: number): void {
  const recent = requestLog.get(hash) ?? [];
  recent.push(now);
  requestLog.set(hash, recent);
}

/**
 * 处理一次提权请求。
 *
 * 返回 `allowed: true` 表示可以在宿主机（沙箱外）执行这条命令。
 */
export async function requestElevation(req: ElevationRequest): Promise<ElevationResult> {
  const cfg = (req.cfg ?? loadConfig().sandbox).elevation;
  const level = classifyElevation(req.command);
  const hash = commandHash(req.command);
  const now = Date.now();
  pruneTokens(now);

  if (!cfg.enabled) {
    return {
      allowed: false,
      level,
      reason:
        "已拒绝：提权通道未开启。如需允许 agent 在沙箱外执行，请在 ~/.tinyclaw/config.toml 中设置\n" +
        '[sandbox.elevation]\nenabled = true\nallowedAgents = ["' +
        req.agentId +
        '"]',
    };
  }
  if (isUnattended(req.origin) && !cfg.allowInCron) {
    return {
      allowed: false,
      level,
      reason:
        "已拒绝：无人值守运行（cron / loop）不允许提权 —— 没有人能审批这次操作。\n" +
        "如确需，请把该命令改为沙箱内可完成的写法，或先把 [sandbox.elevation].allowInCron 打开（不推荐）。",
    };
  }
  if (!cfg.allowedAgents.includes(req.agentId) && !cfg.allowedAgents.includes("*")) {
    return {
      allowed: false,
      level,
      reason: `已拒绝：agent "${req.agentId}" 不在 [sandbox.elevation].allowedAgents 名单里，不能提权。`,
    };
  }

  // 一次性令牌：同一条命令在 TTL 内直接复用（不重复打扰用户）
  const exp = tokens.get(hash);
  if (exp !== undefined && exp > now) return { allowed: true, level, reusedToken: true };

  if (throttled(hash, cfg.maxRequestsPer5min, now)) {
    return {
      allowed: false,
      level,
      reason:
        `已拒绝：同一条命令 5 分钟内已请求过 ${cfg.maxRequestsPer5min} 次提权，请等待或改用沙箱内方案。\n` +
        "（如果你认为这确实必要，请直接告诉用户你要做什么，让他手动执行。）",
    };
  }

  // E1 只读类可以免批（可配）
  if (level === "E1" && cfg.e1AutoApprove) {
    tokens.set(hash, now + cfg.tokenTtlSecs * 1000);
    return { allowed: true, level };
  }

  const prompt =
    `⚠️ agent 请求在**沙箱外**执行（提权，等级 ${level}）：\n${req.command.slice(0, 300)}\n\n` +
    `沙箱外意味着它能访问密钥与整个家目录。允许吗？`;

  // 交互确认：优先用 ask（是/否按钮），否则退到 MFA 文本确认
  recordRequest(hash, now);
  if (req.onAskUser) {
    try {
      const { answer } = await req.onAskUser(prompt, [
        { label: "允许本次", description: `仅对这条命令生效，${cfg.tokenTtlSecs}s 内有效` },
        { label: "拒绝", recommended: true },
      ]);
      if (answer !== "允许本次") {
        return { allowed: false, level, reason: "已拒绝：用户未批准提权" };
      }
    } catch (err) {
      return { allowed: false, level, reason: `已拒绝：提权确认失败（${(err as Error).message}）` };
    }
  } else if (req.onMFARequest) {
    const ok = await req.onMFARequest(prompt).catch(() => false);
    if (!ok) return { allowed: false, level, reason: "已拒绝：用户未批准提权" };
  } else {
    // 没有交互通道 → fail-closed（与无人值守 MFA 兜底同一原则）
    return {
      allowed: false,
      level,
      reason: "已拒绝：当前没有可用的交互通道，无法取得提权批准（提权需要用户当场同意）。",
    };
  }

  tokens.set(hash, now + cfg.tokenTtlSecs * 1000);
  return { allowed: true, level };
}

/** 提权成功后的统一收尾：用户可见提示 + 审计 */
export async function announceElevation(req: {
  command: string;
  origin: RunOrigin | undefined;
  agentId: string;
  sessionId?: string;
  level?: ElevationLevel;
  reusedToken?: boolean;
  onNotify?: (message: string) => Promise<void>;
  cfg?: SandboxConfig;
}): Promise<void> {
  const suffix = req.reusedToken ? "（复用刚才的批准）" : "";
  const notice = `⚠️ 本次在沙箱外执行${suffix}：${req.command.slice(0, 120)}`;
  if (req.onNotify) {
    try {
      await req.onNotify(notice);
    } catch {
      /* 通知失败不影响执行 */
    }
  }
  const cfg = req.cfg ?? loadConfig().sandbox;
  auditToolCall({
    event: "policy",
    origin: req.origin,
    agentId: req.agentId,
    ...(req.sessionId ? { sessionId: req.sessionId } : {}),
    tool: "exec_shell",
    decision: "allow",
    reason: `提权（沙箱外执行，等级 ${req.level ?? "?"}${req.reusedToken ? "，复用令牌" : ""}）`,
    args: { command: req.command },
    cfg,
  });
}
