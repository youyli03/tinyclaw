/**
 * Copilot Code 后端（stub）
 *
 * 当前实现直接复用 tinyclaw 自身的 runAgent() 来处理 code 模式任务。
 * 未来可在此扩展：注入 Copilot 专属工具、修改 system prompt、监控 token 消耗等。
 *
 * 通过 import 副作用触发注册（由 src/code/index.ts 导入）。
 */

import type { CodeBackend } from "./types.js";

/** Copilot 后端实例（单例，仅供类型检查和标识使用） */
export const copilotBackend: CodeBackend = {
  name: "copilot",
};
