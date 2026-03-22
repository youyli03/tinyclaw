#!/usr/bin/env python3
"""
news_fetch.py  —  tinyclaw news MCP server 的多源抓取脚本

功能：
  1. 从 HackerNews（Algolia）+ RSS 多源按 topics 抓取
  2. L1 精确去重（seen_urls.db SQLite）
  3. L2 批次内 n-gram Jaccard 去重
  4. 输出 JSON 列表到 stdout，供 TypeScript 侧解析

用法：
  python3 news_fetch.py --topics "AI,LLM" --since-hours 24 --sources hn,rss --max 50

环境变量（均可选）：
  NEWS_DATA_DIR   数据根目录，默认 ~/.tinyclaw/news
  LAST30_LIB_DIR  last30days lib 目录，默认 ~/last30days-skill/scripts/lib

关键词匹配规则（_title_matches）：
  - 多词短语（如 "gold price"）：标题必须包含该完整短语
  - 多词短语同时拆词：每个 4+ 字符的非停用词单独作为关键词（\b 词边界匹配）
    例：topics="gold price" → kw_set 中同时有 "gold price"、"gold"
    "Gold slips near $4,500" 通过 \bgold\b 匹配 ✓
    "Goldman Sachs rises" 不匹配 \bgold\b ✗（词边界阻断误匹配）

内置 RSS 源清单（DEFAULT_RSS_FEEDS，共 58 源）：

  科技/通用（9）：
    BBC Technology    https://feeds.bbci.co.uk/news/technology/rss.xml
    Al Jazeera        https://www.aljazeera.com/xml/rss/all.xml
    36kr              https://36kr.com/feed
    InfoQ CN          https://www.infoq.cn/feed
    Solidot           https://www.solidot.org/index.rss
    HN RSS            https://hnrss.org/frontpage
    The Verge         https://www.theverge.com/rss/index.xml
    Ars Technica      https://feeds.arstechnica.com/arstechnica/index
    The Register      https://www.theregister.com/headlines.rss
    ZDNet             https://www.zdnet.com/news/rss.xml
    Wired             https://www.wired.com/feed/rss
    TechCrunch        https://techcrunch.com/feed/
    MIT Tech Review   https://www.technologyreview.com/feed/

  AI/LLM 专项（5）：
    HuggingFace Blog  https://huggingface.co/blog/feed.xml
    VentureBeat AI    https://venturebeat.com/category/ai/feed
    Google AI Blog    https://blog.google/innovation-and-ai/technology/ai/rss/
    OpenAI Blog       https://openai.com/blog/rss.xml
    LessWrong         https://www.lesswrong.com/feed.xml?view=curated-questions

  国际新闻（7）：
    CNN Top Stories   http://rss.cnn.com/rss/edition.rss
    CNN Business      http://rss.cnn.com/rss/money_news_international.rss
    CNN Tech          http://rss.cnn.com/rss/edition_technology.rss
    Financial Times   https://www.ft.com/rss/home/uk
    Nikkei Asia       https://asia.nikkei.com/rss/feed/nar
    South China MP    https://www.scmp.com/rss/91/feed
    Japan Times       https://www.japantimes.co.jp/feed/topstories/

  综合财经/宏观（9）：
    MarketWatch       https://feeds.content.dowjones.io/public/rss/mw_marketpulse
    Bloomberg Markets https://feeds.bloomberg.com/markets/news.rss
    CNBC Finance      https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10000664
    CNBC Investing    https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=15839069
    Investing.com     https://www.investing.com/rss/news_1.rss
    WSJ World News    https://feeds.a.dj.com/rss/RSSWorldNews.xml
    WSJ Tech          https://feeds.a.dj.com/rss/RSSWSJD.xml
    Yahoo Finance     https://finance.yahoo.com/news/rssindex
    Wired Business    https://www.wired.com/feed/category/business/latest/rss

  贵金属专项（3）：
    FX Street         https://www.fxstreet.com/rss/news
    Seeking Alpha Gold   https://seekingalpha.com/tag/gold.xml
    Seeking Alpha Silver https://seekingalpha.com/tag/silver.xml

  大宗商品（3）：
    Seeking Alpha Commodities  https://seekingalpha.com/tag/commodities.xml
    OilPrice.com               https://oilprice.com/rss/main
    Seeking Alpha Copper       https://seekingalpha.com/tag/copper.xml

  概念板块（3）：
    Seeking Alpha Energy    https://seekingalpha.com/tag/energy.xml
    Seeking Alpha Materials https://seekingalpha.com/tag/materials.xml
    CNBC Energy             https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=19836768

  加密货币（5）：
    CoinDesk          https://www.coindesk.com/arc/outboundfeeds/rss
    CoinTelegraph     https://cointelegraph.com/rss
    Decrypt           https://decrypt.co/feed
    Bitcoin Magazine  https://bitcoinmagazine.com/.rss/full/
    The Block         https://www.theblock.co/rss.xml

  开源/GitHub（1）：
    GitHub Trending   https://mshibanami.github.io/GitHubTrendingRSS/daily/all.xml

  中文科技媒体（3）：
    虎嗅              https://www.huxiu.com/rss/0.xml
    少数派            https://sspai.com/feed
    IT之家            https://www.ithome.com/rss/
"""

import argparse
import json
import os
import re
import sqlite3
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any

# ── 路径配置 ──────────────────────────────────────────────────────────────────

HOME = Path.home()
DATA_DIR = Path(os.environ.get("NEWS_DATA_DIR", HOME / ".tinyclaw" / "news"))
DATA_DIR.mkdir(parents=True, exist_ok=True)

LAST30_LIB_DIR = Path(
    os.environ.get("LAST30_LIB_DIR", HOME / "last30days-skill" / "scripts" / "lib")
)

# 将 last30days lib 父目录加入 sys.path，使 `from lib.xxx import` 可用
if str(LAST30_LIB_DIR.parent) not in sys.path:
    sys.path.insert(0, str(LAST30_LIB_DIR.parent))

# ── L1 去重：SQLite seen_urls.db ──────────────────────────────────────────────

def _get_db() -> sqlite3.Connection:
    db_path = DATA_DIR / "seen_urls.db"
    conn = sqlite3.connect(str(db_path))
    conn.execute(
        """CREATE TABLE IF NOT EXISTS seen_urls (
            url      TEXT PRIMARY KEY,
            title    TEXT,
            source   TEXT,
            seen_at  TEXT
        )"""
    )
    conn.commit()
    return conn


def _is_seen(conn: sqlite3.Connection, url: str) -> bool:
    row = conn.execute("SELECT 1 FROM seen_urls WHERE url=?", (url,)).fetchone()
    return row is not None


def _mark_seen(conn: sqlite3.Connection, url: str, title: str, source: str) -> None:
    ts = datetime.now(timezone.utc).isoformat()
    conn.execute(
        "INSERT OR IGNORE INTO seen_urls(url,title,source,seen_at) VALUES(?,?,?,?)",
        (url, title, source, ts),
    )
    conn.commit()


# ── L2 批次内去重（n-gram Jaccard）──────────────────────────────────────────

def _ngrams(text: str, n: int = 3):
    t = re.sub(r"[^\w\s]", " ", text.lower())
    t = re.sub(r"\s+", " ", t).strip()
    return {t[i : i + n] for i in range(len(t) - n + 1)} if len(t) >= n else {t}


def _jaccard(a: set, b: set) -> float:
    if not a or not b:
        return 0.0
    inter = len(a & b)
    union = len(a | b)
    return inter / union if union else 0.0


def _l2_dedupe(items: list[dict], threshold: float = 0.65) -> list[dict]:
    kept = []
    kept_ngrams = []
    for item in items:
        text = item.get("title") or item.get("text") or ""
        ng = _ngrams(text)
        if all(_jaccard(ng, kng) < threshold for kng in kept_ngrams):
            kept.append(item)
            kept_ngrams.append(ng)
    return kept


# ── HackerNews 抓取 ───────────────────────────────────────────────────────────

def _fetch_hn(topics: list[str], since_hours: int, max_items: int) -> list[dict]:
    try:
        from lib.hackernews import search_hackernews, parse_hackernews_response  # type: ignore
    except ImportError:
        sys.stderr.write("[news_fetch] 无法导入 lib.hackernews，跳过 HN 源\n")
        return []

    results = []
    now_utc = datetime.now(timezone.utc)
    from_date = (now_utc - timedelta(hours=since_hours)).strftime("%Y-%m-%d")
    to_date = now_utc.strftime("%Y-%m-%d")
    per_topic = max(1, max_items // max(len(topics), 1))

    for topic in topics:
        try:
            response = search_hackernews(
                topic,
                from_date=from_date,
                to_date=to_date,
                depth="default",
            )
            parsed = parse_hackernews_response(response, query=topic)
            for item in parsed[:per_topic]:
                object_id = item.get("object_id", "")
                url = item.get("url") or f"https://news.ycombinator.com/item?id={object_id}"
                results.append(
                    {
                        "source": "hackernews",
                        "id": f"hn_{object_id}",
                        "title": item.get("title", ""),
                        "url": url,
                        "text": "",
                        "topic": topic,
                        "score": item.get("engagement", {}).get("points", 0),
                        "date": item.get("date") or "",
                        "author": item.get("author", ""),
                    }
                )
        except Exception as e:
            sys.stderr.write(f"[news_fetch] HN 抓取 topic={topic} 失败：{e}\n")

    return results


# ── RSS 抓取 ──────────────────────────────────────────────────────────────────

# 内置 RSS 源列表（topics 用于标题关键词过滤；若 topic 为 "*" 则不过滤）
DEFAULT_RSS_FEEDS: list[dict] = [
    # ── 科技/通用（英文）────────────────────────────────────────────────────
    {"name": "BBC Technology", "url": "https://feeds.bbci.co.uk/news/technology/rss.xml", "topics": ["*"]},
    {"name": "Al Jazeera",     "url": "https://www.aljazeera.com/xml/rss/all.xml",        "topics": ["*"]},
    {"name": "The Verge",      "url": "https://www.theverge.com/rss/index.xml",           "topics": ["*"]},
    {"name": "Wired",          "url": "https://www.wired.com/feed/rss",                   "topics": ["*"]},
    {"name": "Ars Technica",   "url": "https://arstechnica.com/feed/",                    "topics": ["*"]},
    {"name": "TechCrunch",     "url": "https://techcrunch.com/feed/",                     "topics": ["*"]},
    {"name": "MIT Tech Review","url": "https://www.technologyreview.com/feed/",           "topics": ["*"]},
    {"name": "HN RSS",         "url": "https://hnrss.org/frontpage",                      "topics": ["*"]},
    # ── AI / LLM 专项 ────────────────────────────────────────────────────────
    {"name": "VentureBeat AI",   "url": "https://feeds.feedburner.com/venturebeat/SZYF",           "topics": ["*"]},
    {"name": "AI News",          "url": "https://www.artificialintelligence-news.com/feed/",        "topics": ["*"]},
    {"name": "LessWrong",        "url": "https://www.lesswrong.com/feed.xml",                       "topics": ["*"]},
    {"name": "HuggingFace Blog", "url": "https://huggingface.co/blog/feed.xml",                     "topics": ["*"]},
    {"name": "The Sequence AI",  "url": "https://thesequence.substack.com/feed",                    "topics": ["*"]},
    {"name": "NVIDIA Blog",      "url": "https://blogs.nvidia.com/feed/",                           "topics": ["*"]},
    {"name": "Google AI Blog",   "url": "https://blog.google/technology/ai/rss/",                   "topics": ["*"]},
    {"name": "Simon Willison",   "url": "https://simonwillison.net/atom/everything/",               "topics": ["*"]},
    {"name": "Import AI",        "url": "https://jack-clark.net/feed/",                             "topics": ["*"]},
    # ── 中文科技媒体 ──────────────────────────────────────────────────────────
    {"name": "36kr",           "url": "https://36kr.com/feed",         "topics": ["*"]},
    {"name": "InfoQ CN",       "url": "https://www.infoq.cn/feed",     "topics": ["*"]},
    {"name": "虎嗅",            "url": "https://www.huxiu.com/rss/0.xml","topics": ["*"]},
    {"name": "少数派",          "url": "https://sspai.com/feed",        "topics": ["*"]},
    {"name": "爱范儿",          "url": "https://www.ifanr.com/feed",    "topics": ["*"]},
    {"name": "Solidot",        "url": "https://www.solidot.org/index.rss","topics": ["*"]},
    {"name": "稀土掘金",        "url": "https://juejin.cn/rss",         "topics": ["*"]},
    # ── 开发者 / 开源 ─────────────────────────────────────────────────────────
    {"name": "GitHub Blog",    "url": "https://github.blog/feed/",     "topics": ["*"]},
    {"name": "Dev.to",         "url": "https://dev.to/feed",           "topics": ["*"]},
    # ── 贵金属专项 ────────────────────────────────────────────────────────────
    {"name": "FX Street",            "url": "https://www.fxstreet.com/rss/news",                   "topics": ["*"]},
    {"name": "Seeking Alpha Gold",   "url": "https://seekingalpha.com/tag/gold.xml",               "topics": ["*"]},
    {"name": "Seeking Alpha Silver", "url": "https://seekingalpha.com/tag/silver.xml",             "topics": ["*"]},
    # ── 大宗商品 ──────────────────────────────────────────────────────────────
    {"name": "Seeking Alpha Commodities", "url": "https://seekingalpha.com/tag/commodities.xml",   "topics": ["*"]},
    {"name": "OilPrice.com",              "url": "https://oilprice.com/rss/main",                  "topics": ["*"]},
    {"name": "Seeking Alpha Copper",      "url": "https://seekingalpha.com/tag/copper.xml",        "topics": ["*"]},
    # ── 概念板块 ──────────────────────────────────────────────────────────────
    {"name": "Seeking Alpha Energy",    "url": "https://seekingalpha.com/tag/energy.xml",          "topics": ["*"]},
    {"name": "Seeking Alpha Materials", "url": "https://seekingalpha.com/tag/materials.xml",       "topics": ["*"]},
    {"name": "CNBC Energy",             "url": "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=19836768", "topics": ["*"]},
    # ── 综合财经 / 宏观 ───────────────────────────────────────────────────────
    {"name": "MarketWatch",        "url": "https://feeds.content.dowjones.io/public/rss/mw_marketpulse",                         "topics": ["*"]},
    {"name": "Bloomberg Markets",  "url": "https://feeds.bloomberg.com/markets/news.rss",                                        "topics": ["*"]},
    {"name": "CNBC Finance",       "url": "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10000664", "topics": ["*"]},
    {"name": "CNBC Investing",     "url": "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=15839069", "topics": ["*"]},
    {"name": "Yahoo Finance",      "url": "https://finance.yahoo.com/news/rssindex",                                             "topics": ["*"]},
    {"name": "Investing.com Forex","url": "https://www.investing.com/rss/news_1.rss",                                           "topics": ["*"]},
    # ── 加密货币 ──────────────────────────────────────────────────────────────
    {"name": "CoinDesk",        "url": "https://feeds.feedburner.com/CoinDesk",  "topics": ["*"]},
    {"name": "CoinTelegraph",   "url": "https://cointelegraph.com/rss",          "topics": ["*"]},
    {"name": "Decrypt",         "url": "https://decrypt.co/feed",                "topics": ["*"]},
    {"name": "Bitcoin Magazine","url": "https://bitcoinmagazine.com/feed",       "topics": ["*"]},
    {"name": "The Block",       "url": "https://www.theblock.co/rss.xml",        "topics": ["*"]},
]


def _fetch_rss(topics: list[str], since_hours: int, max_items: int) -> list[dict]:
    try:
        import urllib.request
        import xml.etree.ElementTree as ET
        from concurrent.futures import ThreadPoolExecutor, as_completed
    except ImportError:
        return []

    cutoff = datetime.now(timezone.utc) - timedelta(hours=since_hours)

    # 关键词集合（小写，用于快速过滤）
    # 对多词短语（如 "gold price"），同时保留整体短语 AND 拆出 4+ 字符单词，
    # 任一命中即视为匹配，避免 "gold price" 无法匹配 "Gold slips" 标题的问题。
    _STOP_WORDS = {"price", "news", "data", "rate", "from", "with", "that", "this",
                   "will", "were", "have", "been", "they", "their", "about", "more"}
    kw_set: set[str] = set()
    for t in topics:
        t = t.strip().lower()
        if not t or t == "*":
            continue
        kw_set.add(t)  # 整体短语匹配（精确）
        if " " in t:   # 多词短语：拆出有意义的单词（≥4 字符，非停用词）
            for word in t.split():
                if len(word) >= 4 and word not in _STOP_WORDS:
                    kw_set.add(word)

    def _title_matches(title: str) -> bool:
        if not kw_set:
            return True
        tl = title.lower()
        for kw in kw_set:
            if " " in kw:
                # 多词短语：整体子串匹配（"gold price" → 要求连续出现）
                if kw in tl:
                    return True
            else:
                # 单个词：词边界匹配，避免 "gold" 命中 "Goldman"
                if re.search(r"\b" + re.escape(kw) + r"\b", tl):
                    return True
        return False

    def _parse_date(s: str | None) -> datetime | None:
        if not s:
            return None
        from email.utils import parsedate_to_datetime
        try:
            return parsedate_to_datetime(s).astimezone(timezone.utc)
        except Exception:
            pass
        fmts = ["%a, %d %b %Y %H:%M:%S %z", "%Y-%m-%dT%H:%M:%S%z", "%Y-%m-%dT%H:%M:%SZ"]
        for fmt in fmts:
            try:
                return datetime.strptime(s, fmt).replace(tzinfo=timezone.utc)
            except ValueError:
                continue
        return None

    def _fetch_one_feed(feed: dict) -> list[dict]:
        """抓取单个 RSS 源，返回匹配的条目列表（出错时返回空列表；SSL/网络错误自动重试一次）。"""
        import time
        import urllib.error
        ns = {"atom": "http://www.w3.org/2005/Atom"}

        def _do_fetch() -> bytes:
            headers = {"User-Agent": "Mozilla/5.0 (compatible; tinyclaw-news/0.1)"}
            req = urllib.request.Request(feed["url"], headers=headers)
            with urllib.request.urlopen(req, timeout=8) as resp:
                return resp.read()

        try:
            try:
                xml_data = _do_fetch()
            except (urllib.error.URLError, OSError):
                # 偶发 SSL EOF / 连接重置 → 等待 1 秒后重试一次
                time.sleep(1)
                xml_data = _do_fetch()

        except Exception as e:
            sys.stderr.write(f"[news_fetch] RSS {feed['name']} 抓取失败：{e}\n")
            return []

        try:
            root = ET.fromstring(xml_data)

            # 兼容 RSS 2.0 和 Atom
            items_el = root.findall(".//item") or root.findall(".//atom:entry", ns)

            feed_items: list[dict] = []
            for el in items_el:
                def _text(tag: str, fallback: str = "", _el=el) -> str:
                    # 注意：必须用 `is not None` 而非布尔判断，
                    # 因为 ET.Element 无子节点时布尔值为 False（即使存在）
                    node = _el.find(tag)
                    if node is None:
                        node = _el.find(f"atom:{tag}", ns)
                    if node is None:
                        return fallback
                    return (node.text or fallback).strip()

                title = _text("title")
                link  = _text("link")
                if not link:
                    link_el = el.find("atom:link", ns)
                    link = (link_el.get("href") or "") if link_el is not None else ""
                pub_date = _text("pubDate") or _text("published") or _text("updated")
                pub_dt = _parse_date(pub_date)

                if not title or not link:
                    continue
                if pub_dt and pub_dt < cutoff:
                    continue
                if not _title_matches(title):
                    continue

                feed_items.append(
                    {
                        "source": f"rss:{feed['name']}",
                        "id": f"rss_{abs(hash(link))}",
                        "title": title,
                        "url": link,
                        "text": _text("description")[:500],
                        "topic": ",".join(topics),
                        "score": 0,
                        "date": pub_dt.strftime("%Y-%m-%d") if pub_dt else "",
                        "author": "",
                    }
                )
                if len(feed_items) >= max_items * 2:
                    break
            return feed_items
        except Exception as e:
            sys.stderr.write(f"[news_fetch] RSS {feed['name']} 抓取失败：{e}\n")
            return []

    # 并发抓取所有 RSS 源；max_workers=12 避免过高并发引发 SSL EOF 握手竞争
    # 每源 timeout=8s + 1 次 retry；总耗时约 8~16s（失败源自动重试）
    results_by_feed: dict[int, list[dict]] = {}
    with ThreadPoolExecutor(max_workers=12) as executor:
        future_to_idx = {
            executor.submit(_fetch_one_feed, feed): idx
            for idx, feed in enumerate(DEFAULT_RSS_FEEDS)
        }
        for future in as_completed(future_to_idx):
            idx = future_to_idx[future]
            results_by_feed[idx] = future.result()

    # 按原始 feed 顺序合并结果，保证输出稳定可预期
    results: list[dict] = []
    for idx in range(len(DEFAULT_RSS_FEEDS)):
        results.extend(results_by_feed.get(idx, []))

    return results


# ── 主流程 ────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="tinyclaw news fetcher")
    parser.add_argument("--topics", required=True, help="逗号分隔的话题列表，如 'AI,LLM'")
    parser.add_argument("--since-hours", type=int, default=24)
    parser.add_argument("--sources", default="hn,rss", help="逗号分隔的源名称，如 'hn,rss'")
    parser.add_argument("--max", type=int, default=50, dest="max_items")
    parser.add_argument("--no-dedup", action="store_true", help="跳过 L1/L2 去重（调试用）")
    args = parser.parse_args()

    topics = [t.strip() for t in args.topics.split(",") if t.strip()]
    sources = {s.strip().lower() for s in args.sources.split(",") if s.strip()}

    raw: list[dict] = []

    if "hn" in sources:
        raw.extend(_fetch_hn(topics, args.since_hours, args.max_items))
    if "rss" in sources:
        raw.extend(_fetch_rss(topics, args.since_hours, args.max_items))

    if not raw:
        print(json.dumps([]))
        return

    # L2 批次内去重
    if not args.no_dedup:
        raw = _l2_dedupe(raw, threshold=0.65)

    # L1 URL 精确去重（同时标记已见）
    if not args.no_dedup:
        conn = _get_db()
        filtered = []
        for item in raw:
            url = item["url"]
            if not _is_seen(conn, url):
                filtered.append(item)
                _mark_seen(conn, url, item.get("title", ""), item.get("source", ""))
        conn.close()
        raw = filtered

    # 限制数量
    raw = raw[: args.max_items]

    print(json.dumps(raw, ensure_ascii=False))


if __name__ == "__main__":
    main()
