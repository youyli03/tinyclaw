/**
 * config.toml 写前校验 + 安全写入单测（node:assert + tsx，零框架依赖）
 *
 * 运行：npm run test:config
 *
 * 重点：
 * 1. 三层校验（语法 / schema / 交叉引用）都能拦住坏配置
 * 2. **诊断绝不回显字段原值**（apiKey 写错类型时 Zod 的 received 会带出密钥）
 * 3. 写入是"校验 → 备份 → 原子写"，坏内容不落盘而进 `.rejected-<ts>`
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { validateConfigText, formatConfigDiags, collectUnknownPaths } from "../src/config/validate.js";
import { patchTomlField, writeConfigText } from "../src/config/writer.js";

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

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tinyclaw-config-validate-"));
function tmpFile(name: string): string {
  return path.join(tmpRoot, name);
}

const CANARY = "CANARY_9f3a_secret_value";

/** 一份最小可用配置（providers 里给 daily 用的 provider 配上凭证） */
const BASE = `[llm.backends]
[llm.backends.daily]
model = "deepseek/deepseek-chat"

[providers.deepseek]
apiKey = "sk-live"
`;

/** 用固定 secret 键名集合校验（不读真实 secrets.toml） */
function validate(text: string, extra: Parameters<typeof validateConfigText>[1] = {}) {
  return validateConfigText(text, { secretKeys: new Set(["QQBOT_MAIN"]), ...extra });
}

const errs = (d: { level: string }[]) => d.filter((x) => x.level === "error");

// ── 1. 语法 / schema ─────────────────────────────────────────────────

test("语法错误 → error，且诊断里不带出错行原文", () => {
  const r = validate('[llm]\nmodel = \napiKey = "' + CANARY + '"\nbroken\n');
  assert.equal(errs(r.diagnostics).length >= 1, true);
  assert.equal(JSON.stringify(r.diagnostics).includes(CANARY), false, "诊断泄露了原值");
  assert.equal(r.config, undefined);
});

test("schema 非法（类型错）→ error 且不回显 received 值", () => {
  const r = validate(BASE + `\n[sandbox]\nenabled = "${CANARY}"\n`);
  const e = errs(r.diagnostics);
  assert.equal(e.length >= 1, true);
  assert.equal(JSON.stringify(r.diagnostics).includes(CANARY), false, "诊断泄露了原值");
  assert.equal(JSON.stringify(r.diagnostics).includes("received"), false);
});

test("合法配置 → 无 error，返回解析结果（含默认值）", () => {
  const r = validate(BASE);
  assert.deepEqual(errs(r.diagnostics), []);
  assert.ok(r.config);
  assert.equal(r.config?.llm.backends.daily.model, "deepseek/deepseek-chat");
});

// ── 2. 交叉引用 ──────────────────────────────────────────────────────

test("未知键（Zod 会 strip）→ warn，指出拼错的路径", () => {
  const r = validate(BASE + `\n[channels.qqbot]\nappId = "x"\n`);
  const w = r.diagnostics.find((d) => d.level === "warn" && d.path === "channels.qqbot");
  assert.ok(w, "必须报出 channels.qqbot 这个 schema 不认的键");
  assert.match(w.message, /静默忽略/);
});

test("$SECRET 占位符缺失 → warn；存在则无告警", () => {
  const missing = validate(BASE + `\n[providers.mimo]\napiKey = "$NOPE_KEY"\n`);
  assert.equal(
    missing.diagnostics.some((d) => d.level === "warn" && d.path === "providers.mimo.apiKey"),
    true
  );
  const ok = validate(BASE + `\n[providers.mimo]\napiKey = "$QQBOT_MAIN"\n`);
  assert.equal(ok.diagnostics.some((d) => d.message.includes("$QQBOT_MAIN")), false);
});

test("工具名拼写错 → error（仅在注入 knownTool 时检查）", () => {
  const text = BASE + `\n[sandbox.unattended]\nallowedTools = ["read_file", "read_fiel"]\n`;
  const without = validate(text);
  assert.equal(without.diagnostics.some((d) => d.level === "error"), false, "未注入 knownTool 时不该报");

  const withKnown = validate(text, { knownTool: (n) => n === "read_file" });
  const e = withKnown.diagnostics.find((d) => d.level === "error");
  assert.ok(e, "必须报出拼错的工具名");
  assert.equal(e.path, "sandbox.unattended.allowedTools[1]");
});

test("extraRwPaths 相对路径 → error；不存在 → warn", () => {
  const rel = validate(BASE + `\n[sandbox]\nextraRwPaths = ["relative/dir"]\n`);
  assert.equal(rel.diagnostics.some((d) => d.level === "error"), true);

  const ghost = validate(BASE + `\n[sandbox]\nextraRwPaths = ["/nonexistent-xyz-path"]\n`);
  assert.equal(ghost.diagnostics.some((d) => d.level === "warn"), true);
});

test("授权的 agentId 不存在 → warn（注入 knownAgent 时）", () => {
  const text = BASE + `\n[selfAccess]\ngrantedAgents = ["default", "ghost"]\n`;
  const r = validate(text, { knownAgent: (id) => id === "default" });
  const w = r.diagnostics.find((d) => d.level === "warn" && d.path === "selfAccess.grantedAgents[1]");
  assert.ok(w);
  assert.match(w.message, /ghost/);
});

test("后端引用的 provider 未配置 → warn", () => {
  const r = validate('[llm.backends.daily]\nmodel = "openrouter/x"\n');
  assert.equal(
    r.diagnostics.some((d) => d.level === "warn" && d.path === "llm.backends.daily.model"),
    true
  );
});

test("collectUnknownPaths:嵌套对象里逐层找出 schema 不认的键", () => {
  const raw = { a: { b: 1, c: { d: 2 } }, e: 3 };
  const parsed = { a: { b: 1 } };
  assert.deepEqual(collectUnknownPaths(raw, parsed, "").sort(), ["a.c", "e"]);
});

// ── 3. 安全写入 ──────────────────────────────────────────────────────

test("writeConfigText:坏内容不落盘，原文件不变，留下 .rejected-<ts>", () => {
  const p = tmpFile("config-reject.toml");
  fs.writeFileSync(p, BASE, { mode: 0o600 });
  const res = writeConfigText('[llm]\nmodel = \n', { filePath: p, secretKeys: new Set() });
  assert.equal(res.ok, false);
  assert.equal(fs.readFileSync(p, "utf-8"), BASE);
  if (!res.ok) {
    assert.ok(fs.existsSync(res.rejectedPath), "必须留证");
    assert.match(res.rejectedPath, /\.rejected-\d{8}-\d{6}/);
    assert.equal(fs.statSync(res.rejectedPath).mode & 0o777, 0o600);
  }
});

test("writeConfigText:合法内容落盘 + 备份 + 权限 0600", () => {
  const p = tmpFile("config-ok.toml");
  fs.writeFileSync(p, BASE, { mode: 0o600 });
  const next = BASE + `\n[tools]\nmaxChatToolRounds = 25\n`;
  const res = writeConfigText(next, { filePath: p, secretKeys: new Set() });
  assert.equal(res.ok, true);
  if (res.ok) assert.ok(res.backupPath && fs.existsSync(res.backupPath));
  assert.equal(fs.readFileSync(p, "utf-8"), next);
  assert.equal(fs.statSync(p).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(`${p}.tmp`), false);
});

test("patchTomlField:保留注释地改一个字段，并把坏值拦下", () => {
  const p = tmpFile("config-patch.toml");
  fs.writeFileSync(p, `# 顶部注释\n${BASE}`, { mode: 0o600 });

  const good = patchTomlField(["llm", "backends", "daily"], "model", '"deepseek/deepseek-reasoner"', {
    filePath: p,
    secretKeys: new Set(),
  });
  assert.equal(good.ok, true);
  assert.match(fs.readFileSync(p, "utf-8"), /# 顶部注释/);
  assert.match(fs.readFileSync(p, "utf-8"), /deepseek\/deepseek-reasoner/);

  const bad = patchTomlField(["auth", "mfa"], "timeoutSecs", '"abc"', {
    filePath: p,
    secretKeys: new Set(),
  });
  assert.equal(bad.ok, false);
  assert.equal(fs.readFileSync(p, "utf-8").includes('timeoutSecs'), false, "坏值不得落盘");
});

test("formatConfigDiags:有 error 时标题为未通过，warn 单列", () => {
  const r = validate(BASE + `\n[channels.qqbot]\nx = 1\n`);
  const lines = formatConfigDiags(r.diagnostics);
  assert.equal(lines[0]?.includes("配置校验"), true);
  assert.equal(lines.some((l) => l.startsWith("- [warn]")), true);
});

// ── 收尾 ────────────────────────────────────────────────────────────

try {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
} catch {
  /* 清理失败不影响结论 */
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
