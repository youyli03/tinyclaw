import { loadConfig } from "../config/loader.js";
import { llmRegistry } from "../llm/registry.js";
import { initLLMConcurrency } from "../llm/concurrency.js";
import { mcpManager } from "../mcp/client.js";
import { agentManager } from "../core/agent-manager.js";
import { getJob } from "./store.js";
import { runJob } from "./runner.js";
import { ChatRuntimeBridge } from "./runtime-bridge.js";
import type { CronJob } from "./schema.js";
import type { CronWorkerRequest, CronWorkerResponse } from "./worker-protocol.js";

function send(msg: CronWorkerResponse): void {
  if (typeof process.send === "function") {
    process.send(msg);
  }
}

function classifyJob(job: CronJob): "tool-only" | "agent" {
  if (Array.isArray(job.steps) && job.steps.length > 0 && job.steps.every((step) => step.type === "tool")) {
    return "tool-only";
  }
  return "agent";
}

async function initRuntime(): Promise<void> {
  const cfg = loadConfig();
  await llmRegistry.init();
  initLLMConcurrency(cfg.concurrency.maxConcurrentLLMRequests);
  await mcpManager.init();
  agentManager.ensureDefault();
}

async function handleRun(requestId: string, jobId: string): Promise<void> {
  try {
    const job = getJob(jobId);
    if (!job) {
      send({ type: "job_error", requestId, message: `cron job \"${jobId}\" not found` });
      return;
    }

    console.log(`[cron-worker] request=${requestId} job=${jobId} route=${classifyJob(job)}`);
    await runJob(job, new ChatRuntimeBridge());
    send({ type: "job_done", requestId });
  } catch (err) {
    send({
      type: "job_error",
      requestId,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

async function main(): Promise<void> {
  await initRuntime();
  send({ type: "ready" });

  process.on("message", (msg: CronWorkerRequest) => {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "run") {
      void handleRun(msg.requestId, msg.jobId);
    }
  });

  process.on("SIGTERM", () => process.exit(0));
  process.on("SIGINT", () => process.exit(0));
}

main().catch((err) => {
  console.error("[cron-worker] fatal:", err);
  process.exit(1);
});
