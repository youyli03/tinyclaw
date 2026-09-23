# tinyclaw 架构文档

> 极简模块化 AI Agent 框架，Bun + TypeScript

--

### 跨 Session 通信(session_get / session_send)

- `session_get` 工具:列举对当前 Agent 可见的所有活跃 session(经双向 allow-list 过滤)
- `session_send` 工具:向指定 session 注入消息,触发该 session 的 Agent 处理任务
- **权限模型**:基于 `~/.tinyclaw/agents/<agentId>/access.toml` 双向 allow-list:
  - 发送方的 `can_access` 必须包含目标 agentId
  - 目标方的 `allow_from` 必须包含发送方 agentId
  - 任一不满足 → 拒绝(默认 deny)
- **典型用例**:loop session 完成分析后向用户主 session 汇报;主 Agent 向专用 Agent 分派子任务
- 仅在完整服务模式下可用,CLI/cron 模式下返回错误

详见 [commands/session-bridge.md](../commands/session-bridge.md)。

### Dashboard(Web UI)

- 访问方式:`tinyclaw web` 显示访问地址;鉴权见下方「鉴权」小节(2026-09 加固:token 不再进 URL)
- **概览页**:今日系统/AI 请求趋势图,快速状态一览
- **指标页**:按 category/key 分组的折线图/柱状图,由 `db_write` 工具写入 `dashboard.db`
- **Token 页**:prompt 构成细分(见下)
- **日报页**:展示 `write_report` 写入的 Markdown 日报存档,按 type+date 索引
- **Cron 页**:可展开的任务卡片列表,显示最近运行状态与日志
- **移动端（≤768px）**:导航是**抽屉式侧边栏** —— 顶栏固定显示 `☰` + 当前页标题，点 `☰` 从左侧滑出
  与桌面端**同一份** `nav-item` 列表（`#sidebar` 变 `transform: translateX(-100%)`，`.sidebar-open` 滑入，
  遮罩/导航项/Esc 关闭，抽屉内可滚动以容纳后续新增的 tab）。**加一个新页面只需改三处**：`VALID_PAGES` +
  侧边栏 `nav-item` + 页面 div —— `tmp/check-mobile-nav-20260913.py` 会断言"每个 VALID_PAGES 都有导航项"防止漏加
  - ⚠️ **顶栏用文档流占位，不要改回 `position: fixed`**：`#main` 自己是滚动容器（`height:100vh; overflow-y:auto`），
    固定顶栏会被滚动内容穿过（安卓上表现为第一行卡片被顶栏"挡住"）。现在 `#app` 在移动端竖排
    （顶栏 52px + `#main` 吃剩余高度 `height:auto; flex:1; min-height:0`），内容在 `#main` 自己的盒子里滚动
  - ⚠️ **JS 与 CSS 必须用同一个断点**：`isMobile` 取自 `matchMedia("(max-width: 768px)")` 的 `matches`
    （并监听其 `change`），**不要**改回 `window.innerWidth <= 768` —— 实测安卓 Edge 上两者会在某些时刻不一致，
    于是 CSS 认为窄屏、JS 却把顶栏 `v-if` 掉了（顶栏消失、抽屉无从打开）
  - 排查入口：侧边栏页脚显示**构建号**（服务端注入 `<html data-build>`，值为前端内容
    `index.html`+`main.js`+`style.css` 的 sha1 前 12 位，静态资源按它加 `?v=` ——
    **内容没变则重启也不变号**，不会无谓刷掉浏览器缓存），
    用来判断手机加载的是不是新版本；带 `?diag=1` 打开会在页面顶部渲染诊断条
    （构建号 / `innerWidth`×`innerHeight` / dpr / visualViewport / `isMobile` / `matchMedia` / 顶栏是否在 DOM / UA）

#### 鉴权（2026-09 加固）

- **入口**：`token` 只从 **POST `/__login` 的表单体** 或 **`Authorization: Bearer <token>` / `X-Auth-Token` 头**读取；
  **不再从 URL query 读取**（URL 会进 Cloudflare/反代访问日志、浏览器历史与 Referer）
- **会话**：登录成功种 `dash_token` cookie，值是**随机 256bit 会话 id**（不是 token 本身）；
  服务端内存 Map 保存「会话 id → 过期时间」，有活动即续期（TTL 7 天）。**进程重启全部会话失效**，
  故 token 轮换后需重新登录。cookie 为 `HttpOnly; SameSite=Lax`，经反代 HTTPS 到达时追加 `Secure`
- **比较**：token 先各自 sha256 再 `timingSafeEqual`（常量时间，不泄漏长度与前缀）
- **限速**：登录失败按来源计数（单来源 8 次/10 分钟、全局 32 次 → 锁 15 分钟）；
  **正确 token 一律放行**，所以攻击者无法用错误 token 把真实用户锁在门外。
  来源标识在直连时用 socket 地址，仅当请求来自本机回环（cloudflared 跑在本机）才信任 `CF-Connecting-IP`
- **保护范围**：除 `GET/POST /__login`、`GET/POST /__logout` 外**所有路径都要鉴权**（含静态资源）——
  登录页是自包含 HTML（内联样式、无外部资源），因此不需要按扩展名放行，也**不再有 `/api/notes/file` 免鉴权白名单**
- **响应头**：所有响应带 `X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、
  `X-Frame-Options: SAMEORIGIN`（用 SAMEORIGIN 而非 DENY，是为了笔记页的同源 PDF `<iframe>` 仍可用）
- **不再发通配 CORS**：Dashboard 是同源应用，`Access-Control-Allow-Origin: *` 只会让任意网站在浏览器里读走数据接口
- **跨站防护**：非安全方法用 `Sec-Fetch-Site: cross-site` 判定并拒绝（**不要**改回 Origin/Host 比对：
  cloudflared 会把 Host 改写成回源地址 `127.0.0.1:4096`，比对必然失败 → 真实用户登录被 403）
- ⚠️ **缓存头必须 `private`**：静态资源若用 `public`，Cloudflare 边缘会把该 200 缓存下来并**对未登录者公开**
  （实测未登录 `GET /main.js` → `200 + cf-cache-status: HIT`）——鉴权只在**回源**生效，边缘缓存会绕过它；
  数据接口一律 `private, no-store`
- **退出**：`GET /__logout` 只渲染确认页（避免被跨站 link/img 触发登出），`POST /__logout` 清 cookie 并删会话
- ⚠️ 令牌仍是**单因子静态凭证**：对外网暴露的域名建议在 Cloudflare Access 等边缘再加一层身份验证

#### 加载与轮询（首屏 4 个 API 请求）

首屏（概览）只发 **4 个** API 请求：`/api/stats`、`/api/cron`、`/api/metrics/latest`、`/api/metrics/batch`。
（优化前是 3 + 21 + 15 = 39 个：`metric-keys` + 逐 key 串行 20 次 + 每条曲线一次。）

| 接口 | 作用 | 要点 |
|---|---|---|
| `GET /api/metrics/latest?days=1&today=1` | **全部已注册指标**的最新值 + 窗口序列 + 窗口合计 | 一条 SQL（`queryLatestMetrics()`）；替代"1 次 key 列表 + N 次串行 `/api/metrics`"（20 个 key 在手机上要数秒） |
| `GET /api/metrics/batch?spec=cat/key:days,…&since=` | 多条曲线一次取回（概览 12 条 token 曲线 + 电费/余额/系统） | `since` 对所有项生效，前端传**各组 ts 的最小值**并各自按自己的 floor 去重；`system` 项特殊（走 `system_snapshots`）；spec 上限 64 项 |
| `GET /api/stats` | CPU/内存/磁盘 + cron 计数 | 5s TTL 缓存 + single-flight（多个标签页并发只采样一次）；磁盘用 `fs.statfsSync`，**不再 fork `df`**（原来每次请求 500ms+） |

- **轮询 30s**：`document.hidden` 时**不轮询**（手机省电/省流量），`visibilitychange` 回到前台立即补一次；
  且**按当前页取数** —— 概览才拉 stats/cron/指标，笔记页不发任何轮询请求
- **切页按需加载**：`ensurePageLoaded(pg)`（`watch(page)` 驱动），首次进入某页才拉该页数据
- ⚠️ 概览图必须**在前台绘制**：canvas 在 `display:none` 的容器里尺寸为 0，隐藏时画的就是废图
  （旧的初始化无条件先画一次概览图，非概览页首屏等于白画）
- 概览 token 柱状图的**行累积缓存**（`overviewLlmRows`）：增量轮询只拿到新增行，但按天聚合要全量，
  所以行按 ts 去重后累积在内存里，每次都能从缓存整张重画（旧代码增量时抓回 12 条曲线却因
  `!incremental` 判断直接丢掉，柱状图一直不更新）
- `index.html`（`no-store`）的**渲染 + gzip 结果按内容 sha1 缓存**，不再每请求重算
- `marked.min.js`（35KB / gzip 11KB）**懒加载**：只有笔记页渲染 Markdown 时才 `loadScriptOnce()` 拉取，
  失败回退 `<pre>` 原文；首屏 5 个静态资源里没有它
- ⚠️ **概览 Token 卡片的 key 是 `llm/token/<src>/<type>`，且每行是"每轮增量"**：今日用量 = 各
  (来源 × 类型) 的窗口**合计**（`sum`，不是最后一条）。曾经这里读不存在的 `llm/tokens_chat`，
  卡片**永远不渲染**（页面只是少一张卡，没有任何报错）—— `tmp/probe-web-load-20260913.ts` 锁死这一点

#### 笔记页（Markdown / PDF）

浏览 `~/.tinyclaw/notes/`（`/api/notes/tree` 拿目录树，`/api/notes/file?path=` 取内容；两者都需登录，桌面端 PDF 走同源 iframe，会话 cookie 照常带上）。
Markdown 走 `marked`（懒加载，见上），PDF 分两条路：

| 端 | 渲染方式 |
|---|---|
| 桌面（`!isMobile`） | 原生 `<iframe>` 直接嵌 `/api/notes/file?path=…` |
| 手机（`isMobile`） | PDF.js（`/pdfjs/pdf.mjs` + `pdf.worker.mjs`）逐页画到 canvas，`IntersectionObserver` 懒渲染 |

手机端三条不可回退的实现细节（`tmp/probe-notes-pdf-mobile-20260913.ts` 锁死）：

- ⚠️ **`renderPdfMobile()` 第一步就置 `pdfPages = ['loading']`**，且 `openNotesFile()` 用
  `mobilePdfOwnsLoading` **让出 `notesLoading` 的归属**。否则"下 pdfjs(658KB) + 整份 PDF（实测 2.2MB）"
  这十几秒里，模板的 `v-else-if="isMobile && pdfPages.length"` 不成立 → 掉进 `v-else` 空状态
  （**显示"点击左侧文件预览"**）—— 用户看到的就是"PDF 渲染坏了"（2026-09-13 的真实截图）。
  现在这段显示 `加载中…` / `正在加载 PDF…` / 进度条，`notesLoading` 由 `renderPdfMobile` 自己收尾。
- ⚠️ **canvas 像素宽度 = 容器 CSS 宽度 × `min(devicePixelRatio, 2)`**，不要写成裸 `scale = min(dpr,2)`：
  手机上 dpr=3 时那是 612pt 页面 → 1224×1584 px（单块 canvas ≈ 7.7MB），而实际只按 ~380px 宽显示 ——
  画得慢、内存大，安卓更容易被节流。按显示宽度算后实测 700×906（≈2.5MB）。
- ⚠️ 失败必须给出路：catch 里渲染 `PDF 渲染失败: <原因>` + **"用系统阅读器打开 →"**（`target="_blank"` 指回
  原文件 URL，走手机自带 PDF 阅读器）；容器拿不到时**抛错**而不是静默 `return`。
- PDF 响应头是 `Cache-Control: private, max-age=300`（原来 `no-store` → 每次打开重下 2.2MB）；
  `Accept-Ranges` + 206 分片照旧。

#### 下载页（一次性令牌）

回答“把文件交给用户”：agent 用 `release_file` 把文件**复制**进释放区，用户登录后在「下载」页选中文件
生成一条一次性 `curl` 命令，在**任何机器**上执行即可下载。**两个区**：

| 区 | 目录（可配） | 形态 | 清理 |
|---|---|---|---|
| 临时区 | `~/.tinyclaw/downloads/`（`dir`） | 平铺文件名 | 列表接口按 `ttlDays` 自动清理 |
| 常驻区 | `~/.tinyclaw/keep/`（`keepDir`） | **可嵌套子目录归类**（`release_file(keep=true, name="分类/文件")`），前端复用笔记的树组件渲染 | **永不自动清理** |

- **接口**：`GET /api/downloads`（返回临时区列表 + 常驻区目录树）/ `POST /api/downloads/link?name=&zone=temp|keep`
  （签发令牌）/ `POST /api/downloads/delete?name=&zone=`（删除并作废令牌）—— 都要会话；
  `GET /dl` 是**唯一免会话路径**，只认一次性令牌（`X-Download-Token` / `Authorization: Bearer <otp>` / `?t=`），
  handler 内部 fail-closed
- **令牌语义**：256bit 随机、只在内存（进程重启全失效）、**绑定文件指纹**（size+mtimeMs，文件被替换即作废）、
  TTL（默认 600s）与最大次数（默认 3，留出 `curl -C -` 续传余量）；**只能下它绑定的那一个文件**。
  常驻文件也是**每次下载各生成一条一次性命令**——常驻的是文件，不是链接
- **生成的命令**：`curl -fL -H "X-Download-Token: <otp>" -o <文件名> https://<host>/dl`
  —— 令牌走**请求头、不进 URL**（URL 会进 Cloudflare/反代日志与浏览器历史）
- ⚠️ **缓存头必须 `private, no-store`**：下载对象一旦被 CF 边缘缓存，就会绕过令牌对所有人公开
- **路径安全**：临时区只接受**文件名**；常驻区接受**相对路径**但逐段校验（拒绝绝对路径、`.`/`..`、
  隐藏段、控制字符；段数与段长有上限），解析后 `realpath` 必须仍落在区内，且拒绝符号链接（含中间目录）。
  校验函数 `downloads.normalizeKeepRel()` 由**投放侧与下载侧共用**，避免两侧口径不一致
- **投放侧安全闸**：`release_file` 拒绝 `isRuntimeSecretPath()` 判定的密钥文件与符号链接，
  并受单文件（`maxFileMb`）与各区总量（`maxTotalMb` / `keepMaxTotalMb`）上限约束；每次调用写审计
- **树的安全**：常驻区遍历不跟随、也不展示符号链接；深度上限 6、条目上限 2000（防病态目录）

配置（`~/.tinyclaw/config.toml`）：

```toml
[web.downloads]
enabled        = true                      # 默认 false
dir            = "~/.tinyclaw/downloads"   # 临时区目录
keepDir        = "~/.tinyclaw/keep"        # 常驻区目录（可用子目录归类）
linkTtlSecs    = 600                       # 一次性令牌有效期(秒)
maxUses        = 3                         # 单个令牌最多下载次数
maxFileMb      = 512                       # 单文件体积上限(MB)
maxTotalMb     = 2048                      # 临时区总占用上限(MB)
keepMaxTotalMb = 5120                      # 常驻区总占用上限(MB)
ttlDays        = 7                         # 临时区保留天数(0 = 不清理；常驻区不受影响)
```

#### Token 页(prompt 构成细分)

回答"钱花在哪一类"——把**每一次 LLM 请求**的 prompt 拆成七类（`src/memory/token-estimate.ts` 的
`breakdownMessages()`，纯计算、无额外模型调用）：

| 分类 | 判定（只用**已有 marker**，不给模型加可见内容） |
|---|---|
| `system` 系统提示 | `role=system`（内置 prompt / 技能提醒 / 格式纠错…） |
| `instructions` 工作区指令 | 以 `<!-- workspace-instructions:` 开头（AGENTS.md 注入） |
| `memory` 记忆注入 | 以 `<!-- memory:` / `<!-- injected:` 开头 |
| `summary` 压缩摘要 | 含 `[对话历史摘要]` / `[编码会话历史摘要]` |
| `tools_schema` 工具定义 | `JSON.stringify(tools)` 的长度（工具 schema 本身也很贵） |
| `tool_results` 工具结果 | `role=tool`（并由 `tool_calls[].id` 反查工具名做**工具归因**） |
| `conversation` 对话正文 | 其余 user/assistant（含 `tool_calls` 参数 JSON） |

- ⚠️ **构成是启发式估算**（全仓统一口径 chars/3.5），**总量一律用提供方报告的 `prompt_tokens`**；
  页面把两者并排显示（含偏差 %），不要把构成当账单 —— 与 DSH `dsh-token-meter` 的纪律一致
  （该插件同样只给 `systemTokens`/`toolsTokens`/`messageTokens` 三桶近似值，并明示"构成绝不呈现为总量"）；
  估算对 CJK 与 JSON schema 会系统性偏低（实测一次真实请求：实际 31,597 vs 估算 26,862，约 −15%）
- 判定顺序有意为之：`role=tool` 先判（工具输出里出现 marker 也算工具结果）→ 再按 marker 判注入类
  （**先于** `role=system`，否则被 system 承载的压缩摘要永远归不进 `summary`）→ 最后按角色兜底
- **存储**：`dashboard.db` 的 `token_breakdown` 表，**每轮请求一行**（含 `actual_prompt/output/cache_*`、
  各分类合计 `items`、单条排行 `top`、工具归因 `tools`、`context_window`/`session_tokens`），
  与 `metrics` 分开：不受指标白名单与 7 天窗口限制
- **接口**：`GET /api/token-breakdown?days=&limit=&session=` → `{rows, latest, byDay, byTool, bySession, totals}`
  （聚合在服务端做；`latest` 取**全局最近一次请求**，用于"最近一次请求占用窗口"卡片）
- **图表**：环形图（最近一次带构成的请求占比）、分类堆叠趋势（按天）、逐轮 prompt 折线（可见"第几轮突然涨了"，
  压缩/视觉的调用也在曲线上、tooltip 标注来源）、单条消耗 Top、工具归因排行、
  会话/来源排行（按 **(会话, 来源)** 分组——同一会话里的对话/压缩/视觉分别成行）
- **上下文窗口占用**用**实际 prompt / contextWindow**（不是仅会话正文的估算——`session.estimatedTokens()`
  不含 system prompt 与工具 schema，会严重低估）；用量写入失败只 `console.warn`，绝不影响对话
- **覆盖范围（全量口径）**：走 ReAct 主循环的请求都记，并按 `classifyTokenSource()` 标注来源 ——
  `chat`（QQ/CLI）/ `code` / `cron`（含 pipeline 的 msg step）/ `loop`（loop 触发复用绑定会话 id，
  只能靠 `origin` 区分）/ `slave`（`agent_fork`）/ `skill`（`skill_run`）；判定顺序是
  **sessionId 前缀（`cron:`/`slave:`/`skill:`）优先于 `origin`**——cron 里 fork 出来的 `slave:` 记成子 Agent
- **压缩/蒸馏与图片识别也在内，但只有总量**：这两条是直连 LLM 的独立调用（各自构造内部请求，七分类对它们
  没有意义），走 `insertTokenUsageOnly()` 记 `source=summarizer|vision` 的 prompt/output/cache，
  构成列留空；因此 Token 页的合计**等于全量**，而环形图/单条 Top 只用**最近一次带构成的请求**
  （接口的 `latestBreakdown`，避免压缩插在最新一行时图形空掉）

---

## 设计原则

- **极简**：每个模块只做一件事，不过度设计
- **安全**：所有敏感信息只在 `~/.tinyclaw/config.toml`，永不进仓库
- **代码/操作分离**：日常对话用 daily LLM，代码任务 spawn codex/copilot，主 Agent 上下文不膨胀
- **数据与代码分离**：仓库只含代码，运行时数据全部在 `~/.tinyclaw/`

---

## 目录结构

### 仓库（代码）

```
tinyclaw/
├── src/
│   ├── main.ts               # 入口：加载配置 → 启动 QQBot → IPC server → Cron → 优雅退出
│   ├── config/               # 配置（schema 是唯一真相）
│   │   ├── schema.ts         # Zod 唯一真相
│   │   ├── validate.ts       # 写前校验（语法/schema/交叉引用）
│   │   ├── settable-paths.ts # config_set 的字段白名单（防自我提权）
│   │   ├── safe-write.ts     # 备份/原子写/留证
│   │   ├── state.ts          # LKG / pending / 回退记录
│   │   └── reload-plan.ts    # 变更分级（hot/soft/restart）
│   ├── health/               # 启动健康自检（离线项 + LLM 探测）
│   ├── main-supervisor.ts    # 进程守护：crash 退避重启（≤20 次）+ 配置 quick-fail 自动回退 + 代码 git 回退
│   ├── core/
│   │   ├── agent.ts          # ReAct 主循环（think → tool_call → observe → respond）
│   │   │                     # 支持 MFA 鉴权、__purpose 进度旁白、auto-fork、textMode 文本工具调用
│   │   ├── purpose-arbiter.ts # __purpose 展示仲裁（取代旧心跳：按工具真实耗时决定说不说）
│   │   ├── job-manager.ts    # 后台 Job：进程组 spawn / 增量日志 / detach / 超时 / 并发上限 / 重启收敛
│   │   ├── systemd-run.ts    # detached job 的 systemd transient unit 载体（独立 cgroup + 0600 env 文件）
│   │   ├── session.ts        # messages[] + JSONL 持久化 + 并发控制 + 压缩（chat/code 两路）
│   │   ├── router.ts         # 意图路由（扩展点，当前直通）
│   │   ├── agent-manager.ts  # Agent 工作区管理（创建/查找/路径/repair）+ session loop 配置读写
│   │   ├── loop-runner.ts    # Loop Session 引擎：扫描 sessions/*.toml，setInterval tick，runAgent
│   │   └── slave-manager.ts  # Slave agent 生命周期：fork（按轮结构化继承）/ status / abort / 进度推送 / 轨迹归档
│   │        （slave-trajectory.ts # Slave 轨迹归档：~/.tinyclaw/slaves/YYYY-MM/YYYY-MM-DD-<id>/）
│   ├── llm/
│   │   ├── client.ts         # OpenAI-compatible 统一接口（streamChat + withRetry + idle timeout）
│   │   ├── registry.ts       # 多后端注册（providers + backends）；get(name)；async init()
│   │   ├── copilot.ts        # GitHub Copilot：token 换取 + 模型发现 + LLMClient 构建
│   │   └── copilotSetup.ts   # RFC 8628 Device Flow OAuth + ~/.tinyclaw/.github_token 持久化
│   ├── memory/
│   │   ├── qmd.ts            # @tobilu/qmd SDK 封装（search / updateIndex / rebuildMemoryIndex，按 agentId 隔离命名空间）
│   │   ├── rkllm-embed.ts    # RKLLM NPU HTTP Embed 客户端（makeRkllmEmbedLlm，替代本地 LlamaCpp，1024 dim）
│   │   ├── cards.ts          # MemoryCard 结构定义与持久化（11 种类型：preference/constraint/profile 等）
│   │   ├── news-watcher.ts   # 监听 .update-pending 标记文件，自动触发增量索引
│   │   ├── store.ts          # 摘要 → agents/<id>/memory/YYYY-MM-DD.md
│   │   └── summarizer.ts     # chat: 全量压缩；code: 滑动窗口压缩（保留最近 8 条）
│   ├── auth/
│   │   ├── mfa.ts            # MSAL Interface B：Device Code Flow + number-matching push
│   │   ├── totp.ts           # Interface C：TOTP 验证码生成（otpauth）
│   │   └── guard.ts          # toolNeedsMFA() 判断 + withMFA() 高阶包装
│   ├── tools/
│   │   ├── registry.ts       # 工具注册表(spec / requiresMFA / hidden)+ ToolContext 定义
│   │   ├── system.ts         # exec_shell / write_file / edit_file / delete_file / read_file / read_image
│   │   ├── fs-search.ts      # grep / glob(ripgrep;复用 exec_shell 的沙箱/提权/审计链路)
│   │   ├── http-request.ts   # http_request(HTTPS GET/POST,headers 支持 $SECRET_NAME 占位符)
│   │   ├── code-assist.ts    # code_assist(双子 Agent 架构:daily 协调 + code 执行)
│   │   ├── ask-master.ts     # ask_master(隐藏工具:daily 子 Agent 暂停向用户提问)
│   │   ├── ask-user-tool.ts  # ask_user(向用户提问,支持预设选项)
│   │   ├── run-code-subagent.ts  # run_code_subagent(隐藏工具:daily 触发 code 子 Agent 执行)
│   │   ├── render-diagram.ts # render_diagram(mermaid mmdc / mermaid.ink;python matplotlib)
│   │   ├── send-report.ts    # send_report(Markdown/mermaid/python → 图片,主动推送给用户)
│   │   ├── notify.ts         # notify_user(不等 run 结束即推送消息)
│   │   ├── write-report.ts   # write_report(日报写入 ~/.tinyclaw/reports/<type>/<date>.md)
│   │   ├── release-file.ts   # release_file(投放到下载页:临时区或 keep=true 的常驻区 ~/.tinyclaw/keep/,后者按目录归类)
│   │   ├── db-write.ts       # db_write(业务指标写入 dashboard.db,Dashboard 折线图展示)
│   │   ├── search-store.ts   # search_store(向量语义搜索本地知识库,如 news)
│   │   ├── memory.ts         # memory_read/write_mem · read/write_active · append_feedback · append_card · append · search
│   │   ├── self-status.ts    # self_status(自省：模型/上下文/缓存命中率/记忆规模/定时任务/运行时占用)
│   │   ├── self-runtime.ts   # self_runtime_scan/read/delete(自指：读写删自己的运行时目录，密钥除外)
│   │   ├── fs-grant-tool.ts  # fs_grant(路径级无感授权：$HOME 内非密钥路径，带 TTL + 审计)
│   │   ├── skill-creator.ts  # create_skill(创建 Skill 文档并注册到 SKILLS.md)
│   │   ├── skill-run.ts      # 技能执行辅助
│   │   ├── agent-fork.ts     # agent_fork / agent_status / agent_wait / agent_trace / agent_abort
│   │   ├── session-bridge.ts # session_get / session_send(跨 session 消息互传,双向 allow-list 权限)
│   │   ├── path-guard.ts     # 路径安全检查(防止越权访问)
│   │   ├── sanitize.ts       # 工具结果清理与截断
│   │   ├── agent-binding.ts  # 自我管理工具的按 agent 绑定（默认只给 default）
│   │   ├── cron.ts           # cron_add / cron_list / cron_remove / cron_enable / cron_disable / cron_run
│   │   └── mcp-manager.ts    # mcp_list_servers / mcp_enable_server / mcp_disable_server（+ 载入诊断）
│   │   └── mcp-admin.ts      # mcp_server_add / mcp_server_remove / mcp_server_set_enabled / mcp_reload（写 mcp.toml，MFA）
│   ├── code/                 # Code 模式（/code 斜杠命令）
│   │   ├── index.ts          # 副作用入口，import 触发命令注册
│   │   ├── commands.ts       # /code /chat /plan /auto /new 命令实现
│   │   ├── system-prompt.ts  # buildCodeSystemPrompt()（精简代码专注 prompt）
│   │   ├── exit-plan-mode-tool.ts  # exit_plan_mode 工具（Plan 子模式计划审批）
│   │   └── backends/         # 代码后端类型定义（扩展点）
│   ├── instructions/         # 工作区指令（AGENTS.md 类）装载
│   │   ├── agents-md.ts      # 向上找项目根 / 多候选 + local 覆盖 / 预算与二分截断 / 增量协调
│   │   └── workspace-prompt.ts  # 渲染成 prompt 段（带指纹缓存），供 code / project 模式注入
│   ├── commands/             # 斜杠命令注册表（/help /status /code /plan 等）
│   │   ├── registry.ts       # parseCommand() + executeCommand()
│   │   └── builtin.ts        # 内置斜杠命令（/help /status /code /chat /plan /auto /new /think）
│   ├── cron/                 # Cron 定时任务调度器
│   │   ├── scheduler.ts      # 轮询 jobs/ 目录，热加载 job JSON，到时触发 runner
│   │   ├── runner.ts         # 单步/Pipeline 两种模式；结果按策略推送；session 自动清理
│   │   ├── store.ts          # jobs/ 目录 CRUD（每个 job 独立 <id>.json 文件）
│   │   └── schema.ts         # Job 类型定义（Zod，兼容 once/every/daily；Pipeline steps）
│   ├── ipc/                  # Unix socket IPC（CLI chat ↔ daemon）
│   │   ├── server.ts         # daemon 端：监听 socket，路由 chat/list/new 请求
│   │   ├── client.ts         # CLI 端：连接 socket，流式打印 delta
│   │   └── protocol.ts       # 消息类型定义（Request / Response）
│   ├── mcp/                  # MCP client 管理器（懒加载）
│   │   ├── client.ts         # MCPManager：读配置 → 按需连接 → 注册/隐藏工具 → reload()
│   │   ├── load-report.ts    # 载入诊断的展示层（纯函数，工具 / CLI / 日志共用）
│   │   ├── config-writer.ts  # mcp.toml 块级补丁 + 全量校验 + 原子写 + .bak 备份
│   │   ├── secret-ref.ts     # `${SECRET:NAME}` 引用解析（连接时从 secrets.toml 取值）
│   │   ├── watcher.ts        # mcp.toml 文件监听（内容哈希去抖 → reload → 通知 cron worker）
│   │   └── meta-tools.ts     # 框架级 mcp_* 工具名单（白名单过滤 / 无人值守硬拒绝用）
│   ├── connectors/
│   │   ├── base.ts           # Connector 接口 + InboundMessage + QQ 事件类型
│   │   ├── utils/
│   │   │   └── media-parser.ts  # 视觉消息解析（图片 URL → ContentPart[]）
│   │   └── qqbot/
│   │       ├── index.ts      # 实现 Connector 接口，胶水层
│   │       ├── gateway.ts    # WS 协议 + 消息队列 + 重连 + Session 持久化
│   │       ├── api.ts        # QQ REST API 封装（token singleflight + send + markdown 派发）
│   │       ├── outbound.ts   # 发送限流（1h/4次）+ 降级主动消息 + 媒体预检 + C2C 流式会话
│   │       ├── transcribe.ts # 语音附件转写（SILK → WAV → faster-whisper ASR）
│   │       └── attachments.ts  # 附件下载到 workspace/downloads/ + 内容注入（图片/语音）
│   └── config/
│       ├── schema.ts         # Zod schema（providers + backends + tools + cron + retry 等）
│       ├── loader.ts         # 读 ~/.tinyclaw/config.toml，不存在时自动复制模板
│       └── writer.ts         # 保留注释的 TOML 行级补丁（供 CLI config set 使用）
├── scripts/
│   └── transcribe.py         # faster-whisper 语音转文字脚本（供 transcribe.ts 调用）
├── mcp-servers/
│   ├── browser/              # Playwright 浏览器自动化 MCP server
│   ├── news/                 # 多源新闻抓取/存档/检索 MCP server
│   │   ├── index.ts          # MCP 工具注册：fetch_and_store / read_day / list_days / search_local / rebuild_index
│   │   └── lib/
│   │       └── news_fetch.py # HackerNews + 58 个 RSS 源；L1 SQLite 去重 + L2 n-gram Jaccard 去重
│   ├── notes/                # 动态笔记知识库 MCP server（Agent 隔离，支持 structured/timestamped/freeform）
│   │   └── index.ts          # 工具：list_categories / create_category / add_note / query_notes / search_notes / delete_note / get_due_reminders
│   ├── polymarket/           # Polymarket 预测市场 MCP server(index.ts 待实现,lib/ 已实现签名逻辑)
│   └── sts2/                 # STS2AIAgent Mod MCP server
├── bin/
│   └── tinyclaw.ts           # 全局命令入口（bun link 后注册为 tinyclaw）
├── docs/                     # 文档（本文件所在目录）
├── config.example.toml       # 配置模板，无真实值，供参考
├── mcp.example.toml          # MCP server 配置模板
└── package.json              # bin.tinyclaw 字段声明全局命令
```

### 运行时数据（`~/.tinyclaw/`，不进仓库）

```
~/.tinyclaw/
├── config.toml               # 所有敏感配置（API key、Azure ID、QQ secret）
├── config.toml.bak-*         # 写入前自动备份（保留最近 5 份，0600）
├── config.toml.rejected-*    # 写前校验拒绝的内容留证（0600，submitter 不提交）
├── config.toml.lkg           # last-known-good 配置副本（成功启动后写入，回退用）
├── .config-state.json        # 配置状态：current / lastGood / pending / lastRollback（0600）
├── .safe_config              # SAFE MODE 标记（存在 = 用最小配置启动）
├── jobs/                     # 后台 job：<id>/{meta.json,stdout.log,stderr.log}（0600/0700）
├── mcp.toml                  # MCP server 配置（独立文件）
├── .service_pid              # supervisor 进程 PID（tinyclaw restart 读取）
├── .github_token             # GitHub OAuth token（0600 权限，由 Device Flow 写入）
├── auth/
│   ├── msal-cache.json       # MSAL token 缓存（自动维护）
│   └── totp.key              # TOTP 共享密钥（auth mfa-setup 生成，0600 权限）
├── agents/                   # Agent 工作区（每个 Agent 独立）
│   ├── env                   # 该 agent 自己的环境变量（KEY=VALUE，0600，沙箱内被掩码）
│   ├── default/
│   │   ├── agent.toml        # 元数据（id、createdAt、bindings）
│   │   ├── SYSTEM.md         # Agent 系统提示（可选）
│   │   ├── MEM.md            # 持久记忆（跨 session 偏好与结论）
│   │   ├── SKILLS.md         # 技能目录（技能名 → 主文档路径）
│   │   ├── TASK.md           # Loop Session 默认任务指令（相对 agentDir；可在 loop 配置中覆盖）
│   │   ├── memory/           # 向量索引（index.sqlite）+ 逐字层（transcript/）+ 压缩摘要 YYYY-MM-DD.md
│   │   ├── notes/            # Notes MCP 数据（index.json + <category>.md + remind_state.json）
│   │   ├── skills/           # 技能脚本目录
│   │   └── workspace/        # exec_shell 默认 cwd
│   │       ├── tmp/          # 临时文件
│   │       └── output/       # 输出文件
│   └── <custom>/             # 自定义 Agent
├── sessions/                 # 各 session 的持久化文件
│   ├── qqbot_c2c_<openid>.jsonl
│   ├── qqbot_c2c_<openid>.code.jsonl   # Code 模式独立文件
│   ├── cli_<uuid>.jsonl
│   └── <sanitized-sessionId>.toml      # Loop 配置（[loop] 块，chat loop 命令管理）
├── cron/
│   ├── jobs/                 # 每个 job 独立 JSON 文件（<id>.json），调度器热加载
│   └── logs/                 # 每次 run 的结果日志（<id>.jsonl，追加写入）
├── slaves/                   # Slave(sub-agent)轨迹归档（结束时从 sessions/ 移动至此，不再删除）
│   └── YYYY-MM/YYYY-MM-DD-<slaveId>/
│       ├── trajectory.jsonl  # 完整轨迹：继承的上下文 + 本次全部工具调用与结果
│       ├── meta.json         # task / status / toolsUsed / agentId / masterSessionId / 起止时间
│       └── result.md         # 最终结果全文（agent_trace 读取）
├── reports/                  # 日报存档(<type>/<date>.md,write_report 写入,Dashboard 展示)
├── downloads/                # Dashboard 下载页·临时区(release_file 写入,按 ttlDays 清理)
├── keep/                     # Dashboard 下载页·常驻区(release_file keep=true 写入,可按子目录归类,永不自动清理)
├── dashboard.db              # Dashboard 业务指标数据库(SQLite,db_write 写入;另含 Token 页的 token_breakdown 表)
├── news/                     # news MCP server 的新闻存档
│   ├── YYYY-MM/
│   │   └── YYYY-MM-DD.md     # 每日新闻存档（Markdown，fetch_and_store 写入）
│   ├── seen_urls.db          # L1 URL 精确去重数据库（SQLite）
│   └── .update-pending       # 存在时触发主进程 QMD 重新索引 news 知识库
└── qqbot/
    ├── session.json          # WS Session 持久化（断线续传）
    └── downloads/            # 附件临时文件
```

---

## 模块说明

### LLM 多后端

- 统一 OpenAI-compatible 接口（`LLMClient`）
- 三个命名后端:`daily`(对话)/ `code`(代码任务)/ `summarizer`(摘要压缩)/ `vision`(视觉模型,可选)
- 配置格式：`[providers.*]` 管理凭证，`[llm.backends.*]` 的 `model` 字段使用 `"provider/model-id"` symbol
  - `"copilot/auto"` → 自动选择 Copilot 默认模型
  - `"copilot/claude-sonnet-4.5"` → 指定具体模型
  - `"openai/gpt-4o"` → OpenAI-compatible 后端
- `registry.get(name)` 运行时取后端实例，`registry.init()` 在 main.ts 中异步预初始化所有后端
- 每个后端携带 `supportsToolCalls` 标志（Copilot 后端从模型元数据自动推断；其它 provider 默认 true，可在 `[llm.backends.*]` 用 `supportsToolCalls = false` 手动声明弱模型）：
  - `true`（默认）→ 通过 OpenAI `tools` 参数进行 function calling
  - `false` → 自动切换为**文本模式工具调用**：系统提示注入工具列表与格式规则，LLM 以 `<tool_call>` XML 块响应，Agent 正则解析后执行
- 所有 LLM 调用均受**连接稳定性**保护（重试 / idle timeout / jitter），详见 [RETRY_AND_STABILITY.md](./RETRY_AND_STABILITY.md)

#### 思考档位（DeepSeek 系后端）

`[llm.backends.<role>]` 可配置三个互斥级别的字段（解析优先级见 `src/llm/thinking.ts`）：

| 字段 | 线级效果 | 说明 |
|---|---|---|
| `disableThinking = true` | `{thinking:{type:"disabled"}}` | 彻底关闭思考（优先级最高） |
| `reasoningEffort = "medium"` | `{thinking:{type:"enabled"}} + {reasoning_effort:"medium"}` | 合法值 **none / minimal / low / medium / high / xhigh / max**（api.deepseek.com 实测枚举；DSH 内部用的 `off` **不是**合法线级值，发了直接 400） |
| `thinkingBudget = 4000` | `{thinking:{type:"enabled",budget_tokens:4000}}` | 旧路径，仅当 agent 传 `ChatOptions.enableThinking`（code 模式）时发送 |

- 会话级覆盖：`/think <档位>` 写 `~/.tinyclaw/sessions/<sanitized-sessionId>.toml` 的 `[thinking] level`，
  下一轮 LLM 请求即生效（无需重启），`/think default` 清除。优先级：会话覆盖 > `disableThinking` > `reasoningEffort` > `thinkingBudget`。
- ⚠️ 只有 DeepSeek 系后端接线了这两个线级字段（`LLMClient` 的 `thinkingControl`）；Copilot / OpenRouter / Google 等后端**忽略**会话覆盖，`/think` 会直接提示不支持。
- ⚠️ `reasoning_effort: "none"` **不等于**关闭思考（实测仍有 reasoning tokens 产出）；要关闭只能用 `off` / `disableThinking`。
- `/think` 设置只作用于**该 session 的 ReAct 主循环**；压缩（summarizer）、视觉、cron job、subagent 各用自己的后端默认值。


#### OpenAI-compatible（`provider` 不填 / 为 `"openai"`）

手动提供 `baseUrl` + `apiKey` + `model`，方便对接任意兼容 API。

对接不支持 function calling 的弱模型时,在 `[llm.backends.*]` 设 `supportsToolCalls = false`,自动改走 textMode 文本工具调用(详见上文 supportsToolCalls 标志说明):

```toml
[llm.backends.daily]
model = "openai/some-weak-model"
supportsToolCalls = false
```

#### GitHub Copilot（`provider = "copilot"`）

| 步骤 | 实现 | 说明 |
|------|------|------|
| 1. GitHub OAuth 认证 | `copilotSetup.ts` | RFC 8628 Device Flow，首次跳出浏览器授权，令牌写入 `~/.tinyclaw/.github_token`（0600） |
| 2. Token 解析优先级 | `copilot.ts` `resolveGitHubToken()` | token 文件 → `gh` CLI → Device Flow（同进程内缓存，不重复触发） |
| 3. Copilot token 换取 | `copilot.ts` `getCopilotToken()` | `GET /copilot_internal/v2/token`，TTL 缓存自动刷新 |
| 4. 模型动态发现 | `copilot.ts` `getCopilotModels()` | `GET /models`，回传 vendor / category / maxOutput / contextWindow 等 |
| 5. 乘数查表 | `copilot.ts` `MODEL_MULTIPLIERS_PAID` | 按官方文档静态表查 premium request 倍数；企业账号优先用 API 返回值 |
| 6. LLMClient 构建 | `copilot.ts` `buildCopilotClient()` | 注入自刷新 copilotFetch，每请求动态换 token |

**模型选择（`model = "auto"` 时）：**
```
is_chat_default → versatile+picker → powerful+picker → any picker → 第一个
```

**premium request 乘数表（付费计划）：**

| 乘数 | 模型 |
|------|------|
| free (×0) | GPT-4o · GPT-4.1 · GPT-5 mini · Raptor mini |
| ×0.25 | Grok Code Fast 1 |
| ×0.33 | Claude Haiku 4.5 · Gemini 3 Flash · GPT-5.1-Codex-Mini |
| ×1 | Claude Sonnet 系列 · GPT-5.x · Gemini 2.5/3 Pro 系列 |
| ×3 | Claude Opus 4.5 / 4.6 |
| ×30 | Claude Opus 4.6 (fast mode, preview) |

来源：[github/docs `data/tables/copilot/model-multipliers.yml`](https://github.com/github/docs/blob/main/data/tables/copilot/model-multipliers.yml)

### QMD 向量记忆

- 每轮对话追加写入 `~/.tinyclaw/memory/sessions/YYYY-MM-DD.md`
- 新对话开始前自动 `qmd.search(userInput)` 注入相关历史记忆
- token 超 80% 阈值 → summarizer LLM 生成摘要 → 归档进 QMD → 无缝开新 session
- Embedding 后端（二选一）：
  - **RKLLM NPU HTTP embed**（推荐，RK3588 板子）：`rkllmEmbed.enabled = true`，1024 dim，启动 `~/rkllm-embed-server/start.sh`
  - **本地 GGUF**（默认，CPU）：`rkllmEmbed.enabled = false`（默认），`embedModel = "hf:..."` 指定模型（~380MB）

### Microsoft MFA

tinyclaw 支持三种 MFA 接口（通过 `auth.mfa.interface` 配置）：

**Interface A — 文字确认（`simple`，默认）**
- 向用户发送操作描述，等待回复"确认" / 其他内容（取消）

**Interface B — MSAL number-matching（`msal`）**
- Azure AD App Registration + Microsoft Authenticator 推送通知
- token 缓存在 `~/.tinyclaw/auth/msal-cache.json`，静默刷新

**Interface C — TOTP 验证码（`totp`）**
- 用户通过 Authenticator App（Google/Microsoft Authenticator 等）生成 6 位码回复确认
- 初次配置：`tinyclaw auth mfa-setup` → 生成二维码扫码绑定 → 密钥保存到 `~/.tinyclaw/auth/totp.key`

所有接口：超时 60s（可配）或用户拒绝 → 操作 abort  
高危工具范围：`exec_shell` / `delete_file` / `write_file` / `edit_file`（以及 `config.toml` 自定义黑名单）

### 自指运行权限（`[selfAccess]`）

Agent 的"自身"就是 `~/.tinyclaw`。默认它对这里**没有**额外权限（越界路径要走确认流程），
被 `config.toml` 授权的 agent 则获得**完整访问权**：

```toml
[selfAccess]
grantedAgents = ["default"]   # 被授权的 agentId；"*" = 全部
allowDelete   = true          # false 时 self_runtime_delete 只做 dry-run
exemptMfa     = true          # 只动运行时目录的调用免除 MFA 逐次确认
maxReadBytes  = 200000        # self_runtime_read 单次返回上限
```

**能力**：`self_runtime_scan`（占用扫描 + 可清理候选）、`self_runtime_read`（读文件/列目录）、
`self_runtime_delete`（`confirm: true` 才真删，支持 `dry_run`）。此外 `write_file` / `edit_file` /
`delete_file` 对运行时目录内的路径不再触发"越界确认"，`self_status` 也会报告运行时占用。

**唯一的例外是密钥**（`tools/path-guard.ts` 的 `isRuntimeSecretPath`）：

| 类别 | 内容 |
|---|---|
| 运行时根下按名拒绝 | `config.toml`、`secrets.toml`、`mcp.toml`、`env`、`.env`、`.github_token`、名字含 `token` 的文件、`auth/**` |
| 全局按扩展名拒绝 | `*.key`、`*.pem`、`*.p12`、`*.pfx` |

密钥不可读（`read_file` / `read_image` / `self_runtime_read` 一律拒绝）、不可写（`write_file` /
`edit_file`）、不可删（`delete_file` / `self_runtime_delete`），且**不因授权而放宽**。
另有三个"删了会出事"的保护项：运行时根目录本身、根下的 `.git`（`tinyclaw-submitter` 的配置备份仓库）、
`agents` 整体。

### 沙箱与权限约束（`[sandbox]`）

权限分两层，各司其职：

| 层 | 机制 | 拦得住 | 拦不住 |
|---|---|---|---|
| **边界层** | `exec_shell` 跑进 `bwrap`：全盘只读为底 + 按目录可写 + **密钥文件掩码成空文件** + 可选断网 | 静态二进制、直接 `syscall()`、任何绕过"检查"的玩法（内核强制） | 环境变量里的密钥（见下） |
| **策略层** | 审计流（`~/.tinyclaw/audit/YYYY-MM.jsonl`，0600 追加写）+ 无人值守白名单 + MFA 兜底 | 越权**意图**：`delete_file` 之类在 cron/loop 里被拒并被记录 | 铁了心绕开策略实现的代码（因此不能当安全边界） |

```toml
[sandbox]
enabled       = true          # 总开关（默认 false）
execShell     = "sandbox"     # "sandbox" | "host"
onUnavailable = "deny"        # bwrap 不可用时拒绝执行，而不是偷偷退回本机
maskSecrets   = true
network       = "allow"       # "deny" 用于不可信内容任务（同时强制收敛环境变量）
inheritEnv    = true
extraRwPaths  = []

[sandbox.audit]
enabled = true

[sandbox.grant]
enabled          = true       # 路径级无感提权（fs_grant）
ttlSecs          = 3600
allowOutsideHome = false

[sandbox.unattended]
mode        = "allowlist"     # cron/loop 只允许 allowedTools
mfaFallback = "deny"          # 无人值守且 MFA 无法送达 → 拒绝（历史行为是静默放行）
```

**掩码清单**（`src/sandbox/bwrap.ts` 的 `MASK_FILES` / `MASK_DIRS` / `MASK_HOME_PATHS`）：
`~/.tinyclaw/{config,secrets,mcp}.toml`、`env`、`.github_token`、`yingli_token.json`、`auth/`、
运行时目录下的 `*.key` / `*.pem` / `*.p12`、`~/.ssh`、`~/.aws`、`~/.netrc`、`~/.gnupg`、
`~/.config/gh`、`~/.docker/config.json`。
掩码例外：`[sandbox].readableSecretPaths` 里显式列出的路径保持可读（默认空），
用于"脚本直接读 `secrets.toml` 取 key"这类现实需求 —— 密钥取用方式的重新设计见 `tmp/job-credentials-design-20260911.md`。

**沙箱可写范围**（默认最小：**只有 workspace**）：

| 场景 | 可写 |
|---|---|
| 任何来源 | `agents/<id>/workspace`（含 `tmp/` `output/` `downloads/`）+ 系统 `/tmp` |
| code 模式 | 另加**当前项目目录**（`codedir`，即 `ctx.cwd`） |
| cron job | 另加该 job 配置里 `writablePaths` 显式声明的路径（如 `~/.tinyclaw/data`、`dashboard.db`） |
| loop trigger | 同上，`loops/<id>.json` 的 `writablePaths` |
| chat / cli | 用 `fs_grant` 主动申请（路径级、TTL、审计） |
| agent 目录其他部分（`memory/` `cards/` `skills/` `MEM.md` `SYSTEM.md` `agent.toml` `access.toml` …） | ❌ 需显式声明/提权 |

声明**文件**时会自动放开它的 SQLite 边车（`-wal` / `-shm` / `-journal`）——否则 WAL 模式下会报
`attempt to write a readonly database`。
⚠️ **专用工具不受白名单限制**：`memory_*` / `write_report` / `create_skill` / `self_runtime_*` 直接写自己的
专属文件（不经 `checkWritePath`），它们是被认可的接口；只有 `write_file` / `edit_file` / `delete_file`
三个通用工具走路径白名单。

**无人值守白名单**（`[sandbox.unattended]`）：cron / loop 的工具调用按 `allowedTools` 放行，默认包含
只读（`read_file`/`search_store`/`self_*`/`cron_list`/`mcp_list_servers`/`session_get`）、记忆写入、
报告类工具、`exec_shell`（沙箱内）与子 agent 系列（`agent_fork`/`agent_wait`/`agent_status`/`agent_trace`/`agent_abort`）。
**不含**破坏性（`delete_file`/`self_runtime_delete`）、特权（`restart_tool`/`cron_add`/`cron_remove`/`mcp_enable_server`…）
与出网（`read_url`/`web_search`/`http_request`）。**MCP 自管理工具**（`mcp_server_add`/`mcp_server_remove`/
`mcp_server_set_enabled`/`mcp_reload`）与**配置自管理工具**（`config_reload`/`config_set`）更进一步：它们在
ReAct 通道**硬拒绝**（`HARD_DENY_REACT_UNATTENDED`，写进 `allowedTools` 也不放行）—— 新增 server 的 `command`
是任意可执行程序，配置里又装着 MFA / 沙箱 / 无人值守白名单本身，都不能在没人看着时改。
`job_start` 同样硬拒绝：后台进程会**活过这一轮**（`detach` 甚至活过服务重启），等于把执行挪到监督窗口之外。

#### 两个通道：声明式 `steps` vs 模型驱动 `react`

无人值守下同一个工具可能由两种途径触发，信任级不同（`auth/tool-policy.ts` 的 `ToolChannel`）：

| 通道 | 来源 | 白名单外的处理 | `agent_fork` |
|---|---|---|---|
| `steps` | job / loop 配置里**声明式写死**的 tool 步骤（用户显式设计，可审计） | 拒绝 | **允许**（如股市日报按市场 fan-out） |
| `react` | ReAct 循环里**模型临场挑选**的工具 | 拒绝 | **硬禁止**（`HARD_DENY_REACT_UNATTENDED`，不受 `allowedTools` / `mode=all` 影响） |

理由：配置里的步骤是"用户写死的意图"，模型临场决定则是"没人看着时的即兴发挥"——
后者 fork 等于再开一个不受监督的 agent。ReAct 侧被拒时，拒绝文案会告诉模型改用声明式步骤表达 fan-out。
`channel=steps` 的放行也会写入审计，便于事后核对某个 job 到底跑了什么。

⚠️ **环境变量是掩码盖不住的一条通道**：`~/.tinyclaw/env` 在服务启动时被注入 `process.env`
（`main.ts` 的 `loadEnvFile`），所以 `inheritEnv = true` 时沙箱内的命令仍能看到那些变量。
`network = "deny"` 会**强制**收敛环境（只透传 `envAllowlist`），因为那个场景正是要防外泄。
长期方案：技能改走 `http_request` 的 `$SECRET_NAME` 间接引用，而不是依赖原始环境变量。

⚠️ **副作用**：沙箱内 `~/.ssh` 被掩码 → `git push` / `ssh` 在 agent 的 shell 里会失败（改用 HTTPS + token）；
未绑定目录一律只读，需要写入的新目录要加进 `extraRwPaths`。

#### 提权（`[sandbox.elevation]`）—— 沙箱默认，提权例外

模型看不到沙箱本身，只能表达意图：`exec_shell({ command, elevate: true })`。框架把它变成一次可见、可拒、可追溯的审批：

| 级别 | 判定（`classifyElevation`） | 默认行为 |
|---|---|---|
| E1 只读类 | 未命中 E2 特征（`ssh -T`、`systemctl --user status`、`git status`） | `e1AutoApprove = true` 时免批执行 |
| E2 有副作用 | 重定向写、`rm/mv/cp/chmod`、`pip/npm install`、`git push`、`systemctl start/stop/restart`、`sudo`… | **每次确认**（`onAskUser` 按钮优先，否则 MFA 文本确认） |

- **一次性令牌**：批准后签发 `{命令哈希, TTL}`（默认 120s），同一条命令不再重复询问；**换命令即失效**。
- **节流**：同一条命令 5 分钟内最多请求 `maxRequestsPer5min` 次（默认 1），防止被拒后刷屏重试。
- **无人值守禁止提权**（`allowInCron = false`）：cron / loop 里没人能审批。
- **子 Agent 禁止提权**（`approvalPolicy: "never"`，见「Agent Fork」节）：Slave 只能在委派时定下的作用域里干活，
  `elevate: true` 一律**确定性拒绝**（工具结果 `已拒绝：子 Agent 不允许提权（approvalPolicy=never）…`）+ 审计，连提示都不发。
- **fail-closed**：没有可用交互通道时一律拒绝（"没人能批准" ≠ "自动批准"）。
- **可见 + 可审计**：提权执行前发一条 `⚠️ 本次在沙箱外执行：<命令>`，并写审计（含等级、是否复用令牌）。
- 白名单：只有 `allowedAgents` 里的 agent 能提权；总开关默认 **false**。

#### 两条提权路径：`fs_grant`（路径级）与 `elevate`（命令级）

两者解决不同问题，**不要混用**：

| | `fs_grant`（`auth/fs-grant.ts` + `tools/fs-grant-tool.ts`） | `elevate`（`sandbox/elevation.ts`） |
|---|---|---|
| 作用对象 | **一个路径/目录** | **单条 shell 命令** |
| 语义 | 把该路径加进可写集合：工具层放行 + 沙箱 bind 成可写（**人仍在沙箱内**） | 这条命令**脱离沙箱**在宿主机跑 |
| 复用 | 同路径 + TTL（默认 3600s），`write_file`/`edit_file`/`exec_shell` 都受益 | 同命令哈希 + TTL（默认 120s），换命令即失效 |
| 审批 | **不打扰用户**（agent 显式调用即可），写审计 | E1 免批 / E2 每次确认 |
| 典型用途 | chat 想写 `~/Documents`、某个项目目录 | `ssh` / `git push`（需要 `~/.ssh`） |

`fs_grant` 的硬边界：只接受 `$HOME` 内、已存在、非密钥、非 `~/.tinyclaw`、非受保护目录（`.ssh` 等）的路径；
**cron / loop 一律拒绝**（无人值守的可写范围只能由任务配置的 `writablePaths` 声明）。
授权集合存在 `Session.grantedWritePaths`（带 TTL，`argsAreSelfRuntimeOnly()` 也会认它 → 免 MFA）。

**授权随 fork 继承给子 Agent**：`agent_fork`（含 auto-fork continuation）与 `skill_run` 的同步子 Agent，
在 fork 时把 master **仍在有效期内**的授权复制一份给子会话（`Session.inheritWriteGrantsTo()`，
TTL 取父的剩余时间、不延长）。语义是"master 申请过的路径，子 Agent 也能用"——子 Agent 自己
**没有任何审批能力**（`approvalPolicy: "never"`，见「Agent Fork」节），只是继承了一个已打开的范围。
未申请过的路径不受影响，已过期的条目不会被复制。

**`elevate` 不下传**：命令级提权与**发起方**绑定（执行发生在发起方的进程/沙箱上下文里），
master 的提权令牌不能转给子 Agent；子 Agent 调 `exec_shell({ elevate: true })` 一律确定性拒绝。

#### 无人值守的密钥：按任务声明（方案 B）

沙箱默认把 `secrets.toml` 掩码成空文件。job / loop 在配置里声明所需密钥后，
运行时生成**只含这些 key** 的临时文件并 bind 回**原路径** → 脚本零改动，但每个任务只看得见自己声明的密钥：

```json
{ "id": "lj50xco3", "secrets": ["DEEPSEEK_API_KEY"], "writablePaths": ["~/.tinyclaw/dashboard.db"] }
```

未声明 = 脚本读到空文件（安全默认）；物化与清理都写审计（`secrets_filter` 事件）。
实现见 `src/sandbox/secrets-filter.ts`；方案对比见 `tmp/job-credentials-design-20260911.md`。
全局例外 `[sandbox].readableSecretPaths` 仍然保留，但**优先用按任务声明**。
**code_assist 工具**：Master Agent 将代码任务委派给两个后台子 Agent 协作完成，不污染主对话历史。

#### 架构图

```
用户
 │ 发出代码任务
 ▼
Master Agent（chat 模式，daily LLM）
 │ 调用 code_assist(task)
 ▼
code_assist.runInternal()
 ├─ 一次性 MFA 预授权（两个子 Agent 共享）
 ├─ 创建 dailySession（slaveDepth=1，mfaPreApproved）
 │   绑定（parentId = masterSession）
 ├─ 创建 codeSession（slaveDepth=2，mfaPreApproved）
 │   绑定（parentId = dailySession）
 └─ slaveManager.fork(dailySession, task, dailyRunFn)
       │  后台异步运行
       ▼
  Daily 协调 Agent（daily LLM，系统提示：DAILY_SUBAGENT_SYSTEM）
   │  分析任务、制订计划、指挥 code 执行
   │
   ├─ 调用 run_code_subagent(instruction)
   │       └─ 同步等待 Code Agent 完成（ctx.codeRunFn）
   │
   ├─ 调用 ask_master(question, context, planPath?)
   │       ├─ 将问题 + plan.md 渲染为图片发给用户（mdToImage）
   │       ├─ 阻塞等待用户回复（session.pendingSlaveQuestion）
   │       └─ main.ts 拦截用户消息 → resolve() 解除阻塞
   │
   └─ 任务完成 → onSlaveComplete → Master 注入结果 → 通知用户
               ↕
  Code 执行 Agent（code LLM，系统提示：CODE_SUBAGENT_SYSTEM）
   读文件 / 写文件 / 执行命令 / 提交代码 …
```

#### 关键设计点

- **MFA 预授权**：`code_assist` 调用时触发一次 MFA，授权两个子 Agent 的 `mfaPreApproved = true`，后续工具调用跳过 MFA 弹窗
- **Session 绑定**：`session.bindParent()` 存储父子关系（`parentId` / `childIds[]`），便于追踪和清理
- **ask_master 阻塞机制**：daily 子 Agent 调用 `ask_master` → 在 `session.pendingSlaveQuestion` 上设置 Promise → `main.ts` 拦截用户下条消息 → resolve unblock → daily 子 Agent 继续运行
- **代码隔离**：code 子 Agent `slaveDepth=2`，无法再触发 fork，也不能调用 `ask_master`
- **反向汇报链**：code → daily（同步，工具返回值）；daily → master（异步，`onSlaveComplete`）；master → 用户（connector.send）

**Code 模式（`/code` 命令）**：切换为代码专注会话，独立 JSONL 文件，滑动窗口压缩，工具轮次上限 25（可配）。  
内置 **Plan / Auto 子模式**（`/plan` / `/auto`）：Plan 模式下 AI 先规划，调用 `exit_plan_mode` 工具提交计划摘要，用户确认后再执行。

### QQBot Connector

QQBot 是**内置 connector**，无需插件，填配置即用。

| 层 | 文件 | 职责 |
|---|---|---|
| API | `api.ts` | QQ REST API 封装（token singleflight、send 系列方法；`markdownSupport` 开启时以 `msg_type: 2 + markdown.content` 发送，否则 `msg_type: 0 + content`） |
| 传输 | `gateway.ts` | WebSocket 协议（Hello/Identify/Resume/Heartbeat/Reconnect） |
| 队列 | `gateway.ts` | 每 peerId 独立串行队列，跨用户并行（最多 10 并发） |
| 重连 | `gateway.ts` | 递增延迟重连（1s→60s），三档 Intent 权限自动降级 |
| 发送 | `outbound.ts` | 被动回复限流（1h/4次），超限自动降级主动消息，长文本分块；`C2CStreamSession` 用官方 `/stream_messages` 流式输出**单聊最终回复**（整段只占 1 次额度；失败/前缀不匹配自动回退普通发送）。⚠️ **流式消息有长度预算**：响应里的 `remain_msg_len`（字符数）是硬约束，超限后平台**静默丢弃**后续分片（请求仍 200），消息会停在"生成中"、最后一片 `input_state=10` 也丢——表现为手机只显示开头几个字而 Dashboard 正文完整。因此该会话**读 `remain_msg_len` 建容量**（另加 2048 字节保守上限，实测 585 字≈1755B 通过、778 字≈2334B 被截断），超预算即停止推送，收尾时用**能装下的最长前缀**（优先段落边界）发 `input_state=10`，剩下的正文由 `main.ts` 用普通发送续发（`finish()` 返回 `{streamed, sentText, remainder}` 表达这个分工） |
| 富媒体 | `utils/media-parser.ts` | `<img>/<audio>/<video>/<file>` 标签解析（含 `qqimg` 等别名与代码块屏蔽）。流式路径额外用 `splitMediaText()` 把正文与媒体标签分开：**正文走流式、媒体单独走普通发送**——`sendMessage()` 才会解析标签并上传文件，若把标签直接流式推给用户，用户只会看到 `<file src=.../>` 裸文本且文件永远发不出去；推送前用 `stripMediaForStream()` 剥离标签并扣住未闭合的标签起始 |
| 富媒体上传 | `api.ts` | `file_type`：**1=图片(png/jpg)、2=视频(mp4)、3=语音(silk)、4=文件(任意)**（顺序不是"音频在视频前"，改这里前先对官方文档）。**下发用哪个类型由文件格式决定，标签只表达意图**（`outbound.ts` 的 `wireMediaType()`）：`.silk`→3、`.mp4`→2、`.png/.jpg`→1，其余一律 4 —— 所以 `mp3` 标成 `<audio>` 也是**文件附件**，不会被 QQ 塞进语音气泡。**小文件**走 `file_data`（base64 内联单次请求，**编码后约 10 MB 为网关上限 ≈ 原始 7.5 MB**）；**大文件**走官方**分片上传**（`upload_prepare` → 逐片 PUT 预签名 URL → `upload_part_finish` → 携带 `upload_id` 调 `/files` 合并拿 `file_info` → 发 `msg_type:7` 消息），上限 200 MB。被服务端以"格式不支持"(850019) 拒收时改用 `file_type=4` 重发（分片路径在**预上传**阶段就发现，零字节代价） |
| 接口 | `index.ts` | 实现 `Connector` 接口，胶水层。`send()` 返回 `SendOutcome`（`hadMedia` / `mediaFailed` / `mediaError`）：媒体失败时会静默降级为纯文本，调用方据此判断"是否真的送到了" |

**事件类型映射：**

| QQ 事件 | `InboundMessage.type` |
|---|---|
| `C2C_MESSAGE_CREATE` | `"c2c"` |
| `AT_MESSAGE_CREATE` | `"guild"` |
| `DIRECT_MESSAGE_CREATE` | `"dm"` |
| `GROUP_AT_MESSAGE_CREATE` | `"group"` |

Session 持久化到 `~/.tinyclaw/qqbot/session.json`，重启后自动 Resume，appId 变更自动失效。

**多 QQBot 实例支持：**

除单 bot 配置 `[channels.qqbot]` 外，支持 `[channels.qqbots.<id>]` map 同时运行多个 bot：

```toml
[channels.qqbots.main]
appId        = "102xxxxx"
clientSecret = "secret1"
agentId      = "default"   # 绑定的 Agent

[channels.qqbots.work]
appId        = "103xxxxx"
clientSecret = "secret2"
agentId      = "work"      # 各 bot 可绑定不同 Agent
```

每个 bot 有独立的 token/gateway/session 状态，通过 `botId` 路由，互不干扰。

**InboundMessageBus（消息路由层）：**

`src/connectors/inbound-bus.ts` 是统一入站消息路由器：
- 接收所有 bot 的 `InboundMessage`，根据 `agentId` 路由到对应 Session
- 斜杠命令（`/code`、`/plan`、`/status` 等）在此层拦截，**优先于** LLM runAgent 处理
- plan / ask_user 等待期间，`/status` 等命令仍可即时响应


### Cron 定时任务

- 数据存储：`~/.tinyclaw/cron/jobs/` （每个 job 独立 `<id>.json` 文件）
- 支持三种调度：`once`（ISO 8601 一次性）/ `every`（固定间隔秒数）/ `daily`（每天 HH:MM）；`daily` 同时支持 `timesOfDay`（数组，一天多个时间点）
- 触发后启动独立 Agent 会话执行任务，结果通过 `Connector.send()` 主动推送
- 通知策略：`always`（每次）/ `on_change`（仅结果变化时）/ `on_error`（仅出错时）/ `never`
- 支持跨 run 对话历史（`stateful = true`）
- `model` 字段:每个 job 可单独指定使用的模型(如 `"copilot/claude-haiku-3.5"`),覆盖全局默认
- `mfaExempt: true`:Pipeline 模式的 `tool` step 默认豁免 MFA,Cron 任务无需人工审批

**两种运行模式：**

1. **单步模式**（默认，向后兼容）：触发后对 `message` 字段执行一次 `runAgent()`，LLM 全权处理任务
2. **Pipeline 模式**：job 含 `steps` 字段时激活，多步骤串行执行，共享同一个 stateful session：
   - `{ type: "tool", name, args }`：直接调用指定工具（不走 LLM），输出注入 session 上下文供后续步骤感知
   - `{ type: "msg", content }`：向 session 注入 user 消息，触发完整 `runAgent()`（LLM 生成回复）
   - 最后一个 `msg` step 的 LLM 输出作为最终推送内容；若无 `msg` step，则取最后一个 `tool` step 的输出
   - 典型用例：`tool(exec_shell, curl …)` → `msg("根据以上数据生成简报")` → 推送给用户

详见 [CRON_PIPELINE.md](./CRON_PIPELINE.md)。

### Loop Session（持续自主执行）

Loop Session 将一个普通 Session 标记为"自主持续运行"模式：服务按固定间隔读取 `TASK.md`，调用 LLM 执行任务，结果按策略推送。

- **配置位置**：`~/.tinyclaw/sessions/<sanitized-sessionId>.toml` 中的 `[loop]` 块
- **与 Cron 的区别**：Loop 复用常驻 Session，记忆跨 tick 持续累积；Cron 每次独立 session
- **CLI 管理**：`tinyclaw chat loop list/show/enable/disable/trigger/set`
- **并发保护**：上次 tick 未完成时自动跳过，不叠加执行
- **日志**：`~/.tinyclaw/cron/logs/loop:<sanitized-sessionId>.jsonl`

> `~/.tinyclaw/sessions/<sanitized-sessionId>.toml` 是**会话级配置文件**，除 `[loop]` 外还存
> `[mcp_chat]` / `[mcp_code]`（会话启用哪些 MCP server）与 `[thinking] level`（`/think` 的思考档位覆盖）。

详见 [LOOP_SESSION.md](./LOOP_SESSION.md)。

### 工具调用的 `__purpose`(进度旁白)

取代了此前的**定时心跳**(`agent.heartbeatIntervalSecs`,默认每 120s 推一句写死的"仍在处理中")。
现在进度提示完全由模型自己写的短旁白驱动。

- **注入**:每个工具的参数 schema 会被加上可选字段 `__purpose`(内置工具、MCP 工具、`customTools` 一视同仁,收口在 `agent.ts` 组装 `tools` 之后)。实现**必须深拷贝**——`getAllToolSpecs()` 返回注册表里的同一对象引用,就地改会让 schema 每轮无限膨胀
- **剥离**:执行前统一从参数中剥离,工具实现与 MCP server 永远看不到它;MFA 判定与告警文案也用剥离后的参数。文本模式(`<tool_call>` XML)走同一条路径
- **进历史**:`__purpose` 就在 assistant 消息的 `tool_calls[].function.arguments` 里,随 JSONL 自然持久化。**不额外插入独立消息**——插在 `assistant(tool_calls)` 与 `tool(result)` 之间会打断配对触发 400
- **展示仲裁**(`core/purpose-arbiter.ts`):每轮 `__purpose` 不设上限,但不是每条都给用户看
  - **只有运行超过 `agent.purposeHoldMs`(默认 4s)的工具才算"用户确实在等"**;快工具静默
  - 两个触发点:①工具运行满 hold ②长工具刚结束且当前无在跑的工具
  - **新鲜度约束**:发送时按**当时的真实进度**重新选取——有工具在跑就取"最后发起"的那条,否则取"最后完成"的那条;已被后续进展超越的候选一律丢弃,**不回放**
  - `agent.purposeMinGapMs`(默认 3s)限制两次展示的间隔;`agent_fork` / `session_send` 这类"秒返回但把活干在后台"的工具跳过 hold 直接展示
- **长度**:`agent.purposeMaxUnits`(默认 10)。计长单位:CJK 按字、连续拉丁串按词,**emoji 不计**;超出按**图形簇边界**截断(`Intl.Segmenter`,不会切断 emoji 或代理对)
- **不因超长拒绝工具调用**——只截断
- 开关:`agent.toolPurpose`(默认 true)

### Agent Fork(Master-Slave)

- **自动 fork**(`agent.autoForkThresholdMs`,默认 120000 = 2 分钟,**0 = 关闭**):ReAct 循环里每批工具执行完检查一次,
  本轮累计运行超阈值、且是交互式 Master(非 code 模式 / 非 Slave / `slaveDepth === 0` / 提供了 `onSlaveComplete`)时,
  调 `slaveManager.forkContinuation()` 克隆 Master 全量上下文起一个 continuation Slave,**Master 当前轮直接结束**并回一句
  "已自动在后台创建 Sub-Agent"。chat / cron / loop 三条入口共用该阈值(`runAgent` 读 `config.agent.autoForkThresholdMs`),
  单次运行可用 `AgentRunOptions.autoForkThresholdMs` 覆盖。⚠️ 它只克隆上下文、**不携带 Master 手上的中间结论**
  (见 `AGENTS.md` §7.4),需要模型自己收尾的复杂任务建议置 `0`,改由模型显式 `agent_fork`
- **委派口径**(常驻 prompt `## Background tasks (agent_fork)` 与 `agent_fork` 工具描述):预计 >5 秒、
  或含 ≥2 个可独立完成的子任务时**默认 fork**;多份独立部分用 `result_mode="wait"` 并行 fan-out 后
  `agent_wait()` 汇总。细节规范在**仓库内置技能** `skills/agent-orchestration/SKILL.md`
  (触发短语「分叉/子 agent/子任务/并行任务/后台任务」,命中后模型 `read_file` 读取)
- `agent_fork` 工具:在后台启动 Slave agent,异步执行耗时任务
  - `context_mode`:继承模式,默认取 `memory.slaveContextMode`
    - `task-only`:不继承历史(system prompt 里的 MEM.md / SKILLS.md 仍然在)。**背景自足时最省**
    - `minimal`:Master 压缩摘要 + 最近 ≤6 轮
    - `standard`(默认):Master 压缩摘要 + 预算内尽可能多的近期轮次
    - `full`:同上但不设轮数上限(仍受预算约束)
  - `context_rounds`:轮数**上限**(与 mode 取更严格者),默认 10,最大 30
  - **预算按窗口比例**:`budgetTokens = clamp(窗口 × memory.slaveContextRatio, 8000, 窗口 − 8000)`。
    固定字符数在不同窗口下不自洽(同一个值在 128k 窗口占 27%、在 800k 窗口只占 4%),故改为比例制。
    Slave 每次 fork 都是新 session,继承内容首次请求**缓存全部未命中、按全价计费**(Master 那边是热的),
    因此**不要全拿**
  - **只取最近**:从最新一轮向前累计直到用满预算即停(不是"取一批再从最旧砍"——那会先把远期拉进来、
    再砍掉近因边缘,顺序是反的)。按轮对齐,起点必须落在 `role:"user"`
  - **继承的职责是"近因"**:本 claw 的 chat 模式是长会话陪伴/管家型,最早那条消息可能来自几个月前。
    远期由三处承担:system prompt 里的 `MEM.md`(长期偏好)、继承时注入的 Master 压缩检查点(本会话中段)、
    以及启动时的**召回层**(见下)
  - **召回层**(`memory.slaveRecall`,默认开):Slave 的自动记忆检索在 `agent.ts` 里被 `!isSlave` 关闭,
    因此启动时补两件事:注入该 Agent 的 `ACTIVE.md`("近期活跃上下文 / 未完成事项 / 最新要求")、
    用 Slave 的 `task` 做一次 QMD 语义检索并注入相关历史片段。把"远期记忆"从"塞进上下文"变成"按需召回"。
    整层带 **3s 超时**(`RECALL_TIMEOUT_MS`)——它位于 `runFn` 之前,耗时直接叠加到 Slave 启动延迟上,
    而检索内部含 embed 服务探活(5s 超时)与 sqlite 回退路径;超时即放弃召回并记日志,绝不拖住 Slave 开工
  - 继承为**结构化复制**(保留 `tool_calls` 与 `role:"tool"`),并同步写入 Slave 自己的 JSONL,使轨迹自包含
  - 继承时**剥掉** Master 消息上的 `_loopTaskRef`:该字段的语义是"最后一条此类消息由 `getMessagesForLLM()` 展开为该路径的文件内容",而 Slave 继承到的 ref 指向 **Master 的** loop 任务文件;保留会让 Slave 侧用它顶掉真正的注入载荷
  - **工作区指令不计入继承预算**:继承来的 `AGENTS.md` 注入(`src/instructions/`)在预算核算里按 **0 字符**计,
    但仍随上下文一起继承(子 Agent 该看到父的仓库规矩)。否则项目模式下 48 KB 量级的基线会把真实对话轮次
    全部挤掉("被指令饿死")——注入排在队尾,而裁剪只从队首丢轮
  - **审批策略钉死 `never`**:Slave 的 `runAgent` 一律带 `approvalPolicy: "never"`(对齐 DSH 委派语义),
    即不能弹 MFA、不能 `exec_shell({elevate: true})`、不能 `ask_user`,命中即确定性拒绝 + 审计;
    cron / loop 的无人值守消息步骤同样钉死该策略
  - **继承路径级授权**:fork 时把 master **仍在有效期内**的 `fs_grant` 授权复制给 Slave
    (`Session.inheritWriteGrantsTo()`,TTL 取父的剩余时间);工具层 `checkWritePath` 与沙箱层
    (`ctx.masterSession.listWriteGrants()`)都会认它,因此"master 申请 → 子 Agent 可用"不需要子 Agent 伸手要权限
    (子 Agent 也可自行 `fs_grant`,但 `elevate` 永不继承)
  - `result_mode: "inject"`(默认):Slave 完成后自动将结果注入 Master session(注入消息带
    `<!-- subagent:result:<slaveId> -->` marker,使"最后一条真实用户消息"的判定不会把它当成用户输入),触发新一轮 LLM 推理后回复用户
  - `result_mode: "wait"`:Slave 完成后静默,Master 需主动调用 `agent_wait(slave_id)` 获取结果;适合并行 fork 多个 Slave 后统一汇总
- `agent_status` 工具:查询单个 Slave 进度(当前阶段 / 已用工具与调用次数 / 实时输出尾部 / 轨迹目录),或列出所有 Slave
- `agent_wait` 工具:等待指定 Slave(或当前会话所有 Slave)完成并返回**结果全文**,支持 `timeout_secs`。
  超时**不改写 Slave 状态**,返回 `timedOut` 标志与仍在运行的 id 列表(超时是调用方的观察结果,不是被观察对象的状态)
- `agent_trace` 工具:检索已归档的 Slave 轨迹(不传参列出最近归档;传 `slave_id` 取结果全文与轨迹路径)
- `agent_abort` 工具:软中断 Slave(只记录中止意图,状态由真正收尾决定,避免状态领先于事实)
- 最大嵌套深度 1:Slave 内不允许再 fork(`agent_fork` 返回错误提示)
- **轨迹归档**:Slave 结束时其 JSONL 被**移动**到 `~/.tinyclaw/slaves/YYYY-MM/YYYY-MM-DD-<slaveId>/`
  (`trajectory.jsonl` + `meta.json` + `result.md`),不再删除;进程重启后遗留的孤立 JSONL 由 `gc()` 归档而非丢弃
- **统一 run 队列**:同一 session 上的一切 `runAgent` 经 `Session.runExclusive()` 严格串行
  (用户消息 / Slave 结果注入 / `session_send` / loop tick / IPC 共用同一队列),避免 messages[] 交错与
  `currentRunPromise` 被覆盖;`Session.waitIdle()` 用于「等待空闲」而非「排队执行」

### MCP 支持

- 启动时只读取 `~/.tinyclaw/mcp.toml`，不连接任何 server
- Agent 通过 `mcp_list_servers` / `mcp_enable_server` / `mcp_disable_server` 按需懒加载
- 工具命名规范：`mcp_{serverName}_{toolName}`（最长 64 字符）
- `enabled` 字段控制 LLM 可见性；底层连接保持，disable 后可零延迟重 enable
- **载入诊断**（`loadMcpConfigDetailed()`，`src/config/loader.ts`）：TOML 语法错误（整份配置按空处理）、
  单条 `[servers.X]` 非法被跳过、无 `[servers.X]` 定义、文件不可读，都产出结构化诊断
  （`level` / `code` / `scope` / `server` / `message` / `hint`），并由三处展示：
  `mcp_list_servers` 返回体的告警段、启动日志 `[mcp] load (startup): …`、CLI `tinyclaw mcp status`
  （另在 `config show` 的 MCP 段打印）。诊断文本只含 Zod 的 `path` + `code`，
  **绝不输出 `issue.received`**（否则 env / headers 的值写错类型时会泄露 token）
- 每个 server 的最近一次连接失败与时间（`MCPServerStatus.lastErrorAt`）同样由 `mcp_list_servers` 展示
- **自管理（写 `mcp.toml`）**：agent 侧四个工具 —— `mcp_server_add`（新增/覆盖）、`mcp_server_remove`、
  `mcp_server_set_enabled`、`mcp_reload`（热重载）。三个写工具 `requiresMFA: true`，且走
  `src/mcp/config-writer.ts`：**块级文本补丁**（保留注释与未知键）→ **写前全量校验**（不通过即拒写）
  → **备份 `mcp.toml.bak-<ts>`（保留 5 份）** → **原子写**（`.tmp` + rename，权限 0600）
- **`mcp.toml` 仍是密钥文件**：`path-guard` 继续拒绝通用文件工具（`read_file`/`write_file`/`self_runtime_*`）
  读写它；上面的专用工具属"被认可的接口"（同 `memory_*`/`write_report`），因此不需要 `elevate` 或放宽白名单
- **`${SECRET:NAME}` 引用**（`src/mcp/secret-ref.ts`）：`env` / `headers` 的值可以是引用，真正的值在**连接
  server 时**从 `~/.tinyclaw/secrets.toml` 读取 —— mcp.toml 与会话历史里只留键名。**只在整值就是引用时解析**
  （不做字符串插值，避免误伤普通文本；`Authorization = "${SECRET:X}"` 的 X 里要存整段 `Bearer …`）。
  非引用值原样透传（兼容手写明文）。引用缺失会在载入期产出 `code: "secret"` 的 error 诊断
  （写配置时**不**做这项检查，先写引用后补 secret 是合理顺序）
- **SSE `headers` 已真正下发**：`requestInit.headers` 供后续 POST，
  `eventSourceInit.fetch` 注入建连请求（SDK 只在提供 `authProvider` 时才自动带 Authorization）
- **`reload()` 语义**：重新读盘 → 按规范化深比较得出 added/changed/removed → 关闭连接并
  `unregisterTool()` 注销被删/被改 server 的工具 → 应用新配置 → 重新启用此前已启用的 server，
  返回一行摘要。不做引用计数（正在执行的调用可能报错，但错误可见、可重试）；工具快照每轮重取，
  新工具**下一轮**即可见
- **自动重载**（`src/mcp/watcher.ts`，只在主进程装）：监听 `~/.tinyclaw` 目录（`config-writer` 是
  "写 `.tmp` 再 rename"，直接 watch 文件会丢 inode 后的事件）→ 700ms 去抖 → **用 sha1 内容哈希判断是否真变了**
  （本机 mtime 不可靠，见 `AGENTS.md` §7.4）→ `reload("watch")`。`.tmp` / `.bak-*` 不算变更。
  主进程重载后通过 cron worker IPC `{ type: "mcp_changed" }` 通知**长驻 worker 子进程**自行重载
  （它有独立的连接与工具注册表），与既有的 `skills_changed` 同构

---

## 后台 Job（`src/core/job-manager.ts`）

> **Job ≠ Sub-Agent**：`agent_fork` 后台跑的是**另一个 LLM agent**（自己的会话与工具循环）；Job 跑的是**进程/命令**。

- **工具面**：`job_start`（`detach` / `env` / `secrets` / `timeout_secs`）、`job_list`、`job_status`、
  `job_output`（**按字节游标增量读**）、`job_kill`（杀整个进程组：`spawn(detached: true)` 让 shell 成为
  group leader，`process.kill(-pid, sig)` 连子进程一起杀 —— 与 `exec_shell` 同款）
- **持久化**：`~/.tinyclaw/jobs/<id>/{meta.json,stdout.log,stderr.log}`（0600 / 目录 0700）。
  `meta.json` 只记 **env 键名**、密钥名、pid、退出码、字节数、备注 —— **绝不落值**。
  systemd 载体另有 `run.sh`（0700 启动器）、`started`（起来过的标记）、`rc`（退出码，重启后补记用）
  与临时的 `env`（0600，启动时即删）
- **两种存活语义**：默认随服务退出（`shutdownJobManager()` 杀组）；`detach: true` 则放进**独立的
  systemd transient unit**（`systemd-run --user --wait --collect --unit=tinyclaw-job-<id>`，
  见 `core/systemd-run.ts`）—— 独立 cgroup 才能活过 `systemctl --user restart tinyclaw`
  （systemd 默认 `KillMode=control-group` 是**按 cgroup** 杀进程，`setsid`/`unref` 换不掉 cgroup）。
  `--wait` 让 job 的退出码作为子进程退出码回到我们手里，`--collect` 让 unit 用完自动回收；
  `systemd-run` 不可用时回落到 `setsid`+`unref` 的普通 detach（只活过前台重启）。
  取证：`tmp/probe-cgroup-detach-20260923.sh`、`tmp/probe-systemd-run-20260923.sh`、`tmp/probe-detach-survive-20260923.sh`
- **systemd 载体的 env 注入**：`systemd-run` 的 `--setenv` / `--property=Environment=` 会把明文写进
  unit 属性（同 UID 一条 `systemctl show` 就能读到），而且 transient service **不继承调用方的 env**。
  所以 env 走 job 目录下 **0600 的 `env` 文件**：启动器 `run.sh`（0700）`source` 它、**立刻删除**，
  再把程序与参数以 **argv** 交给 `exec`（命令本身照旧可见，值不进 argv / 不进 unit 属性）。
  `jobs/<id>/env` 也在沙箱掩码列表里（`sandbox/bwrap.ts` 的 `maskTargets()`）
- **重启后的收敛**（`initJobManager()` + `getJob()` 的读盘刷新）：systemd 载体的 job 用
  `systemctl show` 探活 —— 还在跑就保留 `running`（这正是 detach 的意义），已结束就按启动器写的
  `jobs/<id>/rc` 补记 `succeeded`/`failed` 与退出码；**非 detached 的残留进程**（服务被 SIGKILL、
  崩溃路径没跑到清理时会出现）按"随服务退出"的契约**当场收掉**，不留没人认领的孤儿
- **env 分层**（低 → 高）：`process.env`（启动时已注入 `~/.tinyclaw/env`）< `agents/<id>/env` < job 的 `env`。
  值支持 `${SECRET:NAME}`（spawn 前解析，复用 `mcp/secret-ref.ts` 的解析器）。
  **只通过 spawn 的 env 传递、绝不拼进命令行 → `ps -ef` 看不到值**。
  ⚠️ 诚实的边界：同 UID 的进程仍可读 `/proc/<pid>/environ`；要求更高时用引用式或 job 的 `secrets: [...]`
- **沙箱**：跟随 `[sandbox]`（与 `exec_shell` 同口径，复用 `buildSandboxPlan`）；
  `secrets: [...]` 复用方案 B 的物化器（脚本照旧读 `~/.tinyclaw/secrets.toml`）。
  每个 agent 的 `env` 文件也在沙箱掩码列表里（值靠 env 注入，文件本身不该可读）
- **上限**：非 detached 走管道，每路输出最多落盘 8 MB（超出继续 drain，避免子进程被管道阻塞）；
  `detach: true` 的 stdio 直接落日志文件、不经过本进程，**不设上限**。
  并发上限 8/agent、32/进程（后台 job 不需要 MFA，用硬上限防"跑飞"）
- **agent 环境变量**（`config/agent-env.ts` + `tools/env-admin.ts`）：`env_list` / `env_set` / `env_delete`
  管 `~/.tinyclaw/agents/<id>/env`（0600，沙箱内被掩码）。**刻意没有 `env_get`** —— 值永不回给模型。
  `env_set` / `env_delete` 用**条件 MFA**（`ToolDef.requiresMFAFor`）：密钥类键名（或 `secret: true`）才要审批；
  `env_set` 的 `value` 另经 `ToolDef.redactArgs` 打码，**MFA 提示与审计里只看得到键名**（值不落日志、不进用户消息）
- **隔离与无人值守**：job 记发起它的 `agentId`，只有它能 `job_output` / `job_kill`（无 agent 上下文的
  CLI/cron 不受限）；`job_start` 在无人值守 ReAct 通道**硬拒绝**（后台进程会活过监督窗口），
  声明式 `steps` 仍可用

## Connector 接口（`src/connectors/base.ts`）
```typescript
export interface Attachment {
  contentType: string
  url: string
  filename?: string
}

export interface InboundMessage {
  type: "c2c" | "group" | "guild" | "dm"
  senderId: string      // QQ openid
  peerId: string        // 路由 key（私聊=senderId，群=groupOpenid）
  content: string
  messageId: string
  timestamp: string
  attachments?: Attachment[]
}

/** 一次发送的结果：文本可能已送达，但其中的媒体标签失败并被静默降级为纯文本 */
export interface SendOutcome {
  hadMedia: boolean
  mediaFailed: boolean
  mediaError?: string
}

export interface Connector {
  start(): Promise<void>
  stop(): Promise<void>
  onMessage(handler: (msg: InboundMessage) => Promise<string>): void
  send(peerId: string, type: InboundMessage["type"], text: string, replyToId?: string): Promise<SendOutcome>
}
```

---

## 实现阶段

| Phase | 内容 | v1 状态 |
|-------|------|---------|
| 1 | 地基：package.json · tsconfig · config schema/loader | ✅ 完成 |
| 2 | LLM 多后端：client · registry | ✅ 完成 |
| 3 | QMD 记忆：qmd · store · summarizer | ✅ 完成 |
| 4 | MFA：mfa · guard | ✅ 完成 |
| 5 | 工具层：registry · codex · copilot · system | ✅ 完成 |
| 6 | Agent 主循环：session · router · agent | ✅ 完成 |
| 7 | QQBot：api · outbound · gateway · index + main.ts | ✅ 完成 |
| 8 | Cron：scheduler · runner · tools | ⏸ 预留，不实现 |
| 9 | GitHub Copilot 后端：token 换取 · 模型发现 · 乘数表 | ✅ 完成 |
| 10 | CLI 配置入口：model/config/auth/status/restart/completions | ✅ 完成 |
| 11 | 连接稳定性：重试策略 · jitter · stream idle timeout · 429 Retry-After | ✅ 完成 |
---

## CLI 配置工具（`tinyclaw`）

通过 `npm link` 将项目注册为全局命令（运行时是 node + tsx，不是 bun）。

**安装：**
```bash
cd /path/to/tinyclaw && npm link
tinyclaw completions install && source ~/.bashrc
```

**服务托管方式决定日志去哪**（CLI 会自动判断，见 `src/cli/systemd.ts`）：

| 启动方式 | 进程归属 | 日志 |
|---|---|---|
| `systemctl --user start tinyclaw`（生产用法） | systemd 守护，crash 自动拉起 | journal（`journalctl --user -u tinyclaw.service`） |
| `tinyclaw start` | detached 进程，无人守护 | `~/.tinyclaw/service.log` |

`logs` 只读 journal 的两种情况：unit 处于 active/activating，或 unit 存在但没在跑（读历史日志）；
`service.log` 有内容时优先读文件。想强制指定用 `--source`。

**命令列表：**

| 命令 | 说明 |
|------|------|
| `tinyclaw model show` | 显示三个后端当前模型 |
| `tinyclaw model list [backend]` | 列出可用模型（Copilot 后端实时查 API） |
| `tinyclaw model set [backend]` | 交互式数字菜单选模型 → 写入 config.toml → 可选 restart |
| `tinyclaw config show` | 格式化显示配置（密钥脱敏） |
| `tinyclaw config edit` | 用 `$EDITOR` 打开 config.toml |
| `tinyclaw config set <key> <val>` | dotted path 修改字段（自动推断 bool/int/string）；写入前校验整份配置，不过则拒写并留证 `config.toml.rejected-<ts>` |
| `tinyclaw config status` | 配置自愈状态：当前配置哈希、可用版本（LKG）、待确认（含启动尝试次数）、最近一次自动回退、备份/留证文件、最近一次健康自检结论 |
| `tinyclaw config check` | 对当前 `config.toml` 跑写前校验 + 离线健康检查（不改文件；有 error 时退出码 1，便于脚本/CI 使用） |
| `tinyclaw config reload` | 校验 + 变更分级（hot/soft/restart）并说明如何生效。CLI 是独立进程，不能把改动热应用进正在跑的服务（服务自己的文件监听会应用） |
| `tinyclaw config rollback --list \| --lkg \| --to <备份>` | 手动回退到 LKG 或某个 `config.toml.bak-*`（回退前先校验，坏版本不会被覆盖上去） |
| `tinyclaw config safe-mode on\|off\|status` | SAFE MODE 开关（LKG 也起不来时用最小配置启动，只保留 `providers`/`llm`） |
| `tinyclaw mcp status` | 显示 `~/.tinyclaw/mcp.toml` 的**载入结果与诊断**（TOML 语法错、单条 server 非法、无 `[servers.*]` 定义、`${SECRET:NAME}` 引用缺失、`enabled=false`；env / headers 只列键名，值不回显） |
| `tinyclaw mcp add / remove / enable / disable` | 增删 MCP server、改 `enabled` 开关。走 `config-writer`（写前全量校验 + `.bak-<ts>` 备份 + 原子写），运行中的服务由文件监听自动重载。`add` 用法：`--stdio <cmd> [--arg a]… [--env K=V]…` 或 `--sse <url> [--header K=V]…`，可加 `--desc` / `--disabled` |
| `tinyclaw auth github` | 重新执行 Device Flow OAuth |
| `tinyclaw auth status` | 检查 token 有效性 |
| `tinyclaw status` | 服务进程 + systemd 状态与运行时长 + 日志来源 + 配置摘要 + channel 状态 |
| `tinyclaw logs [-f] [-n N] [-l <level>] [--since <t>] [--grep <re>] [--source journal\|file]` | 查看服务日志。**来源自动识别**：unit 处于 active 时读 `journalctl --user -u tinyclaw.service -o cat`，否则读 `~/.tinyclaw/service.log`；tty 下顺带剥掉进度条的 ANSI 控制符 |
| `tinyclaw restart` | unit 文件存在时一律 `systemctl --user restart tinyclaw.service`；不存在才回退到旧的自拉起流程 |
| `tinyclaw help <command>` | 打印某命令的用法摘要（**不执行**该命令，避免 `help restart` 真去重启） |
| `tinyclaw --version` | 输出版本（读 `package.json`） |
| `tinyclaw completions install` | 自动写入 `~/.bashrc` / `~/.zshrc` / fish completions |

**扩展方式（注册新命令）：**

在 `src/cli/index.ts` 的 `COMMANDS` 对象加一行即可；子命令表由各命令模块 `export const subcommands`
自动汇聚（`buildSubcommands()`），Tab 补全自动生效。

**Tab 补全机制：**
```
tinyclaw mo<Tab>
  → shell 调用 tinyclaw --complete "mo"
  → 输出全量候选（model config auth ...）
  → compgen -W 按前缀过滤 → 显示 model
```

补全覆盖层级：顶层命令 → 子命令 → backend 名（model set/list）→ shell 类型（completions install）

**配置写入路径（唯一入口）**

`config.toml` 的任何写入都收口在 `src/config/writer.ts` 的 `writeConfigText()` / `patchTomlField()`：

1. **校验**（`src/config/validate.ts`）：TOML 语法 → `ConfigSchema.safeParse`（与 `loadConfig()` 同一份真相）
   → 交叉引用检查（工具名拼写需注入 `knownTool`；`extraRwPaths` 绝对性与存在性；`$SECRET` 占位符在
   `secrets.toml` 里存在；授权的 agentId 存在；后端引用的 provider 有凭证；**schema 不认的键**会被 Zod
   静默 strip，这里以 warn 点出来）
2. **有 error 就拒写**：内容不落盘，留证 `config.toml.rejected-<ts>`（0600），返回诊断给调用方
3. **通过则备份 + 原子写**：`.bak-<ts>`（保留 5 份）+ `.tmp`/rename + chmod 0600
   （备份/原子写/留证复用 `src/config/safe-write.ts`，`mcp.toml` 的写入器同用一套）

⚠️ 诊断文本**绝不回显字段原值**：Zod issue 只用 `path` + `code`，语法错误消息会裁剪形似 token 的长串 ——
否则 `apiKey` 写错类型时 Zod 的 `received` 会把密钥带进日志/CLI/工具返回。

**agent 能改哪些字段（`config_set` 的白名单，`src/config/settable-paths.ts`）**

`config.toml` 里同时装着"模型的参数"和"管着模型的规则"，所以 `config_set` 精确到字段放行：

| 允许 | 拒绝（附原因） |
|---|---|
| `llm.backends.<role>.{model,maxTokens,timeoutMs,maxContextWindow,supportsVision,supportsToolCalls,disableThinking,reasoningEffort,thinkingBudget}`、`llm.aliases.*`、`tools.{maxCodeToolRounds,maxChatToolRounds,maxToolResultChars,maxToolCallArgChars}`、`retry.*`、`interactive.*` | `auth.*`（MFA 防线）、`sandbox.*`（沙箱与无人值守白名单）、`selfAccess.*`（特权面）、`health.*`（防呆阈值）、`channels.*`/`web.*`、`providers.*`（apiKey 就是密钥）、`memory.*`（可能触发索引重建/删除）、`submitter.*`、`agent.*`（responseHooks 属注入面）、`tools.http_request.*`（SSRF 开关）、`llm.premiumAllowlist.*`（成本控制） |

**"自我管理"工具的按 agent 绑定**（`src/tools/agent-binding.ts` + `[tools.selfManagement].agents`）

**会改运行配置的**工具默认只绑定 `default` agent：`config_set` / `config_reload` / `config_validate`，以及写
`mcp.toml` 的 `mcp_server_add` / `mcp_server_remove` / `mcp_server_set_enabled` / `mcp_reload`。
纯开关类的 MCP 工具（`mcp_list_servers` / `mcp_enable_server` / `mcp_disable_server`）**不绑** —— 它们只是在自己的
权限范围内开关 MCP 能力，且仍受 per-agent `mcp.toml` 白名单约束。

被绑定的工具对其他 agent **连可见性都不给**（`registry.getAllToolSpecs()` 直接过滤），并且每个工具在 `execute`
里**再校验一次** `ctx.agentId` —— cron/loop 的**声明式步骤**按名字直接 `executeTool`，绕过可见性过滤，执行层必须
自己兜住。放开方式：`config.toml` 写 `[tools.selfManagement] agents = ["default", "onlychat"]`（`["*"]` = 全部，
`[]` = 谁都不给）。

**配置自愈（改坏自动回退）**

`loadConfig()` 是 fail-fast（解析/schema 不过就 `process.exit(1)`），所以配置写坏 = 服务起不来。
回退链分三层，都在 `src/config/state.ts` + `src/main-supervisor.ts`：

| 层 | 触发 | 动作 |
|---|---|---|
| LKG 提升 | `main.ts` 启动成功且自检通过后 | `promoteConfig()`：把当前 `config.toml` 记为 lastGood，并复制成 `config.toml.lkg`（0600），清空 pending |
| quick-fail 回退 | 子进程**启动后 60s 内**退出（`QUICK_FAIL_MS`）且磁盘配置与 LKG **内容哈希不同** | `restoreLastGoodConfig()`：LKG 覆盖回 `config.toml`，坏配置留证 `config.toml.rejected-<ts>`，写 `.rollback_notify.json`（`kind:"config"`）+ `logs/config-rollback.log`，随后立即重启。**每个 supervisor 生命周期最多一次**，防循环 |
| 代码 git 回退（兜底） | 连续崩溃 ≥5 次且非配置原因 | `git stash` + `git checkout HEAD~1 -- .`（**不移动 HEAD**，不再造成 detached HEAD），退避重启 |

判定"配置变过"一律用 **sha1 内容哈希**，不用 mtime（本机 mtime 不可靠，见 §7.4）；因此**手改** `config.toml`
（不经写入器）同样会被兜住。回退通知不依赖 QQ connector：日志与 `logs/config-rollback.log` 一定写。

**启动健康自检**（`src/health/`）

- `config-health.ts`：离线项（写前校验、运行时/日志/会话目录可写、`[sandbox]` 要沙箱时 bwrap 是否可用、
  IPC socket 路径 ≤100 字节、记忆根目录）。不 import `llmRegistry`，CLI 也能用。
- `llm-probe.ts`：唯一花 token 的项 —— 对 `daily` 后端发一次极小请求（收到首个 token 立即 abort）。
  错误分流：**401/403/404/模型名不存在 → 确定性**（允许回退）；**5xx / 超时 / 429 / DNS 失败 → 暂时性**
  （只告警，绝不回退）；认不出来一律按暂时性（保守）。
- 顺序：**先自检、后提升 LKG**（否则会把坏配置记成"可用版本"）。若自检发现确定性错误**且**当前配置与 LKG
  不同 → `restoreLastGoodConfig()` + `exit(75)`（主动重启，不计入崩溃次数）。若与 LKG 相同（说明是环境问题
  而非这次改动）→ 只告警，继续运行，不再回退。
- 配置开关：`[health].enabled`（默认 true，关掉则既不跑自检也不回退）、`[health].probeLlm`（默认 true）、
  `[health].probeTimeoutMs`（默认 5000）。结果落 `logs/health-YYYY-MM-DD.jsonl`。

**热重载与分级**（`src/config/reload-plan.ts` + `reload.ts` + `watcher.ts`）

- `loadConfig()` 默认缓存整份配置；`invalidateConfigCache()` / `loadConfig({fresh:true})` 用于热重载。
- 变更分级（`classifyConfigChange()`，纯函数）：
  - `hot`：`retry` / `tools` / `agent` / `interactive` / `auth.mfa` / `sandbox` 策略类 / `selfAccess` —— 全仓约 94 处
    `loadConfig()` 基本都是"用时现读"，换缓存即生效
  - `soft`：`llm.backends` / `concurrency` / `memory.embedModel|enabled` —— 这些子系统在启动时初始化一次，
    需要重新 init（`llmRegistry.init()` + `initLLMConcurrency()`）
  - `restart`：`channels.*` / `voice.*` / `web.port` / `sandbox.enabled` / `sandbox.execShell` —— 进程级资源，
    或一次工具调用内会被多处读取（热改会半新半旧）→ 走受控重启
  - 原则：**证明不了"改动会立刻被读取点看到"就归 restart**（宁可不热，不假热）
- 入口：agent 工具 `config_reload`（MFA）、CLI `tinyclaw config reload`、`config.toml` 文件监听
  （`ContentWatcher`：内容哈希 + 父目录监听 + 800ms 去抖；连续 3 次重载失败自动停用监听）。
  流程：**校验 → 分级 → 应用（hot/soft）或 markPending + waitIdle(≤10s) + exit(75)（restart）→ 健康自检 → 失败回退 LKG**。
  ⚠️ **只有跑过在线探测的变更才会提升 LKG**：`hot` 类（例如改 `apiKey`）离线检查看不出问题，若把它记成"可用版本"，
  真出问题时就没有回退目标了 —— 这类变更只保留 `pending`，等下次启动/显式 reload 验证后才提升。
  CLI 是独立进程，只能分级与提示，不能把改动热应用进正在跑的服务（服务自己的监听会应用它）。
- 子系统重 init 与受控重启由 main.ts 通过 `setConfigReloadHooks()` 注入，避免 tools → main 的反向依赖。

**SAFE MODE（LKG 也坏时的最后一层）**（`src/config/safe-mode.ts`）

- 开关是标记文件 `~/.tinyclaw/.safe_config`（或 `TINYCLAW_SAFE_CONFIG=1`），**不依赖 config.toml 本身**。
- 命中时 `loadConfig()` 不再 fail-fast，改用 `buildSafeConfig()`：只保留 `providers` / `llm`（从坏文件里尽力捞），
  其余段走 schema 默认值，并**显式收紧特权面**（`grantedAgents=[]`、`allowDelete=false`、`exemptMfa=false`、`wideWriteAccess=false`）。
- 主进程在 SAFE MODE 下：不建任何 QQBot、不启动 cron/loop、不做健康自检、不提升 LKG、不装配置监听；
  日志与 CLI 都明说"本次不是用你的 config.toml 启动的"。
- 触发：supervisor 在"配置回退后仍 quick-fail"时自动打开并重启（每个 supervisor 生命周期一次）；
  也可手动 `tinyclaw config safe-mode on|off|status`。手动回退用 `tinyclaw config rollback --list|--lkg|--to <备份>`。

---

## 配置文件示例（`config.example.toml`）

```toml
# ── LLM 后端（方案 A：OpenAI-compatible） ────────────────────────────────────

[llm.backends.daily]
baseUrl = "https://api.openai.com/v1"
apiKey  = "sk-..."
model   = "gpt-4o"

[llm.backends.code]
baseUrl = "https://api.openai.com/v1"
apiKey  = "sk-..."
model   = "o4-mini"

[llm.backends.summarizer]
baseUrl = "https://api.openai.com/v1"
apiKey  = "sk-..."
model   = "gpt-4o-mini"

# 可选:图片识别专用后端(fallback,用于 read_image 等视觉工具)
# [llm.backends.vision]
# baseUrl = "https://api.openai.com/v1"
# apiKey  = "sk-..."
# model   = "gpt-4o-mini"

# DeepSeek 等支持思维链的模型可关闭 thinking(减少 token 消耗)
# disableThinking = true   # 在对应后端节下添加
# 也可指定思考档位(仅 DeepSeek 系后端):
# reasoningEffort = "medium"   # none|minimal|low|medium|high|xhigh|max
# 会话里用 `/think <档位>` 临时覆盖,`/think default` 恢复后端默认

# ── LLM 后端（方案 B：GitHub Copilot 订阅） ──────────────────────────────────
# 需先运行 `gh auth login`，或通过首次启动的 Device Flow 完成授权
# token 持久化在 ~/.tinyclaw/.github_token，后续无需重新授权

# [llm.backends.daily]
# provider    = "copilot"
# githubToken = "gh_cli"   # "gh_cli" | "env"（$GITHUB_TOKEN）| 直接填 token
# model       = "auto"     # "auto" 或具体 model ID，如 "claude-sonnet-4.6"

# ── Microsoft MFA ──────────────────────────────────────────────────────────────
# 需要一个 Azure AD App Registration
# 注册地址：https://portal.azure.com → App registrations → New registration
# 获取 tenantId 和 clientId 后填入下方

[auth.mfa]
tenantId = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
clientId = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"

# ── QQ Bot ─────────────────────────────────────────────────────────────────────
# 官方 QQ 开放平台：https://q.qq.com/

[channels.qqbot]
appId        = "102xxxxx"
clientSecret = "your-client-secret"

# ── 向量记忆 ───────────────────────────────────────────────────────────────────
# 使用 RKLLM NPU embed(推荐,RK3588 板子):先启动 ~/rkllm-embed-server/start.sh
# 可选:自定义额外知识库(如 Obsidian notes),见 ~/.tinyclaw/memstores.toml

[memory]
rkllmEmbed.enabled = true
rkllmEmbed.port    = 11434
tokenThreshold = 0.8   # 达到上下文 80% 时触发摘要压缩

# Subagent（agent_fork）上下文继承预算与模式，见「Agent Fork」节
slaveContextRatio = 0.05        # 预算 = clamp(窗口 × 比例, 8000, 窗口 − 8000)
slaveContextMode  = "standard"  # task-only | minimal | standard | full
slaveRecall       = true        # Slave 启动时注入 ACTIVE.md + 用 task 做 QMD 语义检索

# 工具调用的 __purpose 进度旁白（取代旧心跳），见「工具调用的 __purpose」节
[agent]
toolPurpose      = true    # 是否启用（关掉则完全不注入、不展示）
purposeMaxUnits  = 10      # 长度上限：CJK 按字、拉丁串按词；emoji 不计
purposeHoldMs    = 4000    # 工具跑超过该时长才算"用户在等"；0 = 一开始就展示
purposeMinGapMs  = 3000    # 两次展示的最小间隔

# 自动 fork（见「Agent Fork」节）：0 = 关闭
autoForkThresholdMs = 120000   # 毫秒；ReAct 轮次超时后把剩余任务交给 continuation Slave
```

---

## IPC 协议对照

| 请求类型 | 参数 | 说明 |
|---|---|---|
| `chat` | `sessionId`, `message` | 向会话发送消息（流式回复） |
| `list` | — | 获取所有内存中的会话快照 |
| `new` | `agentId?` | 创建新终端会话 |
| `memory_rebuild` | `agentId?` | 在服务进程内重建 QMD 向量索引(读取 memstores.toml,使用 RKLLM embed) |

| 响应类型 | 字段 | 说明 |
|---|---|---|
| `chunk` | `delta` | 流式文本片段 |
| `done` | — | 本次回复结束 |
| `error` | `message` | 错误信息 |
| `sessions` | `sessions[]` | 会话列表（响应 `list`） |
| `created` | `sessionId` | 新会话 ID（响应 `new`） |

---

## 子 Agent 绑定（Session Bind）

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

## 常用操作速查

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
ls ~/.tinyclaw/sessions/                 # 原始对话 JSONL + loop .toml 配置
```
