/**
 * Code 模式斜杠命令
 *
 * /code      — 切换到 coding 模式（清空当前上下文，不保留长期历史）
 * /chat      — 切换回聊天模式（恢复 chat JSONL 历史）
 * /plan      — 切换到 plan 子模式（AI 先规划后执行）
 * /auto      — 切换到 auto 子模式（AI 直接执行，默认）
 * /workspace — 查看或设置 Code 模式工作目录（持久化存储）
 *
 * 副作用 import：由 src/code/index.ts → src/commands/builtin.ts 触发注册。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { registerCommand } from "../commands/registry.js";
import { agentManager } from "../core/agent-manager.js";
import { Session } from "../core/session.js";

function denyWhileRunning(session: Session): string | null {
  if (!session.running && !session.currentRunPromise) return null;
  return "⚠️ 当前有任务正在运行，不能在运行中切换模式或子模式，请等待完成后再试。";
}

// ── /code ─────────────────────────────────────────────────────────────────────

registerCommand({
  name: "code",
  description: "切换到 Code 模式（独立编码会话，不写入聊天历史，支持 crash 恢复）",
  usage: "/code",
  modes: ["chat"],
  execute({ session }) {
    const denied = denyWhileRunning(session);
    if (denied) return denied;
    if (session.mode === "code") {
      return "ℹ️ 已处于 Code 模式。发送 `/chat` 可返回聊天模式。";
    }
    session.mode = "code";

    // 恢复已有 code 上下文（从 .code.jsonl 加载）
    const hadHistory = session.reloadFromDisk("code");

    // 创建 .code.active 标记，确保 crash 后能正确恢复
    session.activateCodeMode();

    // 加载持久化工作目录
    const savedDir = Session.readCodeDir(agentManager.codeDirPath(session.agentId));
    if (savedDir) {
      session.codeWorkdir = savedDir;
    }

    const defaultDir = agentManager.workspaceDir(session.agentId);
    const dirLine = savedDir
      ? `• 📁 工作目录：\`${savedDir}\`（上次记录，发送 \`/workspace\` 修改）`
      : `• 📁 工作目录：\`${defaultDir}\`（默认，发送 \`/workspace <路径>\` 指定项目目录）`;

    if (hadHistory) {
      return [
        "🖥️ **已进入 Code 模式**（已恢复上次会话）",
        "",
        "• 上次编码上下文已恢复",
        dirLine,
        "• 发送 `/new` 开始全新编码会话",
        "• 发送 `/chat` 可返回聊天模式（上下文将暂存）",
        "• 发送 `/plan` 启用规划子模式；发送 `/auto` 切换回直接执行（默认）",
      ].join("\n");
    }

    return [
      "🖥️ **已进入 Code 模式**",
      "",
      "• 本次编码上下文独立保存，不写入聊天历史",
      "• 进程重启后可自动恢复当前编码上下文",
      dirLine,
      "• 发送 `/chat` 可返回聊天模式（上下文将暂存）",
      "• 发送 `/plan` 启用规划子模式；发送 `/auto` 切换回直接执行（默认）",
    ].join("\n");
  },
});

// ── /chat ─────────────────────────────────────────────────────────────────────

registerCommand({
  name: "chat",
  description: "切换回聊天模式（恢复聊天历史，退出 Code 模式）",
  usage: "/chat",
  modes: ["code"],
  execute({ session }) {
    const denied = denyWhileRunning(session);
    if (denied) return denied;
    if (session.mode === "chat") {
      return "ℹ️ 已处于聊天模式。发送 `/code` 可切换到 Code 模式。";
    }
    session.mode = "chat";
    const hasHistory = session.reloadFromDisk("chat");
    if (hasHistory) {
      return [
        "💬 **已返回聊天模式**",
        "",
        "• 聊天历史已恢复",
        "• 编码会话上下文已暂存，发送 `/code` 可随时恢复",
        "• 发送 `/code` 可重新进入编码会话",
      ].join("\n");
    }
    return [
      "💬 **已返回聊天模式**",
      "",
      "• 暂无聊天历史记录",
      "• 编码会话上下文已暂存，发送 `/code` 可随时恢复",
      "• 发送 `/code` 可重新进入编码会话",
    ].join("\n");
  },
});

// ── /plan ─────────────────────────────────────────────────────────────────────

registerCommand({
  name: "plan",
  description: "切换到 Plan 子模式：AI 先分析任务、输出计划，等用户确认后再执行（需在 Code 模式下）",
  usage: "/plan",
  modes: ["code"],
  execute({ session }) {
    const denied = denyWhileRunning(session);
    if (denied) return denied;
    if (session.codeSubMode === "plan") {
      return "ℹ️ 已处于 Plan 子模式。发送 `/auto` 可切换回直接执行模式。";
    }
    session.saveCodeSubMode(agentManager.codeSubModePath(session.agentId), "plan");
    return [
      "📋 **已进入 Plan 子模式**",
      "",
      "• AI 将先分析任务，输出详细计划供你确认",
      "• 确认后 AI 才会修改代码文件",
      "• 你可以选择批准、提供修改意见，或取消执行",
      "• 发送 `/auto` 可切换回直接执行模式",
    ].join("\n");
  },
});

// ── /auto ─────────────────────────────────────────────────────────────────────

registerCommand({
  name: "auto",
  description: "Auto 子模式已移除，Code 模式现在统一使用 Plan 模式",
  usage: "/auto",
  modes: ["code"],
  execute({ session: _session }) {
    return [
      "⚠️ **Auto 子模式已移除**",
      "",
      "Code 模式现在统一使用 **Plan 模式**：AI 先分析任务、提交计划，用户确认后再执行修改。",
      "发送 `/plan` 查看当前 Plan 模式说明。",
    ].join("\n");
  },
});

// ── /workspace ────────────────────────────────────────────────────────────────

registerCommand({
  name: "workspace",
  description: "查看或设置 Code 模式工作目录（持久化，下次进入自动恢复）",
  usage: "/workspace [路径]",
  modes: ["code"],
  execute({ session, args }) {
    const dirInput = args.join(" ").trim();
    const defaultDir = agentManager.workspaceDir(session.agentId);

    if (!dirInput) {
      const current = session.codeWorkdir ?? defaultDir;
      const isDefault = !session.codeWorkdir;
      return [
        `📁 **当前工作目录**：\`${current}\`${isDefault ? "（默认）" : ""}`,
        "",
        "用法：`/workspace <路径>` 设置项目目录",
      ].join("\n");
    }

    // 解析路径（相对路径以默认 workspace 为基准）
    const resolved = path.isAbsolute(dirInput) ? dirInput : path.resolve(defaultDir, dirInput);

    if (!fs.existsSync(resolved)) {
      return `❌ 目录不存在：\`${resolved}\``;
    }
    if (!fs.statSync(resolved).isDirectory()) {
      return `❌ 路径不是目录：\`${resolved}\``;
    }

    session.saveCodeDir(agentManager.codeDirPath(session.agentId), resolved);
    return [
      `📁 **工作目录已设置**：\`${resolved}\``,
      "",
      "• 已持久化，下次进入 Code 模式将自动恢复",
      "• AI 的 exec_shell 将在此目录下执行命令",
    ].join("\n");
  },
});

// ── /new ──────────────────────────────────────────────────────────────────────

registerCommand({
  name: "new",
  description: "开始全新编码会话（清空当前 Code 模式上下文，需在 Code 模式下）",
  usage: "/new",
  modes: ["code"],
  execute({ session }) {
    session.clearMessages();
    // 重新激活标记（clearMessages 会删除 .code.active，这里需要重建）
    session.activateCodeMode();
    // 各 session 有独立目录（agents/<id>/code/<sessionId>/PLAN.md），无需清理旧 PLAN.md
    return [
      "🆕 **已开始全新编码会话**",
      "",
      "• 上下文已清空，可以开始新任务",
      "• 发送 `/chat` 可返回聊天模式",
    ].join("\n");
  },
});
