# LLM 连接稳定性架构

> 描述 tinyclaw 在网络抖动、429 限流、5xx 服务端错误、流式挂起等场景下的重试与容错机制。

---

## 一、背景与问题

tinyclaw 使用 GitHub Copilot（及 OpenAI-compatible API）作为 LLM 后端。在实际部署中会遇到以下几类不稳定因素：

| 错误类型 | 典型表现 | 根因 |
|---------|---------|------|
| 传输层断开 | `ECONNRESET` / `connection error` / socket hang up | 网络抖动、NAT 超时、负载均衡切换 |
| HTTP/2 连接重置 | `GOAWAY` / `UND_ERR_SOCKET` / TypeError `terminated` | 服务端 HTTP/2 GOAWAY 帧、undici 连接池断言失败 |
| 证书验证失败 | `UNKNOWN_CERTIFICATE_VERIFICATION_ERROR` | Bun 在某些 Linux 发行版上无法自动找到系统 CA 路径 |
| 请求超时 | `APIConnectionTimeoutError` | 请求体过大、网络延迟过高 |
| 限流 | HTTP 429 + 错误消息含 "try again in Xs" | Copilot/OpenAI API 速率限制 |
| 服务端错误 | HTTP 5xx | 后端服务过载或部署故障 |
| 流式挂起 | 流建立成功但长时间无 chunk | 服务端响应挂起、反向代理超时 |

---

## 二、整体架构

```
Agent.runAgent()
  └── LLMClient.streamChat()
        ├── [Copilot] WebSocket Responses API   ← 优先，原生 keepalive，无 idle timeout
        │     └── ResponsesWsConnection          ← WS 连接管理 + 事件处理
        │           ↕ 失败且 0 chunks → fallback
        ├── withRetry()                          ← HTTP 路径，自动重试
        │     ├── withStreamIdleTimeout()        ← 每 chunk 间 idle timeout（90s）
        │     │     └── 0 chunks + timeout → 非流式 fallback → this.chat()
        │     └── OpenAI SDK stream              ← 实际 HTTP/SSE 连接
        └── [error] onStreamSocketError()        ← 重置 HTTP/2 agent

LLMRegistry.init() / buildCopilotClient()
  ├── getCopilotToken()               ← 自带指数退避重试
  └── getCopilotModels()              ← 自带指数退避重试
```

重试策略通过 `config.toml [retry]` 统一配置，由 `getRetryPolicy()` 在运行时读取。

---

## 三、重试策略（`src/llm/client.ts`）

### 3.1 `withRetry<T>(fn, signal?)`

所有 HTTP LLM 调用（`chat` 和 `streamChat` HTTP 路径）都包裹在此函数中。

```
attempt 0  → fn()
  ├── 成功 → 返回结果
  └── 失败 → isRetryableError(err, policy)?
        ├── false → 立即重新抛出
        └── true  → sleep(backoff) → attempt 1 → ...
                                        ↓
                               attempt > maxAttempts
                                        ↓
                               throw LLMConnectionError
```

**重试判定（`isRetryableError`）：**

| 错误类型 | 控制开关 | 默认 |
|---------|---------|------|
| `APIConnectionTimeoutError` | `retryTimeout` | false（不重试） |
| `RateLimitError`（HTTP 429） | `retry429` | true |
| `APIError`（HTTP >= 500 / 499 / 408） | `retry5xx` | true |
| `APIConnectionError` | `retryTransport` | true |
| ECONNRESET / socket / connection error | `retryTransport` | true |
| GOAWAY / UND_ERR_SOCKET / TypeError "terminated" | `retryTransport` | true |
| 流 idle timeout（消息含 "idle timeout"） | `retryTransport` | true |

### 3.2 退避算法（`backoff`）

采用**指数退避 + ±10% 随机 Jitter**，参考 codex-rs 实现：

```
delay = baseDelayMs × 2^(attempt-1) × random(0.9, 1.1)
```

| 重试次 | baseDelayMs=1000 时的实际延迟（含 jitter） |
|--------|------------------------------------------|
| 第 1 次 | 900 ~ 1100 ms |
| 第 2 次 | 1800 ~ 2200 ms |
| 第 3 次 | 3600 ~ 4400 ms |

Jitter 的作用：多个并发请求同时失败后，避免它们在完全相同的时刻重试，防止"惊群"（thundering herd）现象。

### 3.3 429 Retry-After 解析（`parseRetryAfterMs`）

当收到 `RateLimitError` 时，首先尝试从错误消息中提取建议等待时间：

```
"Please try again in 5s"   → 5000 ms
"retry after 2.5 seconds"  → 2500 ms
"wait 300ms"               → 300 ms
```

若解析成功，使用该值替代指数退避；否则回退到 `backoff()`。这避免了等待时间过长或过短的问题。

---

## 四、流式 Idle Timeout 与非流式 Fallback（`withStreamIdleTimeout`）

### 问题

SSE 流建立成功后，HTTP 连接已建立，但服务端可能停止发送 chunk（如后端内部超时、反向代理切断数据但未关闭连接）。此时 `for await (const chunk of stream)` 会**永久阻塞**，既不报错也不继续。

### 解决方案

在每次 `stream.next()` 调用上加 `setTimeout` 竞争：

```typescript
async function* withStreamIdleTimeout<T>(iter, idleMs, signal?) {
  const it = iter[Symbol.asyncIterator]();
  while (true) {
    const result = await Promise.race([
      it.next(),
      sleep(idleMs).then(() => { throw new Error("stream idle timeout: ...") })
    ]);
    if (result.done) return;
    yield result.value;
  }
}
```

**默认配置：** `streamIdleTimeoutMs = 90000`（90 秒，对齐 Claude Code），可在 `[retry]` 中调整；设为 `0` 禁用。

### 非流式 Fallback（idle timeout + 0 chunks）

当 idle timeout 触发且**未收到任何 chunk** 时，服务端很可能正在处理请求但响应慢（如推理长代码）。此时继续重试流式无改善，改用**非流式**（单次 HTTP 请求等待完整响应）：

```
idle timeout (0 chunks)
  → this.chat(messages, { turnRequestIdOverride: same_id })
  → 等待完整响应（由 backend.timeoutMs 控制）
  → 收到后一次性通过 onChunk(content) 回调
```

复用同一 `turnRequestId` 确保服务端识别为同一请求，不额外计费。

---

## 五、WebSocket Responses API（Copilot 专用）

### 优势

| 特性 | HTTP/2 SSE | WebSocket |
|------|-----------|-----------|
| keepalive | 无（需 idle timeout） | 原生 ping/pong |
| 断线检测 | 服务端停发 chunk 无感知 | WebSocket close 事件 |
| 重连 | 需重建 HTTP/2 连接 | 简单重新 connect() |
| 消息协议 | Chat Completions SSE | Responses API events |

### 连接管理（`ResponsesWsConnection`，`src/llm/responses-ws.ts`）

- URL：`wss://api.githubcopilot.com/v1/responses`（HTTP URL + `/responses`，`https:` → `wss:`）
- 握手认证：`Authorization: Bearer <copilot_token>` + Copilot 专用 headers（每次新连接调用 `getWsHeaders()` 获取最新 token）
- 连接复用：`wsConn` 跨轮次保持，同一 session 不重复握手
- 自动重连：下次使用时检测 `isOpen()`，关闭则重建

### 消息协议

```
发送（response.create）:
{
  "type": "response.create",
  "model": "...",
  "instructions": "...",   // 从 system 消息提取
  "input": [...],          // user/assistant/tool 消息（Responses API 格式）
  "tools": [...],
  "store": false
}

接收（流式事件）:
response.output_text.delta  → onChunk(delta)
response.output_item.added  → 捕获 function_call（工具调用）
response.function_call_arguments.delta → 累积工具参数
response.completed          → 最终结果，流结束
response.failed / error     → 抛出 WebSocketError
```

### 消息格式转换（`chatMessagesToResponsesInput`）

| Chat Completions | Responses API |
|-----------------|--------------|
| `{role:"system", content:"..."}` | 提取为顶层 `instructions` 字符串 |
| `{role:"user", content:"..."}` | `{role:"user", content:"..."}` |
| `{role:"user", content:[{type:"image_url",...}]}` | `{role:"user", content:[{type:"input_image",image_url:"..."}]}` |
| `{role:"assistant", tool_calls:[...]}` | `{type:"function_call", call_id, name, arguments}` |
| `{role:"tool", tool_call_id:"...", content:"..."}` | `{type:"function_call_output", call_id, output}` |

### Fallback 策略

```
streamChat()
  ├── 1. 尝试 WebSocket 路径 (this.backend.wsUrl)
  │         ├── 成功 → 返回结果
  │         └── 失败（chunksReceived=0）→ shouldFallbackToHttp() → 降级
  └── 2. HTTP Chat Completions 路径（带 withRetry）
```

`shouldFallbackToHttp()` 条件（参照 app.js `shouldFallbackToHttp`）：
- `chunksReceived === 0`（流未开始就失败）
- 非 AbortError（用户主动取消不 fallback）
- err 是 `WebSocketError`（连接/协议错误）

---

## 六、HTTP/2 GOAWAY 与连接重置

对应 `@github/copilot` app.js 的 `lRe()` + `aRe()` 机制：

- `lRe(err)`：检测 `"GOAWAY"` / `"UND_ERR_SOCKET"` / TypeError `"terminated"` → 重置全局 dispatcher
- tinyclaw 等效：`isRetryableError()` 匹配这些模式 → `onStreamSocketError()` → `resetH2Agent()`

`resetH2Agent()` 关闭当前 undici HTTP/2 Agent 并置为 `undefined`，下次请求时建立新连接池（新 TCP + TLS 握手），彻底规避残留的 GOAWAY 错误。

---

## 七、Copilot 专用重试（`src/llm/copilot.ts`）

`getCopilotToken()` 和 `getCopilotModels()` 使用独立的简单重试循环（因为它们在 OpenAI SDK 初始化之前运行，无法复用 `withRetry`），但同样读取 retry policy：

```typescript
const MAX_RETRIES = policy?.maxAttempts ?? 3;
const BASE_DELAY  = policy?.baseDelayMs ?? 1000; // token: 500ms

for attempt in 1..MAX_RETRIES+1:
  try { resp = await fetch(...); break }
  catch:
    waitMs = BASE_DELAY × 2^(attempt-1) × jitter(±10%)
    sleep(waitMs)
```

这确保模型列表获取失败（网络抖动）不会导致 agent 启动失败。

---

## 八、系统 CA 证书（`src/llm/copilot.ts`）

**问题：** Bun 在某些 Linux 发行版（Debian/Ubuntu）上无法自动找到系统 CA 证书路径，导致 HTTPS 请求抛出 `UNKNOWN_CERTIFICATE_VERIFICATION_ERROR`。

**解决：** `systemCA()` 按优先级遍历常见路径，找到第一个存在的 CA bundle 并注入 `fetch` 的 `tls.ca` 扩展字段（Bun 专属）：

```typescript
const CA_CANDIDATES = [
  "/etc/ssl/certs/ca-certificates.crt",  // Debian / Ubuntu
  "/etc/pki/tls/certs/ca-bundle.crt",    // RHEL / CentOS
  "/etc/ssl/ca-bundle.pem",              // openSUSE
  "/etc/ssl/cert.pem",                   // Alpine / macOS
];
```

所有 Copilot 相关 `fetch` 调用都通过 `withCA(init?)` 包装：

```typescript
function withCA(init?: RequestInit): RequestInit {
  const ca = systemCA();
  if (!ca) return init ?? {};
  return { ...init, tls: { ca } } as RequestInit;
}
```

**如果仍然失败：**
```bash
sudo apt-get install -y ca-certificates
sudo update-ca-certificates
```

---

## 九、配置参考（`[retry]`）

所有字段均有默认值，无需配置即可使用。仅在需要调整时在 `~/.tinyclaw/config.toml` 中添加：

```toml
[retry]
maxAttempts         = -1     # 最多重试次数（-1 = 无限，由 maxRetryDurationMs 封顶）
baseDelayMs         = 1000   # 指数退避基准延迟（ms），实际带 ±10% 随机抖动
retry429            = true   # 429 限流是否重试
retry5xx            = true   # 5xx 服务端错误是否重试
retryTransport      = true   # 传输层错误（ECONNRESET/GOAWAY/socket 断开等）是否重试
retryTimeout        = false  # 请求超时是否重试（超时通常意味着请求体过大）
streamIdleTimeoutMs = 90000  # 流式调用 chunk 间最长等待（ms）；0 = 禁用（对齐 Claude Code 90s）
```

**常见调整场景：**

| 场景 | 建议配置 |
|------|---------|
| 网络极不稳定，希望多重试几次 | `maxAttempts = 5`，`baseDelayMs = 500` |
| 频繁 429，希望更保守 | `retry429 = true`（保持），`baseDelayMs = 2000` |
| 长任务请求体大，超时需重试 | `retryTimeout = true`，`maxAttempts = 2` |
| 网络稳定，禁用流 idle 检测 | `streamIdleTimeoutMs = 0` |
| 测试环境，禁用所有重试 | `maxAttempts = 0` |

---

## 十、相关文件索引

| 文件 | 职责 |
|------|------|
| `src/llm/client.ts` | `backoff`、`parseRetryAfterMs`、`isRetryableError`、`withRetry`、`withStreamIdleTimeout`、`LLMConnectionError`、WS 流式路径（`streamChatViaWebSocket`）|
| `src/llm/responses-ws.ts` | WebSocket 连接类（`ResponsesWsConnection`）、消息格式转换（Chat Completions ↔ Responses API）、流事件处理（`processResponsesStream`） |
| `src/llm/copilot.ts` | Copilot token/模型列表的独立重试循环；`systemCA` / `withCA`；WS URL 和 headers 注入 |
| `src/config/schema.ts` | `RetryConfigSchema`（Zod schema，含全部默认值） |
| `src/config/loader.ts` | `getRetryPolicy()` — 全局读取 retry 配置入口 |
| `config.example.toml` | `[retry]` 配置节注释示例 |
