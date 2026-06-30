# 蒸馏管线：压缩时自动提取环境信息与行为约束

> 描述 tinyclaw 如何在 Code 模式上下文压缩时，通过一次 LLM 调用同时输出：
> 项目记忆（NOTES.md）、环境信息（ENV.md）、行为约束（feedback.md），
> 实现零额外调用的自动知识沉淀。

---

## 一、背景

### 1.1 问题

Code 模式在长期会话中会积累大量上下文（工具调用、代码片段、文件内容），
传统做法是单纯压缩旧消息为一份文本摘要，但这样做会丢失以下有价值的信息：

- **环境信息**：用户本机有哪些项目、常用工具路径、服务端口等
- **行为约束**：用户纠正过的做法（如"不要自行重启进程"）
- **项目进度**：跨 session 的里程碑和关键决策

这些信息散落在对话历史的工具调用和执行结果中，
如果能**在压缩时自动提取并持久化**，
后续 session 就能直接获得这些上下文，无需用户重复说明。

### 1.2 演进路线

| 阶段 | 触发点 | 输出 | commit |
|------|--------|------|--------|
| 初版 | 每轮结束 | 单项目纯文本 → NOTES.md | - |
| 重构 | 上下文压缩时 | JSON 多项目分组 → NOTES.md | `79e7941` |
| ENV 接入 | 同上 | + `env_updates` → ENV.md | `416cfd3` |
| feedback 接入 | 同上 | + `behavior_corrections` → feedback.md | `0be8767` |

最终形态：**一次蒸馏 LLM 调用，三路输出，零额外成本。**

---

## 二、架构概览

```
                    Code Session 上下文达到阈值
                              │
                              ▼
                    summarizeAndCompressCode()
                              │
                    ┌─────────┴─────────┐
                    │                   │
              toSummarize           toKeep
              (旧消息)              (最近 N 轮)
                    │
                    ▼
              distillCompressionNotes()   ← fire-and-forget
                    │
                    ▼
              buildCompressDistillPrompt()
                    │
                    ▼
              summarizer LLM
                    │
                    ▼
              JSON 输出 {
                projects: [...],         → NOTES.md
                notes: [...],            → NOTES.md
                env_updates: [...],      → ENV.md
                behavior_corrections: [...] → feedback.md
              }
                    │
                    ▼
              parseAndWriteDistillJson()
                    │
          ┌─────────┼─────────┬──────────┐
          ▼         ▼         ▼          ▼
      NOTES.md   ENV.md   feedback.md  dashboard
```

### 关键设计决策

1. **触发点从"每轮结束"移到"上下文压缩时"**
   - 理由：蒸馏 LLM 一次性看到整批被压缩掉的旧消息，摘要质量远高于逐条注入
   - 代价：环境信息/行为约束的写入有延迟（只在压缩时触发），但这是可接受的——不压缩意味着上下文还不紧张，不需要跨 session 恢复

2. **fire-and-forget 模式**
   - 蒸馏调用是异步的，不阻塞压缩结果返回
   - 失败了只打日志，不影响主流程

3. **一次 JSON 覆盖所有项目**
   - 旧设计中每个 project 单独调一次蒸馏 LLM
   - 新设计一次调用输出 `projects[]` 数组，LLM 自行分类

---

## 三、ENV.md 蒸馏

### 3.1 文件格式

路径：`~/.tinyclaw/agents/<agentId>/code/ENV.md`

```markdown
# 本机环境上下文

```json
{
  "projects": {
    "tinyclaw": "/home/lyy/tinyclaw",
    "pin-hunter-bot": "/home/lyy/pin-hunter-bot"
  },
  "tools": {
    "tj.py": "~/.tinyclaw/agents/default/skills/trade-journal/scripts/tj.py",
    "aria2c": "系统安装,RPC port 6800"
  },
  "services": {
    "MCSManager": "HTTP API / Socket.IO,daemon port 24444",
    "Clash": "HTTP 代理端口 7890"
  }
}
```
```

- `.md` 后缀保留（system prompt 引用路径不变）
- 3 个顶层 category：`projects` / `tools` / `services`
- 解析 / 去重按 `category::key` 唯一定位
- system-prompt.ts 从 ` ```json ` 代码块提取 JSON 注入

### 3.2 JSON schema（蒸馏 LLM 输出）

```json
{
  "env_updates": [
    {"category": "projects", "key": "my-project", "value": "/home/lyy/my-project"},
    {"category": "tools", "key": "vivado", "value": "C:/Xilinx/Vivado/2023.1/bin/vivado"},
    {"category": "services", "key": "MCSManager", "value": "HTTP API,daemon port 24444"}
  ]
}
```

- `env_updates` 为**可选**字段，无新环境信息可省略
- `category` 限 3 个枚举值
- prompt 约束：只记可复用项（项目根路径 / 服务 / 常用命令），不记临时路径

### 3.3 防臃肿三层防线

| 层 | 位置 | 机制 |
|----|------|------|
| LLM 已知 key 跳过 | `distillCompressionNotes` | prompt 注入已有 `category::key` 清单，LLM 跳过不输出 |
| 解析器去重 | `parseAndWriteDistillJson` | `category::key` 已存在则跳过 |
| TTL 清理（预留） | 未来 cron | 超 60 天无人引用的 key 标记清理 |

### 3.4 已知 key 清单注入示例

蒸馏 prompt 末尾附加：

```
⚠️ 以下环境 key 已存在于 ENV.md，请勿重复输出：
  projects::tinyclaw, projects::pin-hunter-bot, tools::aria2c, services::MCSManager
```

LLM 看到此清单后不会浪费 output token 重复输出已存在的 key，
token 消耗极小（几十个 key 名）。

---

## 四、feedback.md 蒸馏

### 4.1 文件格式

路径：`~/.tinyclaw/agents/<agentId>/code/feedback.md`

```
- [2026-04-10] 后续在 Plan 模式下需要提交方案时一定要调用 exit_plan_mode
- [2026-05-24] 排查网络问题前先确认目标机器是 rk3588 还是 Windows
- [2026-06-10] 每次回复结束后必须调用 ask_user 询问下一步
```

- 每行一条纠正，格式 `- [YYYY-MM-DD] 纠正内容`
- 日期前缀由解析器自动添加（LLM 只输出 content）

### 4.2 JSON schema（蒸馏 LLM 输出）

```json
{
  "behavior_corrections": [
    {"content": "不要自行重启 tinyclaw 进程"},
    {"content": "排查网络问题前先确认目标机器"}
  ]
}
```

- `behavior_corrections` 为**可选**字段
- 每条只含 `content`，日期前缀由 `parseAndWriteDistillJson` 自动添加
- prompt 约束：**只记跨项目通用的行为约束**，不记专属于单一项目的规则

### 4.3 跨项目通用性约束

蒸馏 prompt 中明确：

```
⚠️ behavior_corrections 必须是跨项目通用的行为约束，不要记录专属于当前项目的规则：
  ✅ "排查网络问题前先确认目标机器"（通用）
  ✅ "不要自行执行 force push，须先告知风险"（通用）
  ❌ "tinyclaw 中不要直接改 YAML 配置"（仅适用于 tinyclaw，属于 NOTES.md）
```

### 4.4 去重策略

1. 蒸馏 prompt 末尾注入已有 feedback 内容清单（纯 content，去掉日期前缀）
2. LLM 看到已存在的纠正后避免重复输出
3. `parseAndWriteDistillJson` 做二次校验：content 完全匹配则跳过

已存在清单注入示例：

```
⚠️ 以下行为约束已记录在 feedback.md，请勿重复输出：
  - 后续在 Plan 模式下需要提交方案时一定要调用 exit_plan_mode
  - 排查网络问题前先确认目标机器是 rk3588 还是 Windows
```

---

## 五、ENV.md ↔ feedback.md 对称设计

| 维度 | ENV.md | feedback.md |
|------|--------|-------------|
| JSON 字段 | `env_updates` | `behavior_corrections` |
| 注入已有 | `category::key` 清单 | 纯 content 清单 |
| 去重键 | `category::key` 完全匹配 | `content` 完全匹配 |
| 写入方式 | JSON 整体覆写 | 逐行追加 |
| LLM 输入 | 已有 key 名 | 已有 content 文本 |
| 内容性质 | 事实（路径 / 端口 / 服务） | 约束（行为规则 / 被纠正的做法） |

---

## 六、路径前缀映射（MCP Windows 路径）

`pathToProjectSlug` 新增 `win:` 和 `home:` 前缀分支：

| 路径示例 | slug |
|----------|------|
| `/home/lyy/tinyclaw` | `_home_lyy_tinyclaw` |
| `win:F:/Github/fpgallm` | `ssh_win_F_Github_fpgallm` |
| `home:/home/lyy/proj` | `_home_lyy_proj` |

解决 MCP 远程 session 中 Windows 路径无法与本地 project slug 对齐的问题。

---

## 七、实现文件

| 文件 | 改动内容 |
|------|----------|
| `src/memory/summarizer.ts` | 核心蒸馏逻辑：prompt 构建、JSON 解析、多文件写入 |
| `src/core/agent-manager.ts` | `codeEnvPath()` 返回 ENV.md 路径 |
| `src/tools/memory.ts` | `pathToProjectSlug` 新增 win:/home: 前缀 |
| `src/core/session.ts` | `compressForCode` 传入 agentId |
| `src/core/agent.ts` | 删除旧的逐轮蒸馏调用 |

---

## 八、相关文档

- [QMD + RKLLM Embed 架构](./qmd-embed.md)：向量索引与 embed 后端
- [MEM.md（chat 模式跨 session 记忆）](../architecture/overview.md)：架构总览
