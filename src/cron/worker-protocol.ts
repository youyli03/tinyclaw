export type CronWorkerRequest =
  | { type: "run"; requestId: string; jobId: string };

export type CronWorkerResponse =
  | { type: "ready" }
  | { type: "job_done"; requestId: string }
  | { type: "job_error"; requestId: string; message: string };
