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
import { slaveManager } from "../core/slave-manager.js";
import { broadcastActivity } from "../ipc/server.js";

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
        "Run a registered skill: forks a sub-agent with the skill doc injected as a guide " +
        "and waits for the result synchronously.\n" +
        "Prefer this when a user request matches an available skill; for long-running " +
        "skills, tell the user first. async=true runs in the background and notifies " +
        "on completion",
      parameters: {
        type: "object",
        properties: {
          skill_name: {
            type: "string",
            description:
              "Skill name (must match name in SKILLS.md, e.g. stock-daily-report)",
          },
          args: {
            type: "string",
            description: "Extra arguments or notes passed to the skill (optional)",
          },
          async: {
            type: "boolean",
            description:
              "true = run in the background and notify on completion instead of waiting (default false)",
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
    const entry = index.find((e) => e.name === skillName || e.name === skillName.toLowerCase());
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
      ? `Run the following skill: ${skillName}\n\nExtra notes: ${args}`
      : `Run the following skill: ${skillName}`;

    const systemPromptSuffix = `## Skill document being executed\n\n${skillDoc}`;

    // 4. fork sub-agent 并同步等待（复用 masterSession 的 agentId，使用空 context window）
    const slaveSession = new Session(`skill:${skillName}:${Date.now()}`, {
      agentId: ctx.masterSession.agentId,
    });

    const asyncMode = Boolean(rawArgs["async"]);

    if (asyncMode) {
      // ── 异步模式：后台 fork，完成后通过 onNotify 推送结果 ─────────────
      const slaveId = slaveManager.fork(
        task,
        ctx.masterSession,
        0,
        ctx.slaveRunFn,
        async (notif) => {
          const icon = notif.status === "done" ? "✅" : "❌";
          const finishMsg = `${icon} skill \`${skillName}\` 执行完成\n\n${notif.result}`;
          if (ctx.onNotify) await ctx.onNotify(finishMsg);
        },
        undefined,
        undefined,
        "inject",
        { systemPromptSuffix }
      );
      return `⏳ skill \`${skillName}\` 已在后台启动（slave: ${slaveId}），完成后自动通知。`;
    }

    const TIMEOUT_MS = 300_000; // 300s
    // 与 agent_fork 一致：master 用 fs_grant 申请过的路径（TTL 内）随子 Agent 继承，
    // 否则 skill 子 Agent 写那些目录会被拒（工具层）或只读（沙箱层）。子 Agent 仍无审批能力。
    ctx.masterSession.inheritWriteGrantsTo(slaveSession);
    let result: string;
    try {
      const runResult = await Promise.race([
        ctx.slaveRunFn(slaveSession, task, {
          systemPromptSuffix,
          onToolCall: (name: string, args: Record<string, unknown>) => {
            broadcastActivity(slaveSession.sessionId, {
              kind: "tool_call",
              name,
              argsSummary: JSON.stringify(args).slice(0, 200),
            });
          },
          onToolResult: (name: string, res: string) => {
            broadcastActivity(slaveSession.sessionId, {
              kind: "tool_result",
              name,
              resultSummary: res.slice(0, 300),
            });
          },
        }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("skill_run timeout (300s)")), TIMEOUT_MS)
        ),
      ]);
      result = runResult.content?.trim() || "(skill 执行完成,无输出)";
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return `❌ skill "${skillName}" 执行失败:${msg}`;
    }

    // 清理 skill 临时 session JSONL,并裁剪同前缀旧文件
    slaveSession.deleteJsonl();
    Session.pruneOldByPrefix(`skill_${skillName}_`, 1);
    return `✅ skill \`${skillName}\` 执行完成\n\n${result}`;
  },
});
