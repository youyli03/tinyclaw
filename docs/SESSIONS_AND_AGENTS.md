# 会话与 Agent 生命周期

> 描述 tinyclaw 的 Agent 工作区、会话路由、记忆命名空间的完整生命周期。

---

## 一、核心概念

### Agent

Agent 是 tinyclaw 的"人格单元"，拥有独立的系统提示与记忆命名空间。

**工作区结构**

```
~/.tinyclaw/agents/<id>/
  agent.toml       — 元数据：id、创建时间、绑定规则
  SYSTEM.md        — Agent 级系统提示（可选）
  MEM.md           — 持久记忆（跨 session 偏好与结论，agent 可直接更新）
  SKILLS.md        — 技能目录（工具/脚本使用说明）
  memory/
    index.sqlite   — 向量索引数据库
    2026-03-15.md  — 压缩摘要（压缩触发时追加）
    2026-03-14.md
    ...
  skills/          — 技能脚本目录
  workspace/       — exec_shell 默认 cwd
    tmp/           — 临时文件
    output/        — 输出文件
```

**agent.toml 格式**

```toml
id = "mywork"
createdAt = "2026-03-15T12:00:00Z"

[[bindings]]
source = "qqbot:c2c:openid123"

[[bindings]]
source = "cli:550e8400-e29b-41d4-a716-446655440000"
```

**系统提示叠加规则（优先级从低到高）**

```
BUILTIN_SYSTEM（写死，始终生效）
  + ~/.tinyclaw/SYSTEM.md（全局用户配置，可选）
    + ~/.tinyclaw/agents/<id>/SYSTEM.md（Agent 级，可选）
```

### Session（会话）

Session 是一次具体对话的上下文容器，持有 `messages[]` 历史记录。

**Session ID 格式**

| 格式 | 来源 |
|---|---|
| `cli:<uuid>` | `tinyclaw chat new` 创建的终端会话 |
| `qqbot:c2c:<openid>` | QQBot 私聊 |
| `qqbot:group:<openid>` | QQBot 群聊 |
| `qqbot:guild:<channelId>` | QQBot 频道 |

---

## 二、Agent 生命周期

### 创建

```bash
tinyclaw agent new mywork
# → 创建 ~/.tinyclaw/agents/mywork/
# → 写入 agent.toml（id、createdAt、空 bindings）
# → 创建 memory/ 目录
```

服务启动时自动调用 `agentManager.ensureDefault()`，确保 `default` Agent 存在。

### 编辑系统提示

```bash
tinyclaw agent edit mywork
# → 打开 $EDITOR 编辑 ~/.tinyclaw/agents/mywork/SYSTEM.md
# → 保存后立即对新会话生效（运行中会话在下次首轮消息时读取）
```

### 绑定会话

将一个消息来源（session source）与 Agent 绑定：

```bash
# 将终端会话绑定到 mywork Agent
tinyclaw chat -s cli:<uuid> bind mywork

# 将 QQ 私聊会话绑定到 mywork Agent
tinyclaw chat -s qqbot:c2c:<openid> bind mywork
```

绑定信息写入 `agent.toml [[bindings]]`。同一 source 只能绑定一个 Agent，绑定新 Agent 时旧绑定自动清除。

### 查看与管理

```bash
tinyclaw agent list          # 列出所有 Agent 及绑定情况
tinyclaw agent show mywork   # 显示详情（系统提示预览、绑定列表）
tinyclaw agent delete mywork # 删除（default 不可删除）
tinyclaw agent repair        # 补全所有 Agent 缺失的目录与模板文件（幂等）
tinyclaw agent repair mywork # 只补全 mywork Agent
```

升级 tinyclaw 后旧 Agent 可能缺少新版才有的目录（`workspace/`、`skills/`）或模板文件（`MEM.md`、`SKILLS.md`），运行 `repair` 可以安全地补全它们而不覆盖已有内容。

### 删除

```bash
tinyclaw agent delete mywork
# → 递归删除 ~/.tinyclaw/agents/mywork/（含 memory/ 和所有历史摘要）
```

### 记忆命名空间隔离

| 会话来源 | 绑定的 Agent | 记忆写入路径 |
|---|---|---|
| `cli:<uuid>`（绑定 mywork） | `mywork` | `agents/mywork/memory/` |
| `qqbot:c2c:xxx`（绑定 default） | `default` | `agents/default/memory/` |
| 未绑定任何 Agent | `default`（fallback） | `agents/default/memory/` |

不同 Agent 的记忆完全隔离，A 的对话历史不会出现在 B 的检索结果中。

---

## 三、Session 生命周期

### 创建

**方式 1 — CLI**

```bash
tinyclaw chat new [--agent <id>]
# → IPC 发送 { type: "new", agentId?: string } 到 daemon
# → daemon 创建 Session(cli:<uuid>, { agentId })
# → 返回 { type: "created", sessionId }
# → 打印新会话 ID
```

**方式 2 — QQBot（自动创建）**

QQBot 收到新 openid 的消息时，自动调用 `getSession(sessionId)`：
1. 查找 `agentManager.resolveAgent("qqbot:c2c:<openid>")` → agentId
2. 创建 `new Session(sessionId, { agentId })`
3. 存入 `sessions` Map

### 运行中

每条消息触发 `runAgent(session, content, opts)`：
1. 若 `session.running == true`：软中断旧 run，等待其结束
2. 初始化 system prompt（仅首轮：BUILTIN + 全局 + Agent SYSTEM.md）
3. QMD 检索该 Agent 的向量记忆，注入 system message
4. ReAct 工具循环（最多 10 轮）
5. JSONL 追加持久化（异步）
6. `maybeCompress()`：超过阈值时触发摘要压缩

### 压缩（summarizeAndCompress）

触发条件：`estimatedTokens / contextWindow > memory.tokenThreshold`（默认 0.8）

```
1. summarizer LLM 生成 ≤400 token 摘要
2. persistSummary(text, agentId)
   → 追加到 agents/<id>/memory/YYYY-MM-DD.md
   → 异步触发 updateMemoryIndex(agentId)（QMD 增量索引）
3. 替换 messages[]：保留 system messages + 摘要，丢弃原始对话
4. 重写 JSONL（只保留 system + 摘要行）
```

### 持久化（崩溃恢复）

每次 `runAgent()` 成功结束后，`appendLastTurnToJsonl()` 追加最后一对对话到：

```
~/.tinyclaw/sessions/<sanitized-sessionId>.jsonl
```

进程重启时，Session 构造函数检测 JSONL 文件并自动恢复 `messages[]`，**不丢失上下文**。

### 销毁

- **正常退出**：JSONL 已持久化，进程退出后 in-memory 状态消失
- **进程重启**：下次收到消息时从 JSONL 自动还原
- **无 TTL**：Session 无自动超期机制，由运营者手动清理 JSONL 文件

---

## 四、IPC 协议对照

| 请求类型 | 参数 | 说明 |
|---|---|---|
| `chat` | `sessionId`, `message` | 向会话发送消息（流式回复） |
| `list` | — | 获取所有内存中的会话快照 |
| `new` | `agentId?` | 创建新终端会话 |

| 响应类型 | 字段 | 说明 |
|---|---|---|
| `chunk` | `delta` | 流式文本片段 |
| `done` | — | 本次回复结束 |
| `error` | `message` | 错误信息 |
| `sessions` | `sessions[]` | 会话列表（响应 `list`） |
| `created` | `sessionId` | 新会话 ID（响应 `new`） |

---

## 五、QQBot 生命周期

### 启动

1. OAuth2 获取 token → WebSocket 建立连接
2. IDENTIFY 握手，声明 Intent（三档降级：全量 → 群消息 → AT 消息）
3. 建立心跳循环（daemon 保活）

### 消息到达

```
DISPATCH 事件 → InboundMessage
  ↓ handleMessage(msg)
  ↓ sessionId = "qqbot:<type>:<peerId>"
  ↓ getSession(sessionId)  ← resolveAgent 查表，首次则创建
  ↓ 检测 pendingApproval（MFA 等待）
  ↓ 软中断检测 session.running
  ↓ fire-and-forget runAgent()
  ↓ 完成后 connector.send(回复) 推送到 QQ
```

### 并发控制

- 每用户串行队列（深度 20），超限直接丢弃
- 最多 10 个用户并发处理
- 同一 Session 新消息到达时软中断旧 run（abort LLM + 等待工具完成）

### 断线重连

指数退避：1s → 2s → 4s → ... → 60s（上限），最多 100 次重试。  
断线期间有序号连续时走 RESUME，否则重新 IDENTIFY。

### 停止

`connector.stop()` → abort WebSocket → 所有 Session JSONL 已持久化在磁盘。

---

## 七、子 Agent 绑定（Session Bind）

`code_assist` 等工具会创建子 Agent Session，并通过 **bind** 机制维护父子关系。

### 绑定字段（`session.ts`）

| 字段 | 类型 | 说明 |
|---|---|---|
| `parentId` | `string \| null` | 父 Session ID（Master 或上级 daily Agent）|
| `childIds` | `string[]` | 子 Session ID 列表 |
| `mfaPreApproved` | `boolean` | 是否已通过一次性 MFA 预授权（跳过后续 MFA 弹窗）|
| `pendingSlaveQuestion` | `{ question, resolve } \| null` | daily 子 Agent 调用 `ask_master` 时的挂起问题 |

### 绑定方法

```typescript
// 在子 Session 上调用，同时更新父 Session 的 childIds[]
childSession.bindParent(masterSession);

// 子 Agent 完成时清理父 Session 的 childIds[]
masterSession.removeChild(childSession.sessionId);
```

### ask_master 阻塞流程

```
daily 子 Agent 调用 ask_master(question, context, planPath?)
  └→ 将问题 + plan.md 渲染为图片发给用户
  └→ 在 masterSession.pendingSlaveQuestion 设置 { question, resolve }
  └→ 阻塞等待（async Promise）

用户回复消息
  └→ main.ts handleMessage() 检测 session.pendingSlaveQuestion
  └→ session.pendingSlaveQuestion = null
  └→ resolve(userMessage)  ← 解除 daily 子 Agent 阻塞
  └→ 发送"已收到，已转发给 AI 继续处理..."
  └→ return（不触发 runAgent）

daily 子 Agent 继续运行（获得用户回复作为工具返回值）
```

### 层级关系示意

```
masterSession（chat，slaveDepth=0）
  └─ dailySession（daily LLM，slaveDepth=1，mfaPreApproved=true）
       └─ codeSession（code LLM，slaveDepth=2，mfaPreApproved=true）
```

- `slaveDepth=2` 的 code Session 不允许再 fork（`agent_fork` 返回错误）
- `slaveDepth=2` 的 code Session 不持有 `ask_master` 工具（只注入给 daily）

---

## 八、常用操作速查

```bash
# Agent 管理
tinyclaw agent new work          # 创建名为 work 的 Agent
tinyclaw agent edit work         # 编辑 work 的系统提示
tinyclaw agent list              # 列出所有 Agent
tinyclaw agent show work         # 查看 work 的详情
tinyclaw agent delete work       # 删除 work（含其记忆）

# 会话操作
tinyclaw chat new                        # 新建终端会话（默认 Agent）
tinyclaw chat new --agent work           # 新建绑定到 work 的会话
tinyclaw chat list                       # 查看所有会话（只读）
tinyclaw chat -s cli:<uuid> 你好         # 发送消息
tinyclaw chat -s cli:<uuid> bind work    # 将会话绑定到 work Agent

# 查看记忆文件
ls ~/.tinyclaw/agents/default/memory/    # 默认 Agent 的压缩摘要
ls ~/.tinyclaw/agents/work/memory/       # work Agent 的压缩摘要
ls ~/.tinyclaw/sessions/                 # 原始对话 JSONL
```
