#!/usr/bin/env node
/**
 * 文案索引（text index）—— 改行为时"还有哪些文案要跟着改"的机械答案。
 *
 * 起因：cron / loop / job / wake 这类功能的说明散落在很多层（实现注释、工具 description、内置
 * system prompt、schema 注释与 config.example.toml、docs/**、模型手册 docs/manual/**、README、
 * AGENTS.md、CLI help）。光靠 `grep 主关键词` 会漏两类地方：
 *   1. 描述同一行为但**不含主关键词**的句子（例如讲 wake 权限却只写 "无人值守"/"白名单"）；
 *   2. 不知道自己"该去哪些层找"——于是只改了 docs，忘了工具描述或手册。
 *
 * 本脚本把两件事合一：每个主题给一组**具体字面串**（刻意选得具体，避免 `env` 这种词到处命中），
 * 扫全部 git 跟踪的文本文件，按层分组打印 file:line —— 并对照该主题"应当存在文案的层"，
 * 把**声明了却没有命中**的层显式列出来（那通常就是被你漏掉的那份文案）。
 *
 * 用法：
 *   node --import tsx/esm scripts/text-index.ts --list          # 列主题
 *   node --import tsx/esm scripts/text-index.ts wake            # 定位 wake 的全部文案
 *   node --import tsx/esm scripts/text-index.ts cron loop job   # 多主题
 *   node --import tsx/esm scripts/text-index.ts --all           # 全部主题
 *   node --import tsx/esm scripts/text-index.ts --write         # 重新生成 docs/architecture/text-index.md
 *   node --import tsx/esm scripts/text-index.ts wake --json     # 机器可读
 * 等价 npm 入口：npm run text-index -- wake
 *
 * ⚠️ 新增主题 = 在本文件底部的 TOPICS 里加一条（这是索引的**唯一真相**，md 由 --write 生成，别手改）。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_MD = path.join(REPO, "docs", "architecture", "text-index.md");

/** 文案所在的层（按顺序判定，先命中先归属；路径判定见 layerOf） */
const LAYERS = [
  { id: "manual", title: "Model-facing manuals (`docs/manual/**`, ephemeral, loaded via the `manual` tool)" },
  { id: "cli", title: "CLI help/usage strings (`src/cli/**`, `bin/**`)" },
  { id: "tool", title: "Tool specs: name/description/parameter docs (`src/tools/**`)" },
  { id: "prompt", title: "Built-in system prompts (`src/code/system-prompt.ts`, `src/instructions/**`; the chat prompt template lives in `src/core/agent.ts`)" },
  { id: "tests", title: "Tests and probe expectations (`tests/**`)" },
  { id: "config-example", title: "Example config with field docs (`*.example.toml`)" },
  { id: "readme", title: "`README.md`" },
  { id: "agents", title: "`AGENTS.md` (facts + trap list)" },
  { id: "docs", title: "Human docs (`docs/**`, excluding `docs/manual`)" },
  { id: "code", title: "Implementation and its comments (`src/**`)" },
  { id: "other", title: "Anything else tracked (skills, mcp-servers, root scripts)" },
] as const;

type LayerId = (typeof LAYERS)[number]["id"];

interface TextTopic {
  /** CLI 键，也是给人看的主关键词 */
  id: string;
  title: string;
  /** 行为以这些文件为准（改文案前先读它们） */
  canonical: string[];
  /** 命中用的字面串（大小写不敏感子串匹配）——务必具体，避免 `env`/`config` 这类泛词 */
  terms: string[];
  /** 该主题**应当**存在文案的层；声明了却 0 命中 = 大概率漏改 */
  layers: LayerId[];
}

const TOPICS: TextTopic[] = [
  {
    id: "cron",
    title: "Cron jobs (scheduled tasks)",
    canonical: ["src/cron/schema.ts", "src/cron/runner.ts", "src/cron/scheduler.ts", "src/tools/cron.ts"],
    terms: [
      "cron_add",
      "cron_run",
      "cron job",
      "cron/<id>",
      "TINYCLAW_CRON_JOB_ID",
      "intervalSecs",
      "timesOfDay",
      "timeRange",
      "runAt",
      "stateful",
      "mfaExempt",
      "clearSessionOnRun",
      "logLevel",
      "PipelineStep",
    ],
    layers: ["code", "tool", "config-example", "docs", "manual", "readme", "agents", "cli"],
  },
  {
    id: "loop",
    title: "Loop triggers (watch mode) and loop sessions",
    canonical: [
      "src/core/loop-trigger.ts",
      "src/core/loop-runner.ts",
      "src/tools/loop-control.ts",
      "src/tools/loop-exit.ts",
    ],
    terms: [
      "loop_control",
      "loop_exit",
      "loop-trigger",
      "loop session",
      "tickSeconds",
      "preCheckScript",
      "bindTo",
      "allowExit",
      "timeRanges",
      "loops/<id>.json",
      "LoopRunner",
    ],
    layers: ["code", "tool", "docs", "manual", "readme", "agents"],
  },
  {
    id: "job",
    title: "Background process jobs (job_start and friends)",
    canonical: ["src/core/job-manager.ts", "src/core/systemd-run.ts", "src/tools/jobs.ts"],
    terms: [
      "job_start",
      "job_output",
      "job_kill",
      "job_status",
      "job_list",
      "TINYCLAW_JOB_ID",
      ".tinyclaw/jobs",
      "systemd-run",
      "detach",
      "timeout_secs",
      "MAX_RUNNING_TOTAL",
    ],
    layers: ["code", "tool", "docs", "manual", "readme", "agents", "tests"],
  },
  {
    id: "env",
    title: "Environment variables for agents / jobs / cron",
    canonical: [
      "src/config/agent-env.ts",
      "src/cron/run-env.ts",
      "src/tools/env-admin.ts",
      "src/core/systemd-run.ts",
    ],
    terms: [
      "agents/<id>/env",
      ".tinyclaw/env",
      "env_set",
      "env_list",
      "env_delete",
      "buildJobEnvBase",
      "buildCronRunEnv",
      "withWakeShimPath",
      "extraEnv",
      "loadDotEnv",
    ],
    layers: ["code", "tool", "config-example", "docs", "manual", "readme", "agents"],
  },
  {
    id: "wake",
    title: "Waking a session (wake tool / CLI / shim / IPC)",
    canonical: [
      "src/main.ts",
      "src/tools/wake.ts",
      "src/core/wake-shim.ts",
      "src/ipc/protocol.ts",
      "src/core/session-channel.ts",
    ],
    terms: [
      "wake(",
      "wake ",
      "TINYCLAW_WAKE_TARGET",
      "WAKE_MIN_INTERVAL_MS",
      "wake-shim",
      "agent.sock",
      "woken",
      "mfaForSession",
      "notifyForSession",
      // 中文文案里"唤醒"就是标记词；`origin=cron` 是被唤醒那一轮权限口径的字面串
      // （2026-09-25 改动时真正漏掉的那行 `src/ipc/client.ts` 只含这两个词，不含 "wake"）
      "唤醒",
      "origin=cron",
    ],
    layers: ["code", "tool", "docs", "manual", "readme", "agents", "cli", "config-example"],
  },
  {
    id: "manual",
    title: "On-demand manuals and ephemeral tool results",
    canonical: ["src/tools/manual.ts", "docs/manual", "src/core/session.ts", "src/tools/registry.ts"],
    terms: [
      "docs/manual",
      "MANUAL_VERSION",
      "ephemeralResult",
      "_ephemeralCallIds",
      "_serializeForPersist",
      "dropEphemeralMessages",
      "isEphemeralResultTool",
    ],
    layers: ["code", "tool", "docs", "readme", "agents"],
  },
  {
    id: "origin-permissions",
    title: "Run origin, unattended whitelist and MFA gating",
    canonical: [
      "src/auth/tool-policy.ts",
      "src/security/audit.ts",
      "src/config/schema.ts",
      "src/core/agent.ts",
    ],
    terms: [
      "unattended",
      "allowedTools",
      "HARD_DENY_REACT_UNATTENDED",
      "mfaFallback",
      "isUnattended",
      "RunOrigin",
      "approvalPolicy",
      "mfaApprovedForThisRun",
      "requiresMFA",
      // 中文别名：这两句常常在"不含主关键词"的段落里描述同一行为（README、docs、手册）
      "无人值守",
      "白名单",
    ],
    layers: ["code", "tool", "config-example", "docs", "manual", "readme", "agents"],
  },
  {
    id: "sandbox",
    title: "Sandbox (bwrap), path guard, elevation and fs_grant",
    canonical: [
      "src/sandbox/bwrap.ts",
      "src/sandbox/elevation.ts",
      "src/auth/fs-grant.ts",
      "src/tools/path-guard.ts",
    ],
    terms: [
      "[sandbox]",
      "bwrap",
      "writablePaths",
      "extraRwPaths",
      "elevate",
      "fs_grant",
      "maskSecrets",
      "readableSecretPaths",
      "checkWritePath",
      "selfAccess",
    ],
    layers: ["code", "tool", "config-example", "docs", "manual", "readme", "agents"],
  },
  {
    id: "secrets",
    title: "Secret access control and ${SECRET:NAME} references",
    canonical: [
      "src/auth/secrets-access.ts",
      "src/mcp/secret-ref.ts",
      "src/config/secret-placeholders.ts",
      "src/config/schema.ts",
    ],
    terms: [
      "secrets.toml",
      "${SECRET:",
      "[secrets]",
      "canReadSecrets",
      "resolveSecretRefs",
      "secretRefName",
      "secrets-access",
    ],
    layers: ["code", "tool", "config-example", "docs", "readme", "agents", "tests"],
  },
  {
    id: "memory-mem",
    title: "MEM.md / ACTIVE.md distillation and injection budget",
    canonical: [
      "src/memory/mem-budget.ts",
      "src/core/memory-maintenance.ts",
      "src/core/agent.ts",
    ],
    terms: [
      "MEM.md",
      "MEM_SECTION_KEYS",
      "memInjectionMaxChars",
      "memory_write_mem",
      "memory_read_mem",
      "DISTILL_MEM_SYSTEM",
      "ACTIVE.md",
      "renderMemForPrompt",
    ],
    layers: ["code", "tool", "config-example", "docs", "readme", "agents"],
  },
  {
    id: "memory-journal",
    title: "Append-only journal, memory_recall / memory_expand",
    canonical: ["src/memory/journal.ts", "src/tools/recall.ts", "src/core/session.ts"],
    terms: ["journal", "memory_recall", "memory_expand", "journalEnabled", "JOURNAL_SUFFIX", "readJournal"],
    layers: ["code", "tool", "config-example", "docs", "readme", "agents"],
  },
  {
    id: "compaction",
    title: "Context compaction, pruning and transcript",
    canonical: [
      "src/memory/summarizer.ts",
      "src/core/session.ts",
      "src/memory/tool-result-pruner.ts",
      "src/memory/transcript.ts",
    ],
    terms: [
      "summarizeAndCompress",
      "compressForCode",
      "CHAT_RETAIN_RATIO",
      "rewriteJsonl",
      "sanitizeMessages",
      "pruneToolResults",
      "transcript",
      "maybeCompress",
    ],
    layers: ["code", "docs", "readme", "agents"],
  },
  {
    id: "tokens",
    title: "Token accounting, cache hit rate and Dashboard metrics",
    canonical: ["src/memory/token-estimate.ts", "src/core/agent.ts", "src/web/backend/collector.ts"],
    terms: [
      "classifyTokenSource",
      "insertTokenUsageOnly",
      "cacheHitRate",
      "cacheReadTokens",
      "promptTokens",
      "latestBreakdown",
      "缓存命中",
    ],
    layers: ["code", "docs", "readme"],
  },
  {
    id: "mcp",
    title: "MCP servers, their config file and hot reload",
    canonical: ["src/mcp/config-writer.ts", "src/mcp/client.ts", "src/tools/mcp-admin.ts", "mcp.example.toml"],
    terms: ["mcp.toml", "mcp_server_add", "mcp_reload", "mcp_enable_server", "mcp-servers"],
    layers: ["code", "tool", "config-example", "docs", "readme", "agents", "tests", "cli"],
  },
  {
    id: "config-reload",
    title: "Config validation, hot reload, rollback and SAFE MODE",
    canonical: [
      "src/config/reload.ts",
      "src/config/reload-plan.ts",
      "src/config/state.ts",
      "src/config/safe-mode.ts",
      "src/config/validate.ts",
    ],
    terms: [
      "config_reload",
      "config_set",
      "SAFE MODE",
      "safe_config",
      "last-known-good",
      "settable-paths",
      "invalidateConfigCache",
      "config.toml.lkg",
    ],
    layers: ["code", "tool", "config-example", "docs", "readme", "agents", "tests", "cli"],
  },
  {
    id: "qqbot",
    title: "QQBot connector (media, streaming, MFA prompts)",
    canonical: ["src/connectors/qqbot/index.ts", "src/connectors/qqbot/outbound.ts"],
    terms: [
      "QQBot",
      "[channels.qqbots]",
      "stream_messages",
      "remain_msg_len",
      "STREAM_MAX_BYTES",
      "buildMFARequest",
      "upload_prepare",
      "file_data",
      "clearTokenCache",
    ],
    layers: ["code", "config-example", "docs", "readme", "agents"],
  },
  {
    id: "subagent",
    title: "Sub-agents: agent_fork / slave sessions / delegation",
    canonical: ["src/core/slave-manager.ts", "src/tools/agent-fork.ts", "src/tools/agent-binding.ts"],
    terms: [
      "agent_fork",
      "agent_wait",
      "agent_abort",
      "slave:",
      "autoForkThresholdMs",
      "slaveManager",
      "isSlave",
    ],
    layers: ["code", "tool", "config-example", "docs", "readme", "agents"],
  },
  {
    id: "code-mode",
    title: "Code mode, plan mode and project binding",
    canonical: ["src/code/system-prompt.ts", "src/code/commands.ts", "src/core/project-router.ts"],
    terms: ["exit_plan_mode", "/code", "plan mode", "codedir", "projectSlug", "code.jsonl", "autoFork"],
    layers: ["code", "tool", "prompt", "docs", "readme", "agents"],
  },
  {
    id: "skills",
    title: "Skills: SKILLS.md, skill_run, create_skill",
    canonical: ["src/skills/registry.ts", "src/skills/watcher.ts", "src/tools/skill-run.ts"],
    terms: ["SKILLS.md", "skill_run", "create_skill", "skillRegistry", "skills/"],
    layers: ["code", "tool", "docs", "readme"],
  },
  {
    id: "web",
    title: "Web Dashboard, downloads and reports",
    canonical: ["src/web/backend/server.ts", "src/web/backend/downloads.ts", "src/tools/release-file.ts"],
    terms: ["dashboard", "release_file", "write_report", "db_write", "/__login", "downloads", "web.token"],
    layers: ["code", "tool", "config-example", "docs", "readme"],
  },
  {
    id: "instructions",
    title: "Workspace instruction injection (AGENTS.md / CLAUDE.md)",
    canonical: ["src/instructions/workspace-prompt.ts", "src/instructions/agents-md.ts"],
    terms: ["workspace-prompt", "baselineIdentity", "AGENTS.md", "CLAUDE.md", "instructions/"],
    layers: ["code", "prompt", "docs", "agents"],
  },
];

// ── 层判定 ────────────────────────────────────────────────────────────────────

function layerOf(rel: string): LayerId {
  if (rel.startsWith("docs/manual/")) return "manual";
  if (rel.startsWith("src/cli/") || rel.startsWith("bin/")) return "cli";
  if (rel.startsWith("src/tools/")) return "tool";
  if (
    rel === "src/code/system-prompt.ts" ||
    rel.startsWith("src/instructions/") ||
    rel.startsWith("src/code/prompts")
  )
    return "prompt";
  if (rel.startsWith("tests/")) return "tests";
  if (rel.endsWith(".example.toml")) return "config-example";
  if (rel === "README.md") return "readme";
  if (rel === "AGENTS.md") return "agents";
  if (rel.startsWith("docs/")) return "docs";
  if (rel.startsWith("src/")) return "code";
  return "other";
}

const TEXT_EXT = /\.(ts|mts|cts|js|mjs|md|toml|json|ya?ml|sh|py)$/;

interface Hit {
  file: string;
  line: number;
  text: string;
  layer: LayerId;
}

function trackedTextFiles(): string[] {
  return execFileSync("git", ["ls-files"], { cwd: REPO, encoding: "utf-8" })
    .split("\n")
    .filter((f) => f !== "" && TEXT_EXT.test(f));
}

function findTopic(topic: TextTopic, files: string[]): Hit[] {
  const needles = topic.terms.map((t) => t.toLowerCase());
  const hits: Hit[] = [];
  for (const rel of files) {
    let content: string;
    try {
      content = fs.readFileSync(path.join(REPO, rel), "utf-8");
    } catch {
      continue;
    }
    const layer = layerOf(rel);
    content.split("\n").forEach((line, i) => {
      const low = line.toLowerCase();
      const hitTerm = needles.find((n) => low.includes(n));
      if (hitTerm === undefined) return;
      hits.push({ file: rel, line: i + 1, text: line.trim().slice(0, 160), layer });
    });
  }
  return hits;
}

function groupByLayer(hits: Hit[]): Map<LayerId, Hit[]> {
  const out = new Map<LayerId, Hit[]>();
  for (const h of hits) {
    const arr = out.get(h.layer) ?? [];
    arr.push(h);
    out.set(h.layer, arr);
  }
  return out;
}

// ── 输出 ──────────────────────────────────────────────────────────────────────

function printTopic(topic: TextTopic, hits: Hit[], maxPerLayer: number): void {
  const grouped = groupByLayer(hits);
  console.log(`\n━━━ ${topic.id} — ${topic.title} ━━━`);
  console.log(`canonical: ${topic.canonical.join(", ")}`);
  console.log(`terms: ${topic.terms.join(" · ")}`);
  console.log(`hits: ${hits.length}`);
  for (const layer of LAYERS) {
    const list = grouped.get(layer.id);
    if (!list || list.length === 0) continue;
    console.log(`\n  [${layer.id}] ${list.length} 处`);
    for (const h of list.slice(0, maxPerLayer)) {
      console.log(`    ${h.file}:${h.line}: ${h.text}`);
    }
    if (list.length > maxPerLayer) console.log(`    … 其余 ${list.length - maxPerLayer} 处省略（--max=N 调整）`);
  }
  const declared = new Set(topic.layers);
  const empty = [...declared].filter((l) => !grouped.has(l));
  const extra = [...grouped.keys()].filter((l) => !declared.has(l));
  console.log(
    `\n  覆盖：声明 ${topic.layers.length} 层，命中 ${[...grouped.keys()].length} 层` +
      (empty.length > 0 ? `\n  ⚠️ 声明了却 0 命中（大概率漏改）: ${empty.join(", ")}` : "") +
      (extra.length > 0 ? `\n  ℹ️ 额外命中（未声明）: ${extra.join(", ")}` : "")
  );
}

function renderMarkdown(): string {
  const lines: string[] = [
    "# Text index: where each feature's copy lives",
    "",
    "<!-- GENERATED by scripts/text-index.ts — do not edit by hand.",
    "     Add or fix a topic in that file's TOPICS table, then run:",
    "       npm run text-index -- --write -->",
    "",
    "Changing a behaviour means changing **all** of its text, not just the implementation:",
    "implementation comments, tool specs (what the model reads), the built-in system prompt,",
    "schema/config-example field docs, `docs/**`, the model-facing manuals in `docs/manual/**`,",
    "`README.md`, `AGENTS.md`, CLI help, and the tests that assert the old wording.",
    "",
    "## How to use it",
    "",
    "```bash",
    "npm run text-index -- --list        # every topic id",
    "npm run text-index -- wake          # locate all copy for one topic (file:line, grouped by layer)",
    "npm run text-index -- cron loop job # several topics at once",
    "npm run text-index -- --all         # everything",
    "```",
    "",
    "The output ends with a **coverage line**: layers this topic declares that produced *zero* hits.",
    "That is usually the copy you forgot — go write it. `grep` alone is not enough here because copy",
    "often describes a behaviour without naming it (e.g. wake permissions written as \"unattended\" /",
    "\"whitelist\"), so each topic carries the *specific* literal strings that mark its text.",
    "",
    "## Layers",
    "",
    "| layer | what lives there |",
    "|---|---|",
    ...LAYERS.map((l) => `| \`${l.id}\` | ${l.title} |`),
    "",
    "## Topics",
    "",
  ];
  for (const t of TOPICS) {
    lines.push(
      `### \`${t.id}\` — ${t.title}`,
      "",
      `- **Canonical source**: ${t.canonical.map((c) => `\`${c}\``).join(", ")}`,
      `- **Copy must exist in**: ${t.layers.map((l) => `\`${l}\``).join(", ")}`,
      `- **Grep terms**: ${t.terms.map((x) => `\`${x}\``).join(", ")}`,
      ""
    );
  }
  lines.push(
    "## Adding a topic",
    "",
    "Append an entry to `TOPICS` in `scripts/text-index.ts`:",
    "",
    "```ts",
    "{",
    '  id: "my-feature",',
    '  title: "What it is",',
    '  canonical: ["src/path/that/defines/it.ts"],',
    '  terms: ["specific_literal", "ConfigKeyName", "ENV_VAR_NAME"],',
    '  layers: ["code", "tool", "docs", "manual", "readme", "agents"],',
    "}",
    "```",
    "",
    "Then run `npm run text-index -- --write` to regenerate this file. Keep `terms` **specific**",
    "(a bare `env` or `config` matches thousands of lines and defeats the purpose).",
    ""
  );
  return lines.join("\n");
}

function writeMarkdown(): void {
  fs.writeFileSync(OUT_MD, renderMarkdown(), "utf-8");
  console.log(`已写入 ${path.relative(REPO, OUT_MD)}（${TOPICS.length} 个主题）`);
}

/**
 * 自检（`npm run test:text-index` 就调它）—— 防"索引自己烂掉"：
 *  1. 主题 id 唯一、`canonical` 路径真实存在（防手滑写错文件名）；
 *  2. 每个主题"声明了却 0 命中"的层 = 错误（要么补文案、要么从 `layers` 里删掉该层）；
 *  3. `docs/architecture/text-index.md` 与 `--print` 的输出一致（防 md 与表漂移）。
 *
 * ⚠️ 第 2 条是刻意的硬失败：它正是"漏改文案"的机械信号。文案搬家了就同步改 `layers`/`terms`。
 */
function check(): number {
  const errors: string[] = [];
  const files = trackedTextFiles();
  const verbose = process.argv.includes("--verbose");
  let undeclaredCount = 0;

  const seen = new Set<string>();
  for (const t of TOPICS) {
    if (seen.has(t.id)) errors.push(`主题 id 重复: ${t.id}`);
    seen.add(t.id);
    for (const c of t.canonical) {
      if (!fs.existsSync(path.join(REPO, c))) errors.push(`[${t.id}] canonical 路径不存在: ${c}`);
    }
    const grouped = groupByLayer(findTopic(t, files));
    for (const layer of t.layers) {
      if (!grouped.has(layer)) {
        errors.push(
          `[${t.id}] 声明了 "${layer}" 层却 0 命中 —— 要么补该层文案，要么从 layers 里去掉它`
        );
      }
    }
    const undeclared = [...grouped.keys()].filter((l) => !t.layers.includes(l));
    if (undeclared.length > 0) {
      undeclaredCount += 1;
      if (verbose) console.log(`  ℹ️ [${t.id}] 额外命中（未声明，不报错）: ${undeclared.join(", ")}`);
    }
  }
  if (undeclaredCount > 0 && !verbose) {
    console.log(`  ℹ️ ${undeclaredCount} 个主题在未声明的层也有命中（加 --verbose 看明细，不报错）`);
  }

  const expected = renderMarkdown();
  const actual = fs.existsSync(OUT_MD) ? fs.readFileSync(OUT_MD, "utf-8") : "";
  if (actual !== expected) {
    errors.push(
      `${path.relative(REPO, OUT_MD)} 与 TOPICS 表不一致 —— 跑 \`npm run text-index -- --write\` 重新生成`
    );
  }

  if (errors.length === 0) {
    console.log(`✅ 文案索引自检通过（${TOPICS.length} 个主题，扫描 ${files.length} 个文件）`);
    return 0;
  }
  console.error(`❌ 文案索引自检失败（${errors.length} 项）：`);
  for (const e of errors) console.error(`   - ${e}`);
  return 1;
}

// ── CLI ───────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const json = argv.includes("--json");
const maxArg = argv.find((a) => a.startsWith("--max="));
const maxPerLayer = maxArg ? Number(maxArg.slice("--max=".length)) : 40;
const rest = argv.filter((a) => !a.startsWith("--"));

if (argv.includes("--write")) {
  writeMarkdown();
  process.exit(0);
}

if (argv.includes("--print")) {
  process.stdout.write(renderMarkdown());
  process.exit(0);
}

if (argv.includes("--check")) {
  process.exit(check());
}

if (argv.includes("--list")) {
  for (const t of TOPICS) console.log(`${t.id.padEnd(20)} ${t.title}`);
  console.log(`\n共 ${TOPICS.length} 个主题；用法：npm run text-index -- <topic>`);
  process.exit(0);
}

const selected = argv.includes("--all")
  ? TOPICS
  : TOPICS.filter((t) => rest.includes(t.id) || rest.includes(t.title));

if (selected.length === 0) {
  console.error(`未知主题：${rest.join(", ") || "(空)"}\n`);
  for (const t of TOPICS) console.error(`  ${t.id}`);
  console.error("\n用 --list 看全部；--all 扫全部。");
  process.exit(1);
}

const files = trackedTextFiles();
if (json) {
  const payload = selected.map((t) => {
    const hits = findTopic(t, files);
    const grouped = groupByLayer(hits);
    return {
      id: t.id,
      title: t.title,
      canonical: t.canonical,
      declaredLayers: t.layers,
      emptyLayers: t.layers.filter((l) => !grouped.has(l)),
      hits,
    };
  });
  console.log(JSON.stringify(payload, null, 2));
} else {
  console.log(`扫描 ${files.length} 个 git 跟踪的文本文件`);
  for (const t of selected) printTopic(t, findTopic(t, files), maxPerLayer);
}
