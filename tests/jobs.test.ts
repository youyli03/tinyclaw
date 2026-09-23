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
 * - detached / 非 detached 在"服务重启"后的收敛（`resolveStaleJob`，含 systemd 载体的探活与补记退出码）
 * - systemd 载体：unit 名、0600 env 文件的转义与还原、启动器脚本（真 bash 跑一遍）、probeUnit
 *
 * 想在"没有 systemd 的机器"上把普通 detach 分支也跑一遍：`XDG_RUNTIME_DIR= npm run test:jobs`
 * （detach 相关断言会自动切到普通 detach 分支）。
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
  readJobOutput,
  resolveStaleJob,
  startJob,
  waiterExitFinalizesJob,
  type JobMeta,
} from "../src/core/job-manager.js";
import {
  jobUnitName,
  probeUnit,
  shellQuote,
  systemdRunAvailable,
  writeJobEnvFile,
  writeJobLauncher,
} from "../src/core/systemd-run.js";
import { spawnSync } from "node:child_process";

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

  if (systemdRunAvailable()) {
    // 有 systemd 时必须走独立 unit（否则活不过 systemctl restart），且 env 文件已被启动器删掉
    assert.match(res.meta.systemdUnit ?? "", /^tinyclaw-job-/);
    assert.equal(probeUnit(res.meta.systemdUnit ?? "").active, true, "systemd unit 应在运行");
    assert.equal(
      fs.existsSync(path.join(jobsRoot(), res.meta.id, "env")),
      false,
      "env 文件应已被启动器删掉"
    );
  } else {
    assert.equal(res.meta.systemdUnit, undefined, "无 systemd-run 时走普通 detach");
  }

  killJob(res.meta.id, "SIGKILL");
  const converged = await waitFor(() => getJob(res.meta.id)?.status !== "running", 10_000);
  assert.equal(converged, true, "kill 后应很快收敛");
  assert.equal(getJob(res.meta.id)?.status, "killed");
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

await test("resolveStaleJob:非 detached + 残留进程还活着 → 收掉它并标 interrupted", () => {
  const r = resolveStaleJob(baseMeta({ pid: 4242 }), { kind: "plain", alive: true });
  assert.equal(r.meta.status, "interrupted");
  assert.equal(r.killOrphan, true, "非 detached 的残留进程必须按「随服务退出」的约定收掉");
  assert.match(r.meta.note ?? "", /4242/);
  assert.ok(r.meta.endedAt);
});

await test("resolveStaleJob:非 detached + 进程已死 → interrupted，不动手", () => {
  const r = resolveStaleJob(baseMeta({}), { kind: "plain", alive: false });
  assert.equal(r.meta.status, "interrupted");
  assert.equal(r.killOrphan, false);
  assert.match(r.meta.note ?? "", /服务重启/);
});

await test("resolveStaleJob:普通 detached + 进程还在 → 保留 running 并点名 pid", () => {
  const r = resolveStaleJob(baseMeta({ detached: true, pid: 4242 }), {
    kind: "plain",
    alive: true,
  });
  assert.equal(r.meta.status, "running");
  assert.equal(r.killOrphan, false);
  assert.match(r.meta.note ?? "", /4242/);
});

await test("resolveStaleJob:普通 detached + 进程已死 → interrupted", () => {
  const r = resolveStaleJob(baseMeta({ detached: true, pid: 4242 }), {
    kind: "plain",
    alive: false,
  });
  assert.equal(r.meta.status, "interrupted");
  assert.match(r.meta.note ?? "", /已不存在/);
});

await test("resolveStaleJob:systemd unit 还在跑 → 保留 running（这才是 detach 的意义）", () => {
  const r = resolveStaleJob(baseMeta({ detached: true, systemdUnit: "tinyclaw-job-abc" }), {
    kind: "systemd",
    active: true,
    exitCode: null,
  });
  assert.equal(r.meta.status, "running");
  assert.equal(r.killOrphan, false);
  assert.match(r.meta.note ?? "", /tinyclaw-job-abc/);
});

await test("resolveStaleJob:systemd unit 已结束且有退出码 → 补记 succeeded / failed", () => {
  const ok = resolveStaleJob(baseMeta({ detached: true, systemdUnit: "u" }), {
    kind: "systemd",
    active: false,
    exitCode: 0,
  });
  assert.equal(ok.meta.status, "succeeded");
  assert.equal(ok.meta.exitCode, 0);

  const bad = resolveStaleJob(baseMeta({ detached: true, systemdUnit: "u" }), {
    kind: "systemd",
    active: false,
    exitCode: 7,
  });
  assert.equal(bad.meta.status, "failed");
  assert.equal(bad.meta.exitCode, 7);
});

await test("resolveStaleJob:systemd unit 查不到、也没有退出码 → interrupted", () => {
  const r = resolveStaleJob(baseMeta({ detached: true, systemdUnit: "gone" }), {
    kind: "systemd",
    active: false,
    exitCode: null,
  });
  assert.equal(r.meta.status, "interrupted");
  assert.equal(r.killOrphan, false);
});

// ── systemd 载体（detached job 的独立 cgroup） ─────────────────────────

await test("jobUnitName:id → 合法 unit 名", () => {
  assert.equal(jobUnitName("job_1a2b3c4d"), "tinyclaw-job-1a2b3c4d");
  assert.equal(jobUnitName("job_a/b c"), "tinyclaw-job-a-b-c");
  assert.match(jobUnitName("job_x"), /^[A-Za-z0-9:_.-]+$/);
});

await test("writeJobEnvFile:0600、跳过非法键名、值能被真正的 bash 原样还原", () => {
  const dir = path.join(tmpRoot, "envtest");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, "env");
  const nasty = `a'b"c$d\`e f\ng`; // 单引号 / 双引号 / $ / 反引号 / 空格 / 换行
  const written = writeJobEnvFile(file, { NORMAL: "x", "1BAD": "y", NASTY: nasty, EMPTY: "" });
  assert.equal(written, 3, "非法键名 1BAD 应被跳过");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);

  const probe = path.join(dir, "probe.sh");
  fs.writeFileSync(
    probe,
    'set -a\n. "$1"\nprintf "%s\\n" "$NORMAL"\nprintf "%s" "$NASTY" | base64 -w0\nprintf "\\n[%s]" "$EMPTY"\n'
  );
  const r = spawnSync("bash", [probe, file], { encoding: "utf-8" });
  assert.equal(r.status, 0, r.stderr ?? "");
  const lines = (r.stdout ?? "").split("\n");
  assert.equal(lines[0], "x");
  assert.equal(
    lines[1],
    Buffer.from(nasty, "utf-8").toString("base64"),
    "特殊字符的值必须逐字节还原"
  );
  assert.equal(lines[2], "[]");
});

await test("writeJobLauncher:source env → 删 env → cd → 跑 argv → 写 rc，输出落日志", () => {
  const dir = path.join(tmpRoot, "launchtest");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeJobEnvFile(path.join(dir, "env"), { FROM_ENV: "hello", __JOB_CWD: tmpRoot });
  const launcher = writeJobLauncher(dir);
  assert.equal(fs.statSync(launcher).mode & 0o777, 0o700);

  const r = spawnSync(
    "bash",
    [launcher, "bash", "-c", "echo got=$FROM_ENV; echo err-here >&2; pwd; exit 5"],
    { encoding: "utf-8" }
  );
  assert.equal(r.status, 5);
  assert.equal(fs.readFileSync(path.join(dir, "rc"), "utf-8").trim(), "5");
  assert.equal(fs.existsSync(path.join(dir, "started")), true);
  assert.equal(fs.existsSync(path.join(dir, "env")), false, "env 文件必须在启动时被删掉");
  const out = fs.readFileSync(path.join(dir, "stdout.log"), "utf-8");
  assert.match(out, /got=hello/, "启动器要把 env 文件里的变量交给 job");
  assert.match(out, new RegExp(tmpRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), "cd 到 __JOB_CWD");
  assert.match(fs.readFileSync(path.join(dir, "stderr.log"), "utf-8"), /err-here/);
  assert.equal(fs.statSync(path.join(dir, "stdout.log")).mode & 0o777, 0o600);
});

await test("writeJobLauncher:env 文件缺失时显式报错退出（不静默空跑）", () => {
  const dir = path.join(tmpRoot, "launchtest-missing-env");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const launcher = writeJobLauncher(dir);
  const r = spawnSync("bash", [launcher, "bash", "-c", "echo should-not-run"], {
    encoding: "utf-8",
  });
  assert.equal(r.status, 127);
  assert.match(r.stderr ?? "", /env 文件缺失/);
  assert.equal(fs.readFileSync(path.join(dir, "rc"), "utf-8").trim(), "127");
  assert.equal(fs.existsSync(path.join(dir, "stdout.log")), false, "不该真的跑命令");
});

await test("probeUnit:不存在的 unit → notFound，且不抛错", () => {
  const p = probeUnit(`tinyclaw-job-nope-${Date.now()}`);
  assert.equal(p.active, false);
  assert.equal(p.notFound, true);
});

await test("systemdRunAvailable:返回布尔值（不抛错）", () => {
  assert.equal(typeof systemdRunAvailable(), "boolean");
});

// ── waiter 退出时该不该给 job 落终态（重启时 systemd 会连带杀掉等待进程） ──

await test("waiterExitFinalizesJob:普通 job 的 child 就是 job 本体 → 落终态", () => {
  assert.equal(waiterExitFinalizesJob(baseMeta({}), true, false), true);
});

await test("waiterExitFinalizesJob:systemd 载体 + unit 还活着 → 不落终态（job 没死）", () => {
  const m = baseMeta({ detached: true, systemdUnit: "tinyclaw-job-x" });
  assert.equal(waiterExitFinalizesJob(m, true, false), false);
});

await test("waiterExitFinalizesJob:systemd 载体 + unit 已结束 → 落终态", () => {
  const m = baseMeta({ detached: true, systemdUnit: "tinyclaw-job-x" });
  assert.equal(waiterExitFinalizesJob(m, false, false), true);
});

await test("waiterExitFinalizesJob:我们主动杀的 → 落终态（收敛成 killed）", () => {
  const m = baseMeta({ detached: true, systemdUnit: "tinyclaw-job-x" });
  assert.equal(waiterExitFinalizesJob(m, true, true), true);
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
// 显式退出：被 kill 的子进程可能留下未关闭的管道句柄（Node 不认为它 ref 着事件循环），
// 只靠"事件循环自然结束"会让脚本偶发地卡在收尾。
process.exit(failed > 0 ? 1 : 0);
