#!/usr/bin/env python3
"""
TrendRadar 热榜新闻检索脚本

从 /home/lyy/TrendRadar/output/news/*.db (SQLite) 中搜索近期热榜标题，
输出 JSON 数组到 stdout。

用法:
  python3 search_trendradar.py --query "美光" [--days 7] [--limit 30] [--platforms "华尔街见闻,财联社热门"]

数据来源: TrendRadar 爬取的各平台热榜（华尔街见闻/财联社/微博/百度/知乎等）
注意: 只含热榜 title + rank，不含文章正文
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from datetime import date, timedelta
from pathlib import Path

# 优先使用 tinyclaw 自己维护的 NewsNow DB（通过 fetch_newsnow.py 抓取）
# 回退到 TrendRadar 原目录（如果存在）
_NEWSNOW_DIR = Path(os.environ.get("NEWSNOW_DB_DIR", Path.home() / ".tinyclaw" / "newsnow"))
_TRENDRADAR_LEGACY_DIR = Path("/home/lyy/TrendRadar/output/news")

def _get_news_dirs() -> list[Path]:
    """返回有效的 DB 目录列表（优先 newsnow，回退 TrendRadar）"""
    dirs = []
    if _NEWSNOW_DIR.exists():
        dirs.append(_NEWSNOW_DIR)
    if _TRENDRADAR_LEGACY_DIR.exists() and _TRENDRADAR_LEGACY_DIR != _NEWSNOW_DIR:
        dirs.append(_TRENDRADAR_LEGACY_DIR)
    return dirs

TRENDRADAR_NEWS_DIR = _NEWSNOW_DIR  # backward compat


def search(
    query: str,
    days: int = 7,
    limit: int = 30,
    platforms: list[str] | None = None,
) -> list[dict]:
    """在最近 days 天的热榜 SQLite DB 中搜索标题包含 query 的条目
    
    优先搜索 ~/.tinyclaw/newsnow/（由 fetch_newsnow.py 维护），
    回退到 TrendRadar 原始目录（/home/lyy/TrendRadar/output/news/）。
    """
    results: list[dict] = []
    today = date.today()
    db_dirs = _get_news_dirs()
    if not db_dirs:
        return []

    for i in range(days):
        if len(results) >= limit:
            break

        d = (today - timedelta(days=i)).isoformat()
        # 在所有目录中查找该日期的 DB（去重：同一日期只取第一个找到的）
        db_path = None
        for db_dir in db_dirs:
            candidate = db_dir / f"{d}.db"
            if candidate.exists():
                db_path = candidate
                break
        if db_path is None:
            continue

        try:
            conn = sqlite3.connect(str(db_path))
            conn.row_factory = sqlite3.Row

            where_clauses = ["n.title LIKE ?"]
            params: list[str] = [f"%{query}%"]

            if platforms:
                placeholders = ",".join("?" * len(platforms))
                where_clauses.append(f"p.name IN ({placeholders})")
                params.extend(platforms)

            where = " AND ".join(where_clauses)
            remaining = limit - len(results)

            # 兼容两种 schema:
            # - 新版 (fetch_newsnow.py): crawl_time
            # - 旧版 (TrendRadar): first_crawl_time
            crawl_col = "n.crawl_time"
            try:
                cols = conn.execute("PRAGMA table_info(news_items)").fetchall()
                col_names = {c[1] for c in cols}
                if "first_crawl_time" in col_names and "crawl_time" not in col_names:
                    crawl_col = "n.first_crawl_time"
            except Exception:
                pass

            sql = f"""
                SELECT n.title, p.name AS platform, n.rank, {crawl_col} AS crawl_time
                FROM news_items n
                LEFT JOIN platforms p ON n.platform_id = p.id
                WHERE {where}
                ORDER BY n.rank ASC
                LIMIT {remaining}
            """

            rows = conn.execute(sql, params).fetchall()
            for row in rows:
                results.append({
                    "date": d,
                    "title": row["title"],
                    "platform": row["platform"] or "",
                    "rank": row["rank"],
                    "crawl_time": row["crawl_time"],
                })
            conn.close()

        except Exception as e:
            # 单个 DB 读取失败不影响其他天
            print(f"[WARN] 读取 {d}.db 失败: {e}", file=sys.stderr)

    return results


def list_available_dates() -> list[str]:
    """列出所有有数据的日期（合并所有 DB 目录）"""
    dates: set[str] = set()
    for db_dir in _get_news_dirs():
        for p in db_dir.glob("*.db"):
            dates.add(p.stem)
    return sorted(dates, reverse=True)


def list_platforms() -> list[str]:
    """从最新 DB 中列出所有平台"""
    dates = list_available_dates()
    if not dates:
        return []
    db_path = None
    for db_dir in _get_news_dirs():
        candidate = db_dir / f"{dates[0]}.db"
        if candidate.exists():
            db_path = candidate
            break
    if db_path is None:
        return []
    try:
        conn = sqlite3.connect(str(db_path))
        rows = conn.execute("SELECT name FROM platforms WHERE is_active=1 ORDER BY name").fetchall()
        conn.close()
        return [r[0] for r in rows]
    except Exception:
        return []


def main() -> None:
    parser = argparse.ArgumentParser(description="TrendRadar 热榜新闻关键词检索")
    parser.add_argument("--query", "-q", default="", help="搜索关键词")
    parser.add_argument("--days", type=int, default=7, help="搜索最近 N 天（默认 7）")
    parser.add_argument("--limit", type=int, default=30, help="最多返回结果数（默认 30）")
    parser.add_argument("--platforms", default="", help="平台过滤，逗号分隔（如 '华尔街见闻,财联社热门'）")
    parser.add_argument("--list-dates", action="store_true", help="列出有数据的日期")
    parser.add_argument("--list-platforms", action="store_true", help="列出所有平台")

    args = parser.parse_args()

    if args.list_dates:
        print(json.dumps({"dates": list_available_dates()}, ensure_ascii=False))
        return

    if args.list_platforms:
        print(json.dumps({"platforms": list_platforms()}, ensure_ascii=False))
        return

    if not args.query:
        print(json.dumps({"error": "缺少 --query 参数"}, ensure_ascii=False))
        sys.exit(1)

    platform_list = [p.strip() for p in args.platforms.split(",") if p.strip()] if args.platforms else None
    results = search(args.query, days=args.days, limit=args.limit, platforms=platform_list)
    print(json.dumps({"results": results, "count": len(results)}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
