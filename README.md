# tinyclaw

极简 AI Agent 框架。Bun + TypeScript,内置 QQBot,支持 MFA 高危操作鉴权。

## 特性

- **多后端 LLM**:GitHub Copilot(凭订阅自动发现模型)或任意 OpenAI-compatible API
- **内置工具集**:文件读写、Shell 执行、HTTP 请求、图表渲染、Cron 定时、MCP 集成、Agent Fork 等
- **Cron Pipeline**:`steps` 数组精确编排 tool → msg 多步流水线,结果推送到 QQ
- **Agent Fork**:后台启动 Slave agent 异步执行耗时任务;按**轮数**继承 Master 上下文(含工具调用与结果);`agent_wait` 汇总多 Slave 结果;子 agent 轨迹**全文归档**可用 `agent_trace` 检索
- **进度旁白**:模型在关键节点给工具调用附一句面向用户的 `__purpose`(如「🔍 正在查你最近三个月的持仓」),只在**用户确实在等**时才展示;取代了旧的定时"仍在处理中"心跳
- **跨 Session 通信**:`session_get / session_send` 实现不同 Agent session 之间消息互传
- **MCP 支持**:懒加载,按需 enable/disable,内置 Browser / News / Notes / Polymarket 等 MCP server;
  `mcp.toml` **载入诊断**直接暴露给 Agent 与 CLI(`tinyclaw mcp status`),语法/字段错误不再静默吞掉;
  可**自管理**:agent 用 `mcp_server_add / remove / set_enabled / reload`(或 CLI `tinyclaw mcp add/…`)增删改
  (写前校验 + 备份 + 原子写),`env`/`headers` 支持 `${SECRET:NAME}` 引用 `secrets.toml`,密钥不落配置文件;
  改完**自动热重载**(文件监听,内容哈希判断),无需重启服务
- **MFA 鉴权**:高危工具支持 Azure AD number-matching 推送、TOTP 验证码、文字确认三种方式
- **沙箱与审计**:`exec_shell` 可跑进 bubblewrap —— 密钥文件在沙箱内被掩码成空文件(内核强制,不是"检查后拒绝"),
  未绑定目录只读、可断网;需要宿主机能力时可用 `exec_shell({elevate:true})` **提权**(按风险分级 E1/E2、
  一次性令牌绑定命令、无人值守一律不许);所有工具调用落入 `~/.tinyclaw/audit/` 审计流(参数已脱敏);
  cron/loop 等无人值守路径按工具白名单放行,且 MFA 无法送达时默认**拒绝**而非放行
- **向量记忆**:对话摘要自动向量化,token 超阈值时自动压缩;`/compact` 手动压缩;多 Agent 独立命名空间
- **原文账本**:每条消息另记一份**只追加**的 `<session>.journal.jsonl` —— 压缩/剪枝只影响"发给模型的视图",
  原文仍可用 `memory_recall`(关键词,可跨会话)与 `memory_expand`(按 seq 取回逐字原文)找回
- **MEM.md 预算注入**:持久记忆按优先级 + 字符预算注入 system prompt(默认 8000 字符),
  超出部分留省略提示、可用 `memory_read_mem` 读全文 —— 记忆可以长,但不会每轮都付整篇的钱
- **Dashboard**:内置 Web UI(`tinyclaw web`),展示指标趋势图、日报存档、Cron 任务状态
- **Code 模式**:`/code` 切换代码专注会话,内置 Plan / Auto 子模式,滑动窗口压缩保留最近上下文
- **语音输入**:QQBot 收到语音消息自动转写(本地 faster-whisper)
- **图片识别**:QQBot 接收图片消息自动转为 vision 内容;`read_image` 工具主动读取本地图片
- **富媒体发送**:回复里嵌 `<img>/<audio>/<video>/<file>` 标签即可发附件;下发类型由文件格式决定
  (mp3 等非 silk 音频按文件发,不会被塞进语音气泡);≤7.5 MB 走内联、更大自动走官方分片上传(上限 200 MB)
- **进程守护**:supervisor 自动重启,崩溃恢复不丢上下文
- **可扩展**:实现 `Connector` 接口即可接入新平台(TG / WhatsApp 等)

## 快速开始

```bash
bun install          # 安装依赖
bun link             # 注册全局命令 tinyclaw(一次性)
bun src/main.ts      # 首次启动,自动生成 ~/.tinyclaw/config.toml
# 编辑配置后重启
tinyclaw restart
```

## 配置

所有配置在 `~/.tinyclaw/config.toml`(不进仓库),模板见 [config.example.toml](config.example.toml)。

**写入前会校验**:`tinyclaw config set/edit` 与 agent 的配置工具都会先跑一遍
`src/config/validate.ts`(TOML 语法 → Zod schema → 交叉引用:工具名拼写、路径绝对/存在、
`$SECRET` 占位符、后端 provider 有没有凭证)。**校验不过就拒写**,被拒内容留证
`config.toml.rejected-<时间戳>`,原文件一字不动 —— 因为 `config.toml` 写坏 = 服务起不来
(`loadConfig()` fail-fast)。通过时先备份 `config.toml.bak-<时间戳>`(保留最近 5 份)再原子写入,权限 0600。

**provider 凭据可以只写名字**:`providers.*.apiKey` 与 `providers.copilot.githubToken` 支持 `$NAME`
占位符,`loadConfig()` 启动时从 `~/.tinyclaw/secrets.toml` 解出真值(明文就不必落在 `config.toml` 里):

```toml
[providers.openrouter]
apiKey = "$OPENROUTER_API_KEY"     # → secrets.toml 的 [OPENROUTER_API_KEY] value
```
只有**这几个白名单字段**会解析(`$PATH` 这类字面量不会被误改);缺键时保留字面量 + 启动告警
(`tinyclaw config check` 也会提示)。改 provider 凭据后走 `tinyclaw config reload`(providers 属 soft 级,
会重新 init LLM 后端 —— 客户端在构造时就固化了 apiKey,只换缓存没用);
但**只改 `secrets.toml`、`config.toml` 没动**时 `config reload` 不会做任何事(它按 config.toml 内容哈希判断),
这种情况要 `tinyclaw restart`。
agent 侧另有 `http_request` 的 header `$NAME`、job/agent env 的 `${SECRET:NAME}`、qqbot 的 `clientSecret`。

**改坏了会自动回退**:服务每次成功启动都会把当前配置记为"上一份可用版本"(`config.toml.lkg`)。
若配置改坏导致启动后 60s 内崩溃,supervisor 会把 `config.toml` 覆盖回那份可用版本并立即重启
(坏配置留证 `.rejected-<时间戳>`,事件写 `.rollback_notify.json` 与 `logs/config-rollback.log`,每个守护
周期最多自动回退一次)。判定"配置是否变过"用内容哈希而非 mtime,所以手改文件同样被兜住。

**启动自检**:启动后跑一遍离线检查(目录可写、bwrap 可用性、IPC socket 路径长度…)并按 `[health].probeLlm`
(默认开)发一次极小 LLM 请求验证 key/模型名。只有**确定性**配置错(401/403/404/模型名不存在)才触发回退,
上游 5xx / 超时 / 限流只告警 —— 以免上游抽风把好配置回退掉。结果写 `logs/health-YYYY-MM-DD.jsonl`。
查看:`tinyclaw config status`(可用版本/待确认/最近回退);手动自检:`tinyclaw config check`。

**热重载(改完不必重启)**:服务监听 `config.toml`(内容哈希判断,`touch` 不触发),变更按**分级**处理:
`hot`(retry/tools/mfa/沙箱策略等"用时现读"的段)换缓存即生效;`soft`(LLM 后端/并发/记忆阈值)重新 init 子系统;
`restart`(channels/voice/web.port/sandbox 开关)走受控重启 —— 证明不了会立即生效的段一律归 restart。
手动触发:agent 工具 `config_reload`(MFA)或 `tinyclaw config reload`;`config_validate` 只读校验。

**记忆相关的开关**(都在 `[memory]`,详见 [config.example.toml](config.example.toml)):
`enabled`/`embedModel`(向量记忆与 embedding 后端)、`tokenThreshold`/`contextWindow`(压缩阈值)、
`journalEnabled`(默认 `true`:每条消息原文另记一份只追加的 `<session>.journal.jsonl`,压缩不再等于销毁)、
`memInjectionMaxChars`(默认 `8000`:MEM.md 注入 system prompt 的字符预算,`0` = 整篇注入)。
`journalEnabled` 与 `memInjectionMaxChars` 都是**用时现读**,改完 `hot` 生效,不必重启。

**agent 能改什么**:`config_set`(**MFA**)只允许改白名单字段 —— 模型/单后端参数(`llm.backends.*`)、模型别名
(`llm.aliases.*`)、轮次与截断上限(`tools.max*`)、重试节奏(`retry.*`)、交互提醒(`interactive.*`);
**管着 agent 自己的规则一律拒改**:`auth.*`(MFA)、`sandbox.*`(沙箱与无人值守白名单)、`selfAccess.*`(自指权限)、
`secrets.*`(密钥授权)、`[health]`(回退阈值)、`channels.*`/`web.*`、`providers.*`(密钥)、`memory.*`、
`tools.http_request.*`(SSRF)、`llm.premiumAllowlist.*`(配额)。另外**会改运行配置的**"自我管理"工具
(`config_set`/`config_reload`/`config_validate` 与写 `mcp.toml` 的 `mcp_server_add`/`mcp_server_remove`/
`mcp_server_set_enabled`/`mcp_reload`)**默认只绑定 `default` agent**(纯开关类的 `mcp_list_servers`/
`mcp_enable_server`/`mcp_disable_server` 不绑),其他 agent 要放开需显式写
`[tools.selfManagement] agents = ["default", "<agentId>"]`。

**密钥只给 default**:`secrets.toml` 的键名是可猜的,而 `${SECRET:NAME}`(job env / **cron env**)、
`job_start(secrets:[...])`、`exec_shell` 的声明式 secrets、`http_request` 的 header `$NAME` 都是"按名字取密钥" ——
所以默认只有 `default` agent 能读:其他 agent 调这些入口会被**拒绝**(理由进审计流),`env_list` 也不给它显示键名。
放开写 `[secrets] agents = ["default", "<agentId>"]`(`["*"]` = 全部,`[]` = 谁都不给);没有 agent 上下文的
调用(CLI、cron 无绑定)视为放行。

**cron 的 env 与密钥**(与 `job_start` 同口径):cron 每次运行会叠加 `~/.tinyclaw/agents/<id>/env`
(即 `env_set` 写的变量),其中值写成 `${SECRET:NAME}` 的键在**过 `[secrets].agents` 授权闸**后从
`secrets.toml` 取值注入子进程(`exec_shell`) —— 密钥**不会**因为写在 `job.secrets` 里就自动进环境变量,
那种声明仍然只以**文件**形态出现在沙箱内(见 `docs/commands/cron-pipeline.md`)。

**LKG 也坏时**:`tinyclaw config rollback --list / --lkg / --to <备份>` 可手动回退;若自动回退后仍起不来,supervisor 会打开 **SAFE MODE**(标记文件 `~/.tinyclaw/.safe_config`):
用最小配置启动(只保留 `providers`/`llm`,不接 QQBot、不跑 cron/loop、不写 LKG、不带特权面),
让服务能起来供你修;`tinyclaw config safe-mode on|off|status` 管理。

**GitHub Copilot:**
```toml
[providers.copilot]
githubToken = "gh_cli"   # 需先 gh auth login,或首次启动时走 Device Flow 授权

[llm.backends]
daily      = { model = "copilot/auto" }
summarizer = { model = "copilot/auto" }
```

**OpenAI-compatible:**
```toml
[providers.openai]
apiKey  = "sk-..."
baseUrl = "https://api.openai.com/v1"

[llm.backends]
daily      = { model = "openai/gpt-4o" }
summarizer = { model = "openai/gpt-4o-mini" }
```

**弱模型(不支持 function calling):**

部分本地/小厂模型不支持 OpenAI function calling（tool_calls）。给这类后端加 `supportsToolCalls = false`，tinyclaw 会自动切换为**文本模式工具调用**（textMode）：系统提示注入工具列表与格式规则，模型以 `<tool_call>{"name":...,"args":...}</tool_call>` XML 文本块响应，Agent 正则解析后执行，无需模型原生支持 tools 参数。

```toml
[llm.backends.daily]
model = "openai/some-weak-model"
supportsToolCalls = false   # 不支持 function calling 的模型走文本工具调用
```

> Copilot 后端留空时按模型元数据（`capabilities.supports.tool_calls`）自动推断，通常无需手动设置。

**思考档位(DeepSeek 系后端):**

`none|minimal|low|medium|high|xhigh|max` 七档(越高思考越多、越贵),`disableThinking = true` 彻底关闭思考:

```toml
[llm.backends.daily]
model = "deepseek/deepseek-v4.1-flash-expires-on-0910"
reasoningEffort = "medium"   # 后端默认档位
# disableThinking = true     # 或:完全关闭思考(优先级高于 reasoningEffort)
```

会话里用 `/think <档位>` 临时覆盖(写 `~/.tinyclaw/sessions/<sessionId>.toml`,重启后仍生效),
`/think off` 关闭思考,`/think default` 恢复后端默认。仅 DeepSeek 系后端支持。

**QQBot + MFA(可选):**
```toml
[channels.qqbots.main]
appId        = "你的 AppID"
clientSecret = "你的 ClientSecret"
# streaming = true   # 单聊最终回复走官方流式消息(整段只占 1 次被动回复额度)
#                    # 回复中的 <img>/<file> 等富媒体标签由正文剥离后单独发送,不受流式影响

[auth.mfa]
tenantId = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
clientId = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

**Dashboard(Web UI + 下载页):**
```toml
[web]
enabled = true
port    = 4096
token   = "openssl rand -hex 24"   # 只从 POST /__login 表单或 Authorization 头读取,不再进 URL

[web.downloads]
enabled        = true              # agent 用 release_file 投放,用户在「下载」页生成一次性 curl 命令
# dir            = "~/.tinyclaw/downloads"  # 临时区(平铺,按 ttlDays 清理)
# keepDir        = "~/.tinyclaw/keep"       # 常驻区(可按子目录归类,永不自动清理)
# linkTtlSecs    = 600             # 令牌有效期(秒)
# maxUses        = 3               # 单个令牌最多下载次数(留 curl -C - 续传余量)
# maxFileMb      = 512             # 单文件体积上限(MB)
# maxTotalMb     = 2048            # 临时区总占用上限(MB)
# keepMaxTotalMb = 5120            # 常驻区总占用上限(MB)
# ttlDays        = 7               # 临时区保留天数(0 = 不清理)
```

**Subagent(后台子 Agent)与自动 fork:**

chat 模式下模型默认把「预计几秒以上、或可拆成多个独立部分」的活派给后台子 Agent(`agent_fork`),
多份独立部分并行 fork 后用 `agent_wait()` 汇总;上下文继承预算与模式见 `[memory]` 的
`slaveContextRatio` / `slaveContextMode` / `slaveRecall`。

```toml
[agent]
autoForkThresholdMs = 0   # 自动 fork:轮次超过该毫秒数就把剩余任务转后台;0 = 关闭(默认 120000 = 2 分钟)
```

> 自动 fork 出来的 continuation Slave 只继承上下文,**不携带 Master 手上的中间结论**;
> 需要模型自己收尾的复杂任务建议设 `0`,改由模型显式 `agent_fork`。

## CLI 速查

```bash
tinyclaw status                        # 服务状态(含 systemd 状态/运行时长/日志来源)
tinyclaw start / restart               # 启动 / 重启(有 systemd unit 时一律交给 systemd)
tinyclaw logs [-f] [-n N]              # 查看日志:自动识别来源(systemd → journal,否则 service.log)
tinyclaw logs -l warn --since "1h ago" # 只看 WARN 以上 / 按时间范围;--grep <re> 正则过滤
tinyclaw help <command>                # 查看某命令的用法(不会执行该命令)
tinyclaw --version                     # CLI 版本

tinyclaw agent new <id>                # 创建 Agent
tinyclaw agent edit <id>               # 编辑系统提示
tinyclaw agent list                    # 列出所有 Agent

tinyclaw model list [backend]          # 可用模型列表
tinyclaw model set [daily|code|summarizer]  # 交互式切换模型

tinyclaw cron list                     # 定时任务列表
tinyclaw cron add / remove / run <id>  # 添加 / 删除 / 立即触发

tinyclaw wake -s <sessionId> <消息>    # 唤醒 LLM：注入消息并触发一轮 agent（受理即返回，脚本/job 用）
                                       # 脚本 / cron / job / 沙箱里可直接裸喊 `wake …`（服务启动时物化到 ~/.tinyclaw/bin/ 并注入 PATH）
tinyclaw send <消息>                   # 一次性 LLM 调用（无历史、无工具）

tinyclaw chat loop list                    # 查看所有 loop session
tinyclaw chat loop enable <sessionId>      # 启用(或新建)loop
tinyclaw chat loop disable <sessionId>     # 禁用 loop
tinyclaw chat loop set <sessionId> <k=v>   # 修改配置字段
tinyclaw chat loop trigger <sessionId>     # 立即触发一次 tick

tinyclaw web                           # 显示 Dashboard 访问地址

tinyclaw config show / edit            # 查看(脱敏)/ 编辑配置
tinyclaw config status                 # 配置自愈状态(LKG/待确认/最近回退)
tinyclaw config check                  # 校验 + 离线自检(出错返回码 1)
tinyclaw config reload                 # 校验 + 变更分级(hot/soft/restart)
tinyclaw config rollback --list        # 可回退版本;--lkg / --to <备份> 执行回退
tinyclaw config safe-mode on|off       # LKG 也起不来时用最小配置启动
tinyclaw mcp status                    # MCP server 配置载入结果(+ 载入诊断)
tinyclaw mcp add <name> --stdio <cmd>  # 新增 server(另支持 --sse <url> / --arg / --env K=V / --desc)
tinyclaw mcp remove <name>             # 删除 server(可写 enable / disable)
tinyclaw auth github / mfa-setup       # GitHub 授权 / TOTP 绑定

tinyclaw completions install           # 安装 tab 补全
```

### 对话内斜杠命令

| 命令 | 说明 |
|------|------|
| `/code` | 切换到 Code 模式(独立 JSONL,滑动窗口压缩) |
| `/chat` | 返回 Chat 模式 |
| `/plan` | Code 模式下切换到 Plan 子模式(先规划再执行) |
| `/auto` | Code 模式下切换到 Auto 子模式(直接执行,默认) |
| `/compact` | 手动触发上下文压缩(无需等 token 自动超限) |
| `/think` | 查看/设置本会话思考档位(`off`/`none`/`minimal`/`low`/`medium`/`high`/`xhigh`/`max`,下一轮生效,仅 DeepSeek 系后端) |
| `/new` | 新建会话 |

## 内置工具速查

### 文件与系统

| 工具 | 说明 |
|------|------|
| `exec_shell` | 执行 Shell 命令(MFA 可配) |
| `write_file` | 写入文件(MFA 可配) |
| `edit_file` | 精确替换文件片段(MFA 可配) |
| `delete_file` | 删除文件或目录(MFA 可配) |
| `read_file` | 读取文件内容(≤50KB) |
| `read_image` | 读取本地图片返回 base64,供视觉模型分析 |
| `grep` | ripgrep 正则检索文件内容(只读;默认遵守 `.gitignore`,自动跳过 `.git`;密钥路径拒绝) |
| `glob` | ripgrep 按 glob 列文件(只读;按路径排序;密钥路径拒绝) |
| `http_request` | 发送 HTTPS 请求,headers 支持 `$SECRET_NAME` 占位符 |

### Agent 协作

| 工具 | 说明 |
|------|------|
| `agent_fork` | 后台 fork Slave agent 异步执行任务(`result_mode: inject\|wait`;`context_mode` 选继承模式,`context_rounds` 定轮数上限) |
| `agent_status` | 查询 Slave 状态与进度(当前阶段 / 已用工具 / 实时输出) |
| `agent_wait` | 等待指定 Slave(或所有 Slave)完成并返回结果全文;超时**不改写** Slave 状态 |
| `agent_trace` | 检索已归档的 Slave 执行轨迹(列出最近归档,或取某个 Slave 的结果全文与轨迹路径) |
| `agent_abort` | 软中断 Slave |
| `session_get` | 列举对当前 Agent 可见的所有活跃 session |
| `session_send` | 向指定 session 注入消息,触发 Agent 处理 |
| `wake` | 唤醒另一个会话的 agent(注入消息 + 起一轮,受理即返回);**那轮的权限跟着目标会话**——目标可送达审批(如 qqbot 会话)就按该会话普通对话权限跑(全量工具 + 审批发到该通道),无交互路径(cli/无常驻连接)才退回无人值守白名单 |
| `ask_user` | 暂停并向用户提问(含预设选项) |

### 自省

| 工具 | 说明 |
|------|------|
| `self_status` | 查询自身运行状态(当前模型 / 上下文用量 / 缓存命中率 / 记忆规模 / 定时任务与 loop 数量 / 行为反馈条数 / 运行时目录占用) |
| `self_runtime_scan` | 扫描**自己的运行时目录** `~/.tinyclaw` 的磁盘占用,并给出可清理候选(safe / caution);需 `[selfAccess]` 授权 |
| `self_runtime_read` | 读取/列举运行时目录下的文件(记忆、会话、cron、loop、日志);密钥文件不可读 |
| `self_runtime_delete` | 删除运行时目录下的文件或目录以清理磁盘(`confirm: true` 才执行,可先 `dry_run`) |
| `fs_grant` | 申请**一个路径/目录**的写权限(路径级无感授权:不打扰用户、带 TTL、写审计);只接受 `$HOME` 内非密钥路径,`~/.tinyclaw` 与 cron/loop 不可用 |

> **自指运行权限**:`config.toml` 的 `[selfAccess].grantedAgents` 列出被授权的 agentId 后,
> 该 agent 对 `~/.tinyclaw` 全树拥有完整访问权,但**密钥类文件始终除外**——
> `config.toml` / `secrets.toml` / `mcp.toml` / `auth/**` / `*.key` / 名字含 token 的文件
> 既不可读、也不可写、不可删(`read_file` 等通用工具同样受此限制)。受保护的还有运行时根目录本身、
> 根下的 `.git`(配置备份仓库)与 `agents` 整体。

### 记忆与知识库

| 工具 | 说明 |
|------|------|
| `memory_read_mem` | 读取当前 Agent 的 MEM.md |
| `memory_write_mem` | 写入 MEM.md(章节级覆盖或追加) |
| `memory_read_active` / `memory_write_active` | 读写 ACTIVE.md 活跃上下文 |
| `memory_append_feedback` | 记录用户行为纠正到 feedback.md(去重 + 自动裁剪,无需 MFA) |
| `memory_append_card` | 主动追加一张结构化记忆卡片(可带原文引用) |
| `memory_append` | 追加一条记忆到当日历史存档并触发向量索引更新 |
| `memory_search` | 手动触发 QMD 向量搜索历史记忆 |
| `memory_recall` | 在**原文账本**里按关键词检索历史对话(可跨会话;`scope=all` 扫本机全部账本),返回 hit + seq 摘录 |
| `memory_expand` | 按 seq 区间从原文账本取回某个会话的**逐字原文**(压缩/剪枝掉的也还在) |
| `search_store` | 在本地知识库(如 `news`)做语义向量搜索 |

### 可视化与报告

| 工具 | 说明 |
|------|------|
| `render_diagram` | 渲染 mermaid/python 图表为图片(返回 `<img>` 标签) |
| `send_report` | 将 Markdown/mermaid/python 渲染为图片立即推送给用户 |
| `notify_user` | 立即发送纯文本通知(不等任务结束) |
| `write_report` | 将日报写入本地文件供 Dashboard 展示 |
| `release_file` | 将文件投放到 Dashboard 下载页(默认临时区;`keep=true` 投到常驻区并按目录归类),用户用一次性 curl 命令取走 |
| `db_write` | 将业务指标数据写入 Dashboard 数据库(折线图/柱状图) |

### Cron 与 MCP

| 工具 | 说明 |
|------|------|
| `cron_add / list / remove` | 管理定时任务 |
| `cron_enable / disable / run` | 启用 / 禁用 / 立即触发任务 |
| `mcp_list_servers` | 列出所有 MCP server,并附带 `mcp.toml` **载入诊断**(语法错/字段非法/无 server 段)与每个 server 最近一次连接失败 |
| `mcp_enable_server` | 启用并加载 MCP server 工具 |
| `mcp_disable_server` | 隐藏 MCP server 工具(底层连接保持) |
| `mcp_server_add` | 新增/覆盖 `mcp.toml` 里的 server 定义并热重载(**MFA**;写前校验+备份+原子写;`env`/`headers` 支持 `${SECRET:NAME}` 引用) |
| `mcp_server_remove` | 删除某个 server 定义并热重载(**MFA**;工具一并注销) |
| `mcp_server_set_enabled` | 设置某个 server 的 `enabled` 开关并热重载(**MFA**) |
| `mcp_reload` | 重新读盘并热重载 MCP 配置(手改 `mcp.toml` 后用它立即生效,不必重启服务) |
| `config_validate` | 只读:校验 `config.toml`(语法/schema/交叉引用)+ 离线自检 |
| `config_reload` | 把磁盘上的 `config.toml` 热应用进运行中的进程(**MFA**;分级 hot/soft/restart,自检失败自动回退) |
| `config_set` | 改**一个**配置字段并热应用(**MFA**)。只允许白名单字段:模型/单后端参数、模型别名、轮次与截断上限、重试节奏、交互提醒;`auth`/`sandbox`/`selfAccess`/`health`/`channels`/`web`/`providers`/`memory` 等一律拒(写前校验+备份+原子写,失败自动回退) |

### 后台 Job 与环境变量

> **Job ≠ Sub-Agent**:`agent_fork` 后台跑的是**另一个 LLM agent**;Job 跑的是**进程/命令**,适合长编译、批量下载、爬取、训练、监听。

| 工具 | 说明 |
|------|------|
| `job_start` | 后台启动一个进程/命令,立即返回 job id(`detach=true` = 独立 systemd unit,能活过 `systemctl restart`;`secrets:[...]` 按任务声明密钥;`timeout_secs` 超时自终止) |
| `job_list` / `job_status` | 列出/查看自己的 job(状态、pid、退出码、字节数、备注) |
| `job_output` | **增量**读输出(自上次读取以来),日志落盘,重启后仍可读 |
| `job_kill` | 杀整个进程组(systemd 载体时停整个 unit),默认 SIGTERM |
| `env_list` | 列出本 agent 的环境变量**键名**(永不回值),含全局 `~/.tinyclaw/env` 的键;被授权的 agent 还能看到 `secrets.toml` 的键名(值同样不回) |
| `env_set` | 写一个变量到 `~/.tinyclaw/agents/<id>/env`(0600);**密钥类键名需 MFA 审批**,普通变量不打扰(审批提示与审计里值打码,只见键名) |
| `env_delete` | 删除一个变量(密钥类同样要审批) |

env 分层(**低 → 高**):`process.env`(已含 `~/.tinyclaw/env`) < `agents/<id>/env` < job 的 `env` 参数。
值支持 `${SECRET:NAME}` 引用式(注入子进程前才解析);**值只通过进程环境传递、不拼命令行 → `ps -ef` 看不到**。

模型的用法来自工具自带的 description,以及内置 system prompt 里的 `## Background jobs (job_start)` 一节
(进程类长任务用它、LLM 类长任务才 `agent_fork`)。注意工具可见性还受**按 agent 的 `tools.toml`** 约束:
只有 `allowlist` 里列了这些工具的 agent 才看得到(默认 agent 没有 `tools.toml` = 全部可见)。

| 存活语义 | 行为 |
|---|---|
| 默认(非 detached) | 随服务退出:服务退出/重启时被收掉;下次启动若发现**残留进程**也会按契约收掉(不会变成孤儿) |
| `detach=true` | 放进**独立的 systemd transient unit**(独立 cgroup),因此能活过 `systemctl --user restart tinyclaw`;重启后 `job_status` 直接查 unit 探活,靠启动器写的 `rc` 文件补记退出码。无 `systemd-run` 的环境回落到 `setsid`+`unref`(只活过前台重启,活不过 `systemctl restart`) |

### 模型手册（按需拉取，用完即弃）

| 工具 | 说明 |
|------|------|
| `manual` | 按需拉取 tinyclaw 的**英文操作手册**（`topic`: `cron` / `jobs` / `loop` / `env`;不传则返回主题索引），内容在 `docs/manual/*.md` |

为什么要它:cron / loop / job / env 的规则又长又互相牵连(谁能写哪里、密钥怎么声明、脚本里怎么唤醒 LLM),
全塞进 system prompt 等于每轮都为一个偶尔才用的功能付 token。所以改成"要用时喊一声"。

**结果是一次性的**(`ToolDef.ephemeralResult`,当前唯一使用者就是它):

- 不进 JSONL、不进原文账本、不进 transcript → 不落盘;
- 压缩时(`Session.compress()` / `compressForCode()`)在摘要**之前**被摘掉 → 不会被蒸馏进长期记忆;
- 摘除时同步修链(把对应的 `tool_call_id` 从 assistant 的 `tool_calls` 里去掉),所以不会留下孤立调用;
- 缓存友好:唯一的消失点是"历史本来就要重写"的压缩时刻,不额外破坏前缀缓存。

因此模型必须在**自己的回复里**留下结论 —— 手册内容下一次压缩后就不在上下文里了。
手册进仓库(`docs/manual/`),改代码时同步改手册;`manual.ts` 的 `MANUAL_VERSION` 随之 +1。

### Code 模式专用

| 工具 | 说明 |
|------|------|
| `exit_plan_mode` | Plan 子模式下提交计划摘要,等待用户审批 |
| `create_skill` | 创建 Skill 文档并注册到 SKILLS.md |

## 运行时目录

```
~/.tinyclaw/
├── config.toml          # 配置(含密钥,不进仓库；写入前会校验,坏值拒写)
├── config.toml.bak-*    # 每次写入前的备份(保留最近 5 份)
├── config.toml.rejected-* # 被写前校验拒绝的内容留证(0600,不进 git)
├── config.toml.lkg      # 上一份"被证实可用"的配置(启动成功后写入,改坏时自动回退用)
├── .config-state.json   # 配置状态(current / lastGood / pending / 最近回退,0600)
├── .safe_config         # SAFE MODE 标记(存在 = 用最小配置启动,只留 providers/llm)
├── jobs/                # 后台 job:每 job 一个目录(meta.json + stdout.log + stderr.log,0600;detached 另有 run.sh/rc/started) 
├── mcp.toml             # MCP server 配置
├── memstores.toml       # 向量知识库配置(news 等)
├── dashboard.db         # Dashboard 指标数据库(SQLite)
├── agents/<id>/env      # 该 agent 自己的环境变量(KEY=VALUE,0600,沙箱内被掩码)
├── agents/default/      # 默认 Agent 工作区
│   ├── SYSTEM.md        # 系统提示
│   ├── MEM.md           # 持久记忆
│   ├── SKILLS.md        # 技能目录
│   ├── TASK.md          # Loop Session 默认任务指令
│   ├── access.toml      # 跨 session 通信权限(can_access / allow_from)
│   ├── memory/          # 向量索引(index.sqlite) + 逐字层(transcript/) + 压缩摘要 YYYY-MM-DD.md
│   ├── notes/           # Notes MCP 数据
│   ├── skills/          # Skill 脚本目录
│   └── workspace/       # Shell 命令默认 cwd
│       ├── tmp/         # 临时文件
│       └── output/      # 输出文件
├── sessions/            # 对话 JSONL(崩溃恢复)+ 原文账本 <id>.journal.jsonl(只追加)+ loop 配置 .toml
├── cron/
│   ├── jobs/            # 定时任务持久化(<id>.json)
│   └── logs/            # 每次 run 的结果日志
├── slaves/              # Slave(sub-agent)轨迹归档
│   └── YYYY-MM/YYYY-MM-DD-<slaveId>/
│       ├── trajectory.jsonl   # 完整轨迹(含继承上下文 + 每次工具调用与结果)
│       ├── meta.json          # 任务/状态/工具/起止时间
│       └── result.md          # 最终结果全文
├── reports/             # 日报存档(<type>/<date>.md,供 Dashboard 展示)
├── downloads/           # Dashboard 下载页·临时区(release_file 投放,按 ttlDays 清理)
├── keep/                # Dashboard 下载页·常驻区(可按子目录归类,永不自动清理)
└── news/                # News MCP 新闻存档(YYYY-MM/YYYY-MM-DD.md)
```

## 系统依赖(可选)

| 功能 | 依赖 |
|------|------|
| 消息图片渲染 | `chromium-browser` + `pip install markdown-it-py Pillow` |
| 语音转文字 | `pip install faster-whisper pilk` |
| News MCP | `pip install requests beautifulsoup4 lxml` |
| Python 图表 | `pip install matplotlib` |

## 文档

**架构**

- [architecture/overview.md](docs/architecture/overview.md) — 整体架构、模块说明、IPC 协议、操作速查
- [architecture/agent-loop.md](docs/architecture/agent-loop.md) — ReAct 循环、MFA、压缩、并发处理
- [architecture/retry.md](docs/architecture/retry.md) — 连接稳定性与重试策略(含 WebSocket 路径)

**功能命令参考**

- [commands/code-mode.md](docs/commands/code-mode.md) — Code 模式(/code /plan /auto /compact)
- [commands/cron-pipeline.md](docs/commands/cron-pipeline.md) — Cron Pipeline 多步流水线
- [commands/loop-session.md](docs/commands/loop-session.md) — Loop Session 持续自主执行
- [commands/session-bridge.md](docs/commands/session-bridge.md) — 跨 Session 通信(session_get/send)

**MCP Server**

- [mcp/news.md](docs/mcp/news.md) — 多源新闻抓取/存档/检索
- [mcp/notes.md](docs/mcp/notes.md) — 结构化笔记知识库

**给模型看的手册（不是用户文档）**

- [manual/cron.md](docs/manual/cron.md) — 定时任务的模式/调度字段/推送策略/沙箱与密钥声明
- [manual/jobs.md](docs/manual/jobs.md) — 后台 job 生命周期、detach、读输出、从脚本唤醒 LLM
- [manual/loop.md](docs/manual/loop.md) — loop 触发器(watch 语义)、loop_control、已知限制
- [manual/env.md](docs/manual/env.md) — 环境变量分层、密钥、沙箱可写范围、`wake` 命令

## License

MIT
