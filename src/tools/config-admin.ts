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
import { agentManager } from "../core/agent-manager.js";
import { readRawConfig } from "../config/writer.js";
import { validateConfigText, formatConfigDiags } from "../config/validate.js";
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
  execute: async () => {
    const rawText = readRawConfig();
    const ctx = runtimeContext();
    const validation = validateConfigText(rawText, ctx);
    const lines = ["## 配置校验", ...formatConfigDiags(validation.diagnostics)];
    if (validation.config === undefined) {
      lines.push("", "❌ 配置无法解析：服务重启时会 fail-fast 拒绝启动");
      return lines.join("\n");
    }
    lines.push("", ...formatHealthReport(runOfflineHealthChecks({ cfg: validation.config, rawText, ...ctx })));
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
  execute: async () => {
    const res = await reloadConfig("tool", runtimeContext());
    return res.message;
  },
});
