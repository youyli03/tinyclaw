import { registerTool } from "./registry.js";

/** http_request 响应体最大字符数，超出时截断 */
const MAX_RESPONSE_BODY = 8_000;
/** 请求超时（毫秒） */
const REQUEST_TIMEOUT_MS = 30_000;

registerTool({
  requiresMFA: false,
  spec: {
    type: "function",
    function: {
      name: "http_request",
      description:
        "发送 HTTPS 请求（GET/POST），返回响应状态码和响应体。仅支持 https:// URL，不支持 http。",
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
            description: "请求头 KV 对象（可选），例如 { \"Authorization\": \"xxx\", \"Content-Type\": \"application/json\" }",
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
    const headers = (args["headers"] ?? {}) as Record<string, string>;
    const body = args["body"] != null ? String(args["body"]) : undefined;

    if (!url) return "错误：缺少 url 参数";
    if (!url.startsWith("https://")) {
      return `错误：仅支持 https:// URL，拒绝请求：${url.slice(0, 100)}`;
    }
    if (method !== "GET" && method !== "POST") {
      return `错误：不支持的 HTTP 方法 "${method}"，仅支持 GET / POST`;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const resp = await fetch(url, {
        method,
        headers,
        body: method === "POST" ? body : undefined,
        signal: controller.signal,
      });

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
