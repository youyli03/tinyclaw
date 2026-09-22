/**
 * MCP 配置载入诊断单测（node:assert + tsx，零框架依赖）
 *
 * 运行：npm run test:mcp
 *
 * 重点覆盖两件事：
 * 1. 载入失败**必须可见**（语法错 / 单条非法 / 缺 servers / enabled=false / 文件不存在）
 * 2. 诊断文本**绝不泄露被校验字段的原值**（env token 写错类型时 Zod 会把原值放进 received）
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadMcpConfigDetailed } from "../src/config/loader.js";
import { formatDiagnostics, summarizeLoad } from "../src/mcp/load-report.js";

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

/** 在系统临时目录里建一个 mcp.toml，返回路径（不污染仓库 tmp/） */
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tinyclaw-mcp-diag-"));
function writeMcp(name: string, content: string): string {
  const p = path.join(tmpRoot, name);
  fs.writeFileSync(p, content, "utf-8");
  return p;
}

/** 诊断的全部可见文本（message + hint），用于"是否泄密"断言 */
function diagText(diags: { message: string; hint?: string }[]): string {
  return diags.map((d) => `${d.message}\n${d.hint ?? ""}`).join("\n");
}

// ── 1. 正常 / 缺文件 ─────────────────────────────────────────────

test("文件不存在:不报错,fileExists=false,无 server", () => {
  const r = loadMcpConfigDetailed(path.join(tmpRoot, "nope.toml"));
  assert.equal(r.fileExists, false);
  assert.deepEqual(r.diagnostics, []);
  assert.deepEqual(Object.keys(r.config.servers), []);
});

test("合法配置:两条 server 全部载入,无 error", () => {
  const p = writeMcp(
    "ok.toml",
    [
      "[servers.notes]",
      'transport = "stdio"',
      'command = "node"',
      'args = ["notes.js"]',
      'description = "笔记"',
      "",
      "[servers.remote]",
      'transport = "sse"',
      'url = "https://example.com/sse"',
    ].join("\n")
  );
  const r = loadMcpConfigDetailed(p);
  assert.deepEqual(Object.keys(r.config.servers).sort(), ["notes", "remote"]);
  assert.equal(
    r.diagnostics.filter((d) => d.level === "error").length,
    0
  );
});

// ── 2. 语法错误（旧行为会伪装成"读取失败"）──────────────────────

test("TOML 语法错:code=syntax + 整份配置为空 + 有修复提示", () => {
  const p = writeMcp("broken.toml", '[servers.notes]\ntransport = "stdio"\ncommand = \n');
  const r = loadMcpConfigDetailed(p);
  assert.equal(r.fileExists, true);
  assert.deepEqual(Object.keys(r.config.servers), []);
  const d = r.diagnostics.find((x) => x.code === "syntax");
  assert.ok(d, "必须给出 syntax 诊断");
  assert.equal(d.level, "error");
  assert.equal(d.scope, "file");
  assert.match(d.message, /语法错误/);
  assert.ok(d.hint, "语法错必须带修复提示");
});

test("TOML 语法错:诊断文本区分于'无法读取'", () => {
  const p = writeMcp("broken2.toml", "this is not = = toml\n");
  const r = loadMcpConfigDetailed(p);
  assert.equal(diagText(r.diagnostics).includes("无法读取"), false);
});

// ── 3. 单条非法：容错 + 可见 ────────────────────────────────────

test("单条 server 非法:其余保留 + 点名 servers.<name>", () => {
  const p = writeMcp(
    "partial.toml",
    [
      "[servers.good]",
      'transport = "stdio"',
      'command = "node"',
      "",
      "[servers.bad]",
      'transport = "carrier-pigeon"',
      'command = "node"',
    ].join("\n")
  );
  const r = loadMcpConfigDetailed(p);
  assert.deepEqual(Object.keys(r.config.servers), ["good"]);
  const d = r.diagnostics.find((x) => x.code === "schema");
  assert.ok(d, "必须给出 schema 诊断");
  assert.equal(d.level, "error");
  assert.equal(d.scope, "server");
  assert.equal(d.server, "bad");
  assert.match(d.message, /servers\.bad/);
  assert.ok(d.hint);
});

test("无 [servers.*] 定义:给出 info(empty) 诊断,不算错误", () => {
  const p = writeMcp("noservers.toml", "[other]\nkey = 1\n");
  const r = loadMcpConfigDetailed(p);
  const d = r.diagnostics.find((x) => x.code === "empty");
  assert.ok(d, "必须给出 empty 诊断");
  assert.equal(d.level, "info");
  assert.equal(d.scope, "file");
  assert.match(d.message, /servers/);
  assert.equal(
    r.diagnostics.filter((x) => x.level === "error").length,
    0
  );
});

test("servers 段结构非法(非表):给出文件级 schema 错误", () => {
  const p = writeMcp("badservers.toml", "servers = 5\n");
  const r = loadMcpConfigDetailed(p);
  const d = r.diagnostics.find((x) => x.scope === "file" && x.code === "schema");
  assert.ok(d, "必须给出文件级诊断");
  assert.equal(d.level, "error");
  assert.match(d.message, /servers/);
});

// ── 4. 泄密红线（Zod issue 的 received 绝不能外泄）──────────────

const CANARY = "CANARY_9f3a_token";

test("泄密红线:字段值写错类型时诊断文本不含原值", () => {
  const p = writeMcp(
    "leaky.toml",
    [
      "[servers.leaky]",
      `enabled = "${CANARY}"`,
      'transport = "stdio"',
      'command = "node"',
    ].join("\n")
  );
  const r = loadMcpConfigDetailed(p);
  const d = r.diagnostics.find((x) => x.code === "schema");
  assert.ok(d, "必须给出 schema 诊断");
  assert.equal(diagText(r.diagnostics).includes(CANARY), false, "诊断文本泄露了字段原值");
  assert.equal(diagText(r.diagnostics).includes("received"), false, "诊断文本带上了 received");
});

test("泄密红线:env 值类型错误也不泄露（含 formatDiagnostics 输出）", () => {
  const p = writeMcp(
    "leaky-env.toml",
    [
      "[servers.leakyenv]",
      'transport = "stdio"',
      'command = "node"',
      `env = { API_KEY = ["${CANARY}"] }`,
    ].join("\n")
  );
  const r = loadMcpConfigDetailed(p);
  const text = [diagText(r.diagnostics), formatDiagnostics(r.diagnostics, "all").join("\n")].join(
    "\n"
  );
  // 该写法是合法 TOML（裸字符串），仍应被 Zod 接受；若被拒也绝不能带原值
  assert.equal(text.includes(CANARY), false, "诊断输出泄露了 env 原值");
});

// ── 5. enabled = false / 汇总 ───────────────────────────────────

test("enabled=false:info 诊断,且 server 仍被载入", () => {
  const p = writeMcp(
    "disabled.toml",
    ["[servers.off]", "enabled = false", 'transport = "stdio"', 'command = "node"'].join("\n")
  );
  const r = loadMcpConfigDetailed(p);
  assert.deepEqual(Object.keys(r.config.servers), ["off"]);
  const d = r.diagnostics.find((x) => x.code === "disabled");
  assert.ok(d);
  assert.equal(d.level, "info");
  assert.equal(d.server, "off");
});

test("summarizeLoad:统计 server 数与 error/info", () => {
  const p = writeMcp(
    "mixed.toml",
    [
      "[servers.off]",
      "enabled = false",
      'transport = "stdio"',
      'command = "node"',
      "",
      "[servers.bad]",
      'transport = "nope"',
    ].join("\n")
  );
  const r = loadMcpConfigDetailed(p);
  const line = summarizeLoad(r.diagnostics, Object.keys(r.config.servers).length);
  assert.match(line, /1 server\(s\)/);
  assert.match(line, /1 error\(s\)/);
  assert.match(line, /1 info/);
});

// ── 6. 展示层 ───────────────────────────────────────────────────

test("formatDiagnostics:level=error 过滤掉 info,标题区分告警/提示", () => {
  const p = writeMcp(
    "mixed2.toml",
    [
      "[servers.off]",
      "enabled = false",
      'transport = "stdio"',
      'command = "node"',
      "",
      "[servers.bad]",
      'transport = "nope"',
    ].join("\n")
  );
  const r = loadMcpConfigDetailed(p);
  const onlyErrors = formatDiagnostics(r.diagnostics, "error");
  assert.equal(onlyErrors.length >= 2, true);
  assert.match(onlyErrors[0] ?? "", /载入告警/);
  assert.equal(
    onlyErrors.some((l) => l.includes("[info]")),
    false
  );

  const onlyInfo = formatDiagnostics(
    [{ level: "info", code: "disabled", scope: "server", server: "x", message: "m" }],
    "all"
  );
  assert.match(onlyInfo[0] ?? "", /载入提示/);
});

test("formatDiagnostics:无诊断返回空数组", () => {
  assert.deepEqual(formatDiagnostics([], "all"), []);
  assert.deepEqual(formatDiagnostics([], "error"), []);
});

// ── 收尾 ────────────────────────────────────────────────────────

try {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
} catch {
  /* 清理失败不影响测试结论 */
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
