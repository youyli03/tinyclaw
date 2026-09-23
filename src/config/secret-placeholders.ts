/**
 * config.toml 里**凭据字段**的 `$NAME` 占位符解析。
 *
 * 背景：provider 的 apiKey 一直只能明文写在 `config.toml`（0600）。config.toml 会被
 * `tinyclaw-submitter` 定时备份进 git 仓库、会被 `config show` 读、也可能被误贴到别处；
 * 而 secrets.toml 是"只放密钥"的那一份。这里让 provider 凭据也能写成 `$NAME`，
 * 与 qqbot 的 `clientSecret`、`http_request` 的 header 用同一套语法/心智。
 *
 * **只解析白名单字段**（见 `PLACEHOLDER_FIELD_PATHS`）：`$PATH`、传给脚本的 `$HOME`
 * 这类字面量在配置里到处都是，做"全字符串替换"会把它们静默改掉。
 *
 * 缺键时**保留字面量**并把名字交给调用方告警（与 `config/validate.ts` 的诊断口径一致）：
 * 启动期抛错会把服务带走，而"按字面量用 → 401"是可控的失败。
 */

import type { Config, ProvidersConfig } from "./schema.js";
import type { SecretsConfig } from "./schema.js";
import { secretValue } from "../mcp/secret-ref.js";

/** 整个值就是一个 `$NAME` 引用时才解析（不做插值，避免误伤普通文本） */
const PLACEHOLDER_RE = /^\$([A-Z][A-Z0-9_]*)$/;

/** 会被解析的字段（文档与测试都引用这份清单） */
export const PLACEHOLDER_FIELD_PATHS: readonly string[] = [
  "providers.openai.apiKey",
  "providers.openrouter.apiKey",
  "providers.deepseek.apiKey",
  "providers.mimo.apiKey",
  "providers.google.apiKey",
  "providers.copilot.githubToken",
];

export interface ResolvedConfig {
  /** 解析后的配置（原对象不被修改） */
  config: Config;
  /** 引用了但 secrets.toml 里没有的键，形如 `providers.openrouter.apiKey=$OPENROUTER_API_KEY` */
  missing: string[];
}

function resolveOne(raw: string, secrets: SecretsConfig, missing: string[], path: string): string {
  const m = PLACEHOLDER_RE.exec(raw.trim());
  if (m === null) return raw; // 明文（或非引用式文本）原样透传
  const name = m[1]!;
  const value = secretValue(secrets, name);
  if (value === undefined) {
    missing.push(`${path}=$${name}`);
    return raw;
  }
  return value;
}

/**
 * 解析 provider 凭据里的 `$NAME`。
 *
 * @param cfg     已通过 schema 校验的配置
 * @param secrets secrets.toml 的内容（由调用方注入，避免本模块反向依赖 loader）
 */
export function resolveProviderSecretPlaceholders(
  cfg: Config,
  secrets: SecretsConfig
): ResolvedConfig {
  const missing: string[] = [];
  const src = cfg.providers;
  const providers: ProvidersConfig = { ...src };

  if (providers.openai !== undefined) {
    providers.openai = {
      ...providers.openai,
      apiKey: resolveOne(providers.openai.apiKey, secrets, missing, "providers.openai.apiKey"),
    };
  }
  if (providers.openrouter !== undefined) {
    providers.openrouter = {
      ...providers.openrouter,
      apiKey: resolveOne(
        providers.openrouter.apiKey,
        secrets,
        missing,
        "providers.openrouter.apiKey"
      ),
    };
  }
  if (providers.deepseek !== undefined) {
    providers.deepseek = {
      ...providers.deepseek,
      apiKey: resolveOne(providers.deepseek.apiKey, secrets, missing, "providers.deepseek.apiKey"),
    };
  }
  if (providers.mimo !== undefined) {
    providers.mimo = {
      ...providers.mimo,
      apiKey: resolveOne(providers.mimo.apiKey, secrets, missing, "providers.mimo.apiKey"),
    };
  }
  if (providers.google !== undefined) {
    providers.google = {
      ...providers.google,
      apiKey: resolveOne(providers.google.apiKey, secrets, missing, "providers.google.apiKey"),
    };
  }
  if (providers.copilot !== undefined) {
    providers.copilot = {
      ...providers.copilot,
      githubToken: resolveOne(
        providers.copilot.githubToken,
        secrets,
        missing,
        "providers.copilot.githubToken"
      ),
    };
  }

  return { config: { ...cfg, providers }, missing };
}
