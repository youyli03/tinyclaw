/**
 * code-project tools — 项目切换与状态查询
 *
 * project_switch: 绑定/切换到指定项目
 * project_status: 查看当前绑定状态
 * project_list:   列出所有可用项目
 */

import { registerTool } from "./registry.js";
import {
  getProjectBinding,
  setProjectBinding,
  acquireLock,
  releaseLock,
  readLock,
  workdirToSlug,
  slugToWorkdir,
  isValidProject,
  listAllProjects,
} from "../core/project-router.js";
import { ensureProjectMemory } from "../core/project-memory.js";

// ── project_switch ───────────────────────────────────────────────────────────

registerTool({
  requiresMFA: true,
  spec: {
    type: "function",
    function: {
      name: "project_switch",
      description:
        "Switch to the given project. Subsequent turns then use the project context " +
        "(MEMORY.md + topic files). If another session already holds that project, an error is " +
        "returned. The task argument runs after the switch: injected as a user message, and " +
        "the AI starts ReAct on the next turn.",
      parameters: {
        type: "object",
        properties: {
          project: {
            type: "string",
            description:
              "Project slug (e.g. _home_lyy_tinyclaw) or absolute path " +
              "(e.g. /home/lyy/tinyclaw)",
          },
          task: {
            type: "string",
            description:
              "Task description to run after the switch (required). For example: 'look at the " +
              "recent commits', 'fix the type error in auth.ts'",
          },
        },
        required: ["project", "task"],
      },
    },
  },
  async execute(args, ctx): Promise<string> {
    const { project, task } = args as { project: string; task: string };
    const sessionId = ctx?.sessionId;
    const agentId = ctx?.agentId ?? "default";

    if (!sessionId) return "错误:缺少 session 上下文";

    // 1. 解析 project → slug
    let slug: string;
    if (project.startsWith("/") || project.startsWith("~/")) {
      slug = workdirToSlug(project);
    } else {
      slug = project;
    }

    // 2. 校验项目是否有效；不存在则尝试自动初始化
    if (!isValidProject(agentId, slug)) {
      const wd = slugToWorkdir(slug);
      if (wd) {
        // 目录存在 → 自动初始化项目数据结构
        ensureProjectMemory(agentId, slug, { workdir: wd });
      } else {
        return `错误:项目 "${slug}" 不存在(目录未找到)。可用 project_list 查看所有项目。`;
      }
    }

    // 3. 读取当前绑定
    const currentBinding = getProjectBinding(sessionId);

    // 4. 已在当前项目
    if (currentBinding === slug) {
      // 直接注入 task
      const sess = ctx?.masterSession;
      if (sess) {
        sess._pendingProjectTask = task;
        sess._projectJustSwitched = true;
      }
      return `✅ 已在当前项目 \`${slug}\`。任务已注入:${task}`;
    }

    // 5. 尝试获取新锁
    const locked = acquireLock(agentId, slug, sessionId);
    if (!locked) {
      const existingLock = readLock(agentId, slug);
      return `❌ 无法切换到项目 \`${slug}\`:已被 session \`${existingLock?.holder ?? "unknown"}\` 占用。`;
    }

    // 6. 释放旧锁
    if (currentBinding) {
      releaseLock(agentId, currentBinding, sessionId);
    }

    // 7. 更新跳板文件
    setProjectBinding(sessionId, slug);

    // 8. 获取 session 对象并更新 projectSlug、注入 task
    const sess = ctx?.masterSession;
    if (sess) {
      // projectSlug 由 agent.ts 在所有 tool_result 写入完成后从跳板文件读取,
      // 避免提前设置导致 addToolResultMessage 时 _getJsonlPath 切换到项目文件
      // 暂存 task,agent.ts 在 flushRoundPendingUserMsgs 后统一注入(避免打断 tool_result 序列)
      sess._pendingProjectTask = task;
      // 设置标记,agent.ts 下一轮检测后重建项目 prompt
      sess._projectJustSwitched = true;
    }

    return `✅ 已切换到项目 \`${slug}\`。任务已注入,即将开始执行。`;
  },
});

// ── project_status ───────────────────────────────────────────────────────────

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "project_status",
      description: "Show the current session's project binding and lock holder.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  async execute(_args, ctx): Promise<string> {
    const sessionId = ctx?.sessionId;
    const agentId = ctx?.agentId ?? "default";

    if (!sessionId) return "错误:缺少 session 上下文";

    const binding = getProjectBinding(sessionId);
    if (!binding) {
      return "📋 当前 session 未绑定任何项目。使用 project_switch 切换到目标项目。";
    }

    const lock = readLock(agentId, binding);
    const workdir = slugToWorkdir(binding);

    let out = `## 项目状态\n\n`;
    out += `- **项目**: \`${binding}\`\n`;
    if (workdir) out += `- **工作目录**: \`${workdir}\`\n`;
    if (lock) {
      out += `- **锁持有者**: \`${lock.holder}\`\n`;
      out += `- **获取时间**: ${lock.acquiredAt}\n`;
      if (lock.holder === sessionId) {
        out += `- **状态**: ✅ 当前 session 持有锁\n`;
      } else {
        out += `- **状态**: ⚠️ 锁被其他 session 持有\n`;
      }
    } else {
      out += `- **锁**: 未锁定\n`;
    }

    return out;
  },
});

// ── project_list ─────────────────────────────────────────────────────────────

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "project_list",
      description: "List all registered projects (slug + working directory).",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  async execute(_args, ctx): Promise<string> {
    const agentId = ctx?.agentId ?? "default";
    const slugs = listAllProjects(agentId);

    if (slugs.length === 0) {
      return "📋 暂无已注册的项目。使用 project_switch 首次绑定项目后将自动注册。";
    }

    const currentBinding = ctx?.sessionId ? getProjectBinding(ctx.sessionId) : null;

    let out = `## 可用项目 (${slugs.length})\n\n`;
    out += `| 项目 | 工作目录 | 状态 |\n`;
    out += `|------|----------|------|\n`;

    for (const slug of slugs) {
      const wd = slugToWorkdir(slug) ?? "-";
      const isCurrent = slug === currentBinding ? "✅ 当前" : "";
      out += `| \`${slug}\` | \`${wd}\` | ${isCurrent} |\n`;
    }

    return out;
  },
});
