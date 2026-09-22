/**
 * 工具调用策略 —— "这个调用该不该放行"的单一裁决点。
 *
 * 现状问题（详见 `AGENTS.md` §7.1 与 `tmp/sandbox-permission-design-20260911.md`）：
 * - MFA 只在 ReAct 主循环生效；`cron/runner.ts` 与 `loop-trigger.ts` 直接 `executeTool()` 完全绕过
 * - 无人值守时 MFA 无法送达 → 历史实现是**静默放行**（fail-open），即"没人看着时最松"
 *
 * 本模块把这两条反过来：无人值守路径按**白名单**放行，白名单外的工具一律拒绝并写明如何放开。
 */

import { loadConfig } from "../config/loader.js";
import type { SandboxConfig } from "../config/schema.js";
import {
  summarizeToolArgs,
  writeAudit,
  type AuditDecision,
  type AuditEvent,
  type RunOrigin,
} from "../security/audit.js";

export interface PolicyDecision {
  allow: boolean;
  /** 拒绝原因（可直接回给模型/用户，含如何放开的指引） */
  reason?: string;
}

/**
 * 写一条工具调用审计（自动解析配置、自动脱敏）。
 *
 * 调用点：agent 主循环（每次工具调用/被拒）、cron runner、loop-trigger。
 */
export function auditToolCall(args: {
  event: AuditEvent;
  origin: RunOrigin | undefined;
  agentId: string;
  sessionId?: string;
  tool: string;
  decision: AuditDecision;
  reason?: string;
  /** 原始参数（会被截断+脱敏；传 undefined 表示不记录参数） */
  args?: Record<string, unknown>;
  purpose?: string;
  durationMs?: number;
  error?: string;
  cfg?: SandboxConfig;
}): void {
  const cfg = args.cfg ?? loadConfig().sandbox;
  writeAudit(
    {
      event: args.event,
      origin: args.origin ?? "unknown",
      agentId: args.agentId,
      ...(args.sessionId ? { sessionId: args.sessionId } : {}),
      tool: args.tool,
      decision: args.decision,
      ...(args.reason ? { reason: args.reason } : {}),
      ...(args.args ? { args: summarizeToolArgs(args.args, cfg.audit.maxArgChars) } : {}),
      ...(args.purpose ? { purpose: args.purpose } : {}),
      ...(args.durationMs !== undefined ? { durationMs: args.durationMs } : {}),
      ...(args.error ? { error: args.error.slice(0, 300) } : {}),
    },
    { enabled: cfg.audit.enabled, ...(cfg.audit.dir ? { dir: cfg.audit.dir } : {}) }
  );
}

/** 无人值守来源（cron / loop）—— 人不在场，没有审批可送达 */
export function isUnattended(origin: RunOrigin | undefined): boolean {
  return origin === "cron" || origin === "loop";
}

/**
 * 工具调用的**通道**：
 * - `react`：ReAct 循环里模型自己挑的工具调用（default）
 * - `steps`：job / loop 配置里**声明式写死**的 tool 步骤（pipeline steps / loop steps）
 *
 * 两者的信任级不同：`steps` 是用户（或建任务时的 agent）在配置里显式写下的意图，事后可审计、可复核；
 * `react` 是模型在无人监督时**临场决定**要做什么。所以某些能力只对 `steps` 开放。
 */
export type ToolChannel = "react" | "steps";

/**
 * 即使在 `allowedTools` 里也不允许**ReAct 通道**调用的工具（硬规则，不可由配置放开）。
 *
 * `agent_fork`：在无人值守的 ReAct 循环里 fork，等于让模型在没人看着时**再开一个不受监督的 agent**
 * （新 session、新上下文、自己的 LLM 预算与工具循环），既是能力放大也是策略绕过面。
 * 而写在 job 配置里的 `steps: [{type:"tool", name:"agent_fork"}]` 是**声明式**步骤
 * （如"股市日报"按市场 fan-out 多个 slave），属用户显式设计，允许。
 */
const HARD_DENY_REACT_UNATTENDED = new Set([
  "agent_fork",
  "mcp_server_add",
  "mcp_server_remove",
  "mcp_server_set_enabled",
  "mcp_reload",
]);

/** 硬禁止工具的解释（拒绝文案用） */
const HARD_DENY_REASON: Record<string, string> = {
  agent_fork:
    "无人值守的 ReAct 循环禁止 fork 子 agent：那等于让模型在没人看着时再开一个不受监督的 agent" +
    "（独立 session / 上下文 / 预算）。如果确实需要 fork 做 fan-out，请把它写成 job 配置里的" +
    "声明式步骤（steps: [{type:\"tool\", name:\"agent_fork\", args:{...}}]）—— 那样是用户写死的意图，" +
    "允许执行。",
  mcp_server_add:
    "无人值守时禁止新增 MCP server：新 server 的 command 是任意可执行程序，等于在没人看着时扩大" +
    "可执行面。请在有人值守的会话里让 agent 调用它（会走 MFA 确认），或自己编辑 ~/.tinyclaw/mcp.toml。",
  mcp_server_remove:
    "无人值守时禁止删除 MCP server 配置（会静默改变其它任务可用的工具集）。请在有人值守的会话里操作。",
  mcp_server_set_enabled:
    "无人值守时禁止启停 MCP server（启用一个被禁用的 server 等于扩大可执行面）。请在有人值守的会话里操作。",
  mcp_reload: "无人值守时禁止重载 MCP 配置：重载本身无害，但它是上述改动生效的入口，统一在有人值守时进行。",
};

function auditOpts(cfg: SandboxConfig): { dir?: string; enabled: boolean } {
  return {
    enabled: cfg.audit.enabled,
    ...(cfg.audit.dir ? { dir: cfg.audit.dir } : {}),
  };
}

/**
 * 无人值守路径的工具准入检查。
 *
 * @param toolName 工具名
 * @param cfg      已加载的 `[sandbox]` 配置（调用方传入，便于测试）
 * @param channel  `react`（模型临场挑选，默认）或 `steps`（配置里声明式的 tool 步骤）
 * @returns allow=false 时给出可操作的拒绝文案
 */
export function checkUnattendedTool(
  toolName: string,
  cfg: SandboxConfig,
  channel: ToolChannel = "react"
): PolicyDecision {
  // 硬规则优先于一切配置：这几个工具在无人值守的 **ReAct 通道**永远不放行
  // （声明式 steps 通道不受此限，见 ToolChannel 注释）
  if (channel === "react" && HARD_DENY_REACT_UNATTENDED.has(toolName)) {
    return {
      allow: false,
      reason: `已拒绝：${HARD_DENY_REASON[toolName] ?? `${toolName} 在无人值守的 ReAct 循环中被禁止`}`,
    };
  }

  const mode = cfg.unattended.mode;
  if (mode === "all") return { allow: true };

  const allowed = cfg.unattended.allowedTools;
  if (mode === "allowlist" && allowed.includes(toolName)) return { allow: true };
  if (mode === "deny" && allowed.includes(toolName)) return { allow: true };

  return {
    allow: false,
    reason:
      `已拒绝：无人值守路径（cron / loop）不允许调用 ${toolName}。\n` +
      `如需放开，请在 ~/.tinyclaw/config.toml 的 [sandbox.unattended].allowedTools 中加入 "${toolName}"，` +
      `或把 mode 改为 "all"（不推荐）。\n` +
      `原因：无人值守时没有用户在场审批，只有事前白名单可靠。`,
  };
}

/** 带审计的无人值守准入检查（拒绝时落审计） */
export function enforceUnattendedTool(args: {
  toolName: string;
  origin: RunOrigin | undefined;
  agentId: string;
  sessionId?: string;
  /** `react`（ReAct 循环，默认）或 `steps`（job/loop 配置里声明式的 tool 步骤） */
  channel?: ToolChannel;
  cfg?: SandboxConfig;
}): PolicyDecision {
  const cfg = args.cfg ?? loadConfig().sandbox;
  if (!isUnattended(args.origin)) return { allow: true };

  const channel = args.channel ?? "react";
  const decision = checkUnattendedTool(args.toolName, cfg, channel);
  if (!decision.allow) {
    writeAudit(
      {
        event: "policy",
        origin: args.origin ?? "unknown",
        agentId: args.agentId,
        ...(args.sessionId ? { sessionId: args.sessionId } : {}),
        tool: args.toolName,
        decision: "deny",
        reason: `无人值守白名单外（channel=${channel}）`,
      },
      auditOpts(cfg)
    );
  } else if (channel === "steps") {
    // 声明式步骤放行也留痕：便于事后核对"这个 job 到底跑过什么"
    writeAudit(
      {
        event: "policy",
        origin: args.origin ?? "unknown",
        agentId: args.agentId,
        ...(args.sessionId ? { sessionId: args.sessionId } : {}),
        tool: args.toolName,
        decision: "allow",
        reason: "声明式步骤（channel=steps）",
      },
      auditOpts(cfg)
    );
  }
  return decision;
}

/**
 * 无人值守 + MFA 无法送达时的兜底决定。 *
 * `[sandbox.unattended].mfaFallback`：
 * - `deny`（默认）：拒绝该调用（"没人能审批" ≠ "自动批准"）
 * - `allow`：历史行为（静默放行）
 */
export function unattendedMfaFallback(args: {
  toolName: string;
  origin: RunOrigin | undefined;
  agentId: string;
  sessionId?: string;
  cfg?: SandboxConfig;
}): PolicyDecision {
  const cfg = args.cfg ?? loadConfig().sandbox;
  if (!isUnattended(args.origin)) return { allow: true };
  if (cfg.unattended.mfaFallback === "allow") {
    writeAudit(
      {
        event: "mfa",
        origin: args.origin ?? "unknown",
        agentId: args.agentId,
        ...(args.sessionId ? { sessionId: args.sessionId } : {}),
        tool: args.toolName,
        decision: "allow",
        reason: "无人值守且 mfaFallback=allow（配置放行）",
      },
      auditOpts(cfg)
    );
    return { allow: true };
  }
  return {
    allow: false,
    reason:
      `已拒绝：${args.toolName} 需要 MFA 确认，但当前是无人值守运行（无交互回调）。\n` +
      `如需允许，可把 [sandbox.unattended].mfaFallback 改为 "allow"，或把该工具加入 allowedTools 并确认其无需 MFA。`,
  };
}
