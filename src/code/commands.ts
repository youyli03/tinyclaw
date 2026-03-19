/**
 * Code 模式斜杠命令
 *
 * /code — 切换到 coding 模式（清空当前上下文，不保留长期历史）
 * /chat — 切换回聊天模式（恢复 chat JSONL 历史）
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
