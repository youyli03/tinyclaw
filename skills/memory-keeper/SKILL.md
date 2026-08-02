---
name: memory-keeper
description: |
  项目跨 session 记忆(code_note)读写规范。含 MEMORY.md 索引与 topic 文件的分工、
  摘要行格式([YYYY-MM-DD] [s:N] 摘要 → topic.md)、[s:N] 稳定性语义、写入时机清单
  (约束/里程碑/根因/任务完成)、project slug 命名规则。附带 code_clarify_project 用法。
trigger-phrases:
  - 记忆
  - 记录一下
  - 记住
  - 进度
  - 约束
  - 决策
  - 项目记忆
  - MEMORY
  - topic
  - code_note
  - 跨 session
requires:
  - code_note_read
  - code_note_write
  - code_note_search
  - code_clarify_project
---

# memory-keeper — 项目记忆(code_note)读写规范

## 分工

| 存储 | 用途 | 文件 |
|------|------|------|
| MEMORY.md 索引 | 每分区一行摘要,指向 topic 文件 | `~/.tinyclaw/agents/default/code/projects/<slug>/MEMORY.md` |
| topic 文件 | 详细内容(architecture/decisions/progress/bugs/constraints) | 同目录 `topic.md` |
| 项目 slug | 本地路径 `/`→`_`;SSH `ssh_`+host+路径;win 同理 | 如 `_home_lyy_tinyclaw` |

## 读取(code_note_read)

- 不传 project → 列出所有已知项目
- 传 project 不传 topic → MEMORY.md 摘要模式(每节标题+前 2 条,limit 控制)
- 传 topic → 读 topic 文件全文,自动附带 age warning(>7 天未更新)
- 传 section → 只读 MEMORY.md 或 topic 中对应 `## 分区` 内容
- summary=false → MEMORY.md 全文

## 写入时机(code_note_write,立即调用不等 session 结束)

1. 发现跨 session 有价值的约束(如"此进程不能自行 kill")
2. 完成重要里程碑(如"pathname 路由已完成")
3. 定位到非显而易见的根因
4. 任务完成(说"已完成")前更新进度

## 摘要行格式(写入 MEMORY.md 索引)

```
- [YYYY-MM-DD] [s:5] 一句话摘要 → topic.md
```

- `[s:N]` 稳定性 1~10:默认新条目 5;重要约束/决策用 6~8;越高在 prompt 中存活越久
- 必须指向 topic 文件(`→ progress.md`),内容写进 topic 文件
- 旧条目超过约 200 行时,把详情移到 topic 文件,索引只留摘要

## topic 文件

- 按分区组织:⛔ 约束 / 🧠 架构 / 📊 进度 / 🐛 问题 / 📝 决策
- 可用 `section` 参数做章节级 upsert,不影响其他章节

## 项目归属不确定(code_clarify_project)

- 无法从 workdir/对话语义判断当前项目时调用:列出已知项目让用户选择
- 涉及 SSH 时传 ssh_host,自动 DNS 解析比对已有 IP 映射
