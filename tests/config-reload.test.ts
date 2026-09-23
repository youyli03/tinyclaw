/**
 * 配置变更分级 + 重载计划单测（node:assert + tsx，零框架依赖）
 *
 * 运行：npm run test:config-reload
 *
 * 分级是"热修改"的安全边界：**证明不了会立即生效的段必须归 restart**，
 * 而坏配置在任何级别下都不允许被应用。
 */
import assert from "node:assert/strict";
import { classifyConfigChange, diffConfigSections } from "../src/config/reload-plan.js";
import { planReloadStep } from "../src/config/reload.js";
import { ConfigSchema, type Config } from "../src/config/schema.js";

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

const BASE_TEXT = `[providers.deepseek]
apiKey = "sk-test"

[llm.backends.daily]
model = "deepseek/deepseek-chat"
`;

function cfg(overrides: Record<string, unknown> = {}): Config {
  return ConfigSchema.parse({
    providers: { deepseek: { apiKey: "sk-test" } },
    llm: { backends: { daily: { model: "deepseek/deepseek-chat" } } },
    ...overrides,
  });
}

/** 生成一份文本（供 planReloadStep 校验） */
function text(extra: string): string {
  return `${BASE_TEXT}\n${extra}\n`;
}

// ── diff ─────────────────────────────────────────────────────────────

test("diffConfigSections:相同配置 → 空数组", () => {
  assert.deepEqual(diffConfigSections(cfg(), cfg()), []);
});

test("diffConfigSections:定位到具体字段路径", () => {
  const before = cfg();
  const after = cfg({ tools: { maxChatToolRounds: 25 } });
  const paths = diffConfigSections(before, after);
  assert.equal(paths.includes("tools.maxChatToolRounds"), true, JSON.stringify(paths));
});

test("diffConfigSections:嵌套对象下钻（不会只报父路径）", () => {
  const before = cfg();
  const after = ConfigSchema.parse({
    providers: { deepseek: { apiKey: "sk-other" } },
    llm: { backends: { daily: { model: "deepseek/deepseek-chat" } } },
  });
  const paths = diffConfigSections(before, after);
  assert.deepEqual(paths, ["providers.deepseek.apiKey"]);
});

// ── 分级 ─────────────────────────────────────────────────────────────

test("分级:超时/工具上限这类 → hot", () => {
  const plan = classifyConfigChange(cfg(), cfg({ tools: { maxChatToolRounds: 25 } }));
  assert.equal(plan.cls, "hot");
  assert.match(plan.reason, /用时现读|换缓存/);
});

test("分级:retry / sandbox 策略 / mfa 工具 → hot", () => {
  const a = cfg();
  const b = ConfigSchema.parse({
    providers: { deepseek: { apiKey: "sk-test" } },
    llm: { backends: { daily: { model: "deepseek/deepseek-chat" } } },
    retry: { maxAttempts: 7 },
    auth: { mfa: { tools: ["edit_file"] } },
  });
  assert.equal(classifyConfigChange(a, b).cls, "hot");
});

test("分级:LLM 后端 / 并发 / 记忆阈值 → soft", () => {
  const a = cfg();
  const b = ConfigSchema.parse({
    providers: { deepseek: { apiKey: "sk-test" } },
    llm: { backends: { daily: { model: "deepseek/deepseek-reasoner" } } },
  });
  const plan = classifyConfigChange(a, b);
  assert.equal(plan.cls, "soft");
  assert.equal(plan.sections.includes("llm.backends.daily.model"), true);
});

test("分级:provider 凭据变更 → soft（客户端构造时固化了 apiKey，必须重新 init 后端）", () => {
  const a = cfg();
  const b = cfg({ providers: { deepseek: { apiKey: "sk-rotated" } } });
  const plan = classifyConfigChange(a, b);
  assert.equal(plan.cls, "soft", `实际 ${plan.cls}`);
  assert.equal(plan.sections.includes("providers.deepseek.apiKey"), true);
});

test("分级:channels / voice / web.port / sandbox 开关 → restart", () => {
  const cases: Array<Record<string, unknown>> = [
    { channels: { qqbots: { main: { appId: "1", clientSecret: "s" } } } },
    { web: { port: 4097 } },
    // sandbox.enabled 默认 false（schema 里刻意全关），所以这里用"开启沙箱"作为变更
    { sandbox: { enabled: true, execShell: "sandbox" } },
  ];
  for (const over of cases) {
    const plan = classifyConfigChange(cfg(), cfg(over));
    assert.equal(plan.cls, "restart", `应判 restart：${JSON.stringify(over)}（实际 ${plan.cls}）`);
  }
});

test("分级:混合变更取最重的那级（restart > soft > hot）", () => {
  const b = ConfigSchema.parse({
    providers: { deepseek: { apiKey: "sk-test" } },
    llm: { backends: { daily: { model: "deepseek/deepseek-reasoner" } } }, // soft
    tools: { maxChatToolRounds: 25 }, // hot
    web: { port: 4097 }, // restart
  });
  assert.equal(classifyConfigChange(cfg(), b).cls, "restart");
});

test("分级:内容相同 → none", () => {
  const plan = classifyConfigChange(cfg(), cfg());
  assert.equal(plan.cls, "none");
  assert.deepEqual(plan.sections, []);
});

// ── 重载计划（校验闸门） ──────────────────────────────────────────────

test("planReloadStep:语法坏 → 拒绝且不产出计划", () => {
  const r = planReloadStep("[llm]\nmodel = \n", cfg());
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.message, /已拒绝/);
});

test("planReloadStep:schema 非法 → 拒绝", () => {
  const r = planReloadStep(text('enabled = "yes"').replace("enabled", "[sandbox]\nenabled"), cfg());
  assert.equal(r.ok, false);
});

test("planReloadStep:合法 + 有变化 → 产出计划与解析结果", () => {
  const r = planReloadStep(text("[tools]\nmaxChatToolRounds = 25"), cfg());
  assert.equal(r.ok, true);
  if (r.ok) {
    assert.equal(r.plan.cls, "hot");
    assert.equal(r.config.tools.maxChatToolRounds, 25);
  }
});

test("planReloadStep:合法但没变化 → none", () => {
  const r = planReloadStep(BASE_TEXT, cfg());
  assert.equal(r.ok, true);
  if (r.ok) assert.equal(r.plan.cls, "none");
});

test("planReloadStep:工具名拼写错 → 拒绝（注入 knownTool 时）", () => {
  const bad = text('[sandbox.unattended]\nallowedTools = ["read_fiel"]');
  const withoutCtx = planReloadStep(bad, cfg());
  assert.equal(withoutCtx.ok, true, "未注入注册表时不判工具名");

  const withCtx = planReloadStep(bad, cfg(), { knownTool: (n) => n === "read_file" });
  assert.equal(withCtx.ok, false);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
