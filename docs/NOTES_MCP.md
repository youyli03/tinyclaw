# Notes MCP Server

> 为每个 Agent 提供独立的结构化笔记知识库，通过 MCP 工具调用读写。
> 数据存储在 `~/.tinyclaw/agents/<agent-id>/notes/`，Agent 间完全隔离。

---

## 笔记格式类型

| 类型 | 特点 | 适用场景 |
|---|---|---|
| `structured` | 严格字段约束，分类创建时指定字段 | 交易记录、日志 |
| `timestamped` | 自动加时间戳，内容自由 | 提醒、待办、点子 |
| `freeform` | 完全自由格式，按块追加 | 知识点、命令速查 |

---

## 工具速查

| 工具 | 功能 |
|---|---|
| `mcp_notes_list_categories` | 列出所有分类 |
| `mcp_notes_create_category` | 新建分类（指定类型与字段） |
| `mcp_notes_add_note` | 写入一条笔记 |
| `mcp_notes_query_notes` | 读取某分类的全部笔记 |
| `mcp_notes_search_notes` | 关键词全文搜索 |
| `mcp_notes_delete_note` | 按 note_id 删除一条笔记 |
| `mcp_notes_get_due_reminders` | 获取待提醒条目（24h 去重） |

---

## 快速上手

**写入提醒：**
```
mcp_notes_add_note(category="reminders", content="4月5日抢高铁票")
```

**写入交易记录：**
```
mcp_notes_add_note(
  category="trading_log",
  content={time:"2026-03-28 14:00", code:"002361", action:"买", price:"14.2", qty:"100"}
)
```

**新建自定义分类：**
```
mcp_notes_create_category(name="stm32", type="freeform", description="STM32知识点")
```

**查询笔记：**
```
mcp_notes_query_notes(category="reminders")
mcp_notes_query_notes(category="trading_log", limit=10)  # 最近10条
```

**全库搜索：**
```
mcp_notes_search_notes(query="高铁")
mcp_notes_search_notes(query="002361", category="trading_log")
```

**对话开始时检查提醒（每次必调用）：**
```
mcp_notes_get_due_reminders()
# 返回 { due: [{note_id, text}], total_reminders: N }
# due 不为空时，在首条回复中顺带提示用户
```

---

## 内置默认分类

| 分类 | 类型 | 说明 |
|---|---|---|
| `trading_log` | structured | 炒股操作记录（time / code / action / price / qty / note）|
| `reminders` | timestamped | 提醒与待办事项 |
| `ideas` | timestamped | 功能点子与想法 |

---

## 数据存储

```
~/.tinyclaw/agents/default/notes/
  index.json           分类元数据
  reminders.md         提醒笔记（Markdown）
  trading_log.md       交易记录（Markdown 表格）
  ideas.md             点子
  remind_state.json    提醒去重状态（记录每条上次提醒时间）
  <自定义>.md          用 create_category 新建的分类
```

---

## 注册配置（`~/.tinyclaw/mcp.toml`）

```toml
[servers.notes]
enabled   = true
transport = "stdio"
command   = "bun"
args      = ["/home/你的用户名/tinyclaw/mcp-servers/notes/index.ts", "--agent-id", "default"]
description = "动态笔记知识库（Agent 隔离）"
```

多 Agent 场景：为每个 Agent 单独注册一个 server 条目，`--agent-id` 传对应 Agent ID。
