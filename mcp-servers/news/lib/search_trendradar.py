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
import sqlite3
import sys
from datetime import date, timedelta
from pathlib import Path

TRENDRADAR_NEWS_DIR = Path("/home/lyy/TrendRadar/output/news")


def search(
    query: str,
    days: int = 7,
    limit: int = 30,
    platforms: list[str] | None = None,
) -> list[dict]:
    """在最近 days 天的 TrendRadar SQLite DB 中搜索标题包含 query 的热榜条目"""
    results: list[dict] = []
    today = date.today()

    for i in range(days):
        if len(results) >= limit:
            break

        d = (today - timedelta(days=i)).isoformat()
        db_path = TRENDRADAR_NEWS_DIR / f"{d}.db"
        if not db_path.exists():
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

            sql = f"""
                SELECT n.title, p.name AS platform, n.rank, n.first_crawl_time
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
                    "crawl_time": row["first_crawl_time"],
                })
            conn.close()

        except Exception as e:
            # 单个 DB 读取失败不影响其他天
            print(f"[WARN] 读取 {d}.db 失败: {e}", file=sys.stderr)

    return results


def list_available_dates() -> list[str]:
    """列出 TrendRadar 有数据的日期"""
    if not TRENDRADAR_NEWS_DIR.exists():
        return []
    return sorted(
        [p.stem for p in TRENDRADAR_NEWS_DIR.glob("*.db")],
        reverse=True,
    )


def list_platforms() -> list[str]:
    """从最新 DB 中列出所有平台"""
    dates = list_available_dates()
    if not dates:
        return []
    db_path = TRENDRADAR_NEWS_DIR / f"{dates[0]}.db"
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
