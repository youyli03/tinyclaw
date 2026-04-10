export type CronWorkerRequest =
  | { type: "run"; requestId: string; jobId: string }
  /** 主进程通知 worker：某 agent 的 skill 文件已变更，需刷新缓存 */
  | { type: "skills_changed"; agentId: string };

export type CronWorkerResponse =
  | { type: "ready" }
  | { type: "job_done"; requestId: string }
  | { type: "job_error"; requestId: string; message: string };
