/**
 * 配置管理工具（校验 / 热重载）
 *
 * - `config_validate`：只读。跑写前校验（语法 / schema / 交叉引用 + 工具名拼写，用**运行中的注册表**）
 *   与离线健康自检。无副作用、不需要 MFA。
 * - `config_reload`：把磁盘上的 `config.toml` 热应用进运行中的进程（分级：hot 换缓存 / soft 重 init /
 *   restart 受控重启），失败或自检发现确定性错误时回退到上一份可用配置。**需要 MFA**（会改运行期行为）。
 *
 * 安全边界：`config.toml` 仍是密钥文件，通用文件工具读写它一律被拒；这里是"被认可的接口"。
 * 无人值守（cron / loop）两个工具都**硬拒绝**（`auth/tool-policy.ts` 的 HARD_DENY_REACT_UNATTENDED）。
 */

import { registerTool, getTool } from "./registry.js";
import { guardSelfManagement } from "./agent-binding.js";
import { agentManager } from "../core/agent-manager.js";
import { readRawConfig, patchTomlField } from "../config/writer.js";
import { validateConfigText, formatConfigDiags } from "../config/validate.js";
import { isConfigSetPathAllowed } from "../config/settable-paths.js";
import { runOfflineHealthChecks, formatHealthReport } from "../health/config-health.js";
import { reloadConfig } from "../config/reload.js";

/** 运行中的工具注册表 + agent 列表（校验交叉引用用） */
function runtimeContext(): { knownTool: (n: string) => boolean; knownAgent: (id: string) => boolean } {
  return {
    knownTool: (name: string) => getTool(name) !== undefined,
    knownAgent: (id: string) => agentManager.listAgentIds().includes(id),
  };
}

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "config_validate",
      description:
        "Validate the on-disk ~/.tinyclaw/config.toml without changing anything: TOML syntax, the Zod " +
        "schema, and cross-references (unknown keys that would be silently ignored, tool names that do " +
        "not exist, non-absolute or missing writable paths, $SECRET placeholders missing from " +
        "secrets.toml, unknown agent ids). Also runs the offline health checks (directory " +
        "writability, sandbox availability, IPC socket path length).",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  execute: async (_args, toolCtx) => {
    const denied = guardSelfManagement("config_validate", toolCtx?.agentId);
    if (denied !== null) return denied;
    const rawText = readRawConfig();
    const vctx = runtimeContext();
    const validation = validateConfigText(rawText, vctx);
    const lines = ["## 配置校验", ...formatConfigDiags(validation.diagnostics)];
    if (validation.config === undefined) {
      lines.push("", "❌ 配置无法解析：服务重启时会 fail-fast 拒绝启动");
      return lines.join("\n");
    }
    lines.push(
      "",
      ...formatHealthReport(runOfflineHealthChecks({ cfg: validation.config, rawText, ...vctx }))
    );
    return lines.join("\n");
  },
});

registerTool({
  requiresMFA: true,
  spec: {
    type: "function",
    function: {
      name: "config_reload",
      description:
        "Hot-reload ~/.tinyclaw/config.toml into the running process. The file is validated first " +
        "(a broken file is rejected and nothing is applied), then the change is classified: 'hot' " +
        "sections just refresh the cached config, 'soft' sections (LLM backends, concurrency) re-init " +
        "their subsystem, and 'restart' sections (channels, voice, web.port, sandbox toggles) trigger a " +
        "supervised restart. Afterwards a health check runs; a deterministic failure (401/403/404/unknown " +
        "model) rolls the config back to the last known good version. Use it after editing config.toml " +
        "by hand.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  execute: async (_args, toolCtx) => {
    const denied = guardSelfManagement("config_reload", toolCtx?.agentId);
    if (denied !== null) return denied;
    const res = await reloadConfig("tool", runtimeContext());
    return res.message;
  },
});

// ── config_set：模型可以自己调的"安全段" ──────────────────────────────────────

/** 把字符串值推断成 TOML 字面量（与 `tinyclaw config set` 同口径） */
function toTomlLiteral(raw: string): string {
  const v = raw.trim();
  if (v === "true" || v === "false") return v;
  if (/^-?\d+(\.\d+)?$/.test(v)) return v;
  if (v.startsWith("[") && v.endsWith("]")) {
    try {
      const parsed = JSON.parse(v) as unknown[];
      return "[" + parsed.map((x) => JSON.stringify(x)).join(", ") + "]";
    } catch {
      return JSON.stringify(raw);
    }
  }
  return JSON.stringify(raw);
}

registerTool({
  requiresMFA: true,
  spec: {
    type: "function",
    function: {
      name: "config_set",
      description:
        "Set ONE config field in ~/.tinyclaw/config.toml and hot-reload it, so the change takes effect " +
        "without a restart. Only a small allow-list of fields is writable: model and per-backend " +
        "parameters (llm.backends.<daily|code|summarizer|vision>.*), model aliases (llm.aliases.*), " +
        "round/truncation limits (tools.max*ToolRounds / maxToolResultChars / maxToolCallArgChars), " +
        "retry pacing (retry.*) and interactive reminder timing (interactive.*). Everything that guards " +
        "the agent itself is refused: auth, sandbox, selfAccess, health, channels, web, providers, " +
        "memory, submitter, agent, tools.http_request, llm.premiumAllowlist. The write is validated as a " +
        "whole (a bad value is rejected and nothing is written), backed up, written atomically with 0600 " +
        "permissions, and reverted automatically if the post-change health check fails.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              "Dotted config path, e.g. llm.backends.daily.model, llm.aliases.fast, " +
              "tools.maxChatToolRounds, retry.maxAttempts, interactive.maxReminds",
          },
          value: {
            type: "string",
            description:
              "New value as text: true/false, a number, a JSON array, or a plain string " +
              '(e.g. "deepseek/deepseek-reasoner"). Type is inferred like `tinyclaw config set`.',
          },
        },
        required: ["path", "value"],
      },
    },
  },
  execute: async (args, toolCtx) => {
    const denied = guardSelfManagement("config_set", toolCtx?.agentId);
    if (denied !== null) return denied;

    const path = String(args["path"] ?? "").trim();
    const value = args["value"] === undefined ? undefined : String(args["value"]);
    if (path === "" || value === undefined) return "已拒绝：缺少 path 或 value 参数。";

    const policy = isConfigSetPathAllowed(path);
    if (!policy.ok) return policy.reason ?? "已拒绝：该字段不可写。";

    const parts = path.split(".");
    const key = parts.pop();
    if (key === undefined || parts.length === 0) {
      return `已拒绝：路径 "${path}" 至少要包含 section 与字段名。`;
    }

    // 先用写前校验拦一道（坏值不落盘），再交给 reloadConfig 分级应用
    const writeRes = patchTomlField(parts, key, toTomlLiteral(value), runtimeContext());
    if (!writeRes.ok) {
      return [
        `已拒绝：写入会使 config.toml 校验失败，未做任何改动。`,
        ...formatConfigDiags(writeRes.diagnostics),
        `被拒内容已留证：${writeRes.rejectedPath}`,
      ].join("\n");
    }

    const applied = await reloadConfig("tool", runtimeContext());
    const cls = applied.plan.cls;
    return [
      `已设置 ${path} = ${value}`,
      `备份：${writeRes.backupPath ?? "无（文件原本不存在）"}`,
      `变更分级：${cls}${cls === "restart" ? "（已请求受控重启）" : "（已热应用）"}`,
      applied.message,
    ].join("\n");
  },
});
