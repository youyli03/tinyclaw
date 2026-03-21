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
        from lib.hackernews import search_stories  # type: ignore
    except ImportError:
        sys.stderr.write("[news_fetch] 无法导入 lib.hackernews，跳过 HN 源\n")
        return []

    results = []
    cutoff = datetime.now(timezone.utc) - timedelta(hours=since_hours)

    for topic in topics:
        try:
            items = search_stories(topic, depth="default", since=cutoff.strftime("%Y-%m-%d"))
            for item in items[: max_items // max(len(topics), 1)]:
                results.append(
                    {
                        "source": "hackernews",
                        "id": f"hn_{item.id}",
                        "title": item.title,
                        "url": item.url or f"https://news.ycombinator.com/item?id={item.id}",
                        "text": "",
                        "topic": topic,
                        "score": getattr(item, "score", 0),
                        "date": item.date or "",
                        "author": getattr(item, "author", ""),
                    }
                )
        except Exception as e:
            sys.stderr.write(f"[news_fetch] HN 抓取 topic={topic} 失败：{e}\n")

    return results


# ── RSS 抓取 ──────────────────────────────────────────────────────────────────

# 内置 RSS 源列表（topics 用于标题关键词过滤；若 topic 为 "*" 则不过滤）
DEFAULT_RSS_FEEDS: list[dict] = [
    {"name": "BBC Technology", "url": "https://feeds.bbci.co.uk/news/technology/rss.xml", "topics": ["*"]},
    {"name": "Al Jazeera", "url": "https://www.aljazeera.com/xml/rss/all.xml", "topics": ["*"]},
    {"name": "36kr",    "url": "https://36kr.com/feed", "topics": ["*"]},
    {"name": "InfoQ CN", "url": "https://www.infoq.cn/feed", "topics": ["*"]},
    {"name": "Solidot", "url": "https://www.solidot.org/index.rss", "topics": ["*"]},
    {"name": "HN RSS",  "url": "https://hnrss.org/frontpage", "topics": ["*"]},
]


def _fetch_rss(topics: list[str], since_hours: int, max_items: int) -> list[dict]:
    try:
        import urllib.request
        import xml.etree.ElementTree as ET
    except ImportError:
        return []

    cutoff = datetime.now(timezone.utc) - timedelta(hours=since_hours)
    results = []

    # 关键词集合（小写，用于快速过滤）
    kw_set = {t.strip().lower() for t in topics if t.strip() and t.strip() != "*"}

    def _title_matches(title: str) -> bool:
        if not kw_set:
            return True
        tl = title.lower()
        return any(kw in tl for kw in kw_set)

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

    for feed in DEFAULT_RSS_FEEDS:
        try:
            headers = {"User-Agent": "Mozilla/5.0 (compatible; tinyclaw-news/0.1)"}
            req = urllib.request.Request(feed["url"], headers=headers)
            with urllib.request.urlopen(req, timeout=15) as resp:
                xml_data = resp.read()
            root = ET.fromstring(xml_data)

            # 兼容 RSS 2.0 和 Atom
            ns = {"atom": "http://www.w3.org/2005/Atom"}
            items_el = root.findall(".//item") or root.findall(".//atom:entry", ns)

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

                results.append(
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
                if len(results) >= max_items * 2:
                    break
        except Exception as e:
            sys.stderr.write(f"[news_fetch] RSS {feed['name']} 抓取失败：{e}\n")

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
