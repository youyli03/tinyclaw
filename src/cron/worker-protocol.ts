export type CronWorkerRequest =
  | { type: "run"; requestId: string; jobId: string; trigger: "schedule" | "manual" }
  /** 主进程通知 worker:某 agent 的 skill 文件已变更,需刷新缓存 */
  | { type: "skills_changed"; agentId: string }
  /** 主进程通知 worker:mcp.toml 已变更并已重载,需自行重载本地 MCP 配置 */
  | { type: "mcp_changed" };

export type CronWorkerResponse =
  | { type: "ready" }
  | { type: "job_done"; requestId: string }
  | { type: "job_error"; requestId: string; message: string };
