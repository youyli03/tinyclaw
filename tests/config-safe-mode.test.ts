/**
 * SAFE MODE 单测（node:assert + tsx，零框架依赖）
 *
 * 运行：npm run test:config-safe-mode
 *
 * 覆盖"LKG 也坏时还能起来修"这条路：
 * - 开关是标记文件（可注入目录），不依赖 config.toml 本身
 * - 最小配置**只保留 providers / llm**，坏文件里其它段一律不给
 * - 无论输入多烂都**不抛错**（否则就从"起不来"变成"更起不来"）
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildSafeConfig,
  isSafeModeEnabled,
  safeModeFlagPath,
  setSafeMode,
} from "../src/config/safe-mode.js";

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

function newDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "tinyclaw-safe-mode-"));
}

// ── 开关 ─────────────────────────────────────────────────────────────

test("setSafeMode:开 → 标记文件存在且 0600；关 → 删除", () => {
  const d = newDir();
  assert.equal(isSafeModeEnabled(d), false);
  assert.equal(setSafeMode(true, d), true);
  assert.equal(isSafeModeEnabled(d), true);
  assert.equal(fs.existsSync(safeModeFlagPath(d)), true);
  assert.equal(fs.statSync(safeModeFlagPath(d)).mode & 0o777, 0o600);

  assert.equal(setSafeMode(false, d), true);
  assert.equal(isSafeModeEnabled(d), false);
  assert.equal(fs.existsSync(safeModeFlagPath(d)), false);
});

test("setSafeMode:重复关不报错（幂等）", () => {
  const d = newDir();
  assert.equal(setSafeMode(false, d), true);
  assert.equal(setSafeMode(false, d), true);
});

test("isSafeModeEnabled:目录不存在/不可读 → false（不抛错）", () => {
  assert.equal(isSafeModeEnabled("/nonexistent-xyz-dir"), false);
});

// ── 最小配置 ─────────────────────────────────────────────────────────

test("buildSafeConfig:保留 providers / llm，丢掉 channels 等其它段", () => {
  const text = `
[providers.deepseek]
apiKey = "sk-keep-me"

[llm.backends.daily]
model = "deepseek/deepseek-reasoner"

[channels.qqbots.main]
appId = "123"
clientSecret = "secret"

[memory]
enabled = true
`;
  const cfg = buildSafeConfig(text);
  // 保留：LLM 还能用（否则起来也没意义）
  assert.equal(cfg.providers.deepseek?.apiKey, "sk-keep-me");
  assert.equal(cfg.llm.backends.daily.model, "deepseek/deepseek-reasoner");
  // 丢弃：不接 QQBot、不跑依赖这些段的子系统
  assert.deepEqual(Object.keys(cfg.channels.qqbots), []);
  assert.equal(cfg.memory.enabled, false, "memory 应回到 schema 默认值");
});

test("buildSafeConfig:语法全坏 → 仍返回可解析配置（占位后端）", () => {
  const cfg = buildSafeConfig("this is = = not toml\n[[[");
  assert.ok(cfg);
  assert.equal(typeof cfg.llm.backends.daily.model, "string");
  assert.equal(cfg.llm.backends.daily.model.length > 0, true);
});

test("buildSafeConfig:不传文本 → 仍可用（不抛错）", () => {
  const cfg = buildSafeConfig();
  assert.ok(cfg);
  assert.deepEqual(Object.keys(cfg.channels.qqbots), []);
});

test("buildSafeConfig:LLM 段本身非法 → 退化到占位配置而不是抛错", () => {
  const cfg = buildSafeConfig('[llm.backends.daily]\nmodel = 5\n');
  assert.ok(cfg);
  assert.equal(typeof cfg.llm.backends.daily.model, "string");
});

test("buildSafeConfig:安全模式下不带上特权面（显式收紧，不靠 schema 宽松默认）", () => {
  const text = `
[providers.deepseek]
apiKey = "sk-x"

[selfAccess]
grantedAgents = ["default"]
allowDelete = true
exemptMfa = true
wideWriteAccess = true
`;
  const cfg = buildSafeConfig(text);
  assert.deepEqual(cfg.selfAccess.grantedAgents, [], "自指授权不属于最小配置");
  assert.equal(cfg.selfAccess.allowDelete, false, "不允许真删");
  assert.equal(cfg.selfAccess.exemptMfa, false, "不免 MFA");
  assert.equal(cfg.selfAccess.wideWriteAccess, false, "不放开整树写入");
});

// ── 收尾 ─────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
