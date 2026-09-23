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
| `src/main-supervisor.ts` | 进程守护：崩溃退避重启 + **配置 quick-fail 自动回退**（LKG 覆盖）+ 代码 git 回退 |
| `src/config/` | `schema.ts`(唯一真相) · `loader.ts` · `writer.ts`(写前校验的 TOML 补丁) · `validate.ts`(写前校验) · `settable-paths.ts`(`config_set` 字段白名单) · `agent-env.ts`(agent 环境变量) · `safe-write.ts`(备份/原子写/留证) · `state.ts`(LKG/pending/回退) · `reload-plan.ts`/`reload.ts`/`watcher.ts`(分级热重载) · `safe-mode.ts`(最小配置启动) |
| `src/health/` | `config-health.ts`(离线自检，CLI 可复用) · `llm-probe.ts`(在线探测 + 错误分流) |
| `src/core/job-manager.ts` | **后台 Job**：进程组 spawn / 增量日志 / detach / 超时 / 并发上限 / 重启标记 |
| `src/core/agent.ts` | **ReAct 主循环**（prepare → preamble → 循环 → finalize）、MFA 检查、文本模式、auto-fork |
| `src/core/session.ts` | `messages[]` + JSONL 持久化 + 压缩触发 + 并发控制 + **统一 run 队列**（`runExclusive()` / `waitIdle()`） |
| `src/core/inbound-bus.ts` | 用户回复统一路由（MFA / Plan 审批 / ask_user 的 Waiter 队列） |
| `src/core/slave-manager.ts` · `slave-trajectory.ts` | `agent_fork` 子 Agent 生命周期（按轮结构化继承 / 进度 / 等待 / 中断）与轨迹全文归档 |
| `src/core/loop-runner.ts` · `loop-trigger.ts` | 两套 Loop 执行引擎（TASK.md / JSON 配置） |
| `src/core/project-router.ts` · `project-memory.ts` | Code 模式项目绑定、锁、项目记忆 |
| `src/llm/` | `client.ts`(流式+重试+idle)、`registry.ts`(多后端)、`copilot*.ts`、`responses-ws.ts` |
| `src/memory/` | `qmd.ts`(向量库)、`summarizer.ts`(压缩/蒸馏，2056 行)、`cards.ts`、`entry-scorer.ts` |
| `src/tools/` | 工具实现 + `registry.ts`(注册表)。**新增工具必须走 `registerTool()`**；`agent-binding.ts` 管"自我管理工具默认只给 default agent" |
| `src/auth/` | `guard.ts`(MFA 判定)、`mfa.ts`(MSAL)、`totp.ts`、`prompt-integrity.ts`(金丝雀) |
| `src/security/injection-detector.ts` | 工具结果提示注入检测 |
| `src/connectors/` | `base.ts`(接口) + `qqbot/`(gateway/api/outbound/transcribe) + `utils/`(渲染) |
| `src/cron/` | `scheduler.ts`(含独立 worker 进程) · `runner.ts`(单步/Pipeline) · `schema.ts` |
| `src/skills/` | Skill 注册表 + 热重载 watcher |
| `src/code/` | `/code` 模式：命令、系统提示组装、`exit_plan_mode` |
| `src/commands/` | 斜杠命令注册表 + 内置命令 |
| `src/ipc/` | Unix socket 协议（`protocol.ts` 是请求/响应类型的唯一真相） |
| `src/mcp/client.ts` | MCP 懒加载管理器 |
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
| 工作区指令装载（`src/instructions/`） | `docs/commands/code-mode.md` 的「工作区指令注入」节 |
| Web Dashboard（`src/web/backend/**`、`src/web/frontend/**`） | `docs/architecture/overview.md` 的「Dashboard(Web UI)」节 |
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
  所有 `config.toml` 写入都必须经 `writeConfigText()` / `patchTomlField()`：**写前校验**（`src/config/validate.ts`
  的语法 / schema / 交叉引用）→ 不过则拒写并留证 `config.toml.rejected-<ts>` → 通过则 `.bak-<ts>` 备份 +
  `.tmp`/rename 原子写 + 0600。备份/原子写/留证的共用实现在 `src/config/safe-write.ts`（`mcp.toml` 同用）。
- 密钥读取只允许来自 `~/.tinyclaw/config.toml` / `secrets.toml`，永不硬编码，永不打日志（用 `utils/redact.ts`）。
- **热重载分级**（`src/config/reload-plan.ts` + `reload.ts`）：`hot`（用时现读的段，换缓存）/ `soft`
  （`llm.backends` / `concurrency` / `memory.embedModel|enabled`，需重新 init 子系统）/ `restart`
  （`channels` / `voice` / `web.port` / `sandbox.enabled|execShell`，进程级资源或一次调用内多处读取）。
  **证明不了"改动会立刻被读取点看到"就归 `restart`** —— 宁可不热，不假热。入口：agent 工具 `config_reload`、
  CLI `tinyclaw config reload`、`config.toml` 监听（`ContentWatcher`，连续 3 次失败自动停用）。
- **`loadConfig()` 默认缓存**：新增"用时现读"的配置读取点没问题；如果在**启动时取一次存字段**，
  必须同时把它归入 `reload-plan.ts` 的 `soft`/`restart`，否则热重载对它无效。

### 工具

- 注册格式：`registerTool({ spec, requiresMFA, execute, hidden? })`。
- **`spec.function.description` 必须与实现一致**。已知反例：`exec_shell` 描述写"需要 MFA 确认"，实际 `requiresMFA: false`（`system.ts:151-158`）——修实现或修描述，不要留着。
- 所有工具结果统一经 `sanitizeToolResult()` 收口（`registry.ts:219`），不要在工具内部自己截断后再拼超长内容。
- 涉及文件写入的工具**必须**调用 `checkWritePath()`（`tools/path-guard.ts`）；涉及读取的**必须**调用 `checkReadPath()`（它只拦密钥与 `.ssh`/`.git`，**没有**工作区白名单，见 §7.1），新增读类工具请自行加校验。
- **"自我管理"工具的按 agent 绑定**（`tools/agent-binding.ts`）：**会改运行配置的**工具默认只给 `default` agent ——
  `config_set`/`config_reload`/`config_validate` 与写 `mcp.toml` 的 `mcp_server_add`/`mcp_server_remove`/
  `mcp_server_set_enabled`/`mcp_reload`（纯开关类的 `mcp_list_servers`/`mcp_enable_server`/`mcp_disable_server` 不绑）。
  新增同类"改自己运行配置"的工具时：① 加进 `DEFAULT_AGENT_ONLY_TOOLS`；② 在 `execute` 里调
  `guardSelfManagement(name, ctx?.agentId)`（**执行层必须自己兜住** —— cron/loop 的声明式步骤按名字直接
  `executeTool`，绕过可见性过滤）；③ 加进 `auth/tool-policy.ts` 的 `HARD_DENY_REACT_UNATTENDED`。
  授权方式：`[tools.selfManagement] agents = [...]`（`["*"]` = 全部，`[]` = 谁都不给）。
- **`config_set` 只能改白名单字段**（`config/settable-paths.ts`）：模型/单后端参数、模型别名、轮次与截断上限、
  重试节奏、交互提醒。**管着 agent 的规则一律拒**（auth/sandbox/selfAccess/health/channels/web/providers/
  memory/submitter/agent/tools.http_request/llm.premiumAllowlist）—— 放行等于让模型拆自己的护栏。
- **条件 MFA**（`ToolDef.requiresMFAFor`）：同一工具"危险参数才审批"用它（参考 `env_set`：密钥类键名才要审批），
  不要为这种情况拆成两个工具；判定与静态 `requiresMFA` 取或（`agent.ts` 的 MFA 块）。
  参数里带**明文密钥**时同时给 `ToolDef.redactArgs`（参考 `env_set`：`value` 换成 `***`）—— MFA 提示会发给用户、
  审计会落盘，两处都只允许看到键名。
- **后台 Job**（`core/job-manager.ts` + `tools/jobs.ts`）：Job 跑**进程**，Sub-Agent 跑**LLM**，两者别混。
  新增 job 相关入口时保持三条不变式：① 日志/meta 只落 **env 键名**不落值；② 值只通过 spawn 的 env 传递、
  **绝不拼命令行**（`ps -ef` 不可见）；③ `job_start` 类工具加入 `HARD_DENY_REACT_UNATTENDED`。
- **agent 环境变量**（`config/agent-env.ts` + `tools/env-admin.ts`）：文件 `~/.tinyclaw/agents/<id>/env`（0600，
  沙箱掩码）；分层 `process.env` < agent env < 单次覆盖；**没有** `env_get`，值永不回给模型。

### 错误处理

- 禁止空 `catch {}` 吞掉异常；至少 `console.warn` 带模块前缀。
- 用户可见错误用中文，格式 `错误：<原因>`；工具被拒绝用 `已拒绝：<原因>`。
- 日志用 `createLogger(module)`（`utils/logger.ts`），不要裸 `console.log` 打敏感内容。

### 命令与文档

- 新增 CLI 子命令：在 `src/cli/index.ts` 的 `COMMANDS` 加一行，子命令表由各模块 `export const subcommands` 自动汇聚（不需要手改 `SUBCOMMANDS`）。
- 新增斜杠命令：`src/commands/registry.ts` 的 `registerCommand`，并在 `builtin.ts` 或 `src/code/index.ts` 里注册。

### 语言约定（prompt / 工具描述 / 回复）

**给模型的文本优先英文，给用户的文本跟随用户语言。** 判据是"这段字符串的读者是谁"：

| 内容 | 语言 | 理由 |
|---|---|---|
| 内置 system prompt 与所有注入段（自指、沙箱、`__purpose`、反馈等） | **英文优先** | 指令性文本；英文 token 更省、与工具 schema 同语言，模型遵循更稳 |
| 工具 `spec.function.description`、参数 `description` | **英文优先** | schema 层本就与 OpenAI 约定同语言 |
| 工具**返回给模型**的结果、拒绝原因（`已拒绝：…`、`错误：…`） | **中文**（现状，保持不变） | 模型会**原样转述**给用户，见"错误处理"节 |
| Agent 回复用户 | **跟随用户语言** | 中文用户→中文；英文用户→英文；不因 prompt 是英文而改用英文回复 |
| 代码注释、`docs/`、本文件 | 中文（现状） | 面向维护者 |
| commit message | 英文（§10.1） | 已有规则 |

约束与禁忌：

- ❌ 不要把**面向用户的**错误/提示文案改成英文 —— 用户会直接看到英文报错。用户可见字符串继续用中文（`错误：<原因>` / `已拒绝：<原因>`）。
- ❌ 不要为了"统一语言"去翻译 `docs/`、注释或历史日志。
- ✅ 新增 prompt 段落 / 新工具时按本规则直接用英文；改动既有中文段落时**顺手翻成英文**（渐进迁移，不需要一次性全量）。
- ✅ 英文 prompt 里引用用户可见文案时，保留中文原文（例如提示"工具会返回 `已拒绝：…`"）。

> **现状（已迁移 / 仍保留中文）**——数字由 `tmp/lang-inventory-20260911.ts` 盘点，改完回来更新：
>
> | 面 | 状态 |
> |---|---|
> | `buildBuiltinSystem`（`agent.ts:202`，225 行） | 正文已全英文；剩 15 行中文**全是注释与故意保留的示例**（`__purpose` 中文样板、引用的 `"⚠️ 附件发送失败"`），**不含中文指令** |
> | `buildSelfAccessPrompt` / `buildSandboxPrompt` | 0 行中文 |
> | `src/tools/**` 工具/参数 `description`（232 条） | 剩 **2 条**：`memory.ts` 里 `ask_user` 选项的 `description`（返回给模型的数据） |
> | 5 个 MCP server 的 `description`（155 条） | 剩 **9 条**：`mcp-servers/notes/index.ts` 的 `DEFAULT_CATEGORIES` 分类/字段说明（运行时数据，不是 schema） |
> | code 模式 prompt（`code/system-prompt.ts` / `code/project-prompt.ts`） | 已全英文（仅用户可见样例保留中文原话） |
> | 其它 prompt 语料 | 已英文：`memory/summarizer.ts`（压缩/蒸馏）、`core/memory-maintenance.ts`、`core/slave-manager.ts`、`cron/runner.ts`、`core/loop-trigger.ts`、`skills/registry.ts`、`tools/skill-creator.ts`、`memory/qmd.ts` 的检索标签 |
> | Agent 回复用户 | 已从"写死中文"改为**跟随用户语言**（`agent.ts` 通用规范 + 文字模式 + code 模式三处） |
>
> ⚠️ **这些字面量是数据键/匹配串，永远不要翻译**（翻了会静默失效）：
> `MEM.md` / `ACTIVE.md` 的章节名（`👤 用户偏好`、`🎯 当前任务`、`🐛 踩坑记录` …）、`MEMORY.md` 的
> `⛔ 约束` / `🧠 架构` / `📊 进度` / `🐛 问题` / `📝 决策`、`[对话历史摘要]`、`[编码会话历史摘要]`、
> `[分析]`（`summarizer.ts` 的 `resolveSlug` 比对，已同时兼容 `analysis/general/misc`）、
> `[⚠️BLOCKED:zh_you_are]`（注入检测器依赖）、`[压缩蒸馏]`、`[NOTIFY]`/`[/NOTIFY]`、`[工具结果已截断]`、
> `# 本机环境上下文`、`[用户]:`/`[助手]:`/`[工具结果]:` 等 `formatMsgForSummary` 产出的前缀、
> `[历史图片: …]`、以及 `error: "无新增"` 这类被代码比对的 sentinel。
>
> ✅ **prompt 里凡出现"模型写给用户"的样例文案**，都必须在同句注明 *written in the user's own language*，
> 中文样例只是"中文用户视角的示例"。
>
> ⚠️ 语言由探针锁死：`tmp/probe-sandbox-prompt-20260911.ts` 断言沙箱段/自指段不含任何中文字符、内置 prompt
> 本体无中文指令、源码里已无「用中文回复」；`tmp/probe-self-access-20260911.ts`、`tmp/probe-p25-live-20260911.ts`
> 断言英文关键词 —— 翻回中文会立刻变红。存量盘点用 `tmp/lang-inventory-20260911.ts`，
> 逐行判定「面向用户 / 面向模型」用 `tmp/lang-audit-20260911.ts`，MCP 等 tsconfig 覆盖不到的文件用
> `tmp/check-syntax-20260911.ts` 做语法兜底。

---

## 7. 已知陷阱（动手前必看）

这些是审查中确认的**现存问题**。修改相邻代码时顺手修掉是加分项，但**不要**在文档里把未修的问题描述成已修。

> **修好其中任一项后，必须同步删除本表中对应行**（否则本文件自身就变成了 §7.3 所警告的漂移源）。

### 7.1 安全模型：工具层"写严读松" + 可选的沙箱边界层

- **MFA 只在 ReAct 主循环生效**（`agent.ts:2058` 起的 MFA 块）。`cron/runner.ts`（Pipeline tool step）与
  `loop-trigger.ts`（Loop steps）直接 `executeTool()`，**不经过 MFA** —— 但它们现在**必过无人值守白名单**
  （`auth/tool-policy.ts` 的 `enforceUnattendedTool`，白名单在 `[sandbox.unattended].allowedTools`）。
  新增"绕过 ReAct 循环直接调工具"的入口时，**必须**同样调用 `enforceUnattendedTool` + `auditToolCall`。
  ⚠️ 默认白名单是"只读 + 计算 + 写 workspace + exec_shell + 声明式步骤用的 agent_fork"，**不含**破坏性/特权/出网类；
  生产里如果某个无人值守任务被拒（审计里能看到 `policy` deny），优先把它需要的工具加进 `allowedTools`，
  而不是把 `mode` 改成 `all`。
  ⚠️ **无人值守分两个通道，规则不同**（`auth/tool-policy.ts` 的 `ToolChannel`）：
  - `channel: "steps"` = job / loop 配置里**声明式写死**的 tool 步骤（用户显式设计，可审计）→ 按白名单放行，**`agent_fork` 允许**
    （`~/.tinyclaw/cron/jobs/` 里 `2quff5jh`、`hs5xjebl` 两个股市日报就是这样按市场 fan-out 的）
  - `channel: "react"` = ReAct 循环里**模型临场挑选**的工具 → 命中 `HARD_DENY_REACT_UNATTENDED` 的一律拒绝
    （目前有 `agent_fork`、MCP 自管理四件套 `mcp_server_add/remove/set_enabled`/`mcp_reload`、
    `config_reload`/`config_set`、以及 `job_start`），且**不受 `allowedTools` / `mode=all` 影响**
  新增"无人值守能调工具"的入口时，必须显式选择通道：声明式步骤传 `channel: "steps"`，模型驱动传 `"react"`（默认）。
- **MFA 兜底已改为 fail-closed**：无人值守（cron/loop）且无交互回调时按 `[sandbox.unattended].mfaFallback`
  处理，默认 `deny`（历史行为是 `mfaPassed = true` 静默放行）。交互式运行（chat/cli）无回调时仍按旧行为放行，
  并会留审计记录。`cron_add` 的 `mfaExempt` 默认值已从写死 `true` 改为 `false`。
- **沙箱是可选边界层，不是默认**：`[sandbox].enabled && execShell = "sandbox"` 时 `exec_shell` 进 bwrap ——
  密钥文件被空文件掩码（沙箱内**不存在**）、未绑定目录只读、可断网、`onUnavailable = "deny"` 时 bwrap 缺失即拒绝。
  ⚠️ **掩码不覆盖环境变量**：`~/.tinyclaw/env` 会注入 `process.env`（`main.ts` 的 `loadEnvFile`），
  `inheritEnv = true` 时沙箱内照样能读到；`network = "deny"` 会强制收敛环境。
  ⚠️ 掩码使 `~/.ssh` 在沙箱内为空 → agent 的 shell 里 `ssh` / `git push` 会失败；
  需要时用 `exec_shell({ elevate: true })` 走**提权通道**（`src/sandbox/elevation.ts`）：
  按风险分级（E1 只读可免批 / E2 有副作用每次确认）、批准后签发**绑定命令哈希的一次性令牌**（默认 120s，换命令即失效）、
  同命令 5 分钟内请求节流、**cron/loop 一律不许提权**、**子 Agent（`approvalPolicy: "never"`）不许提权也不许发起任何审批**、无交互通道即 fail-closed，且提权必须发一条用户可见提示 + 写审计。
- **沙箱可写范围默认最小：只有 workspace**。基础集 = `agents/<id>/workspace` + `/tmp`（code 模式另加项目目录 `ctx.cwd`）；
  **agent 目录下的其他部分**（`memory/` `cards/` `skills/` `notes/` `logs/` `MEM.md` `ACTIVE.md` `SYSTEM.md` `agent.toml`
  `access.toml` …）与运行时目录其他部分、`~/FinanceSkill` 等，都**必须显式声明或由 agent 主动提权**：
  cron job / loop trigger 用**各自的** `writablePaths`（经 `ToolContext.sandboxExtraRwPaths` /
  `AgentRunOptions.sandboxExtraRwPaths` 传到 `buildSandboxPlan`），chat / cli 用 `fs_grant`。
  声明**文件**时会自动放开其 SQLite 边车（`-wal`/`-shm`/`-journal`），否则 WAL 模式会 `attempt to write a readonly database`。
  ⚠️ 例外：**专用工具不受此限** —— `memory_*` / `write_report` / `release_file` / `create_skill` / `self_runtime_*`
  直接写它们的专属文件（不经 `checkWritePath`），属于"被认可的接口"而不是任意写入；
  `release_file` 另有自己的闸：拒绝 `isRuntimeSecretPath()` 判定的密钥文件与符号链接，并受
  `[web.downloads]` 的单文件/目录总量上限约束。只有 `write_file` / `edit_file` / `delete_file`
  三个通用工具走 `checkWritePath` 的白名单。
  密钥掩码的例外走 `[sandbox].readableSecretPaths`（默认空）；按任务的密钥声明见下条。
- **两条提权路径，别混**（`AGENTS.md` 之外见 `docs/architecture/overview.md` 沙箱节）：
  - `fs_grant`（`auth/fs-grant.ts` + `tools/fs-grant-tool.ts`）：**路径级**、不打扰用户、带 TTL（默认 3600s）、写审计；
    授权后工具层（`checkWritePath` 认 `Session.grantedWritePaths`）与沙箱层（bind 成可写）**口径一致**；
    只接受 `$HOME` 内、已存在、非密钥、非 `~/.tinyclaw`、非 `.ssh` 等受保护目录；**cron/loop 一律拒绝**。
    免 MFA 判据 `argsAreSelfRuntimeOnly(args, ctx)` 同时认"运行时目录"与"已授权路径"。
  - `elevate`（`sandbox/elevation.ts`）：**命令级**、这条命令脱离沙箱在宿主机跑，E1 免批 / E2 每次确认。
    ⚠️ **不下传给子 Agent**：提权与**发起方**绑定（执行发生在发起方的上下文里），子 Agent 调 `elevate: true` 一律拒绝；
    而 `fs_grant` 的授权会**随 fork 继承**（`Session.inheritWriteGrantsTo()`，只复制 TTL 内的、不延长）——
    所以"给子 Agent 开权限"的正确做法是 master 先 `fs_grant`，再 `agent_fork`。
- **无人值守的密钥按任务声明**（方案 B，`sandbox/secrets-filter.ts`）：job / loop 配置 `secrets: ["NAME"]` →
  运行时物化一个只含这些 key 的临时文件并 bind 回 `~/.tinyclaw/secrets.toml`（脚本零改动），用后即删、物化写审计；
  未声明 = 脚本读到空文件。全局例外 `[sandbox].readableSecretPaths` 仍在，但优先用按任务声明。
- **读路径已加密钥边界，但仍无工作区白名单**：`read_file`（`system.ts`）与 `read_image` 经 `checkReadPath()`
  拒绝**密钥**（`~/.tinyclaw/{config,secrets,mcp}.toml`、`auth/**`、`*.key`、`*token*`）与 `.ssh`/`.git`，
  但除此之外仍只 `path.resolve` 就直读 → 仍可读任意其他绝对路径（如 `~/.bash_history`）。
- **自指权限（`[selfAccess].grantedAgents`）是本仓库唯一"按 agent 放开"的授权口**：被授权的 agent 拿到 `~/.tinyclaw` 全树（含 `self_runtime_delete` 真删、通用文件工具免越界确认、免 MFA）。密钥例外由 `path-guard.ts` 的 `isRuntimeSecretPath()` 统一裁决——**新增任何读写/删除入口都必须调用它**（写作走 `checkWritePath`、读作走 `checkReadPath`），否则就把"密钥除外"这个承诺打破了。
- **`exec_shell` 的工具层守卫仍然很薄**：只拦"写危险系统路径"（17 个 `/etc/*` 前缀）。真正兜住它的是沙箱边界层；
  沙箱关着的时候，shell 能读 `secrets.toml` / `config.toml` / `~/.ssh`（`tmp/sandbox-gap-probe.sh` 有取证）。
- **`path-guard` 不解析符号链接**（`path-guard.ts` 无 `realpathSync`），workspace 内软链可逃逸。
- **`config show` 泄密**：`config/schema-display.ts:42-43` 只脱敏 copilot/openai 的 key，deepseek/openrouter/mimo/google 明文；qqbot 脱敏路径写的是旧的 `channels.qqbot.*`。
  （`redactKnownSecrets` 现已接入审计流，不再是"全仓无调用点"。）

### 7.2 别以为这些代码在跑

| 死代码 / 失效项 | 位置 |
|---|---|
| `render_document` 工具：模块从未被 import | `tools/render-document.ts:176` |
| `mfaPreApproved` 全仓无赋值 | `session.ts:202` |
| `Session.bindParent` / `removeChild` 无调用者 | `session.ts:1203-1221` |
| `distillCodeTurnToNotes` 无调用者 | `memory/summarizer.ts:1351` |
| `getVisionClient` / `buildAutoModePrompt` / `forceReleaseLock` | `llm/registry.ts:353` / `code/system-prompt.ts:107` / `core/project-router.ts:170` |
| `loop-runner.restartSession` 有 bug 且无调用者 | `core/loop-runner.ts:61-75` |
| `existingPlan` 恒为 `undefined` → 「Existing plan」段永远不渲染 | `code/system-prompt.ts:51`（形参在 `:217` 传入） |
| `/auto` 已废弃（只返回提示） | `code/commands.ts:180-193` |

> 旧条目「MicroCompact 调用点整段被注释」已删除：那段注释块已被真正的工具结果剪枝取代
> （`agent.ts:1171-1174` 的无模型剪枝，参考 DSH），不再是死代码。

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
| `agent-loop.md:129-131` 记忆 top-5 + minScore=0.3 | 无 minScore 过滤 |
| `agent-loop.md:219-221` `persistSummary` 异步不阻塞 | 被 `await`（`summarizer.ts:1462`） |
| `retry.md:235` copilot 指数退避+jitter | 固定延迟（`copilot.ts:236,603`） |
| `code-mode.md:33,250` `/auto` 为默认子模式 | 已废弃 |
| `cron-pipeline.md:257` pipeline tool step「继承 mfaExempt 豁免」 | 实为无条件绕过 MFA；**已在文档中改正**（现描述为走无人值守声明式通道 + `mfaFallback`），该行保留仅作历史索引，可删 |
| `loop-session.md:189-202` 整节讲 `preCheckScript` | **`LoopSessionConfig` 里没有这个字段**（只有 `enabled` / `agentId` / `tickSeconds` / `taskFile` / `stateful`），`loop-runner.ts` 也没有任何预检逻辑——该能力在 loop-session 上**不存在** |

### 7.4 其他坑

- **`better-sqlite3` 未在 `package.json` 的 dependencies 声明**（`web/backend/db.ts:28` 用 `createRequire` 加载），干净环境 Dashboard 会崩。本机 `node_modules/better-sqlite3` 的预编译产物还是 2026-03-14 编的（ABI 127，而 Node 20.11 要 115）→ 在 `node --import tsx/esm` 的探针里加载会报 `ERR_DLOPEN_FAILED`，但**服务进程内是好的**（`/proc/<pid>/maps` 可见已映射，chat 记忆检索确实在注入）。要修就是 `npm rebuild better-sqlite3`。
- **`AutoFreeClient.supportsToolCalls` 恒为 `true`**（`openrouter.ts:169-171`）→ OpenRouter 免费模型永远走不到 textMode。
- **QQ 富媒体的下发类型由文件格式决定，不是标签**（`outbound.ts` 的 `wireMediaType()`）：`.silk`→语音(3)、`.mp4`→视频(2)、`.png/.jpg`→图片(1)，**其余一律文件(4)** —— 所以 `mp3` 即使写成 `<audio>` 也是附件，不会被 QQ 当语音气泡；官方各类型只吃固定格式（否则 400 850019），被拒时改用 `file_type=4` 重发（分片路径在**预上传**阶段零字节代价发现）。
- **QQ 富媒体有两条上传路径，别混**：**≤ 原始 7.5 MB** 走 `file_data`（base64 内联进单次请求，**编码后约 10 MB 即网关上限**，判的是 **base64 长度**而非原始字节——曾按原始字节比，8.2 MB 文件放行后网关 500 `call inner proxy error`，用户却只看到"附件已发"）；**更大**走官方**分片上传**（`upload_prepare` → 逐片 PUT → `upload_part_finish` → 带 `upload_id` 合并 `file_info` → `msg_type:7` 发送），硬上限 **200 MB**，超硬限制才在本地拒绝。分片协议的 `file_size` / `block_size` 都是**字符串**，`md5_10m` 取**前 10,002,432 字节**的 MD5（不是整文件）。⚠️ **c2c openid 按 bot 隔离**：`7EE1BD…` 只对 `[channels.qqbots.chat]` 有效，用别的 bot 发会得到 `11255 用户/群已注销`。
- **QQ 单聊的流式消息有长度预算，超了**不会**报错**：`POST /v2/users/{openid}/stream_messages` 的响应带 `remain_msg_len`（流式消息剩余长度，字符数）；超过这条消息的容量后平台**静默丢弃**后续分片（**请求仍返回 200**），消息永久停在"生成中"，最后一片 `input_state=10` 也丢 → 客户端表现是**手机只显示开头几个字**（如 `对…`）而 Dashboard 显示完整正文（Dashboard 渲染的是会话正文，与这条流式消息无关），于是"同一句话在不同设备不一样"。实测锚点：585 字（≈1755 B）到达、778 字（≈2334 B）与 905 字（≈2715 B）被截断 → 保守上限取 **2048 字节**（`outbound.ts` 的 `STREAM_MAX_BYTES`）。`C2CStreamSession` 必须读 `remain_msg_len` 建容量、超预算停止推送、收尾时用能装下的最长前缀发 `input_state=10`，余量交给普通发送（`finish()` 的 `{streamed, sentText, remainder}`）；**不要**把这段"读预算 + 补余量"的逻辑简化掉，也不要再假设"流式成功 = 用户看全了"。
- **模型可能返回"空正文"，而框架的兜底文案会撒谎（已修，别再退回去）**：实测（2026-09-13，340k+ token 长会话）
  flash 级模型把输出预算全烧在 `reasoning_content` 里并**退化成同一句的无限重复**（`好。写。好。发送。…`，
  同句上百次），`content` 为空 → 旧行为把"无 tool_calls"当成最终回复 → 用户只收到 `✅ 已完成`。
  现在的处理链：`finish_reason` 已捕获（`ChatResult.finishReason`）→ `llm/reasoning-guard.ts` 分三态
  （`length` / `degenerate` / `silent`）→ `agent.ts` 注入纠偏提示并**重试本轮一次**（`emptyRetryPending` 只救一次）
  + 日志点名 + 指标 `llm/empty_reply` → 仍为空则 `AgentRunResult.emptyReplyKind` 交给 `main.ts` 发**诚实**兜底
  （`⚠️ 模型这轮没有产出正文…`），`✅ 已完成` 只留给"工具已交付、模型确实没补充"的情形。
  ⚠️ 改 `agent.ts` 循环或 `main.ts` 兜底时**不要**把空正文当成正常收尾。
- **思考档位的线级枚举与 DSH 不一样，别照抄（实测）**：`api.deepseek.com/v1` 的 `reasoning_effort`
  只认 **`none|minimal|low|medium|high|xhigh|max`**；DSH 内部的 `off` **不是**合法值——发 `off` 直接
  400 `unknown variant "off", expected one of none, minimal, low, medium, high, xhigh, max`。
  真正"关闭思考"只有 `{thinking:{type:"disabled"}}`；`reasoning_effort:"none"` **不等于**关闭
  （同一道题仍产出 ~142 reasoning tokens）。档位是**上限/引导**不是工作量下限：简单题 7 档几乎无差异
  （~140 tokens），多步题 low=260 → high=319。这套枚举与解析只在 `src/llm/thinking.ts`
  （`resolveThinkingParams()`），schema 与 `/think` 都从那里取，**不要**在别处再写一份档位表。
  ⚠️ 会话级覆盖只对声明了 `thinkingControl` 的后端（DeepSeek 系）下发；给 Copilot/OpenRouter 发
  `thinking` / `reasoning_effort` 会被端点拒绝。
- **`gateway.ts:184` 的 finally 删队列会丢新消息**；`api.ts:74` 的 token singleflight 失败后永久卡死。
- **`qmd.ts:258-280` 维度不一致时直接删整个 `index.sqlite`**（无备份）。
- **`mcp-servers/` 与 `scripts/` 不在 `tsconfig` 的 `include` 范围内**（只含 `src/**/*`），改动它们后 typecheck 不会覆盖。
- **Cron 推送口径不一致（潜在，当前 0 个 job 受影响）**：`runner.ts:531` 的常规推送分支额外要求
  `job.output.sessionId`，而 `notify="llm"` 分支（`:511`）只要求 `peerId` —— 于是 `notify = always/on_error/on_change`
  配 `sessionId = null`（schema 默认值）时会**静默不推送**，log 里也看不出来。实测 24 个 job 目前都填了 `sessionId`，
  所以还没踩到；新建 job 时若只填 `peerId` 就会踩。
- **本机 mtime 精度不可靠（实测）**：在 `/home/lyy/tinyclaw` 下对同一文件连续两次写入，
  `statSync(p,{bigint:true}).mtimeNs` **完全相同**（实测 `1789219717043616105` vs `1789219717043616105`），
  `mtimeMs` 亦然 → **任何"用 mtime 判断文件是否变了"的缓存都会漏掉更新**。
  要用内容哈希（sha1/sha256）。参考实现：`src/instructions/workspace-prompt.ts` 的 `baselineIdentity()`
  （对每个指令文件的 `digest` 做 sha1），逐文件摘要由 `src/instructions/agents-md.ts` 的 `sha1()` 产出。
- **Subagent 未修的剩余问题**：
  - `agent_wait()` 不传 `slave_id` 时按 `masterSessionId` 捞回该 master **24h 内全部** Slave（无 scope / 时间 / 分页过滤，`slave-manager.ts` 的 `waitForByMaster`）
  - auto-fork 触发时（`agent.ts` 读 `agent.autoForkThresholdMs`，默认 120000ms，0 = 关闭）Master 当前轮**直接 break**，其手上的中间结论不随上下文交给 continuation Slave
  - `tools/skill-run.ts` 的 skill 临时 session 在**失败路径不清理** JSONL（`deleteJsonl` 只在成功分支），且 300s 超时用的是 `Promise.race`，**不取消**后台仍在跑的 Slave
  - **子 Agent 拿不到声明式密钥**：按任务声明的密钥（`sandbox/secrets-filter.ts` 方案 B）目前只有 cron job / loop trigger 能声明，`agent_fork` 与 `skill_run` 的子 Agent **无处声明、也不继承父的声明** → 它们在沙箱里 `exec_shell` 读 `~/.tinyclaw/secrets.toml` 一律是**空文件**。要让子 Agent 用密钥，需给 `agent_fork` 加 `secrets: [...]`（按任务声明 + 审计），暂未做

### 7.5 Loop 引擎（确认存在、影响真实运行）

> 2026-09 审查确认。这三条互相叠加，导致 `~/.tinyclaw/loops/` 里那个"盯盘"触发器**自 2026-05-01 起没有真正执行过一次**，而日志里看不出来。

- **`preCheckScript` 用 `process.execPath`（= node）执行任意脚本**（`loop-trigger.ts:327`）→ 任何**非 JS** 预检脚本必然抛 `SyntaxError` 并返回非 0，于是**每一个 tick 都被静默跳过**。用户实际配置的是 Python（`is_trading_day.py`）。实测：60 天内 6139 次"返回 1 / 跳过"、**0 次"通过"、0 次"tick 完成"**。修法：按 shebang 或显式解释器执行，并把失败原因（含 stderr）写进运行日志。
- **loop-trigger 的注入载荷被自己的配置文件顶掉**（`loop-trigger.ts:415`）→ 它把 `path.join(loopsDir, "<id>.json")` 当 `_loopTaskRef` 传给 `session.addLoopTaskMessage()`，而 `getMessagesForLLM()` 对"最后一条带该字段的消息"的语义是**展开该路径的文件内容**——于是 LLM 收到的是 **loop 的 JSON 配置**，而不是本次 tick 的步骤输出 / `message` / exitHint。该缺陷 2026-03-30 引入时因误用 `require("node:fs")`（ESM 下抛错）被 `catch` 兜底掩盖，**2026-07-06 引入 ESLint 时顺手改成 `fs.readFileSync`，缺陷才正式激活**。注意：Slave 继承路径已在 `slave-manager.ts` 剥掉该字段规避，**loop-trigger 自身未修**。
- **loop 引擎零持久日志** → 启动/跳过/失败/完成全部只有 `console.log`，`~/.tinyclaw/loops/logs/` 根本不存在。这正是前两条能潜伏数月而无人察觉的原因：最有诊断价值的"跳过"信号没有任何消费方。

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
| `subject` | 必填，单行，不加句号；动宾式说明"做了什么"；**必须全英文** |
| `body` | 可选；涉及多文件或行为变更时必写，逐条列出关键改动；**必须全英文** |

> **提交信息一律全英文**（`type` / `scope` / `subject` / `body` 全部英文，禁止中英混排）。
> 仓库历史中存在中文提交，那是旧约定；**新提交一律英文**。

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

**示例**：

```
feat(llm): harden connection stability with retries, jitter, stream idle timeout, 429 Retry-After
fix(cron): inject pipeline tool steps as synthetic tool calls to stop hallucinated data
docs: add LOOP_SESSION.md and refresh outdated sections
refactor(mcp): agent-centric MCP access control via per-agent mcp.toml
```

**禁止**：中文或任何非英文的提交信息；`修复：xxx` 这类无 type 前缀的裸标题；`update` / `修改` / `fix bug` 这类无信息量标题；一次提交混杂多个不相关改动（拆成多次提交）。

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

`src/core/tinyclaw-submitter.ts` 是**独立的定时备份调度器**（每 4h 自动提交 `~/.tinyclaw` 配置仓库，设计上无人值守），不属于"agent 提交行为"，不适用 §10.2。如需对其也加审批，须单独改该模块。其提交信息仍遵循 §10.1（全英文 Conventional Commits）。

### 10.4 Commit timing and granularity

**Commit when the task is done — never leave finished work uncommitted.** As soon as a task (or a
self-contained milestone within it) is finished, prepare the commit: stage, run the §10.2
self-check, show the user the file list + proposed message, and ask for approval (§10.2 still
applies — asking is mandatory; leaving it uncommitted is not an option).

**Keep every commit small — one commit, one concern:**

- Aim for **≤ 5 files** per commit. If a change touches more, split it by concern (e.g. security
  hardening / new feature / the docs that only make sense with it) instead of one "misc" commit.
- When several concerns share a file, stage **hunks** (`git add -p`, or `git diff | git apply
  --cached`) so each commit still carries only its own concern.
- An intermediate commit must still build: `npm run typecheck` has to pass on the committed tree.
  Verify by **materialising that tree** (write exactly the files the commit will contain, run
  typecheck, then commit). Do **not** verify with `git stash push -u --keep-index` + `stash pop`:
  a conflicting pop silently writes conflict markers into the working tree and `-q` hides it
  (this actually happened on 2026-09-22 and needed a stash recovery to undo).
- Docs go in the same commit as the code they describe (§4) — never split code and its docs.
- Do not mix a `fix` into a `feat` commit because they happened in the same session; separate
  concerns earn separate commits (and separate Conventional Commit types).

> Rationale: small single-concern commits are reviewable, bisectable and revertable; a 14-file
> "everything I did today" commit is none of those.

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
