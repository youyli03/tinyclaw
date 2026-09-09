# AGENTS.md

> 面向 AI 编码代理（Claude Code / Cursor / Copilot / Codex / 其他）的项目规则。
> **动手改任何文件之前，先读完本文件。**
>
> 人类贡献者同样适用；与 README 冲突时，**以本文件为准**（README 有已知滞后，见 §7）。
>
> **若仓库根存在 `AGENTS.local.md`，必须先读它**——机器/环境私有的约束（SSH 主机与用户名、部署路径、本地端口等）都在那里，不进 git。模板见 `AGENTS.local.example.md`，规则见 §11。

---

## 0. 五条硬规则（违反即视为任务未完成）

| # | 规则 | 判定标准 |
|---|------|----------|
| **R1** | **改代码必须同步改文档** | 同一次变更内完成，禁止"代码先上、文档稍后补"。映射见 §4 |
| **R2** | **临时文件一律放 `tmp/`** | 仓库内任何新增临时产物必须落在 `<repo>/tmp/`，见 §5 |
| **R3** | **禁止写入密钥与运行时数据** | `config.toml` / `secrets.toml` / `mcp.toml` / `~/.tinyclaw/**` 永不进仓库 |
| **R4** | **禁止留死代码与失效文档** | 新增前先 grep 是否已存在；删功能时一并删文档与引用 |
| **R5** | **提交前必须取得用户同意** | 禁止未经明确同意执行 `git commit`；格式遵循 Conventional Commits，见 §10 |

> 交付前必须自检 R1–R5 并逐条说明（见 §8）。

---

## 1. 项目速览

tinyclaw 是一个模块化 AI Agent 平台：ReAct 主循环 + 多 LLM 后端 + 向量记忆 + MFA 高危鉴权 + QQBot connector + Cron/Loop 自主执行 + Web Dashboard。

### ⚠️ 最容易搞错的三件事

1. **运行时是 Node + tsx，不是 Bun。** `package.json` 的 `start` 是 `node --import tsx/esm src/main.ts`；`bin/tinyclaw.ts` 的 shebang 也是 node。README 里写的 `bun install` / `bun link` 已过时。
2. **配置的唯一真相是 `src/config/schema.ts`（Zod）。** `config.example.toml` 目前与 schema 不兼容（见 §7.3），改 schema 时必须同步修模板。
3. **数据与代码分离。** 仓库只含代码；所有运行时状态在 `~/.tinyclaw/`。

### 关键事实

| 项 | 值 |
|---|---|
| 语言 / 模块 | TypeScript + ESM（`"type": "module"`） |
| TS 严格度 | `strict` + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` |
| 入口 | `src/main.ts`（服务）、`src/cli/index.ts`（CLI）、`bin/tinyclaw.ts`（全局命令） |
| 进程守护 | `src/main-supervisor.ts`（崩溃退避重启） |
| 代码量 | `src/` 约 129 个 TS 文件 |
| 测试 | 仅 `tests/edit-file-core.test.ts`（测试覆盖极低，新增逻辑请补测试） |

---

## 2. 常用命令

```bash
npm run typecheck        # tsc --noEmit（必过）
npm run lint             # eslint src/（必过）
npm run lint:fix
npm run format           # prettier --write 'src/**/*.ts'
npm run start            # 前台启动服务
npm run cli -- status    # 走 CLI
node --import tsx/esm tests/edit-file-core.test.ts   # 现有唯一测试

# 不要用 bun 命令（README 里的 bun 说明已过时）
```

---

## 3. 目录与职责地图

| 路径 | 职责 |
|---|---|
| `src/main.ts` | 服务入口：配置 → LLM 注册表 → MCP → QQBot → IPC → Cron/Loop → 消息总线 |
| `src/main-supervisor.ts` | 进程守护、崩溃回滚 |
| `src/core/agent.ts` | **ReAct 主循环**（prepare → preamble → 循环 → finalize）、MFA 检查、文本模式、auto-fork |
| `src/core/session.ts` | `messages[]` + JSONL 持久化 + 压缩触发 + 并发控制 |
| `src/core/inbound-bus.ts` | 用户回复统一路由（MFA / Plan 审批 / ask_user 的 Waiter 队列） |
| `src/core/slave-manager.ts` | `agent_fork` 子 Agent 生命周期 |
| `src/core/loop-runner.ts` · `loop-trigger.ts` | 两套 Loop 执行引擎（TASK.md / JSON 配置） |
| `src/core/project-router.ts` · `project-memory.ts` | Code 模式项目绑定、锁、项目记忆 |
| `src/llm/` | `client.ts`(流式+重试+idle)、`registry.ts`(多后端)、`copilot*.ts`、`responses-ws.ts` |
| `src/memory/` | `qmd.ts`(向量库)、`summarizer.ts`(压缩/蒸馏，2056 行)、`cards.ts`、`entry-scorer.ts` |
| `src/tools/` | 工具实现 + `registry.ts`(注册表)。**新增工具必须走 `registerTool()`** |
| `src/auth/` | `guard.ts`(MFA 判定)、`mfa.ts`(MSAL)、`totp.ts`、`prompt-integrity.ts`(金丝雀) |
| `src/security/injection-detector.ts` | 工具结果提示注入检测 |
| `src/connectors/` | `base.ts`(接口) + `qqbot/`(gateway/api/outbound/transcribe) + `utils/`(渲染) |
| `src/cron/` | `scheduler.ts`(含独立 worker 进程) · `runner.ts`(单步/Pipeline) · `schema.ts` |
| `src/skills/` | Skill 注册表 + 热重载 watcher |
| `src/code/` | `/code` 模式：命令、系统提示组装、`exit_plan_mode` |
| `src/commands/` | 斜杠命令注册表 + 内置命令 |
| `src/ipc/` | Unix socket 协议（`protocol.ts` 是请求/响应类型的唯一真相） |
| `src/mcp/client.ts` | MCP 懒加载管理器 |
| `src/config/` | `schema.ts`(唯一真相) · `loader.ts` · `writer.ts`(保留注释的 TOML 补丁) |
| `src/web/backend/` | Dashboard HTTP 服务 + SQLite + 采样 |
| `src/utils/` | logger / redact / file-perm / tls |
| `mcp-servers/` | 独立 MCP server（browser / news / notes / polymarket / sts2） |
| `docs/` | 项目文档（**R1 要求同步维护**） |
| `AGENTS.local.md` | **私有约束，不进 git**（gitignored）；模板 `AGENTS.local.example.md`，见 §11 |
| `tmp/` | **唯一允许的临时目录**（gitignored） |

---

## 4. 文档同步矩阵（R1 硬约束）

改了左边，**必须**同步更新右边。缺一即视为任务未完成。

| 改动内容 | 必须同步的文档 |
|---|---|
| `src/config/schema.ts` 任何字段增删改 | `config.example.toml` + `docs/architecture/overview.md` 配置节 + `README.md` 配置节 |
| 新增/删除/重命名工具（`registerTool`） | `README.md` 工具表 + `docs/architecture/overview.md` 工具清单 |
| 新增斜杠命令 | `README.md` CLI/命令表 + `docs/architecture/overview.md` + `src/cli/index.ts` 的 `COMMANDS` |
| `src/ipc/protocol.ts` 请求/响应类型 | `docs/architecture/overview.md` 的「IPC 协议对照」表 |
| Cron 行为（schema/runner/scheduler） | `docs/commands/cron-pipeline.md` |
| Loop（runner / trigger） | `docs/commands/loop-session.md` / `docs/commands/loop-trigger.md` |
| Code 模式（命令 / prompt / 子模式） | `docs/commands/code-mode.md` |
| 记忆 / 压缩 / 蒸馏 | `docs/memory/qmd-embed.md` / `docs/memory/distill-pipeline.md` |
| 重试 / 超时 / 流式稳定性 | `docs/architecture/retry.md` |
| Agent 循环步骤 / 消息链 / 压缩触发 | `docs/architecture/agent-loop.md` |
| QQBot / MCP server | `README.md` + 对应 `docs/mcp/*.md` |
| CLI 命令与补全 | `docs/architecture/overview.md` 的「CLI 配置工具」节 |
| 运行时目录结构变化 | `README.md`「运行时目录」+ `docs/architecture/overview.md`「目录结构」 |

### 文档写作要求

- **文档必须描述代码事实**，不要写"设计意图"当作"已实现"。凡未落地的能力，明确标注 `（未实现）`。
- 数字（默认值、阈值、上限、超时）必须与 `schema.ts` 一致；不要手写记忆值。
- 改行为时同步删除文档里的旧描述，**不要保留"以前是 X，现在是 Y"的历史叙述**。

---

## 5. 临时文件规范（R2）

### 唯一位置

```
<repo>/tmp/          ← 仓库内所有临时产物的唯一落点（已在 .gitignore:44）
```

### 规则

1. **禁止**把临时文件写到仓库根目录、`src/`、`docs/`、`scripts/`、`mcp-servers/`。
2. **禁止**写到 `$HOME` 根目录、`/etc`、`/usr`、`/tmp` 之外的系统路径，或任何敏感配置文件（`.gitconfig` / `.bashrc` / `.ssh/*`）。
3. `tmp/` 不存在时自行创建：`mkdir -p tmp`。
4. **命名**：`tmp/<用途>-<时间戳或短哈希>.<ext>`，例如 `tmp/probe-agentloop-20260809.json`。不要用 `test.txt` / `a.js` / `新建文件.md`。
5. **清理责任**：任务结束时删除本次产生的临时文件；确需保留供用户查看的，在交付说明里写明路径与原因。
6. **不要提交**：`tmp/` 已被 gitignore，禁止用 `git add -f` 绕过。

### 与运行时目录的区别（别混淆）

| 场景 | 路径 |
|---|---|
| **开发/调试时**（AI 或人操作仓库） | `<repo>/tmp/` |
| **tinyclaw 运行时**（Agent 调 `write_file`） | `~/.tinyclaw/agents/<agentId>/workspace/tmp/`（临时）/ `.../workspace/output/`（交付产物） |

后者的约束写在 `src/core/agent.ts` 的内置 system prompt 里（`agent.ts:250-268`），改运行时行为请改那里，不要改本文件。

---

## 6. 编码规范

### 模块与导入

- 全程 ESM，**import 路径必须带 `.js` 后缀**（即使源文件是 `.ts`），例如 `import { loadConfig } from "./config/loader.js"`。
- 避免循环依赖：`tools/*` 不得 import `core/agent.ts`，需要的函数通过 `ToolContext` 注入（参考 `slaveRunFn`）。
- 工具模块靠**副作用 import** 注册（`agent.ts:37-56`、`main.ts:46-50`）。新增工具文件后，**必须**在其中一处加 import，否则运行期工具不存在。

### 类型

- 禁止 `any`。确实无法推断时用 `unknown` + 类型守卫。
- `noUncheckedIndexedAccess` 已开：数组/对象索引访问结果可能是 `undefined`，用 `!` 前先确认该处不变量成立。
- `exactOptionalPropertyTypes` 已开：可选属性要按条件展开（`...(x ? { k: x } : {})`），不要赋 `undefined`。

### 配置

- `src/config/schema.ts` 是唯一真相。新增配置项 → 加 Zod 字段 + 默认值 + `config.example.toml` 注释 + 文档。
- `src/config/writer.ts` 做的是**行级补丁**，只替换命中键的那一行；多行数组/多行字符串会被破坏。改动它时务必补测试。
- 密钥读取只允许来自 `~/.tinyclaw/config.toml` / `secrets.toml`，永不硬编码，永不打日志（用 `utils/redact.ts`）。

### 工具

- 注册格式：`registerTool({ spec, requiresMFA, execute, hidden? })`。
- **`spec.function.description` 必须与实现一致**。已知反例：`exec_shell` 描述写"需要 MFA 确认"，实际 `requiresMFA: false`（`system.ts:151-158`）——修实现或修描述，不要留着。
- 所有工具结果统一经 `sanitizeToolResult()` 收口（`registry.ts:219`），不要在工具内部自己截断后再拼超长内容。
- 涉及文件写入的工具**必须**调用 `checkWritePath()`（`tools/path-guard.ts`）；涉及读取的目前**没有**该检查（见 §7.1），新增读类工具请自行加校验。

### 错误处理

- 禁止空 `catch {}` 吞掉异常；至少 `console.warn` 带模块前缀。
- 用户可见错误用中文，格式 `错误：<原因>`；工具被拒绝用 `已拒绝：<原因>`。
- 日志用 `createLogger(module)`（`utils/logger.ts`），不要裸 `console.log` 打敏感内容。

### 命令与文档

- 新增 CLI 子命令：在 `src/cli/index.ts` 的 `COMMANDS` 加一行，子命令表由各模块 `export const subcommands` 自动汇聚（不需要手改 `SUBCOMMANDS`）。
- 新增斜杠命令：`src/commands/registry.ts` 的 `registerCommand`，并在 `builtin.ts` 或 `src/code/index.ts` 里注册。

---

## 7. 已知陷阱（动手前必看）

这些是审查中确认的**现存问题**。修改相邻代码时顺手修掉是加分项，但**不要**在文档里把未修的问题描述成已修。

> **修好其中任一项后，必须同步删除本表中对应行**（否则本文件自身就变成了 §7.3 所警告的漂移源）。

### 7.1 安全模型是"写严读松"

- **MFA 只在一条路径上生效**：检查点在 `agent.ts:1906-1955`。`cron/runner.ts:221`（Pipeline tool step）与 `loop-trigger.ts:377`（Loop steps）直接 `executeTool()`，**完全绕过 MFA**；且 `cron_add` 默认写死 `mfaExempt: true`（`tools/cron.ts:206`）。新增任何"绕过 ReAct 循环直接调工具"的入口，必须自行补鉴权。
- **MFA fail-open**：`agent.ts:1928-1937`，无交互回调时 `mfaPassed = true`。新增鉴权分支请 fail-closed。
- **读路径无边界**：`read_file`（`system.ts:409-413`）与 `read_image`（`system.ts:510-512`）只 `path.resolve` 后直接读，无白名单 → 可读 `~/.ssh/id_rsa`、`secrets.toml`。
- **`path-guard` 不解析符号链接**（`path-guard.ts:118-193` 无 `realpathSync`），workspace 内软链可逃逸。
- **`redactKnownSecrets` 全仓无调用点**（`utils/redact.ts:65-75`），日志脱敏实际未生效。
- **`config show` 泄密**：`config/schema-display.ts:42-43` 只脱敏 copilot/openai 的 key，deepseek/openrouter/mimo/google 明文；qqbot 脱敏路径写的是旧的 `channels.qqbot.*`。

### 7.2 别以为这些代码在跑

| 死代码 / 失效项 | 位置 |
|---|---|
| MicroCompact 调用点整段被注释 | `agent.ts:1116-1135` |
| `render_document` 工具：模块从未被 import | `tools/render-document.ts:176` |
| `mfaPreApproved` 全仓无赋值 | `session.ts:122` |
| `Session.bindParent` / `removeChild` 无调用者 | `session.ts:998-1010` |
| `distillCodeTurnToNotes` 无调用者 | `memory/summarizer.ts:1265` |
| `getVisionClient` / `buildAutoModePrompt` / `forceReleaseLock` | `llm/registry.ts:353` / `code/system-prompt.ts:107` / `core/project-router.ts:170` |
| `loop-runner.restartSession` 有 bug 且无调用者 | `core/loop-runner.ts:61-75` |
| `/auto` 已废弃（只返回提示） | `code/commands.ts:180-193` |

### 7.3 文档漂移（改文档时的对照表）

以下**文档当前是错的**，修文档时按右列为准：

| 文档 | 实际 |
|---|---|
| README 的 `bun install` / `bun link` | node + tsx |
| `config.example.toml` 全篇结构（`llm.backends.*.apiKey`、`channels.qqbot`、`tools.code_assist`） | 已与 `schema.ts` 不兼容；`BackendRoleSchema` 无 `apiKey/baseUrl/provider`，`ChannelsSchema` 只有 `qqbots` |
| `overview.md:474` Cron「预留，不实现」 | 已完整实现（含独立 worker 进程） |
| `overview.md:590-603` IPC 4 请求/5 响应 | 实际 16/19（`ipc/protocol.ts:39-140`） |
| `overview.md:480-505` CLI 6 命令 | 实际 18 个 |
| `overview.md:74-79, 282-330` `code_assist` / `ask_master` / `run_code_subagent` 双子 Agent | **这三个文件与工具都不存在** |
| `overview.md:71` `withMFA()` | 不存在 |
| `overview.md:279` MFA 超时 60s | 默认 `timeoutSecs = 0`（永不超时） |
| `overview.md:124` 语音 SILK→WAV | 代码中无 SILK 转换 |
| `agent-loop.md:112` system prompt 只初始化一次 | 每轮重建（`agent.ts:966-1061`） |
| `agent-loop.md:129-131` 记忆 top-5 + minScore=0.3 | 无 minScore 过滤 |
| `agent-loop.md:219-221` `persistSummary` 异步不阻塞 | 被 `await`（`summarizer.ts:1462`） |
| `retry.md:235` copilot 指数退避+jitter | 固定延迟（`copilot.ts:236,603`） |
| `code-mode.md:33,250` `/auto` 为默认子模式 | 已废弃 |
| `cron-pipeline.md:257` pipeline tool step「继承 mfaExempt 豁免」 | 实为无条件绕过 MFA |

### 7.4 其他坑

- **`better-sqlite3` 未在 `package.json` 的 dependencies 声明**（`web/backend/db.ts:28` 用 `createRequire` 加载），干净环境 Dashboard 会崩。
- **`AutoFreeClient.supportsToolCalls` 恒为 `true`**（`openrouter.ts:169-171`）→ OpenRouter 免费模型永远走不到 textMode。
- **`gateway.ts:184` 的 finally 删队列会丢新消息**；`api.ts:74` 的 token singleflight 失败后永久卡死。
- **`qmd.ts:258-280` 维度不一致时直接删整个 `index.sqlite`**（无备份）。
- **`system-prompt.ts:1-3` 文件头注释已被误编辑破坏**，改动该文件时顺手修复。
- **`mcp-servers/` 与 `scripts/` 不在 `tsconfig` 的 `include` 范围内**（只含 `src/**/*`），改动它们后 typecheck 不会覆盖。

---

## 8. 完成定义（Definition of Done）

交付前逐条自检并在回复中说明：

1. [ ] `npm run typecheck` 通过
2. [ ] `npm run lint` 通过
3. [ ] **R1**：受影响的文档已更新（对照 §4 矩阵，列出改了哪些 `.md` / `.toml`）
4. [ ] **R2**：临时文件都在 `tmp/`，本次产生的已清理（列出保留项及原因）
5. [ ] **R3**：没有把密钥、`~/.tinyclaw/**`、运行时数据写进仓库
6. [ ] **R4**：没有留下新的死代码；删除功能时同步删了引用与文档
7. [ ] 新增/修改的工具 `spec.function.description` 与实现一致
8. [ ] **R5**：如需提交，message 已按 §10.1 规范书写，且已取得用户明确同意（列出待提交文件清单与拟用 message）
9. [ ] 报告变更文件清单（用可点击的相对路径）

---

## 9. 禁止事项

- ❌ 用 `bun` 命令（已迁到 node + tsx）
- ❌ 在仓库根/`src/`/`docs/` 下留临时文件
- ❌ 只改代码不改文档，或只改文档不改代码
- ❌ 在文档里描述未实现的能力
- ❌ 用 `any`、空 `catch {}`、`git add -f` 绕过 gitignore
- ❌ 直接把 `config.toml` / `secrets.toml` 的内容写进任何仓库文件或日志
- ❌ 绕过 `registerTool()` 私自导出工具，或新增工具后忘记加副作用 import
- ❌ 在未确认的情况下修改 `docs/architecture/overview.md` 之外的"设计意图"段落来掩盖代码缺陷——**修代码，或如实标注未实现**
- ❌ 未经用户明确同意执行 `git commit` / `git commit --amend` / `git push` / `git reset --hard`（见 §10.2）
- ❌ 用无 type 前缀的裸标题提交（如 `修复：xxx`、`update`、`fix bug`）（见 §10.1）
- ❌ `git add -f AGENTS.local.md`，或把它的内容复制进任何进 git 的文件 / 日志 / 提交信息（见 §11）

---

## 10. Git 提交规范

### 10.1 提交信息格式：Conventional Commits（强制）

```
<type>(<scope>): <subject>

<body>
```

| 部分 | 规则 |
|---|---|
| `type` | 必填，取值见下表 |
| `scope` | 可选，用模块名，与 `src/` 目录对应（`llm` / `cron` / `qqbot` / `memory/qmd` / `code-prompt` …） |
| `subject` | 必填，单行，不加句号；动宾式说明"做了什么"；**中英文均可**（仓库历史混用） |
| `body` | 可选；涉及多文件或行为变更时必写，逐条列出关键改动 |

**允许的 type**（与仓库历史一致）：

| type | 用途 |
|---|---|
| `feat` | 新功能 |
| `fix` | 修缺陷 |
| `docs` | 仅文档 |
| `refactor` | 重构（不改变外部行为） |
| `perf` | 性能优化 |
| `test` | 测试 |
| `chore` | 构建 / 配置 / 杂务 |
| `style` | 格式（不影响语义） |
| `revert` | 回滚某次提交 |

**真实示例**（取自本仓库历史）：

```
feat(llm): 补强 LLM 连接稳定性 — 重试、jitter、流 idle timeout、429 Retry-After
fix(cron): pipeline tool step 改用合成 tool call 对注入 session，修复幻觉问题
docs: 新增 LOOP_SESSION.md，更新过时文档
refactor(mcp): agent-centric MCP access control via per-agent mcp.toml
```

**禁止**：`修复：xxx` 这类无 type 前缀的裸中文标题；`update` / `修改` / `fix bug` 这类无信息量标题；一次提交混杂多个不相关改动（拆成多次提交）。

### 10.2 每次提交前必须取得用户同意（R5，强制）

**未经用户明确同意，禁止执行任何 `git commit`。**

标准流程：

1. `git add -A` 暂存
2. `git diff --cached --name-only` 自检：确认无 `*.tgz` / `*.log` / `workspace/` / `tmp/` / `config.toml` / `secrets.toml` / `*.key`；发现则 `git restore --staged <file>`
3. **向用户展示**：待提交文件清单 + 拟用的完整 commit message
4. 等待用户明确回复（"提交" / "可以" / "go" 等）。**不得把沉默、无关回复或默认行为当作同意**
5. 获准后才执行 `git commit`；用户要求改 message 则修改后重新请求确认

**同样需要用户同意的操作**：`git commit --amend`、`git push`、`git push --force`、`git rebase`、`git reset --hard`、`git tag`。

**用户拒绝后**：不要反复追问、不要换措辞再问，等用户主动指示。

### 10.3 例外

`src/core/tinyclaw-submitter.ts` 是**独立的定时备份调度器**（每 4h 自动提交 `~/.tinyclaw` 配置仓库，设计上无人值守），不属于"agent 提交行为"，不适用 §10.2。如需对其也加审批，须单独改该模块。

---

## 11. 私有约束：`AGENTS.local.md`

机器/环境相关、**不应进 git** 的约束集中放这里，避免污染本文件。

### 三个文件的分工

| 文件 | 进 git | 用途 |
|---|---|---|
| `AGENTS.md`（本文件） | ✅ | 通用规则，所有环境一致 |
| `AGENTS.local.md` | ❌ **不进**（`.gitignore` 已忽略） | 本机 / 本环境的私有约束 |
| `AGENTS.local.example.md` | ✅ | 格式模板，含示例字段 |

- **不存在 `AGENTS.local.md` 时**：跳过，不影响任何规则。
- **存在则必读**：开始任何任务前先读它。
- **优先级**：`AGENTS.local.md` 的约束**优先于**本文件的通用规则（更具体）；
  但与 **§0 五条硬规则**冲突时，**以 §0 为准**（私有文件不能放宽 R1–R5）。

### 适合写在这里的内容

- **SSH**：主机别名 / IP / 端口 / 用户名 / 私钥路径（例：`ssh -i ~/.ssh/id_ed25519_deploy USER@HOST`）
- **部署与运行**：远端目录、服务名、容器名、日志路径
- **本地环境**：端口、代理、镜像源、内网地址、解释器路径
- **机器差异**：本机 `python3` 实为 `python3.11`、某依赖未安装等
- **个人偏好**：默认分支、提交署名、通知方式

### 不要写在这里的内容

- **明文密钥 / token / 密码**——它只是"不进 git"，不是保险箱。密钥仍放
  `~/.tinyclaw/config.toml` 与 `~/.tinyclaw/secrets.toml`；本文件只写**引用方式**
  （例：`SSH key 见 ~/.ssh/id_ed25519_deploy`、`token 见 secrets.toml 的 $FOO_TOKEN`）。
- 可复用的项目规则——那是本文件的职责（按 R1 同步维护）。

### 硬性禁止

- ❌ `git add -f AGENTS.local.md`
- ❌ 把它的内容复制进任何进 git 的文件、日志或提交信息
- ❌ 在其中写明文密码

### 用法

```bash
cp AGENTS.local.example.md AGENTS.local.md   # 然后按本机情况填写
git status --porcelain                        # 应看不到 AGENTS.local.md
```
