#!/usr/bin/env python3
"""
fetch_newsnow.py — 从 NewsNow API 抓取各平台热榜并存入本地 SQLite DB

参考: TrendRadar (https://github.com/sansan0/TrendRadar) 的爬虫设计
数据来源: NewsNow 项目 (https://github.com/ourongxing/newsnow) 的公共 API

用法:
  python3 fetch_newsnow.py [--platforms "wallstreetcn-hot,cls-hot,zhihu"] [--limit 50]

数据存储: ~/.tinyclaw/newsnow/YYYY-MM-DD.db  (每日一个 SQLite 文件)
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path
from urllib.parse import urlparse
import random

try:
    import requests
except ImportError:
    print("[错误] 缺少 requests 库，请安装: pip install requests", file=sys.stderr)
    sys.exit(1)

# ── 配置 ──────────────────────────────────────────────────────────────────────

NEWSNOW_API = "https://newsnow.busiyi.world/api/s"

# 默认抓取的平台列表（参考 TrendRadar config）
DEFAULT_PLATFORMS: list[dict] = [
    {"id": "wallstreetcn-hot",    "name": "华尔街见闻",  "domain": "wallstreetcn.com"},
    {"id": "cls-hot",             "name": "财联社热门",  "domain": "cls.cn"},
    {"id": "zhihu",               "name": "知乎",       "domain": "zhihu.com"},
    {"id": "weibo",               "name": "微博",       "domain": "weibo.com"},
    {"id": "baidu",               "name": "百度热搜",   "domain": "baidu.com"},
    {"id": "toutiao",             "name": "今日头条",   "domain": "toutiao.com"},
    {"id": "bilibili-hot-search", "name": "bilibili",  "domain": "bilibili.com"},
    {"id": "thepaper",            "name": "澎湃新闻",   "domain": "thepaper.cn"},
    {"id": "ifeng",               "name": "凤凰网",     "domain": "ifeng.com"},
    {"id": "tieba",               "name": "贴吧",       "domain": "baidu.com"},
    {"id": "douyin",              "name": "抖音",       "domain": "douyin.com"},
]

DB_DIR = Path(os.environ.get(
    "NEWSNOW_DB_DIR",
    Path.home() / ".tinyclaw" / "newsnow"
))

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
    "Cache-Control": "no-cache",
}

# ── SQLite 存储 ────────────────────────────────────────────────────────────────

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS platforms (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS news_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    platform_id TEXT NOT NULL,
    rank INTEGER NOT NULL,
    url TEXT DEFAULT '',
    mobile_url TEXT DEFAULT '',
    crawl_time TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(title, platform_id, crawl_time)
);

CREATE INDEX IF NOT EXISTS idx_news_platform ON news_items(platform_id);
CREATE INDEX IF NOT EXISTS idx_news_rank ON news_items(rank);
"""


def get_db_path(date: str) -> Path:
    DB_DIR.mkdir(parents=True, exist_ok=True)
    return DB_DIR / f"{date}.db"


def init_db(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA_SQL)
    conn.commit()


def upsert_platforms(conn: sqlite3.Connection, platforms: list[dict]) -> None:
    for p in platforms:
        conn.execute(
            "INSERT OR REPLACE INTO platforms(id, name) VALUES(?, ?)",
            (p["id"], p["name"])
        )
    conn.commit()


def insert_items(
    conn: sqlite3.Connection,
    platform_id: str,
    items: list[dict],
    crawl_time: str,
) -> int:
    inserted = 0
    for i, item in enumerate(items):
        title = item.get("title", "").strip()
        url = item.get("url", "").strip()
        mobile_url = item.get("mobileUrl", "").strip()
        if not title:
            continue
        try:
            conn.execute(
                "INSERT OR IGNORE INTO news_items(title, platform_id, rank, url, mobile_url, crawl_time) "
                "VALUES(?, ?, ?, ?, ?, ?)",
                (title, platform_id, i + 1, url, mobile_url, crawl_time)
            )
            inserted += 1
        except Exception:
            pass
    conn.commit()
    return inserted


# ── 爬虫 ──────────────────────────────────────────────────────────────────────

def _check_domain(items: list[dict], expected_domain: str) -> bool:
    """简单校验返回数据中的链接域名是否合法"""
    for item in items[:3]:
        for key in ("url", "mobileUrl"):
            url = item.get(key, "")
            if not url:
                continue
            try:
                host = urlparse(url).hostname or ""
                if host and not (host == expected_domain or host.endswith("." + expected_domain)):
                    return False
            except Exception:
                pass
    return True


def fetch_platform(platform: dict, max_retries: int = 2) -> list[dict]:
    """从 NewsNow API 抓取单个平台热榜"""
    pid = platform["id"]
    url = f"{NEWSNOW_API}?id={pid}&latest"

    for attempt in range(max_retries + 1):
        try:
            resp = requests.get(url, headers=HEADERS, timeout=10)
            resp.raise_for_status()
            data = resp.json()

            if data.get("status") not in ("success", "cache"):
                raise ValueError(f"状态异常: {data.get('status')}")

            items = data.get("items", [])
            if not isinstance(items, list):
                return []

            # 域名安全校验
            expected = platform.get("domain", "")
            if expected and items and not _check_domain(items, expected):
                print(f"[WARN] {pid}: 域名校验失败，跳过", file=sys.stderr)
                return []

            print(f"[INFO] {pid}({platform['name']}): {len(items)} 条", file=sys.stderr)
            return items

        except Exception as e:
            if attempt < max_retries:
                wait = random.uniform(2, 4) + attempt * 1.5
                print(f"[WARN] {pid} 失败: {e}，{wait:.1f}s 后重试...", file=sys.stderr)
                time.sleep(wait)
            else:
                print(f"[ERROR] {pid} 抓取失败: {e}", file=sys.stderr)

    return []


# ── 主函数 ────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description="抓取 NewsNow 热榜数据存入本地 SQLite")
    parser.add_argument(
        "--platforms", "-p", default="",
        help="平台 ID 逗号分隔（如 wallstreetcn-hot,cls-hot），默认抓取所有"
    )
    parser.add_argument(
        "--limit", "-l", type=int, default=50,
        help="每平台最多保留条数（默认 50）"
    )
    parser.add_argument(
        "--date", "-d", default=None,
        help="写入日期 YYYY-MM-DD（默认今天）"
    )
    parser.add_argument(
        "--list-platforms", action="store_true",
        help="列出支持的平台 ID 及名称"
    )
    args = parser.parse_args()

    if args.list_platforms:
        for p in DEFAULT_PLATFORMS:
            print(f"  {p['id']:30s}  {p['name']}")
        return

    # 过滤平台
    if args.platforms:
        requested = {x.strip() for x in args.platforms.split(",") if x.strip()}
        platforms = [p for p in DEFAULT_PLATFORMS if p["id"] in requested]
        if not platforms:
            print(f"[错误] 未找到任何有效平台 ID: {args.platforms}", file=sys.stderr)
            sys.exit(1)
    else:
        platforms = DEFAULT_PLATFORMS

    date_str = args.date or datetime.now(timezone.utc).astimezone().strftime("%Y-%m-%d")
    crawl_time = datetime.now(timezone.utc).astimezone().strftime("%H:%M")
    db_path = get_db_path(date_str)

    print(f"[INFO] 数据库: {db_path}", file=sys.stderr)
    print(f"[INFO] 日期: {date_str}  时间: {crawl_time}", file=sys.stderr)

    conn = sqlite3.connect(str(db_path))
    init_db(conn)
    upsert_platforms(conn, platforms)

    total = 0
    for platform in platforms:
        items = fetch_platform(platform)
        if items:
            n = insert_items(conn, platform["id"], items[:args.limit], crawl_time)
            total += n

    conn.close()
    result = {
        "date": date_str,
        "db": str(db_path),
        "platforms": len(platforms),
        "inserted": total,
    }
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    main()
