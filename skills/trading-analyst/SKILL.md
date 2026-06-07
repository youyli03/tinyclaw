---
name: trading-analyst
description: |
  美股多智能体分析 Skill，基于 TradingAgents 框架，支持对指定股票发起技术/新闻/基本面/情绪四维分析和多空辩论决策。
  支持的股票: MU、NVDA、ARM、ORCL、AMD、INTC、TSLA、META、MSFT、AAPL、AMZN、GOOGL 等所有美股代码
  注意: 每次分析约需 3-8 分钟，LLM 使用 DeepSeek（推理+对话）。
trigger-phrases:
  - 分析
  - 多空分析
  - 股票分析
  - 帮我分析
  - 怎么样
  - 值得买吗
  - 技术面
  - 基本面
  - 多空辩论
  - trading analysis
requires:
  - exec_shell
---

# trading-analyst — 美股多智能体分析

本 skill 封装了 **TradingAgents** 多智能体框架，对指定美股进行四维分析 + 多空辩论，输出完整投资决策报告。

## 触发时机

用户提到以下意图时触发：
- "分析 NVDA" / "帮我分析英伟达"
- "MU 最近怎么样" / "看看美光走势"
- "ARM 值得买入吗" / "ORCL 技术面分析"
- "[股票代码] 多空分析" / "帮我研究一下 [股票]"

## 执行步骤

> **必须按以下步骤执行，不得跳过或自行替代**

### 第 1 步：确定参数

从用户意图中提取：
- `TICKER`：股票代码（英文大写，如 `NVDA`、`MU`、`ARM`）
  - 若用户说公司名，转换：英伟达→NVDA、美光→MU、Arm/ARM→ARM、甲骨文→ORCL
- `DATE`（可选）：分析日期，默认不传（自动取最近交易日）

### 第 2 步：告知用户开始分析

发送消息：`🔍 开始分析 {TICKER}，预计需要 3-8 分钟，请稍候...`

### 第 3 步：运行分析脚本

找到本 skill 的目录（通过 read_file 读取的 doc_path 的父目录的父目录），执行：

```bash
python3 /home/lyy/tinyclaw/skills/trading-analyst/scripts/run.py --ticker {TICKER}
# 或带日期：
python3 /home/lyy/tinyclaw/skills/trading-analyst/scripts/run.py --ticker {TICKER} --date {DATE}
```

- 超时设置：600 秒（10 分钟）
- stdout 输出即为完整 Markdown 报告
- stderr 为进度日志（可忽略）

### 第 4 步：输出报告

将 stdout 内容直接发送给用户（Markdown 格式，系统会自动渲染为图片）。

若脚本报错，输出错误信息并告知用户分析失败原因。

## 分析维度

1. **技术面**（Market Analyst）：SMA/EMA、RSI、MACD、布林带、ATR
2. **新闻面**（News Analyst）：TrendRadar 中文财经新闻（华尔街见闻/财联社）
3. **基本面**（Fundamentals Analyst）：市盈率、EPS、市值、营收增长
4. **情绪面**（Sentiment Analyst）：综合情绪评分
5. **多空辩论**：看多/看空观点对决，研究经理裁判
6. **最终决策**：买入区间/持有/减仓建议

## 配置说明

- DeepSeek API Key：从 `~/.tinyclaw/secrets.toml` 自动读取（`DEEPSEEK_API_KEY`）
- TradingAgents 框架：位于 `/home/lyy/TradingAgents-main`
- 中文新闻：TrendRadar SQLite DB（`/home/lyy/TrendRadar/output/news/`）
