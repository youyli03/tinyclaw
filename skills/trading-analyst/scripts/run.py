#!/usr/bin/env python3
"""
美股多智能体分析主脚本 — trading-analyst skill
用法: python run.py --ticker NVDA [--date 2026-06-06] [--rounds 1] [--hypothesis "NVDA 是否超买"]

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


# ── Monkey-patch hypothesis：注入假设到辩论初始状态 ──────────────────────────
_HYPOTHESIS: str = ""  # 由 main() 设置

def _patch_hypothesis_into_debate(hypothesis: str) -> None:
    """
    将用户的分析假设注入到 Bull/Bear 研究员的初始辩论状态中。
    做法：在 create_bull_researcher / create_bear_researcher 的 prompt 里额外注入假设说明，
    让多空双方都要围绕这个假设展开论证。
    """
    if not hypothesis:
        return

    try:
        import tradingagents.agents.researchers.bull_researcher as bull_mod
        import tradingagents.agents.researchers.bear_researcher as bear_mod
        from tradingagents.agents.utils.agent_utils import (
            get_instrument_context_from_state,
            get_language_instruction,
        )

        hyp_text = hypothesis.strip()

        def create_bull_researcher_with_hyp(llm):
            def bull_node(state) -> dict:
                investment_debate_state = state["investment_debate_state"]
                history = investment_debate_state.get("history", "")
                bull_history = investment_debate_state.get("bull_history", "")
                current_response = investment_debate_state.get("current_response", "")
                market_research_report = state["market_report"]
                sentiment_report = state["sentiment_report"]
                news_report = state["news_report"]
                fundamentals_report = state["fundamentals_report"]
                instrument_context = get_instrument_context_from_state(state)
                asset_type = state.get("asset_type", "stock")
                target_label = "stock" if asset_type == "stock" else "asset"
                fundamentals_label = (
                    "Company fundamentals report"
                    if asset_type == "stock"
                    else "Asset fundamentals report (may be unavailable for crypto)"
                )

                prompt = f"""You are a Bull Analyst. The user has posed a specific hypothesis/question:

[USER HYPOTHESIS]: {hyp_text}

Your primary task is to evaluate this hypothesis from a bullish perspective — build evidence-based arguments supporting the bullish case and address the hypothesis directly.

Key points to focus on:
- Growth Potential: Highlight the company's market opportunities, revenue projections, and scalability.
- Competitive Advantages: Emphasize factors like unique products, strong branding, or dominant market positioning.
- Positive Indicators: Use financial health, industry trends, and recent positive news as evidence.
- Directly address the hypothesis: "{hyp_text}" with specific data supporting the bull case.
- Bear Counterpoints: Critically analyze the bear argument with specific data and sound reasoning.

Resources available:
{instrument_context}
Market research report: {market_research_report}
Social media sentiment report: {sentiment_report}
Latest world affairs news: {news_report}
{fundamentals_label}: {fundamentals_report}
Conversation history: {history}
Last bear argument: {current_response}
""" + get_language_instruction()

                response = llm.invoke(prompt)
                argument = f"Bull Analyst: {response.content}"
                return {
                    "investment_debate_state": {
                        "history": history + "\n" + argument,
                        "bull_history": bull_history + "\n" + argument,
                        "bear_history": investment_debate_state.get("bear_history", ""),
                        "current_response": argument,
                        "count": investment_debate_state["count"] + 1,
                    }
                }
            return bull_node

        def create_bear_researcher_with_hyp(llm):
            def bear_node(state) -> dict:
                investment_debate_state = state["investment_debate_state"]
                history = investment_debate_state.get("history", "")
                bear_history = investment_debate_state.get("bear_history", "")
                current_response = investment_debate_state.get("current_response", "")
                market_research_report = state["market_report"]
                sentiment_report = state["sentiment_report"]
                news_report = state["news_report"]
                fundamentals_report = state["fundamentals_report"]
                instrument_context = get_instrument_context_from_state(state)
                asset_type = state.get("asset_type", "stock")
                target_label = "stock" if asset_type == "stock" else "asset"
                fundamentals_label = (
                    "Company fundamentals report"
                    if asset_type == "stock"
                    else "Asset fundamentals report (may be unavailable for crypto)"
                )

                prompt = f"""You are a Bear Analyst. The user has posed a specific hypothesis/question:

[USER HYPOTHESIS]: {hyp_text}

Your primary task is to challenge this hypothesis from a bearish perspective — present evidence-based arguments against the hypothesis and highlight risks.

Key points to focus on:
- Risks and Challenges: Highlight factors that could hinder performance.
- Directly challenge the hypothesis: "{hyp_text}" with specific data supporting the bear case.
- Competitive Weaknesses: Emphasize vulnerabilities and threats.
- Negative Indicators: Use evidence from financial data, market trends, or recent adverse news.
- Bull Counterpoints: Critically analyze the bull argument with specific data.

Resources available:
{instrument_context}
Market research report: {market_research_report}
Social media sentiment report: {sentiment_report}
Latest world affairs news: {news_report}
{fundamentals_label}: {fundamentals_report}
Conversation history: {history}
Last bull argument: {current_response}
""" + get_language_instruction()

                response = llm.invoke(prompt)
                argument = f"Bear Analyst: {response.content}"
                return {
                    "investment_debate_state": {
                        "history": history + "\n" + argument,
                        "bear_history": bear_history + "\n" + argument,
                        "bull_history": investment_debate_state.get("bull_history", ""),
                        "current_response": argument,
                        "count": investment_debate_state["count"] + 1,
                    }
                }
            return bear_node

        # Monkey-patch
        bull_mod.create_bull_researcher = create_bull_researcher_with_hyp
        bear_mod.create_bear_researcher = create_bear_researcher_with_hyp
        print(f"[INFO] 已注入分析假设: {hyp_text}", file=sys.stderr)

    except Exception as e:
        print(f"[WARN] hypothesis 注入失败（无影响，继续通用分析）: {e}", file=sys.stderr)


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


def format_report(state: dict, decision: str, ticker: str, analysis_date: str, hypothesis: str = "") -> str:
    """格式化最终 Markdown 报告"""

    def extract(key: str) -> str:
        val = state.get(key, "") if hasattr(state, "get") else getattr(state, key, "")
        return str(val).strip() if val else ""

    sections: list[str] = []
    sections.append(f"# 📊 {ticker} 多智能体分析报告")
    meta = f"> 分析日期：{analysis_date} | LLM：DeepSeek R1"
    if hypothesis:
        meta += f"\n> \n> **分析假设**：{hypothesis}"
    sections.append(meta)
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
            if hypothesis:
                sections.append(f"> 辩论围绕假设展开：**{hypothesis}**")
                sections.append("")
            if bull:
                sections.append("### 看多方最终论点")
                sections.append(str(bull[-1])[:1200])
            if bear:
                sections.append("### 看空方最终论点")
                sections.append(str(bear[-1])[:1200])
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
    parser.add_argument("--hypothesis", "-H", default="", help='针对特定观点分析，如 "NVDA 是否值得此时买入"')
    parser.add_argument("--full", action="store_true", help="输出完整原始状态（调试用）")
    args = parser.parse_args()

    ticker = args.ticker.upper()
    analysis_date = args.date or get_last_trading_day()
    hypothesis = args.hypothesis.strip()

    print(f"[INFO] 开始分析 {ticker}（日期：{analysis_date}，辩论轮次：{args.rounds}）...", file=sys.stderr)
    if hypothesis:
        print(f"[INFO] 分析假设: {hypothesis}", file=sys.stderr)

    # 注入假设 monkey-patch（必须在 TradingAgentsGraph 导入后、实例化前进行）
    _patch_hypothesis_into_debate(hypothesis)

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
        report = format_report(state, decision, ticker, analysis_date, hypothesis)
        print(report)


if __name__ == "__main__":
    main()
