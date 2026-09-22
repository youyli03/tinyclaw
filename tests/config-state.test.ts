/**
 * 配置状态（LKG / pending / 自动回退）单测（node:assert + tsx，零框架依赖）
 *
 * 运行：npm run test:config-state
 *
 * 覆盖"改坏配置 → 自动回退"的核心判定：
 * - 用**内容哈希**判定"配置是否变过"（不依赖 mtime，本机 mtime 不可靠）
 * - 回退只动 `config.toml`，坏配置留证 `.rejected-<ts>`，并写通知 + 日志
 * - 没有 LKG 时不回退（首次部署），且绝不抛错
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  bumpBootAttempt,
  configDigest,
  configStatePaths,
  currentConfigDigest,
  noteConfigWritten,
  promoteConfig,
  readConfigState,
  restoreLastGoodConfig,
  shouldRollbackConfig,
} from "../src/config/state.js";

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

const GOOD = '[llm.backends.daily]\nmodel = "deepseek/deepseek-chat"\n';
const BAD = "[llm.backends.daily]\nmodel = \n";

/** 每个用例一个独立目录（模拟 ~/.tinyclaw） */
function newDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "tinyclaw-cfg-state-"));
  fs.writeFileSync(path.join(d, "config.toml"), GOOD, { mode: 0o600 });
  return d;
}

// ── 哈希 ─────────────────────────────────────────────────────────────

test("configDigest:内容相同 → 相同；内容不同 → 不同", () => {
  assert.equal(configDigest(GOOD), configDigest(GOOD.slice()));
  assert.notEqual(configDigest(GOOD), configDigest(BAD));
});

test("currentConfigDigest:文件不存在返回 null", () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "tinyclaw-cfg-state-"));
  assert.equal(currentConfigDigest(d), null);
  fs.rmSync(d, { recursive: true, force: true });
});

// ── 写入 / 提升 / 尝试计数 ───────────────────────────────────────────

test("noteConfigWritten:记录 current 并标记 pending", () => {
  const d = newDir();
  noteConfigWritten(GOOD, d);
  const st = readConfigState(d);
  assert.equal(st.current?.hash, configDigest(GOOD));
  assert.equal(st.pending?.hash, configDigest(GOOD));
  assert.equal(st.pending?.bootAttempts, 0);
  assert.equal(st.lastGood, null);
});

test("bumpBootAttempt:每次 +1（无 pending 时为 0）", () => {
  const d = newDir();
  assert.equal(bumpBootAttempt(d), 0);
  noteConfigWritten(GOOD, d);
  assert.equal(bumpBootAttempt(d), 1);
  assert.equal(bumpBootAttempt(d), 2);
  assert.equal(readConfigState(d).pending?.bootAttempts, 2);
});

test("promoteConfig:写 LKG 副本、清 pending、lastGood 有 hash", () => {
  const d = newDir();
  noteConfigWritten(GOOD, d);
  promoteConfig(GOOD, d);
  const st = readConfigState(d);
  assert.equal(st.pending, null);
  assert.equal(st.lastGood?.hash, configDigest(GOOD));
  assert.equal(fs.readFileSync(path.join(d, "config.toml.lkg"), "utf-8"), GOOD);
  assert.equal(fs.statSync(path.join(d, "config.toml.lkg")).mode & 0o777, 0o600);
});

test("promoteConfig:内容未变时幂等（不重复写盘）", () => {
  const d = newDir();
  promoteConfig(GOOD, d);
  const first = fs.readFileSync(configStatePaths(d).statePath, "utf-8");
  promoteConfig(GOOD, d);
  assert.equal(fs.readFileSync(configStatePaths(d).statePath, "utf-8"), first);
});

// ── 是否该回退 ───────────────────────────────────────────────────────

test("shouldRollbackConfig:没有 LKG → false（首次部署不误回退）", () => {
  const d = newDir();
  noteConfigWritten(BAD, d);
  fs.writeFileSync(path.join(d, "config.toml"), BAD, { mode: 0o600 });
  assert.equal(shouldRollbackConfig(d), false);
});

test("shouldRollbackConfig:配置与 LKG 一致 → false；改坏了 → true", () => {
  const d = newDir();
  promoteConfig(GOOD, d);
  assert.equal(shouldRollbackConfig(d), false);

  fs.writeFileSync(path.join(d, "config.toml"), BAD, { mode: 0o600 });
  assert.equal(shouldRollbackConfig(d), true);
});

test("shouldRollbackConfig:LKG 副本被删 → false（无料可用）", () => {
  const d = newDir();
  promoteConfig(GOOD, d);
  fs.writeFileSync(path.join(d, "config.toml"), BAD, { mode: 0o600 });
  fs.unlinkSync(path.join(d, "config.toml.lkg"));
  assert.equal(shouldRollbackConfig(d), false);
});

// ── 回退 ─────────────────────────────────────────────────────────────

test("restoreLastGoodConfig:覆盖回 LKG、留证坏配置、记录并写通知/日志", () => {
  const d = newDir();
  promoteConfig(GOOD, d);
  fs.writeFileSync(path.join(d, "config.toml"), BAD, { mode: 0o600 });

  const res = restoreLastGoodConfig("启动后 3s 内退出", d);
  assert.equal(res.ok, true);
  assert.ok(res.record);

  // 1. 配置被覆盖回好的那份
  assert.equal(fs.readFileSync(path.join(d, "config.toml"), "utf-8"), GOOD);
  assert.equal(fs.statSync(path.join(d, "config.toml")).mode & 0o777, 0o600);

  // 2. 坏配置留证（0600，名字可被 submitter 的 DENY 匹配）
  const rejected = res.record?.rejectedPath;
  assert.ok(rejected, "必须留证");
  assert.match(rejected, /config\.toml\.rejected-\d{8}-\d{6}$/);
  assert.equal(fs.readFileSync(rejected, "utf-8"), BAD);
  assert.equal(fs.statSync(rejected).mode & 0o777, 0o600);

  // 3. 状态记录
  const st = readConfigState(d);
  assert.equal(st.lastRollback?.reason, "启动后 3s 内退出");
  assert.equal(st.lastRollback?.fromHash, configDigest(BAD));
  assert.equal(st.lastRollback?.toHash, configDigest(GOOD));
  assert.equal(st.current?.hash, configDigest(GOOD));

  // 4. 通知文件（kind=config，供 main.ts 推 QQ）
  const notify = JSON.parse(
    fs.readFileSync(configStatePaths(d).notifyPath, "utf-8")
  ) as { kind: string; reason: string };
  assert.equal(notify.kind, "config");
  assert.match(notify.reason, /quick-fail|启动后/);

  // 5. 日志（不依赖 connector 也能看见）—— 内容不得含配置原文
  const log = fs.readFileSync(configStatePaths(d).logPath, "utf-8");
  assert.match(log, /自动回退配置/);
  assert.equal(log.includes("deepseek"), false, "日志不应抄录配置内容");

  // 6. 回退后不再需要回退
  assert.equal(shouldRollbackConfig(d), false);
});

test("restoreLastGoodConfig:没有 LKG → ok:false 且不动配置文件", () => {
  const d = newDir();
  fs.writeFileSync(path.join(d, "config.toml"), BAD, { mode: 0o600 });
  const res = restoreLastGoodConfig("test", d);
  assert.equal(res.ok, false);
  assert.match(res.reason ?? "", /LKG/);
  assert.equal(fs.readFileSync(path.join(d, "config.toml"), "utf-8"), BAD);
});

test("readConfigState:状态文件损坏 → 返回空状态而非抛错", () => {
  const d = newDir();
  fs.writeFileSync(configStatePaths(d).statePath, "{ not json", "utf-8");
  const st = readConfigState(d);
  assert.equal(st.lastGood, null);
  assert.equal(st.pending, null);
});

// ── 收尾 ─────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
