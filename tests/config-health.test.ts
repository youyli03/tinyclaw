/**
 * 配置健康自检单测（node:assert + tsx，零框架依赖）
 *
 * 运行：npm run test:config-health
 *
 * 最关键的一条：**错误分流** —— 只有确定性配置错才允许自动回退，
 * 上游 5xx / 超时 / 限流必须判成暂时性（否则会把好配置回退掉）。
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  appendHealthLog,
  formatHealthReport,
  runOfflineHealthChecks,
  type HealthReport,
} from "../src/health/config-health.js";
import { classifyLlmError, withLlmProbe } from "../src/health/llm-probe.js";
import { ConfigSchema } from "../src/config/schema.js";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ❌ ${name}`);
    console.error(`     ${(e as Error).message}`);
  }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tinyclaw-health-"));

/** 一份最小合法配置（schema 默认值足够） */
function baseCfg() {
  return ConfigSchema.parse({
    providers: { deepseek: { apiKey: "sk-test" } },
    llm: { backends: { daily: { model: "deepseek/deepseek-chat" } } },
  });
}

// ── 错误分流（回退判据的命门） ───────────────────────────────────────

test("classifyLlmError:确定性配置错 → deterministic=true", () => {
  for (const msg of [
    "401 Unauthorized",
    "403 Forbidden: invalid api key",
    "404 model not found: deepseek/nope",
    "Unknown model: foo",
    "invalid_request_error: model does not exist",
    "Incorrect API key provided",
  ]) {
    assert.equal(classifyLlmError(new Error(msg)).deterministic, true, `应判确定性：${msg}`);
  }
});

test("classifyLlmError:暂时性故障 → deterministic=false（绝不回退）", () => {
  for (const msg of [
    "500 Internal Server Error",
    "502 Bad Gateway",
    "503 Service Unavailable",
    "429 Too Many Requests",
    "request timeout after 5000ms",
    "fetch failed",
    "socket hang up",
    "ECONNRESET",
    "getaddrinfo ENOTFOUND api.deepseek.com",
  ]) {
    assert.equal(classifyLlmError(new Error(msg)).deterministic, false, `应判暂时性：${msg}`);
  }
});

test("classifyLlmError:认不出来 → 保守判暂时性", () => {
  assert.equal(classifyLlmError(new Error("some weird thing happened")).deterministic, false);
  assert.equal(classifyLlmError("not an error object").deterministic, false);
});

test("classifyLlmError:消息被压成单行且截断（不刷屏、不带超长内容）", () => {
  const r = classifyLlmError(new Error(`line1\nline2 ${"x".repeat(500)}`));
  assert.equal(r.message.includes("\n"), false);
  assert.equal(r.message.length <= 300, true);
});

// ── 离线检查 ─────────────────────────────────────────────────────────

test("离线检查:合法配置 + 可写运行时目录 → 无 error", () => {
  const dir = path.join(tmpRoot, "ok");
  fs.mkdirSync(path.join(dir, "logs"), { recursive: true });
  fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
  const r = runOfflineHealthChecks({ cfg: baseCfg(), runtimeDir: dir });
  assert.equal(r.ok, true, JSON.stringify(r.checks.filter((c) => c.level === "error")));
  assert.equal(r.rollbackWorthy, false);
});

test("离线检查:配置文本有 error → error 且可回退（deterministic）", () => {
  const dir = path.join(tmpRoot, "badcfg");
  fs.mkdirSync(path.join(dir, "logs"), { recursive: true });
  fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
  const r = runOfflineHealthChecks({
    cfg: baseCfg(),
    rawText: "[llm.backends.daily]\nmodel = \n",
    runtimeDir: dir,
    secretKeys: new Set(),
  });
  assert.equal(r.ok, false);
  assert.equal(r.rollbackWorthy, true);
  assert.equal(
    r.checks.some((c) => c.name === "config-validation" && c.deterministic),
    true
  );
});

test("离线检查:运行时路径是文件而非目录 → error（可回退）", () => {
  const dir = path.join(tmpRoot, "file-not-dir");
  fs.writeFileSync(dir, "x");
  const r = runOfflineHealthChecks({ cfg: baseCfg(), runtimeDir: dir });
  assert.equal(r.rollbackWorthy, true);
  assert.equal(r.checks.some((c) => c.name.startsWith("dir-writable:") && c.deterministic), true);
});

test("离线检查:目录不存在 → 只 warn（首次运行会创建）", () => {
  const dir = path.join(tmpRoot, "ghost-dir");
  const r = runOfflineHealthChecks({ cfg: baseCfg(), runtimeDir: dir });
  assert.equal(r.rollbackWorthy, false);
  assert.equal(r.checks.some((c) => c.level === "warn"), true);
});

test("离线检查:沙箱开启时检查 bwrap 可用性（本机会给出明确结论）", () => {
  const dir = path.join(tmpRoot, "sandbox");
  fs.mkdirSync(path.join(dir, "logs"), { recursive: true });
  fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
  const cfg = baseCfg();
  cfg.sandbox.enabled = true;
  cfg.sandbox.execShell = "sandbox";
  const r = runOfflineHealthChecks({ cfg, runtimeDir: dir });
  const c = r.checks.find((x) => x.name === "sandbox-bwrap");
  assert.ok(c, "必须给出 bwrap 结论");
  assert.equal(["ok", "warn", "error"].includes(c.level), true);
});

// ── 在线探测结果合并 ─────────────────────────────────────────────────

test("withLlmProbe:确定性失败 → rollbackWorthy=true", () => {
  const base: HealthReport = { ok: true, rollbackWorthy: false, checks: [] };
  const merged = withLlmProbe(base, { ok: false, deterministic: true, message: "401 Unauthorized" });
  assert.equal(merged.ok, false);
  assert.equal(merged.rollbackWorthy, true);
  assert.equal(merged.checks[0]?.name, "llm-probe");
});

test("withLlmProbe:暂时性失败 → 只 warn，rollbackWorthy 保持 false", () => {
  const base: HealthReport = { ok: true, rollbackWorthy: false, checks: [] };
  const merged = withLlmProbe(base, { ok: false, deterministic: false, message: "503" });
  assert.equal(merged.ok, true, "暂时性故障不算 error");
  assert.equal(merged.rollbackWorthy, false);
  assert.equal(merged.checks[0]?.level, "warn");
});

test("withLlmProbe:成功 → ok", () => {
  const base: HealthReport = { ok: true, rollbackWorthy: false, checks: [] };
  const merged = withLlmProbe(base, { ok: true, deterministic: false, message: "ok" });
  assert.equal(merged.ok, true);
  assert.equal(merged.checks[0]?.level, "ok");
});

// ── 展示与落盘 ───────────────────────────────────────────────────────

test("formatHealthReport:只列非 ok 项并带通过计数", () => {
  const report: HealthReport = {
    ok: false,
    rollbackWorthy: true,
    checks: [
      { name: "a", level: "ok", deterministic: false, message: "fine" },
      { name: "b", level: "error", deterministic: true, message: "broken" },
    ],
  };
  const lines = formatHealthReport(report);
  assert.equal(lines.some((l) => l.includes("broken")), true);
  assert.equal(lines.some((l) => l.includes("fine")), false);
  assert.equal(lines.some((l) => l.includes("通过 1 项")), true);
});

test("appendHealthLog:写 logs/health-YYYY-MM-DD.jsonl 且一行一条", () => {
  const dir = path.join(tmpRoot, "logdir");
  const report: HealthReport = { ok: true, rollbackWorthy: false, checks: [] };
  const f1 = appendHealthLog(report, dir);
  const f2 = appendHealthLog(report, dir);
  assert.ok(f1);
  assert.equal(f1, f2);
  assert.match(f1, /health-\d{4}-\d{2}-\d{2}\.jsonl$/);
  const lines = fs.readFileSync(f1, "utf-8").trim().split("\n");
  assert.equal(lines.length, 2);
  const parsed = JSON.parse(lines[0] ?? "{}") as { ok: boolean; at: string };
  assert.equal(parsed.ok, true);
  assert.ok(parsed.at);
});

// ── 收尾 ─────────────────────────────────────────────────────────────

try {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
} catch {
  /* 清理失败不影响结论 */
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
