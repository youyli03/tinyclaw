/**
 * Agent 环境变量工具（`~/.tinyclaw/agents/<id>/env`）
 *
 * - `env_list`：列出**键名**（分类：引用式 / 密钥类 / 普通）+ 全局 `~/.tinyclaw/env` 的键名。**永不回值**。
 * - `env_set`：写一个变量。**密钥类键名（或 `secret: true`）需要 MFA 审批**（`requiresMFAFor` 按参数判定）。
 * - `env_delete`：删一个变量（密钥类同样要审批）。
 *
 * 刻意**没有** `env_get`：值一旦能取回，就等于把密钥送进对话历史与日志。要看值请人工 `cat` 文件
 * （`~/.tinyclaw/agents/<id>/env`，0600，沙箱内被掩码）。
 *
 * 值支持 `${SECRET:NAME}` 引用式 —— 引用式的值不落明文，注入子进程前才从 `secrets.toml` 解析。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { registerTool } from "./registry.js";
import {
  ENV_KEY_RE,
  agentEnvPath,
  deleteAgentEnvVar,
  isSecretRefValue,
  listAgentEnv,
  looksLikeSecretKey,
  setAgentEnvVar,
  writeAgentEnv,
} from "../config/agent-env.js";
import { loadSecretsConfig } from "../config/loader.js";
import { canReadSecrets, secretKeyNames, secretsDeniedReason } from "../auth/secrets-access.js";
import { auditToolCall } from "../auth/tool-policy.js";

/** 值长度上限（环境变量不该塞大块内容） */
const MAX_VALUE_CHARS = 4 * 1024;

/** secrets.toml 的键名清单（读不到就空表；只取名字，永不取值） */
function availableSecretNames(): string[] {
  try {
    return secretKeyNames(loadSecretsConfig());
  } catch {
    return [];
  }
}

/** 全局 `~/.tinyclaw/env` 的键名（只看键，不看值） */
function globalEnvKeys(): string[] {
  try {
    const text = fs.readFileSync(path.join(os.homedir(), ".tinyclaw", "env"), "utf-8");
    const keys: string[] = [];
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (t === "" || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq > 0) keys.push(t.slice(0, eq).trim());
    }
    return keys;
  } catch {
    return [];
  }
}

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "env_list",
      description:
        "List the environment variables this agent manages (keys only -- values are NEVER returned). " +
        "Shows which keys are ${SECRET:NAME} references and which look like credentials (those need user " +
        "approval to write). Background jobs started by this agent inherit process.env (including " +
        "~/.tinyclaw/env) plus these variables.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  execute: async (_args, ctx) => {
    const agentId = ctx?.agentId ?? "default";
    const entries = listAgentEnv(agentId);
    const lines = [`## agent ${agentId} 的环境变量（文件：${agentEnvPath(agentId)}）`, ""];
    if (entries.length === 0) {
      lines.push("（还没有自己的变量；用 `env_set` 添加）");
    } else {
      for (const e of entries) {
        const kind = e.isRef ? "引用式 ${SECRET:…}" : "明文值";
        const risk = e.secretLike ? "密钥类（写需审批）" : "普通";
        lines.push(`- \`${e.key}\` — ${kind} · ${risk}`);
      }
    }
    const global = globalEnvKeys();
    lines.push(
      "",
      `全局 ~/.tinyclaw/env 的键（${global.length} 个，值不显示）：${
        global.length > 0 ? global.map((k) => `\`${k}\``).join(", ") : "（无）"
      }`
    );
    // secrets.toml 的键名：只对 [secrets].agents 授权的 agent 可见（名字可猜，所以这层也要按 agent 收敛）
    if (canReadSecrets(ctx?.agentId)) {
      const names = availableSecretNames();
      lines.push(
        "",
        `secrets.toml 的键（${names.length} 个，值不显示；job 里可用 \`\${SECRET:NAME}\` 引用）：${
          names.length > 0 ? names.map((k) => `\`${k}\``).join(", ") : "（无）"
        }`
      );
    } else {
      lines.push(
        "",
        "> 当前 agent 未被授权读 secrets.toml（`[secrets].agents`），其中键名不显示。"
      );
    }
    lines.push(
      "",
      "> 优先级：process.env（含全局 env）< 该 agent 的 env < 单次调用显式传入的 env。",
      "> 值不会通过工具返回；后台 job 直接继承这些变量。"
    );
    return lines.join("\n");
  },
});

registerTool({
  requiresMFA: false,
  // 密钥类键名（或显式 secret:true）→ 需要用户审批；普通变量不打扰
  requiresMFAFor: (args) =>
    args["secret"] === true || looksLikeSecretKey(String(args["key"] ?? "")),
  // 值可能是明文密钥：MFA 提示会发给用户、审计会落盘，两处都只允许看到键名
  redactArgs: (args) => ({ ...args, value: "***" }),
  spec: {
    type: "function",
    function: {
      name: "env_set",
      description:
        "Set one environment variable for this agent (stored in ~/.tinyclaw/agents/<id>/env, mode 0600). " +
        "Use this to give your background jobs their own variables. Writing a credential-looking key " +
        "(name containing KEY/TOKEN/SECRET/PASS/AUTH/API...) requires user approval. Prefer the " +
        "${SECRET:NAME} reference form so the plaintext stays in secrets.toml instead of this file. " +
        "The value is never echoed back.",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", description: "Variable name, e.g. LOG_LEVEL or MY_API_KEY" },
          value: {
            type: "string",
            description: 'Value, or a ${SECRET:NAME} reference, e.g. "${SECRET:MY_TOKEN}"',
          },
          secret: {
            type: "boolean",
            description: "Force user approval even if the key name does not look like a credential",
          },
        },
        required: ["key", "value"],
      },
    },
  },
  execute: async (args, ctx) => {
    const agentId = ctx?.agentId ?? "default";
    const key = String(args["key"] ?? "").trim();
    const value = args["value"] === undefined ? "" : String(args["value"]);

    if (!ENV_KEY_RE.test(key)) {
      return `已拒绝：环境变量名 "${key}" 非法（须匹配 [A-Za-z_][A-Za-z0-9_]*，长度 ≤64）。`;
    }
    // 引用式值读的是 secrets.toml：未被授权的 agent 不许把它写进自己的 env（否则等于给自己开后门）
    if (isSecretRefValue(value) && !canReadSecrets(ctx?.agentId)) {
      return secretsDeniedReason("env_set 里的 ${SECRET:NAME} 引用式值", ctx?.agentId);
    }
    if (value.length > MAX_VALUE_CHARS) {
      return `已拒绝：值过长（${value.length} > ${MAX_VALUE_CHARS} 字符）。`;
    }

    const entries = setAgentEnvVar(agentId, key, value);
    try {
      writeAgentEnv(agentId, entries);
    } catch (err) {
      return `错误：写入失败 —— ${err instanceof Error ? err.message : String(err)}`;
    }

    auditToolCall({
      event: "policy",
      origin: ctx?.origin,
      agentId,
      ...(ctx?.sessionId ? { sessionId: ctx.sessionId } : {}),
      tool: "env_set",
      decision: "allow",
      reason: `设置 agent env：${key}（${isSecretRefValue(value) ? "引用式" : "明文"}${
        looksLikeSecretKey(key) ? "，密钥类" : ""
      }）`,
      args: { key },
    });

    const kind = isSecretRefValue(value) ? "引用式 ${SECRET:…}（明文不入本文件）" : "明文值";
    const warn =
      looksLikeSecretKey(key) && !isSecretRefValue(value)
        ? "\n⚠️ 这是明文密钥：同 UID 的进程可通过 /proc/<pid>/environ 读到；更稳的做法是改用 `${SECRET:NAME}` 引用式。"
        : "";
    return `已设置 \`${key}\`（${kind}）→ ${agentEnvPath(agentId)}${warn}`;
  },
});

registerTool({
  requiresMFA: false,
  requiresMFAFor: (args) => looksLikeSecretKey(String(args["key"] ?? "")),
  spec: {
    type: "function",
    function: {
      name: "env_delete",
      description:
        "Delete one environment variable managed by this agent. Deleting a credential-looking key " +
        "requires user approval.",
      parameters: {
        type: "object",
        properties: { key: { type: "string", description: "Variable name to delete" } },
        required: ["key"],
      },
    },
  },
  execute: async (args, ctx) => {
    const agentId = ctx?.agentId ?? "default";
    const key = String(args["key"] ?? "").trim();
    if (key === "") return "已拒绝：缺少 key 参数。";

    const { entries, found } = deleteAgentEnvVar(agentId, key);
    if (!found) return `\`${key}\` 不在 ${agentEnvPath(agentId)} 里，未做改动。`;
    try {
      writeAgentEnv(agentId, entries);
    } catch (err) {
      return `错误：写入失败 —— ${err instanceof Error ? err.message : String(err)}`;
    }
    auditToolCall({
      event: "policy",
      origin: ctx?.origin,
      agentId,
      ...(ctx?.sessionId ? { sessionId: ctx.sessionId } : {}),
      tool: "env_delete",
      decision: "allow",
      reason: `删除 agent env：${key}`,
      args: { key },
    });
    return `已删除 \`${key}\`。`;
  },
});
