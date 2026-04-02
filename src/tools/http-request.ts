import { registerTool } from "./registry.js";
import { loadSecretsConfig } from "../config/loader.js";

/** http_request 响应体最大字符数，超出时截断 */
const MAX_RESPONSE_BODY = 8_000;
/** 请求超时（毫秒） */
const REQUEST_TIMEOUT_MS = 30_000;

/**
 * 将 headers 中的 `$KEY` 占位符替换为 secrets.toml 中的真实值。
 *
 * 安全规则：
 * - **只替换 headers**，url / body 完全不做替换（防提示词注入）
 * - 占位符格式：`$KEY`，KEY 仅由大写字母、数字、下划线组成（`$[A-Z][A-Z0-9_]*`）
 * - 替换前校验 `allowed_hosts`：目标 hostname 不在白名单中时直接抛错
 * - 返回替换后的 headers 副本，原始输入不修改
 *
 * @throws {Error} secret 未定义 / allowed_hosts 校验失败
 */
function resolveSecretHeaders(
  headers: Record<string, string>,
  hostname: string,
): Record<string, string> {
  const secrets = loadSecretsConfig();
  const SECRET_RE = /\$([A-Z][A-Z0-9_]*)/g;
  const resolved: Record<string, string> = {};

  for (const [headerName, headerValue] of Object.entries(headers)) {
    resolved[headerName] = headerValue.replace(SECRET_RE, (_match, key: string) => {
      const entry = secrets[key];
      if (!entry) {
        throw new Error(
          `未知 secret "$${key}"，请在 ~/.tinyclaw/secrets.toml 中配置\n` +
          `格式：\n[${key}]\nvalue = "实际值"\nallowed_hosts = ["目标域名"]`,
        );
      }
      if (entry.allowed_hosts.length > 0 && !entry.allowed_hosts.includes(hostname)) {
        throw new Error(
          `secret "$${key}" 不允许发送到 "${hostname}"（allowed_hosts: [${entry.allowed_hosts.map(h => `"${h}"`).join(", ")}]）`,
        );
      }
      return entry.value;
    });
  }

  return resolved;
}

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "http_request",
      description:
        "发送 HTTPS 请求（GET/POST），返回响应状态码和响应体。仅支持 https:// URL，不支持 http。\n\n" +
        "headers 的 value 支持 `$SECRET_NAME` 占位符，运行时自动从 ~/.tinyclaw/secrets.toml 读取真实值（AI 不可见）。" +
        "占位符只在 headers 中生效，url 和 body 中的 $xxx 不会被替换（防止凭证泄露）。",
      parameters: {
        type: "object",
        properties: {
          method: {
            type: "string",
            enum: ["GET", "POST"],
            description: "HTTP 方法：GET 或 POST",
          },
          url: {
            type: "string",
            description: "请求 URL，必须以 https:// 开头",
          },
          headers: {
            type: "object",
            description:
              "请求头 KV 对象（可选）。value 可使用 `$SECRET_NAME` 占位符引用 secrets.toml 中的凭证，" +
              "例如：{ \"Authorization\": \"$TB_TOKEN\", \"Content-Type\": \"application/json\" }",
            additionalProperties: { type: "string" },
          },
          body: {
            type: "string",
            description: "请求体字符串（可选，POST 时使用），通常为 JSON.stringify 后的内容",
          },
        },
        required: ["method", "url"],
      },
    },
  },
  async execute(args): Promise<string> {
    const method = String(args["method"] ?? "GET").toUpperCase();
    const url = String(args["url"] ?? "");
    const rawHeaders = (args["headers"] ?? {}) as Record<string, string>;
    const body = args["body"] != null ? String(args["body"]) : undefined;

    if (!url) return "错误：缺少 url 参数";
    if (!url.startsWith("https://")) {
      return `错误：仅支持 https:// URL，拒绝请求：${url.slice(0, 100)}`;
    }
    if (method !== "GET" && method !== "POST") {
      return `错误：不支持的 HTTP 方法 "${method}"，仅支持 GET / POST`;
    }

    // 解析目标 hostname，用于 secrets 域名白名单校验
    let hostname: string;
    try {
      hostname = new URL(url).hostname;
    } catch {
      return `错误：无效的 URL：${url.slice(0, 100)}`;
    }

    // 替换 headers 中的 $SECRET 占位符（url / body 不做替换）
    let resolvedHeaders: Record<string, string>;
    try {
      resolvedHeaders = resolveSecretHeaders(rawHeaders, hostname);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return `错误：${msg}`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const fetchInit: RequestInit = {
        method,
        headers: resolvedHeaders,
        signal: controller.signal,
      };
      if (method === "POST") fetchInit.body = body ?? "";
      const resp = await fetch(url, fetchInit);

      let text: string;
      try {
        text = await resp.text();
      } catch {
        text = "(无法读取响应体)";
      }

      if (text.length > MAX_RESPONSE_BODY) {
        text =
          text.slice(0, MAX_RESPONSE_BODY) +
          `\n[…响应已截断：共 ${text.length} 字符，仅显示前 ${MAX_RESPONSE_BODY} 字符]`;
      }

      return `HTTP ${resp.status}\n${text}`;
    } catch (err: unknown) {
      if (err instanceof Error && err.name === "AbortError") {
        return `错误：请求超时（>${REQUEST_TIMEOUT_MS / 1000}s）：${url}`;
      }
      const msg = err instanceof Error ? err.message : String(err);
      return `错误：请求失败：${msg}`;
    } finally {
      clearTimeout(timer);
    }
  },
});
