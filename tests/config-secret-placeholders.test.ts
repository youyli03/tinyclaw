/**
 * provider 凭据的 `$NAME` 占位符解析（`src/config/secret-placeholders.ts`）
 *
 * 运行：npm run test:config-secrets
 *
 * 覆盖：
 * - 白名单字段（providers.*.apiKey / providers.copilot.githubToken）真的被解析
 * - 明文原样透传；非引用式文本（`$NAME extra`、`$lowercase`）不碰
 * - **白名单之外**的 `$NAME` 一律不动（做过全域替换会静默改掉 `$PATH` 这类字面量）
 * - 缺键 → 保留字面量 + 报告缺失名（不抛错：启动期抛错会把服务带走）
 * - 不修改传入对象（`loadConfig()` 的缓存对象不能被就地改）
 */
import assert from "node:assert/strict";
import { ConfigSchema, type Config, type SecretsConfig } from "../src/config/schema.js";
import {
  PLACEHOLDER_FIELD_PATHS,
  resolveProviderSecretPlaceholders,
} from "../src/config/secret-placeholders.js";

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

const secrets: SecretsConfig = {
  OPENAI_KEY: { value: "sk-openai-real", allowed_hosts: [] },
  OPENROUTER_API_KEY: { value: "sk-or-real", allowed_hosts: [] },
  GITHUB_TOKEN: { value: "ghp_real", allowed_hosts: [] },
  // 历史裸字符串格式也要能取到
  LEGACY_KEY: "legacy-value",
};

/** schema 要求的最小底盘（llm.backends.daily 是必填） */
const BASE = { llm: { backends: { daily: { model: "deepseek/chat" } } } } as const;

/** 用最少输入构造一个通过 schema 校验的配置 */
function parseCfg(partial: Record<string, unknown>): Config {
  return ConfigSchema["parse"]({ ...BASE, ...partial }) as Config;
}

/** 一个最小可用配置（其余段走 schema 默认值） */
function cfgWithExample(): Config {
  return parseCfg({
    providers: {
      openai: { apiKey: "$OPENAI_KEY" },
      openrouter: { apiKey: "$OPENROUTER_API_KEY", baseUrl: "https://openrouter.ai/api/v1" },
      deepseek: { apiKey: "plain-deepseek-key" },
      copilot: { githubToken: "$GITHUB_TOKEN" },
    },
    llm: {
      ...BASE.llm,
      aliases: { fast: "$FAST_ALIAS", normal: "deepseek/chat" },
    },
  });
}

await test("白名单字段：$NAME 解成 secrets.toml 的真值", () => {
  const { config, missing } = resolveProviderSecretPlaceholders(cfgWithExample(), secrets);
  assert.equal(config.providers.openai?.apiKey, "sk-openai-real");
  assert.equal(config.providers.openrouter?.apiKey, "sk-or-real");
  assert.equal(config.providers.copilot?.githubToken, "ghp_real");
  assert.deepEqual(missing, []);
});

await test("明文（非引用式）原样透传", () => {
  const { config, missing } = resolveProviderSecretPlaceholders(cfgWithExample(), secrets);
  assert.equal(config.providers.deepseek?.apiKey, "plain-deepseek-key");
  assert.deepEqual(missing, []);
});

await test("历史裸字符串格式的 secret 也能取到", () => {
  const cfg = parseCfg({ providers: { mimo: { apiKey: "$LEGACY_KEY" } } });
  const { config } = resolveProviderSecretPlaceholders(cfg, secrets);
  assert.equal(config.providers.mimo?.apiKey, "legacy-value");
});

await test("白名单之外的 $NAME 一律不碰（llm.aliases 保持字面量）", () => {
  const { config } = resolveProviderSecretPlaceholders(cfgWithExample(), secrets);
  assert.equal(config.llm.aliases["fast"], "$FAST_ALIAS");
  assert.equal(config.llm.aliases["normal"], "deepseek/chat");
});

await test("非整值引用不解析：$NAME extra / $lowercase / 前后有空格以外的东西", () => {
  const cfg = parseCfg({
    providers: {
      openai: { apiKey: "$OPENAI_KEY extra" },
      google: { apiKey: "$lowercase" },
    },
  });
  const { config, missing } = resolveProviderSecretPlaceholders(cfg, secrets);
  assert.equal(config.providers.openai?.apiKey, "$OPENAI_KEY extra");
  assert.equal(config.providers.google?.apiKey, "$lowercase");
  assert.deepEqual(missing, []);
});

await test("缺键：保留字面量 + 报告缺失名（不抛错）", () => {
  const cfg = parseCfg({ providers: { openrouter: { apiKey: "$NOT_IN_SECRETS" } } });
  const { config, missing } = resolveProviderSecretPlaceholders(cfg, secrets);
  assert.equal(config.providers.openrouter?.apiKey, "$NOT_IN_SECRETS");
  assert.deepEqual(missing, ["providers.openrouter.apiKey=$NOT_IN_SECRETS"]);
});

await test("secrets.toml 读不出来（空表）→ 全部保留字面量并逐个报告", () => {
  const cfg = parseCfg({
    providers: { openrouter: { apiKey: "$A_KEY" }, copilot: { githubToken: "$B_KEY" } },
  });
  const { config, missing } = resolveProviderSecretPlaceholders(cfg, {});
  assert.equal(config.providers.openrouter?.apiKey, "$A_KEY");
  assert.equal(config.providers.copilot?.githubToken, "$B_KEY");
  assert.equal(missing.length, 2);
});

await test("不修改传入对象（loadConfig 的缓存对象不能就地改）", () => {
  const cfg = cfgWithExample();
  const before = cfg.providers.openai?.apiKey;
  const { config } = resolveProviderSecretPlaceholders(cfg, secrets);
  assert.equal(cfg.providers.openai?.apiKey, before);
  assert.notEqual(config.providers, cfg.providers);
  assert.notEqual(config, cfg);
});

await test("白名单清单与实现一致（文档里引用的就是这份）", () => {
  assert.deepEqual(PLACEHOLDER_FIELD_PATHS, [
    "providers.openai.apiKey",
    "providers.openrouter.apiKey",
    "providers.deepseek.apiKey",
    "providers.mimo.apiKey",
    "providers.google.apiKey",
    "providers.copilot.githubToken",
  ]);
  // 每个白名单字段名都要真的出现在实现里（防止清单与代码漂移）
  const cfg = parseCfg({
    providers: {
      openai: { apiKey: "$K" },
      openrouter: { apiKey: "$K" },
      deepseek: { apiKey: "$K" },
      mimo: { apiKey: "$K" },
      google: { apiKey: "$K" },
      copilot: { githubToken: "$K" },
    },
  });
  const { missing } = resolveProviderSecretPlaceholders(cfg, { K: "v" });
  assert.deepEqual(missing, []);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
