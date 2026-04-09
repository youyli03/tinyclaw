import { loadConfig } from "../config/loader.js";
import { llmRegistry } from "../llm/registry.js";
import { initLLMConcurrency } from "../llm/concurrency.js";
import { mcpManager } from "../mcp/client.js";
import { agentManager } from "../core/agent-manager.js";
import { getJob } from "./store.js";
import { runJob } from "./runner.js";
import { ChatRuntimeBridge } from "./runtime-bridge.js";

async function main(): Promise<void> {
  const jobId = process.argv[2];
  if (!jobId) {
    throw new Error("missing cron job id");
  }

  const cfg = loadConfig();
  await llmRegistry.init();
  initLLMConcurrency(cfg.concurrency.maxConcurrentLLMRequests);
  await mcpManager.init();
  agentManager.ensureDefault();

  const job = getJob(jobId);
  if (!job) {
    throw new Error(`cron job "${jobId}" not found`);
  }

  await runJob(job, new ChatRuntimeBridge());
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("[cron-worker] fatal:", err);
    process.exit(1);
  });
