# News MCP Server

> 多源新闻自动抓取、去重、存档、向量检索的 MCP server。
> 路径：`mcp-servers/news/`

---

## 架构概览

```
cron job（daily）
  └── mcp_news_fetch_and_store(topics, max, since_hours)
        └── news_fetch.py
              ├── HackerNews Algolia API
              └── 58 个 RSS 源（科技/财经/AI/大宗商品/加密/中文媒体）
                    ↓
              L1 去重（seen_urls.db，SQLite 精确去重）
              L2 去重（n-gram Jaccard，批次内语义去重）
                    ↓
              写入 ~/.tinyclaw/news/YYYY-MM/YYYY-MM-DD.md
              写入 .update-pending（触发主进程 QMD 重新索引）
                    ↓
              search_store("news", query)  ← 向量语义搜索
```

---

## MCP 工具列表

| 工具 | 说明 |
|------|------|
| `fetch_and_store` | 按 topics 从 HN + RSS 多源抓取，去重后追加写入当日 Markdown 存档 |
| `read_day` | 读取指定日期的存档（默认今天），返回完整 Markdown 文本 |
| `list_days` | 列出本地已有存档的日期列表（最近 N 天） |
| `search_local` | 本地全文关键词搜索（文本匹配，多词 OR 逻辑） |
| `rebuild_index` | 写入 `.update-pending` 标记，触发主进程 QMD 重新索引 |

向量语义搜索使用内置的 `search_store` 工具（而非 MCP 工具），基于 Gemma-300M 嵌入模型。

---

## 信息源

### HackerNews（Algolia API）

- 按 topics 关键词过滤标题，取最近 `since_hours` 小时内的热门帖
- 保留：标题、URL、评分（⭐N）、发布时间、作者

### RSS 源（58 个）

分类如下：

| 类别 | 数量 | 代表源 |
|------|------|--------|
| 科技/通用 | 13 | BBC Tech / Wired / TechCrunch / MIT Tech Review / The Verge |
| AI/LLM 专项 | 5 | HuggingFace Blog / VentureBeat AI / OpenAI Blog / LessWrong |
| 国际新闻 | 7 | CNN / Financial Times / Nikkei Asia / SCMP |
| 综合财经/宏观 | 9 | Bloomberg / CNBC / WSJ / Yahoo Finance / MarketWatch |
| 贵金属专项 | 3 | FX Street / Seeking Alpha Gold & Silver |
| 大宗商品 | 3 | OilPrice.com / Seeking Alpha Commodities & Copper |
| 能源/板块 | 3 | Seeking Alpha Energy & Materials / CNBC Energy |
| 加密货币 | 5 | CoinDesk / CoinTelegraph / Decrypt / Bitcoin Magazine |
| 开源/GitHub | 1 | GitHub Trending RSS |
| 中文科技媒体 | 3 | 虎嗅 / 少数派 / IT之家 |

---

## 去重机制

### L1：精确去重（`seen_urls.db`）

- SQLite 数据库，跨 run 持久化
- 每个 URL 只入库一次，再次出现直接跳过
- 保留最近 30 天记录，自动清理过期条目

### L2：批次内语义去重（n-gram Jaccard）

- 同一批次内，相似度 > 0.6 的标题视为重复，只保留评分更高的一条
- 防止同一事件被多个 RSS 源重复收录

---

## 存档格式

每日存档为 Markdown 文件（`~/.tinyclaw/news/YYYY-MM/YYYY-MM-DD.md`）：

```markdown
# 新闻存档 2026-03-24

## 抓取批次 2026-03-24T00:00:51.610Z

### 文章标题 ⭐42 `[oil]`
- **来源**：hackernews
- **链接**：https://...
- **发布**：2026-03-24
- **作者**：username

### RSS 文章标题 `[stock market,S&P500,Nasdaq]`
- **来源**：rss:Bloomberg
- **链接**：https://...
- **发布**：2026-03-24

前300字摘要...
```

---

## 与 Cron Pipeline 的集成模式

**正确方式**：`tool` step 负责抓取，`msg` step 负责分析（LLM 全工具环境）。

```json
{
  "steps": [
    {
      "type": "tool",
      "name": "mcp_news_fetch_and_store",
      "args": { "topics": "A股,港股,Federal Reserve,oil,gold", "max": 100, "since_hours": 26 }
    },
    {
      "type": "msg",
      "content": "读取今日新闻（mcp_news_read_day），执行实体关系分析，最后 send_report 推送日报。"
    }
  ]
}
```

详细的 Pipeline 设计与防幻觉技巧见 [CRON_PIPELINE.md](./CRON_PIPELINE.md)。

---

## 实体关系分析层

在 `msg` step 的 prompt 中加入结构化分析指令，可以让 LLM 从新闻中抽取：

### ① 核心实体抽取

```
实体名 [类型：央行/政府/企业/人物/政策/地缘事件]
影响方向：▲利多 / ▼利空 / ━中性 / ?不确定
一句话描述（必须来自新闻原文）
```

### ② 实体关系链

```
[实体A] --[关系]--> [实体B] → 市场影响
例：[美联储] --[维持利率不变]--> [美元走弱] → 利多黄金/人民币升值
例：[伊朗/霍尔木兹] --[供应风险]--> [原油价格上涨] → 利空航空，利多能源
```

### ③ 跨资产传导路径

```
[触发因素] → [大宗商品] → [A股行业] → 个股逻辑
```

### ④ 事件持续性预判

| 事件 | 直接影响 | 持续性 |
|------|---------|--------|
| 事件名 | 哪些行业/资产 | 短期（1-3日）/ 中期（1-2周）/ 长期（1月+）|

---

## 配置（`~/.tinyclaw/mcp.toml`）

```toml
[servers.news]
enabled = true
transport = "stdio"
command = "bun"
args = ["/path/to/tinyclaw/mcp-servers/news/index.ts"]
description = "多源新闻抓取/去重/存档 MCP server"
```

**memstores 向量索引（`~/.tinyclaw/memstores.toml`）：**

```toml
[[stores]]
name    = "news"
title   = "每日新闻存档（HackerNews / RSS 抓取）"
path    = "~/.tinyclaw/news"
pattern = "**/*.md"
enabled = true
```

需要在 `config.toml` 中启用向量记忆：

```toml
[memory]
enabled    = true
embedModel = "hf:ggml-org/embeddinggemma-300M-GGUF/embeddinggemma-300M-Q8_0.gguf"
```

---

## 系统依赖

```bash
pip3 install requests beautifulsoup4 lxml
# 可选：更好的编码检测
pip3 install charset-normalizer chardet
```
