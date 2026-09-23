/**
 * 后台 Job + agent 环境变量 单测（node:assert + tsx，零框架依赖）
 *
 * 运行：npm run test:jobs
 *
 * 覆盖：
 * - env 分层（process.env < agents/<id>/env < 显式 env）与解析口径
 * - 密钥类键名判定（决定是否要审批）
 * - job 生命周期：启动 → 增量读输出（游标）→ 状态收敛；kill 进程组；超时
 * - **只落键名不落值**：meta.json / 返回文本里不得出现注入的密钥值
 * - 工具面：`env_set` 的条件 MFA（密钥类键名才审批）与 `redactArgs`（明文值不进 MFA 提示/审计）
 * - detached / 非 detached 在"服务重启"后的标记逻辑
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ENV_KEY_RE,
  agentEnvPath,
  buildJobEnvBase,
  deleteAgentEnvVar,
  isSecretRefValue,
  listAgentEnv,
  looksLikeSecretKey,
  parseEnvText,
  readAgentEnv,
  setAgentEnvVar,
  writeAgentEnv,
} from "../src/config/agent-env.js";
import {
  getJob,
  jobsRoot,
  killJob,
  markStaleJob,
  readJobOutput,
  startJob,
  type JobMeta,
} from "../src/core/job-manager.js";

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ❌ ${name}`);
    console.error(`     ${(e as Error).message}`);
  }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tinyclaw-jobs-"));
/** 测试创建的 job 目录，结尾统一清理 */
const createdJobs: string[] = [];

async function waitFor(pred: () => boolean, timeoutMs = 8000, stepMs = 50): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (pred()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return pred();
}

// ── agent env ────────────────────────────────────────────────────────

await test("parseEnvText:注释 / 空行 / 引号 / 无等号行都按约定处理", () => {
  const m = parseEnvText(
    ["# comment", "", "A=1", 'B="two words"', "C='sq'", "BADLINE", "D=a=b"].join("\n")
  );
  assert.equal(m.get("A"), "1");
  assert.equal(m.get("B"), "two words");
  assert.equal(m.get("C"), "sq");
  assert.equal(m.get("D"), "a=b");
  assert.equal(m.has("BADLINE"), false);
});

await test("looksLikeSecretKey:密钥类键名识别", () => {
  for (const k of [
    "OPENAI_API_KEY",
    "MY_TOKEN",
    "DB_PASSWORD",
    "X_CREDENTIAL",
    "AUTH_HEADER",
    "api",
  ]) {
    assert.equal(looksLikeSecretKey(k), true, `应判为密钥类：${k}`);
  }
  for (const k of ["LOG_LEVEL", "TZ", "DEBUG", "HOME", "PYTHONWARNINGS", "WORKDIR"]) {
    assert.equal(looksLikeSecretKey(k), false, `应判为普通：${k}`);
  }
});

await test("ENV_KEY_RE / isSecretRefValue:键名与引用式语法", () => {
  assert.equal(ENV_KEY_RE.test("GOOD_KEY"), true);
  assert.equal(ENV_KEY_RE.test("1BAD"), false);
  assert.equal(ENV_KEY_RE.test("has-dash"), false);
  assert.equal(isSecretRefValue("${SECRET:FOO}"), true);
  assert.equal(isSecretRefValue("plain"), false);
});

await test("write/read/set/delete:落盘 0600 且只含键值对", () => {
  const agent = "testagent";
  writeAgentEnv(agent, new Map([["LOG_LEVEL", "debug"]]), tmpRoot);
  const p = agentEnvPath(agent, tmpRoot);
  assert.equal(fs.existsSync(p), true);
  assert.equal(fs.statSync(p).mode & 0o777, 0o600);

  writeAgentEnv(agent, setAgentEnvVar(agent, "MY_TOKEN", "${SECRET:MY_TOKEN}", tmpRoot), tmpRoot);
  assert.equal(readAgentEnv(agent, tmpRoot).get("MY_TOKEN"), "${SECRET:MY_TOKEN}");

  const del = deleteAgentEnvVar(agent, "LOG_LEVEL", tmpRoot);
  assert.equal(del.found, true);
  writeAgentEnv(agent, del.entries, tmpRoot);
  assert.equal(readAgentEnv(agent, tmpRoot).has("LOG_LEVEL"), false);

  const listed = listAgentEnv(agent, tmpRoot);
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.key, "MY_TOKEN");
  assert.equal(listed[0]?.isRef, true);
  assert.equal(listed[0]?.secretLike, true);
});

await test("buildJobEnvBase:分层 process.env < agent env < 显式 env（后者覆盖）", () => {
  const agent = "layered";
  writeAgentEnv(
    agent,
    new Map([
      ["LAYER", "agent"],
      ["ONLY_AGENT", "a"],
    ]),
    tmpRoot
  );
  const r = buildJobEnvBase(
    { LAYER: "base", ONLY_BASE: "b" },
    agent,
    { LAYER: "explicit" },
    tmpRoot
  );
  assert.equal(r.env["LAYER"], "explicit");
  assert.equal(r.env["ONLY_BASE"], "b");
  assert.equal(r.env["ONLY_AGENT"], "a");
  assert.deepEqual(r.agentKeys.sort(), ["LAYER", "ONLY_AGENT"]);
  assert.deepEqual(r.overrideKeys, ["LAYER"]);
});

// ── job 生命周期 ─────────────────────────────────────────────────────

await test("startJob:跑完变 succeeded 且输出可增量读，第二次读为空", async () => {
  const res = await startJob({
    command: "echo hello-job; echo err-line 1>&2",
    agentId: "default", // 用真实 agent：沙箱会 chdir 到它的 workspace
  });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  createdJobs.push(res.meta.id);

  const done = await waitFor(() => getJob(res.meta.id)?.status !== "running");
  assert.equal(done, true, "应在超时内结束");
  const meta = getJob(res.meta.id);
  assert.equal(meta?.status, "succeeded");
  assert.equal(meta?.exitCode, 0);

  const first = readJobOutput(res.meta.id, "both");
  assert.equal(first.ok, true);
  assert.match(first.text ?? "", /hello-job/);
  assert.match(first.text ?? "", /err-line/);

  const second = readJobOutput(res.meta.id, "both");
  assert.equal(second.text, "", "第二次读不应重复给旧输出");
});

await test("startJob:非 0 退出 → failed；meta.json 里只有键名没有值", async () => {
  const canary = "sk-CANARY-should-not-appear-in-meta-9f3a";
  const res = await startJob({
    command: "exit 3",
    agentId: "default",
    env: { MY_API_KEY: canary, LOG_LEVEL: "info" },
  });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  createdJobs.push(res.meta.id);
  await waitFor(() => getJob(res.meta.id)?.status !== "running");
  assert.equal(getJob(res.meta.id)?.status, "failed");

  const metaText = fs.readFileSync(path.join(jobsRoot(), res.meta.id, "meta.json"), "utf-8");
  assert.equal(metaText.includes(canary), false, "meta.json 泄露了 env 值");
  assert.match(metaText, /MY_API_KEY/, "meta.json 应记录键名");
  assert.equal(res.meta.envKeys.includes("MY_API_KEY"), true);
});

await test("job_kill:杀掉进程组，状态收敛为 killed", async () => {
  const res = await startJob({ command: "sleep 30", agentId: "default" });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  createdJobs.push(res.meta.id);
  assert.equal(getJob(res.meta.id)?.status, "running");

  const k = killJob(res.meta.id, "SIGTERM");
  assert.equal(k.ok, true);
  const stopped = await waitFor(() => getJob(res.meta.id)?.status !== "running");
  assert.equal(stopped, true, "kill 后应很快结束");
  assert.equal(["killed", "failed"].includes(getJob(res.meta.id)?.status ?? ""), true);
});

await test("job_kill:已结束的 job 再 kill 会明确报错", async () => {
  const res = await startJob({ command: "true" });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  createdJobs.push(res.meta.id);
  await waitFor(() => getJob(res.meta.id)?.status !== "running");
  const k = killJob(res.meta.id);
  assert.equal(k.ok, false);
  assert.match(k.reason ?? "", /已结束/);
});

await test("timeout:超时自动终止并留下备注", async () => {
  const res = await startJob({ command: "sleep 30", timeoutSecs: 1 });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  createdJobs.push(res.meta.id);
  const stopped = await waitFor(() => getJob(res.meta.id)?.status !== "running", 10_000);
  assert.equal(stopped, true, "应在超时后结束");
  assert.match(getJob(res.meta.id)?.note ?? "", /超时/);
});

await test("detach:标记 detached，日志落盘且 job 目录存在", async () => {
  const res = await startJob({ command: "sleep 20", detach: true, agentId: "default" });
  assert.equal(res.ok, true);
  if (!res.ok) return;
  createdJobs.push(res.meta.id);
  assert.equal(res.meta.detached, true);
  assert.equal(fs.existsSync(path.join(jobsRoot(), res.meta.id, "meta.json")), true);
  assert.equal(fs.existsSync(path.join(jobsRoot(), res.meta.id, "stdout.log")), true);
  killJob(res.meta.id, "SIGKILL");
});

await test("readJobOutput:不存在的 job 给出明确错误", () => {
  const r = readJobOutput("job_nope");
  assert.equal(r.ok, false);
  assert.match(r.reason ?? "", /未找到/);
});

// ── 重启标记（纯函数） ────────────────────────────────────────────────

const baseMeta = (over: Partial<JobMeta>): JobMeta => ({
  id: "job_x",
  command: "sleep 1",
  detached: false,
  startedAt: new Date().toISOString(),
  status: "running",
  envKeys: [],
  secretNames: [],
  bytes: { stdout: 0, stderr: 0 },
  ...over,
});

await test("markStaleJob:非 detached → interrupted", () => {
  const m = markStaleJob(baseMeta({}), () => true);
  assert.equal(m.status, "interrupted");
  assert.match(m.note ?? "", /服务重启/);
  assert.ok(m.endedAt);
});

await test("markStaleJob:detached 且进程还在 → 保留 running 并注明可能仍在", () => {
  const m = markStaleJob(baseMeta({ detached: true, pid: 4242 }), () => true);
  assert.equal(m.status, "running");
  assert.match(m.note ?? "", /4242/);
});

await test("markStaleJob:detached 但进程已死 → interrupted", () => {
  const m = markStaleJob(baseMeta({ detached: true, pid: 4242 }), () => false);
  assert.equal(m.status, "interrupted");
  assert.match(m.note ?? "", /已不存在/);
});

// ── 工具面：条件 MFA 与"值不进提示/审计" ──────────────────────────────

await test("env_set:密钥类键名要审批、普通键名不打扰，且 value 在提示/审计里打码", async () => {
  const { getTool } = await import("../src/tools/registry.js");
  await import("../src/tools/env-admin.js");
  const def = getTool("env_set");
  assert.ok(def, "env_set 应已注册");
  assert.equal(def.requiresMFA, false);
  const needsMfa = def.requiresMFAFor;
  assert.ok(needsMfa);
  assert.equal(needsMfa({ key: "OPENAI_API_KEY", value: "sk-x" }), true);
  assert.equal(needsMfa({ key: "LOG_LEVEL", value: "debug" }), false);
  assert.equal(needsMfa({ key: "LOG_LEVEL", value: "debug", secret: true }), true);
  const redacted = def.redactArgs?.({ key: "OPENAI_API_KEY", value: "sk-plaintext" });
  assert.deepEqual(redacted, { key: "OPENAI_API_KEY", value: "***" });
  assert.equal(JSON.stringify(redacted).includes("sk-plaintext"), false);
});

await test("job_start / env_list 已注册（副作用 import 生效）", async () => {
  const { getTool } = await import("../src/tools/registry.js");
  await import("../src/tools/jobs.js");
  for (const name of ["job_start", "job_list", "job_status", "job_output", "job_kill"]) {
    assert.ok(getTool(name), `${name} 应已注册`);
  }
  for (const name of ["env_list", "env_set", "env_delete"]) {
    assert.ok(getTool(name), `${name} 应已注册`);
  }
  // 刻意没有 env_get：值永不回给模型
  assert.equal(getTool("env_get"), undefined);
});

// ── 收尾 ─────────────────────────────────────────────────────────────

for (const id of createdJobs) {
  try {
    fs.rmSync(path.join(jobsRoot(), id), { recursive: true, force: true });
  } catch {
    /* 清理失败不影响结论 */
  }
}
try {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
} catch {
  /* ignore */
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
