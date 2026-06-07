#!/usr/bin/env python3
"""
美股多智能体分析主脚本 — trading-analyst skill
用法: python run.py --ticker NVDA [--date 2026-06-06] [--rounds 1]

依赖:
  - TradingAgents 框架: /home/lyy/TradingAgents-main
  - DeepSeek API Key: ~/.tinyclaw/secrets.toml (DEEPSEEK_API_KEY)
  - TrendRadar 中文新闻: /home/lyy/TrendRadar/output/news/*.db (可选)
"""
from __future__ import annotations

import argparse
import os
import re
import sys
from datetime import date, timedelta
from pathlib import Path

# ── DeepSeek API Key ─────────────────────────────────────────────────────────
def _load_deepseek_key() -> str:
    """从 ~/.tinyclaw/secrets.toml 读取 DeepSeek API Key，回退环境变量"""
    secrets_path = Path.home() / ".tinyclaw" / "secrets.toml"
    try:
        content = secrets_path.read_text(encoding="utf-8")
        m = re.search(r'DEEPSEEK_API_KEY\s*=\s*["\']([^"\']+)["\']', content)
        if m:
            return m.group(1)
    except Exception:
        pass
    return os.environ.get("DEEPSEEK_API_KEY", "")


DEEPSEEK_KEY = _load_deepseek_key()
if not DEEPSEEK_KEY:
    print("[错误] 未找到 DEEPSEEK_API_KEY，请在 ~/.tinyclaw/secrets.toml 中配置", file=sys.stderr)
    sys.exit(1)

# ── 环境变量：LLM 提供商 ──────────────────────────────────────────────────────
os.environ["TRADINGAGENTS_LLM_PROVIDER"] = "deepseek"
os.environ["TRADINGAGENTS_DEEP_THINK_LLM"] = "deepseek-reasoner"
os.environ["TRADINGAGENTS_QUICK_THINK_LLM"] = "deepseek-chat"
os.environ["DEEPSEEK_API_KEY"] = DEEPSEEK_KEY

# ── 添加 TradingAgents 到 Python 路径 ─────────────────────────────────────────
TA_PATH = "/home/lyy/TradingAgents-main"
if not Path(TA_PATH).exists():
    print(f"[错误] TradingAgents 目录不存在: {TA_PATH}", file=sys.stderr)
    sys.exit(1)
if TA_PATH not in sys.path:
    sys.path.insert(0, TA_PATH)

# ── 当前脚本目录（加入 sys.path 以便导入 news_adapter）─────────────────────
SCRIPT_DIR = Path(__file__).parent.resolve()
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

# ── Monkey-patch 新闻函数：替换 yfinance 新闻为 TrendRadar 中文新闻 ──────────
try:
    from news_adapter import get_trendradar_news
    import tradingagents.dataflows.yfinance_news as yfn_module
    yfn_module.get_news_yfinance = get_trendradar_news
    print("[INFO] 已注入 TrendRadar 中文新闻适配器", file=sys.stderr)
except Exception as e:
    print(f"[WARN] 新闻适配器加载失败，使用默认 yfinance 新闻: {e}", file=sys.stderr)


# ── 工具函数 ──────────────────────────────────────────────────────────────────
def get_last_trading_day() -> str:
    """获取最近一个交易日（跳过周末，不处理节假日）"""
    d = date.today()
    # 周一→周五(3天前)，周日→周五(2天前)，周六→周五(1天前)
    if d.weekday() == 0:  # Monday
        d -= timedelta(days=3)
    elif d.weekday() == 6:  # Sunday
        d -= timedelta(days=2)
    elif d.weekday() == 5:  # Saturday
        d -= timedelta(days=1)
    else:
        # 工作日：用前一天（当天可能尚未收盘）
        d -= timedelta(days=1)
        if d.weekday() == 5:  # 前一天是周六
            d -= timedelta(days=1)
    return d.isoformat()


def format_report(state: dict, decision: str, ticker: str, analysis_date: str) -> str:
    """格式化最终 Markdown 报告"""

    def extract(key: str) -> str:
        val = state.get(key, "") if hasattr(state, "get") else getattr(state, key, "")
        return str(val).strip() if val else ""

    sections: list[str] = []
    sections.append(f"# 📊 {ticker} 多智能体分析报告")
    sections.append(f"> 分析日期：{analysis_date} | 数据来源：yfinance + TrendRadar | LLM：DeepSeek R1")
    sections.append("")

    for report_key, title in [
        ("market_report",       "📈 技术面分析（Market Analyst）"),
        ("news_report",         "📰 新闻面分析（News Analyst）"),
        ("fundamentals_report", "🏢 基本面分析（Fundamentals Analyst）"),
        ("sentiment_report",    "😐 情绪面分析（Sentiment Analyst）"),
    ]:
        content = extract(report_key)
        if content:
            sections.append(f"## {title}")
            sections.append(content)
            sections.append("")

    # 多空辩论摘要
    debate = state.get("investment_debate_state")
    if isinstance(debate, dict):
        bull = debate.get("bull_history", [])
        bear = debate.get("bear_history", [])
        if bull or bear:
            sections.append("## ⚔️ 多空辩论摘要")
            if bull:
                sections.append("### 看多方最终论点")
                sections.append(str(bull[-1])[:1000])
            if bear:
                sections.append("### 看空方最终论点")
                sections.append(str(bear[-1])[:1000])
            sections.append("")

    sections.append("## 🎯 最终决策")
    sections.append(str(decision))
    sections.append("")

    return "\n".join(sections)


# ── 主函数 ────────────────────────────────────────────────────────────────────
def main() -> None:
    parser = argparse.ArgumentParser(description="美股多智能体分析 — trading-analyst skill")
    parser.add_argument("--ticker", "-t", required=True, help="股票代码，如 NVDA、MU、ARM")
    parser.add_argument("--date", "-d", default=None, help="分析日期 YYYY-MM-DD（默认：最近交易日）")
    parser.add_argument("--rounds", type=int, default=1, help="多空辩论轮次（默认 1）")
    parser.add_argument("--full", action="store_true", help="输出完整原始状态（调试用）")
    args = parser.parse_args()

    ticker = args.ticker.upper()
    analysis_date = args.date or get_last_trading_day()

    print(f"[INFO] 开始分析 {ticker}（日期：{analysis_date}，辩论轮次：{args.rounds}）...", file=sys.stderr)

    from tradingagents.graph.trading_graph import TradingAgentsGraph
    from tradingagents.default_config import DEFAULT_CONFIG

    config = DEFAULT_CONFIG.copy()
    config["llm_provider"] = "deepseek"
    config["deep_think_llm"] = "deepseek-reasoner"
    config["quick_think_llm"] = "deepseek-chat"
    config["max_debate_rounds"] = args.rounds
    config["max_risk_discuss_rounds"] = 1
    config["output_language"] = "Chinese"

    ta = TradingAgentsGraph(debug=False, config=config)

    print("[INFO] 多智能体分析运行中（预计 3-8 分钟）...", file=sys.stderr)
    state, decision = ta.propagate(ticker, analysis_date)

    if args.full:
        for key, val in state.items():
            if val:
                print(f"\n=== {key} ===\n{val}")
        print(f"\n=== 最终决策 ===\n{decision}")
    else:
        report = format_report(state, decision, ticker, analysis_date)
        print(report)


if __name__ == "__main__":
    main()
