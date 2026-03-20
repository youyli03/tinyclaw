/**
 * Code 模式斜杠命令
 *
 * /code — 切换到 coding 模式（清空当前上下文，不保留长期历史）
 * /chat — 切换回聊天模式（恢复 chat JSONL 历史）
 * /plan — 切换到 plan 子模式（AI 先规划后执行）
 * /auto — 切换到 auto 子模式（AI 直接执行，默认）
 *
 * 副作用 import：由 src/code/index.ts → src/commands/builtin.ts 触发注册。
 */

import { registerCommand } from "../commands/registry.js";

// ── /code ─────────────────────────────────────────────────────────────────────

registerCommand({
  name: "code",
  description: "切换到 Code 模式（独立编码会话，不写入聊天历史，支持 crash 恢复）",
  usage: "/code",
  execute({ session }) {
    if (session.mode === "code") {
      return "ℹ️ 已处于 Code 模式。发送 `/chat` 可返回聊天模式。";
    }
    session.mode = "code";
    session.clearMessages();
    return [
      "🖥️ **已进入 Code 模式**",
      "",
      "• 本次编码上下文独立保存，不写入聊天历史",
      "• 进程重启后可自动恢复当前编码上下文",
      "• 发送 `/chat` 可返回聊天模式（恢复之前的聊天历史）",
      "• 发送 `/plan` 启用规划子模式，`/auto` 切换回直接执行（默认）",
    ].join("\n");
  },
});

// ── /chat ─────────────────────────────────────────────────────────────────────

registerCommand({
  name: "chat",
  description: "切换回聊天模式（恢复聊天历史，退出 Code 模式）",
  usage: "/chat",
  execute({ session }) {
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
        "• 编码会话上下文已清除",
        "• 发送 `/code` 可重新开始编码会话",
      ].join("\n");
    }
    return [
      "💬 **已返回聊天模式**",
      "",
      "• 暂无聊天历史记录",
      "• 发送 `/code` 可切换到 Code 模式",
    ].join("\n");
  },
});

// ── /plan ─────────────────────────────────────────────────────────────────────

registerCommand({
  name: "plan",
  description: "切换到 Plan 子模式：AI 先分析任务、输出计划，等用户确认后再执行（需在 Code 模式下）",
  usage: "/plan",
  execute({ session }) {
    if (session.mode !== "code") {
      return "ℹ️ `/plan` 仅在 Code 模式下有效。发送 `/code` 先切换到 Code 模式。";
    }
    if (session.codeSubMode === "plan") {
      return "ℹ️ 已处于 Plan 子模式。发送 `/auto` 可切换回直接执行模式。";
    }
    session.codeSubMode = "plan";
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
  description: "切换到 Auto 子模式：AI 直接执行任务，不经过规划阶段（默认模式，需在 Code 模式下）",
  usage: "/auto",
  execute({ session }) {
    if (session.mode !== "code") {
      return "ℹ️ `/auto` 仅在 Code 模式下有效。发送 `/code` 先切换到 Code 模式。";
    }
    if (session.codeSubMode === "auto") {
      return "ℹ️ 已处于 Auto 子模式（默认）。发送 `/plan` 可切换到规划子模式。";
    }
    session.codeSubMode = "auto";
    return [
      "🚀 **已切换到 Auto 子模式**",
      "",
      "• AI 将直接分析并执行任务，不经过规划确认",
      "• 这是 Code 模式的默认行为",
      "• 发送 `/plan` 可切换回规划子模式",
    ].join("\n");
  },
});


// ── /code ─────────────────────────────────────────────────────────────────────

registerCommand({
  name: "code",
  description: "切换到 Code 模式（独立编码会话，不写入聊天历史，支持 crash 恢复）",
  usage: "/code",
  execute({ session }) {
    if (session.mode === "code") {
      return "ℹ️ 已处于 Code 模式。发送 `/chat` 可返回聊天模式。";
    }
    session.mode = "code";
    session.clearMessages();
    return [
      "🖥️ **已进入 Code 模式**",
      "",
      "• 本次编码上下文独立保存，不写入聊天历史",
      "• 进程重启后可自动恢复当前编码上下文",
      "• 发送 `/chat` 可返回聊天模式（恢复之前的聊天历史）",
    ].join("\n");
  },
});

// ── /chat ─────────────────────────────────────────────────────────────────────

registerCommand({
  name: "chat",
  description: "切换回聊天模式（恢复聊天历史，退出 Code 模式）",
  usage: "/chat",
  execute({ session }) {
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
        "• 编码会话上下文已清除",
        "• 发送 `/code` 可重新开始编码会话",
      ].join("\n");
    }
    return [
      "💬 **已返回聊天模式**",
      "",
      "• 暂无聊天历史记录",
      "• 发送 `/code` 可切换到 Code 模式",
    ].join("\n");
  },
});
