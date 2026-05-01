# QMD + RKLLM Embed 架构

> 描述 tinyclaw 如何用 RKLLM NPU HTTP embed 替代本地 LlamaCpp 做向量索引，
> 包括 per-store llm 覆盖、memstores.toml、IPC rebuild、tokenize 估算与 systemd 部署。

---

## 一、背景

`@tobilu/qmd` 内部在 `createStore()` 时会自动 `new LlamaCpp()` 并赋给 `store.internal.llm`，
因此调用 `setDefaultLlamaCpp()` 对已创建的 store **无效**。

tinyclaw 的解决方案：**在 `createStore()` 完成后，直接覆盖 `store.internal.llm`**，
注入一个符合 QMD LLM interface 的 RKLLM HTTP embed 对象，彻底绕过本地 GGUF 初始化。

---

## 二、RKLLM embed server

### 服务脚本

```
~/rkllm-embed-server/
  server.py       # HTTP server，调用 rkllm C SDK 做 embedding
  start.sh        # 启动脚本
```

### 关键配置（`server.py`）

| 参数 | 值 | 说明 |
|------|-----|------|
| `max_context_len` | 2048 | 最大 token 数，超过会截断 |
| `_MAX_TEXT_CHARS` | 1800 | 输入截断字符数（防止超过 context 导致崩溃） |
| 监听地址 | `127.0.0.1:11434` | 仅本机访问 |
| 并发 | `ThreadingHTTPServer` + `request_queue_size=64` | 支持并发批量请求 |

### API

```
POST /embed
  Body: { "text": "..." }
  Response: { "embedding": [1024 floats], "dim": 1024 }

POST /embed_batch
  Body: { "texts": ["...", "..."] }
  Response: { "embeddings": [[...], [...]] }
```

### systemd user service

文件：`~/.config/systemd/user/rkllm-embed.service`

```ini
[Unit]
Description=RKLLM Embed HTTP Server
After=network.target

[Service]
Type=simple
WorkingDirectory=/home/lyy/rkllm-embed-server
ExecStart=/usr/bin/python3 server.py
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
```

启用开机自启：

```bash
systemctl --user enable rkllm-embed
systemctl --user start rkllm-embed
loginctl enable-linger $USER   # 确保用户 service 开机自启（无需登录）
```

---

## 三、tinyclaw 侧实现

### 3.1 makeRkllmEmbedLlm（`src/memory/rkllm-embed.ts`）

返回符合 QMD LLM interface 的对象，实现以下方法：

| 方法 | 实现 |
|------|------|
| `embed(text)` | `POST /embed` |
| `embedBatch(texts)` | `POST /embed_batch` |
| `tokenize(text)` | 估算：`ceil(text.length / 1.8)` → `Uint32Array` |
| `modelExists()` | 返回 `{ exists: true }` |
| `expandQuery(q)` | 返回 `[{ type: "vec", text: q }]`（退化为语义搜索） |
| `generate()` / `rerank()` | `throw`（不支持） |
| `dispose()` | 空操作 |

**tokenize 估算说明**：QMD 用 `tokenize().length` 做文档分块，
RKLLM 约 1.8 chars/token（中英混合），
`/1.8` 估算 → chunk 约 900 tokens ≈ 1620 chars/chunk，不超 `max_context_len=2048`。

### 3.2 per-store llm 覆盖（`src/memory/qmd.ts`）

```typescript
const store = await createStore({ dbPath, collections });
// 覆盖 internal llm，绕过 QMD 内部 LlamaCpp
(store as any).internal.llm = makeRkllmEmbedLlm(port);
```

每次 `getQMDStore(agentId)` 调用都确保 RKLLM embed 已注入。

---

## 四、memstores.toml

文件位置：`~/.tinyclaw/memstores.toml`

### 格式

```toml
[[stores]]
name    = "notes"
title   = "个人笔记（Obsidian Vault）"
path    = "~/.tinyclaw/user-data/notes/vault"
pattern = "**/*.md"
enabled = true

[[stores]]
name    = "docs"
title   = "项目文档"
path    = "/home/lyy/projects/myapp/docs"
pattern = "**/*.md"
enabled = false
```

### 字段说明

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `name` | string | ✅ | QMD collection 名，同时作为 `search_store` 工具的 `store` 参数枚举值 |
| `title` | string | ✅ | 展示给 LLM 的描述，出现在工具 description 和搜索结果标头 |
| `path` | string | ✅ | Markdown 文件根目录，支持 `~` 展开 |
| `pattern` | string | 默认 `**/*.md` | glob 匹配模式 |
| `enabled` | bool | 默认 `true` | false 时不注册，不出现在工具枚举中 |

### 效果

- 服务启动时，`search_store` 工具的 `store` 枚举自动包含所有 `enabled=true` 的 store
- rebuild 时动态遍历，逐一索引

---

## 五、索引重建（memory_rebuild IPC）

### 触发方式

```bash
tinyclaw memory index   # CLI → 通过 IPC 在服务进程内执行
```

### 流程（`rebuildMemoryIndex(agentId)` in `qmd.ts`）

```
1. 关闭旧 store（storeMap.delete(agentId)）
2. 打开 SQLite，调用 clearAllEmbeddings(db)（清空所有向量）
3. 重新 createStore()，覆盖 store.internal.llm = makeRkllmEmbedLlm()
4. 读取 memstores.toml，将 enabled=true 的 store 追加到 collections
5. 调用 store.indexFiles() 对所有 .md 文件重新向量化（1024 dim）
6. 完成后写入 storeMap 缓存
```

### IPC 协议

| 请求 | 参数 | 响应 |
|------|------|------|
| `memory_rebuild` | `{ agentId?: string }` | `{ ok: true, chunks: number }` 或 `{ ok: false, error: string }` |

---

## 六、常见问题

### Dimension mismatch

**现象**：QMD 搜索报 `Dimension mismatch: 768 vs 1024`。

**原因**：旧索引由本地 LlamaCpp（Qwen3-Embedding 768 dim）生成，与当前 RKLLM（1024 dim）不兼容。

**修复**：

```bash
tinyclaw memory index   # 触发 IPC rebuild，清空旧 embeddings 并重建
```

### embed server 未启动

**现象**：`rkllm-embed HTTP 111: Connection refused`。

**修复**：

```bash
systemctl --user start rkllm-embed
# 或手动启动
cd ~/rkllm-embed-server && python3 server.py &
```

### 文本过长（Input is longer than the context size）

**原因**：单个 chunk 超过 `max_context_len=2048` tokens。

**修复**：`server.py` 已内置 `_MAX_TEXT_CHARS=1800` 截断，正常情况不触发。
若仍出现，检查 `tokenize` 估算是否过小，或调低 `qmd` 的 chunk 大小。
