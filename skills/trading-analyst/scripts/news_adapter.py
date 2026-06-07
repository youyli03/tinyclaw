#!/usr/bin/env python3
"""
TrendRadar 新闻适配器
将 TrendRadar SQLite DB 中的中文财经新闻适配为 TradingAgents 要求的格式
"""
from __future__ import annotations

import sqlite3
from datetime import date, timedelta
from pathlib import Path

TRENDRADAR_NEWS_DIR = Path("/home/lyy/TrendRadar/output/news")

NEWS_KEYWORDS_MAP: dict[str, list[str]] = {
    "MU": ["美光", "MU", "Micron", "HBM", "DRAM", "NAND", "存储", "内存"],
    "NVDA": ["英伟达", "NVDA", "NVIDIA", "GPU", "H100", "H200", "Blackwell", "Hopper", "算力"],
    "ARM": ["ARM", "Arm", "软银", "芯片架构"],
    "ORCL": ["甲骨文", "ORCL", "Oracle", "云数据库"],
    "AMD": ["AMD", "超微", "EPYC", "锐龙", "Instinct"],
    "INTC": ["英特尔", "INTC", "Intel", "Foundry"],
    "TSLA": ["特斯拉", "TSLA", "Tesla", "马斯克", "Musk", "Autopilot", "FSD"],
    "META": ["Meta", "元宇宙", "Zuckerberg", "扎克伯格", "Instagram", "WhatsApp"],
    "MSFT": ["微软", "MSFT", "Microsoft", "Copilot", "Azure", "OpenAI"],
    "AAPL": ["苹果", "AAPL", "Apple", "iPhone", "iPad", "Mac"],
    "AMZN": ["亚马逊", "AMZN", "Amazon", "AWS", "Prime"],
    "GOOGL": ["谷歌", "GOOGL", "Google", "Alphabet", "Gemini", "Search"],
    # 全局宏观关键词（所有 ticker 都包含）
    "_GLOBAL": [
        "美联储", "Fed", "降息", "加息", "利率", "通胀", "CPI", "PCE",
        "纳指", "纳斯达克", "Nasdaq", "标普", "S&P",
        "美股", "科技股", "科技板块",
        "AI", "人工智能", "大模型", "AGI", "LLM",
        "半导体", "芯片", "晶圆", "台积电", "TSMC",
        "非农", "失业率", "就业",
        "关税", "贸易战", "制裁",
    ],
}


def get_trendradar_news(ticker: str, start_date: str, end_date: str) -> str:
    """
    适配函数：替换 TradingAgents 的 get_news_yfinance
    从 TrendRadar DB 拉中文财经新闻
    
    Args:
        ticker: 股票代码，如 "NVDA"
        start_date: 开始日期字符串，如 "2026-06-06"
        end_date: 结束日期字符串
    
    Returns:
        Markdown 格式的新闻字符串
    """
    ticker_upper = ticker.upper()
    
    # 关键词：ticker 专属 + 全局宏观
    keywords = NEWS_KEYWORDS_MAP.get(ticker_upper, [ticker_upper])
    keywords = keywords + NEWS_KEYWORDS_MAP["_GLOBAL"]
    
    # 找最近 3 天的 DB 文件
    items: list[dict] = []
    today = date.today()
    
    for delta in range(3):
        d = today - timedelta(days=delta)
        db_path = TRENDRADAR_NEWS_DIR / f"{d.isoformat()}.db"
        if not db_path.exists():
            continue
        
        try:
            conn = sqlite3.connect(str(db_path))
            c = conn.cursor()
            c.execute("""
                SELECT n.title, n.url, p.name, n.rank
                FROM news_items n
                JOIN platforms p ON n.platform_id = p.id
                WHERE p.id IN ('wallstreetcn-hot', 'cls-hot')
                ORDER BY n.rank ASC
                LIMIT 100
            """)
            rows = c.fetchall()
            conn.close()
            
            for title, url, platform, rank in rows:
                if any(kw.lower() in title.lower() for kw in keywords):
                    items.append({
                        "title": title,
                        "url": url or "",
                        "platform": platform,
                        "rank": rank,
                        "date": d.isoformat(),
                    })
        except Exception as e:
            print(f"[news_adapter] 读取 {db_path} 失败: {e}")
        
        if len(items) >= 15:
            break
    
    if not items:
        return f"## {ticker} 相关新闻 ({start_date} ~ {end_date})\n\n暂无相关中文财经新闻"
    
    lines = [
        f"## {ticker} 中文财经新闻（来源：华尔街见闻/财联社）",
        f"（时间范围：{start_date} ~ {end_date}，共 {len(items)} 条）",
        "",
    ]
    
    for i, item in enumerate(items[:15], 1):
        url_part = f" ([链接]({item['url']}))" if item["url"] else ""
        lines.append(f"{i}. **{item['title']}** `{item['platform']}`{url_part}")
    
    return "\n".join(lines)
