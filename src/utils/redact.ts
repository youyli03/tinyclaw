import { loadSecretsConfig, loadConfig } from "../config/loader.js";

/**
 * 凭证脱敏工具。
 *
 * 用于在日志 / 错误消息中安全展示 token、apiKey 等敏感值,
 * 避免明文凭证落入 service.log 或被其他用户/进程读取。
 */

/**
 * 对单个 secret 值脱敏:保留前 4 + 后 2 字符,中间用 *** 代替。
 *
 * - 长度 ≤ 8 时全部替换为 ***(避免暴露过多)
 * - 空值返回空串
 *
 * @example redactSecret("sk-or-v1-abcdef0123456789ea5") => "sk-o***a5"
 */
export function redactSecret(value: string | undefined | null): string {
  if (!value) return "";
  if (value.length <= 8) return "***";
  return `${value.slice(0, 4)}***${value.slice(-2)}`;
}

/**
 * 收集当前所有已知敏感凭证值(secrets.toml + config 各 provider apiKey 等)。
 * 用于 redactKnownSecrets 全文替换。
 */
function collectKnownSecrets(): string[] {
  const values = new Set<string>();
  // secrets.toml
  try {
    const secrets = loadSecretsConfig();
    for (const entry of Object.values(secrets)) {
      if (entry?.value && entry.value.length >= 6) values.add(entry.value);
    }
  } catch {
    /* ignore */
  }
  // config providers
  try {
    const cfg = loadConfig();
    const providers = cfg.providers as Record<string, { apiKey?: string }> | undefined;
    if (providers) {
      for (const p of Object.values(providers)) {
        if (p?.apiKey && p.apiKey.length >= 6 && p.apiKey !== "gh_cli") {
          values.add(p.apiKey);
        }
      }
    }
    // web token
    const webToken = (cfg.web as { token?: string } | undefined)?.token;
    if (webToken && webToken.length >= 6) values.add(webToken);
  } catch {
    /* ignore */
  }
  return [...values];
}

/**
 * 在任意文本中,把所有已知的真实凭证值替换为 `***`。
 *
 * 用于在打印外部内容 / 错误堆栈前过滤,防止凭证意外泄露到日志。
 * 凭证收集失败时原样返回(不阻塞)。
 */
export function redactKnownSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  for (const secret of collectKnownSecrets()) {
    if (!secret) continue;
    // 全局替换(转义正则特殊字符)
    const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(escaped, "g"), "***");
  }
  return out;
}
