/**
 * Code 模式后端接口定义。
 *
 * 当前实现：copilot（使用 tinyclaw 自身的 LLM + runAgent）
 * 未来可扩展：codex、claude-code（调用外部 CLI 子进程）
 */

export type CodeBackendName = "copilot" | "codex" | "claude-code";

/**
 * Code 后端接口。
 * 每个后端负责接受用户任务、执行并返回结果。
 * copilot 后端直接复用 runAgent()；外部 CLI 后端 spawn 子进程并捕获输出。
 */
export interface CodeBackend {
  readonly name: CodeBackendName;
}
