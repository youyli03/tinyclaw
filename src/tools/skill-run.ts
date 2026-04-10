/**
 * skill_run 工具 — 同步 fork sub-agent 执行指定 skill 并返回结果
 *
 * 仅在 chat 模式注入（agent.ts 工具过滤中排除 code 模式）。
 * 执行流程：
 *  1. 解析 SKILLS.md 找到对应 skill 的文档路径
 *  2. 读取 SKILL.md 完整内容
 *  3. 通过 ctx.slaveRunFn fork 一个 sub-agent（systemPromptSuffix = skill 内容）
 *  4. 同步等待结果（timeout 300s）
 *  5. 返回结果给调用方
 */

import * as fs from "node:fs";
import { registerTool, type ToolContext } from "./registry.js";
import { Session } from "../core/session.js";
import { skillRegistry, type SkillEntry } from "../skills/registry.js";

// ── 兼容旧调用方的 re-export ─────────────────────────────────────────────

/**
 * @deprecated 请改用 skillRegistry.getEntries(agentId)
 * 保留此函数仅为向后兼容，内部已走缓存。
 */
export function parseSkillsIndex(agentId: string): SkillEntry[] {
  return skillRegistry.getEntries(agentId);
}

export type { SkillEntry };

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "skill_run",
      description:
        "执行一个已注册的 skill（技能工作流）。会 fork 一个独立 sub-agent，" +
        "注入 skill 文档作为执行指南，同步等待完成后返回结果。\n\n" +
        "**使用场景**：当用户请求匹配某个可用技能时，优先调用此工具执行，而不是自行尝试。\n" +
        "**注意**：执行耗时较长的 skill 时请告知用户正在执行中。",
      parameters: {
        type: "object",
        properties: {
          skill_name: {
            type: "string",
            description: "要执行的 skill 名称（与 SKILLS.md 中的 name 一致，如 stock-daily-report）",
          },
          args: {
            type: "string",
            description: "传给 skill 的附加参数或说明（可选）",
          },
        },
        required: ["skill_name"],
      },
    },
  },
  execute: async (rawArgs: Record<string, unknown>, ctx?: ToolContext): Promise<string> => {
    const skillName = String(rawArgs["skill_name"] ?? "").trim();
    if (!skillName) return "错误：缺少 skill_name 参数";

    const args = rawArgs["args"] ? String(rawArgs["args"]).trim() : "";

    // 需要 slaveRunFn 才能 fork
    if (!ctx?.slaveRunFn) {
      return "⚠️ skill_run 不能在 sub-agent 内嵌套调用（已达最大嵌套深度）。";
    }
    if (!ctx.masterSession) {
      return "错误：skill_run 需要在交互式会话中调用（masterSession 未提供）";
    }

    const agentId = ctx.agentId ?? "default";

    // 1. 解析 SKILLS.md，找到对应条目
    const index = parseSkillsIndex(agentId);
    const entry = index.find(
      (e) => e.name === skillName || e.name === skillName.toLowerCase()
    );
    if (!entry) {
      const available = index.map((e) => e.name).join(", ") || "（暂无）";
      return `错误：找不到 skill "${skillName}"。可用技能：${available}`;
    }

    // 2. 读取 skill 文档
    if (!fs.existsSync(entry.docPath)) {
      return `错误：skill 文档不存在：${entry.docPath}`;
    }
    const skillDoc = fs.readFileSync(entry.docPath, "utf-8").trim();
    if (!skillDoc) {
      return `错误：skill 文档为空：${entry.docPath}`;
    }

    // 3. 构建 sub-agent task
    const task = args
      ? `执行以下技能：${skillName}\n\n附加说明：${args}`
      : `执行以下技能：${skillName}`;

    const systemPromptSuffix = `## 当前执行的 Skill 文档\n\n${skillDoc}`;

    // 4. fork sub-agent 并同步等待（复用 masterSession 的 agentId，使用空 context window）
    const slaveSession = new Session(`skill:${skillName}:${Date.now()}`, {
      agentId: ctx.masterSession.agentId,
    });

    const TIMEOUT_MS = 300_000; // 300s
    let result: string;
    try {
      const runResult = await Promise.race([
        ctx.slaveRunFn(slaveSession, task, { systemPromptSuffix }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("skill_run timeout (300s)")), TIMEOUT_MS)
        ),
      ]);
      result = runResult.content?.trim() || "（skill 执行完成，无输出）";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `❌ skill "${skillName}" 执行失败：${msg}`;
    }

    return `✅ skill \`${skillName}\` 执行完成\n\n${result}`;
  },
});
