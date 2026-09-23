/**
 * 密钥按 agent 授权（`src/auth/secrets-access.ts` + 四个 agent 可达入口）
 *
 * 运行：npm run test:secrets
 *
 * 覆盖：
 * - `canReadSecrets` 判定矩阵（默认只给 default / `"*"` 放开 / `[]` 全拒 / 无 agent 上下文放行）
 * - `secretKeyNames`：只出键名、排序、跳过没有值的条目、兼容裸字符串格式
 * - `secretsDeniedReason` 写明原因与如何放开
 * - 接线：`job_start` 的 `${SECRET:NAME}` 与 `secrets:[...]` 对未授权 agent 必须**拒绝**；
 *   `env_list` 对未授权 agent 不显示 secrets 键名
 *
 * 注：与 `[secrets].agents` 相关的两处接线断言带条件 —— 若本机把它放开了（`"*"`），
 * 就跳过"应当拒绝"的断言而不是误报失败。
 */
import assert from "node:assert/strict";
import {
  canReadSecrets,
  loadSecretAgents,
  secretKeyNames,
  secretsDeniedReason,
  DEFAULT_SECRET_AGENTS,
} from "../src/auth/secrets-access.js";
import { startJob } from "../src/core/job-manager.js";
import { executeTool } from "../src/tools/registry.js";
import "../src/core/agent.js"; // 副作用注册全部工具（与运行时一致）
import type { SecretsConfig } from "../src/config/schema.js";

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>): Promise<void> {
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

await test("canReadSecrets:默认列表只放行 default", () => {
  assert.deepEqual([...DEFAULT_SECRET_AGENTS], ["default"]);
  assert.equal(canReadSecrets("default", DEFAULT_SECRET_AGENTS), true);
  assert.equal(canReadSecrets("onlychat", DEFAULT_SECRET_AGENTS), false);
});

await test("canReadSecrets:`*` 放开全部、`[]` 谁都不给", () => {
  assert.equal(canReadSecrets("anything", ["*"]), true);
  assert.equal(canReadSecrets("default", []), false);
});

await test("canReadSecrets:没有 agent 上下文（CLI / cron 无绑定）→ 放行", () => {
  assert.equal(canReadSecrets(undefined, []), true);
  assert.equal(canReadSecrets("", []), true);
});

await test("loadSecretAgents:读不到配置时回退到默认值，不抛错", () => {
  const list = loadSecretAgents();
  assert.equal(Array.isArray(list), true);
  assert.equal(list.length > 0, true);
});

await test("secretKeyNames:只出键名、排序、跳过无值条目、兼容裸字符串", () => {
  const table = {
    ZED_KEY: { value: "z-value", allowed_hosts: [] },
    ALPHA_TOKEN: "legacy-bare-value",
    EMPTY_ONE: { value: "", allowed_hosts: [] },
    NO_VALUE: { allowed_hosts: [] },
  } as unknown as SecretsConfig;
  const names = secretKeyNames(table);
  assert.deepEqual(names, ["ALPHA_TOKEN", "ZED_KEY"]);
  // 绝不带值
  assert.equal(
    names.some((n) => n.includes("value")),
    false
  );
});

await test("secretsDeniedReason:写明原因 + 如何放开", () => {
  const msg = secretsDeniedReason("job_start 的 ${SECRET:NAME} 引用", "onlychat", ["default"]);
  assert.match(msg, /^已拒绝：/);
  assert.match(msg, /onlychat/);
  assert.match(msg, /\[secrets\] agents = \["default", "onlychat"\]/);
});

await test("接线:job_start 的 ${SECRET:NAME} 引用对未授权 agent 必须拒绝", async () => {
  const denied = "probe-not-authorized-agent";
  if (canReadSecrets(denied)) {
    console.log("     （跳过：本机 [secrets].agents 放开了所有 agent）");
    return;
  }
  const res = await startJob({
    command: "echo hi",
    agentId: denied,
    env: { X: "${SECRET:DEEPSEEK_API_KEY}" },
  });
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.match(res.reason, /已拒绝：/);
    assert.match(res.reason, /secrets\.toml/);
  }
});

await test("接线:job_start 的 secrets:[...] 声明对未授权 agent 必须拒绝", async () => {
  const denied = "probe-not-authorized-agent";
  if (canReadSecrets(denied)) {
    console.log("     （跳过：本机 [secrets].agents 放开了所有 agent）");
    return;
  }
  const res = await startJob({
    command: "echo hi",
    agentId: denied,
    secrets: ["DEEPSEEK_API_KEY"],
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.match(res.reason, /已拒绝：/);
});

await test("接线:env_list 对 default 显示 secrets 键名、对未授权 agent 不显示", async () => {
  const allowed = await executeTool("env_list", {}, { agentId: "default" });
  assert.match(allowed, /secrets\.toml 的键/);

  const denied = "probe-not-authorized-agent";
  if (canReadSecrets(denied)) {
    console.log("     （跳过未授权那一半：本机放开了所有 agent）");
    return;
  }
  const hidden = await executeTool("env_list", {}, { agentId: denied });
  assert.equal(/secrets\.toml 的键/.test(hidden), false);
  assert.match(hidden, /未被授权读 secrets\.toml/);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
