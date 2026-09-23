/**
 * `config_set` 可写白名单 + 自我管理工具按 agent 绑定 单测
 *
 * 运行：npm run test:config-settable
 *
 * 这两条都是"防越权"的判据，必须逐条钉死：
 * - 模型能改的只有"自己怎么跑"的参数；管着它的规则（MFA / 沙箱 / 自指权限 / 回退阈值 / SSRF / 配额）一律拒
 * - 自我管理类工具默认只给 `default`；其他 agent 连**可见性**都不给
 */
import assert from "node:assert/strict";
import { isConfigSetPathAllowed } from "../src/config/settable-paths.js";
import {
  DEFAULT_AGENT_ONLY_TOOLS,
  DEFAULT_SELF_MANAGEMENT_AGENTS,
  guardSelfManagement,
  isSelfManagementAllowed,
  loadSelfManagementAgents,
} from "../src/tools/agent-binding.js";
import { getAllToolSpecs, registerTool } from "../src/tools/registry.js";

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

// ── config_set 白名单 ────────────────────────────────────────────────

test("允许：模型 / 单后端参数 / 别名 / 轮次上限 / 重试节奏 / 交互提醒", () => {
  for (const p of [
    "llm.backends.daily.model",
    "llm.backends.code.maxTokens",
    "llm.backends.summarizer.timeoutMs",
    "llm.backends.daily.reasoningEffort",
    "llm.backends.daily.disableThinking",
    "llm.aliases.fast",
    "tools.maxChatToolRounds",
    "tools.maxToolResultChars",
    "retry.maxAttempts",
    "retry.streamIdleTimeoutMs",
    "interactive.maxReminds",
  ]) {
    assert.equal(isConfigSetPathAllowed(p).ok, true, `应允许：${p}`);
  }
});

test("拒绝：管着 agent 的规则（auth / sandbox / selfAccess / health / channels / web）", () => {
  for (const p of [
    "auth.mfa.tools",
    "auth.mfa.timeoutSecs",
    "sandbox.unattended.allowedTools",
    "sandbox.enabled",
    "sandbox.elevation.allowedAgents",
    "selfAccess.grantedAgents",
    "selfAccess.allowDelete",
    "health.probeLlm",
    "health.enabled",
    "channels.qqbots.main.appId",
    "web.port",
    "web.token",
  ]) {
    const res = isConfigSetPathAllowed(p);
    assert.equal(res.ok, false, `应拒绝：${p}`);
    assert.match(res.reason ?? "", /已拒绝/);
  }
});

test("拒绝：密钥与成本/注入面（providers / premiumAllowlist / http_request / memory / agent / submitter）", () => {
  for (const p of [
    "providers.deepseek.apiKey",
    "providers.copilot.githubToken",
    "llm.premiumAllowlist.allowedSessions",
    "tools.http_request.allowPrivateHosts",
    "memory.enabled",
    "memory.embedModel",
    "agent.responseHooks.qqbot",
    "submitter.notify",
  ]) {
    assert.equal(isConfigSetPathAllowed(p).ok, false, `应拒绝：${p}`);
  }
});

test("拒绝：白名单外的同段字段也不算（前缀放行不存在）", () => {
  // tools 段只放行 4 个上限字段，别的都不行
  assert.equal(isConfigSetPathAllowed("tools.security.injectionDetect.enabled").ok, false);
  // llm 段只放行 backends/aliases，premiumAllowlist 之外还有别的也不放行
  assert.equal(isConfigSetPathAllowed("llm.somethingElse").ok, false);
  // 拒绝文案里要告诉人正确做法
  const res = isConfigSetPathAllowed("sandbox.enabled");
  assert.match(res.reason ?? "", /tinyclaw config set|人工/);
});

// ── 按 agent 绑定 ────────────────────────────────────────────────────

test("默认绑定：只绑「会改运行配置的」工具（config_* 与写 mcp.toml 的那几个）", () => {
  assert.deepEqual([...DEFAULT_SELF_MANAGEMENT_AGENTS], ["default"]);
  for (const t of [
    "config_set",
    "config_reload",
    "config_validate",
    "mcp_server_add",
    "mcp_server_remove",
    "mcp_server_set_enabled",
    "mcp_reload",
  ]) {
    assert.equal(DEFAULT_AGENT_ONLY_TOOLS.has(t), true, `应在默认绑定集合里：${t}`);
  }
  // 纯开关类不绑：其他 agent 仍能看目录 / 开关自己权限范围内的 MCP 能力
  for (const t of ["mcp_list_servers", "mcp_enable_server", "mcp_disable_server"]) {
    assert.equal(DEFAULT_AGENT_ONLY_TOOLS.has(t), false, `不该绑：${t}`);
  }
});

test("isSelfManagementAllowed：default 放行；其他 agent 默认拒绝；无 agent 上下文放行", () => {
  const list = ["default"];
  assert.equal(isSelfManagementAllowed("default", list), true);
  assert.equal(isSelfManagementAllowed("onlychat", list), false);
  assert.equal(isSelfManagementAllowed(undefined, list), true, "CLI/cron 无 agent 上下文不该被误伤");
  assert.equal(isSelfManagementAllowed("", list), true);
  assert.equal(isSelfManagementAllowed("any", ["*"]), true, "通配符 = 全部放开");
  assert.equal(isSelfManagementAllowed("default", []), false, "空列表 = 谁都不给");
});

test("guardSelfManagement：拒绝文案点名当前 agent 并给出授权写法", () => {
  const msg = guardSelfManagement("config_set", "onlychat", ["default"]);
  assert.ok(msg !== null);
  assert.match(msg, /onlychat/);
  assert.match(msg, /tools\.selfManagement|selfManagement/);
  assert.equal(guardSelfManagement("config_set", "default", ["default"]), null);
});

test("可见性：非授权 agent 拿不到自我管理工具，default 拿得到", () => {
  const agents = loadSelfManagementAgents();
  if (agents.includes("*")) {
    console.log("     （本机配置把所有 agent 都放开了，跳过可见性断言）");
    return;
  }
  // 注册一个与真实工具同名的占位（registerTool 重名会抛，故用 try）
  try {
    registerTool({
      requiresMFA: false,
      spec: {
        type: "function",
        function: { name: "config_set", description: "test placeholder", parameters: {} as never },
      },
      execute: async () => "noop",
    });
  } catch {
    /* 已经被真正的工具注册过：直接用它 */
  }

  const forDefault = getAllToolSpecs("default").map((t) => t.function.name);
  const forNobody = getAllToolSpecs("__no_such_agent__").map((t) => t.function.name);
  assert.equal(forDefault.includes("config_set"), true, "default 应当看得到 config_set");
  assert.equal(forNobody.includes("config_set"), false, "未授权 agent 不该看到 config_set");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
