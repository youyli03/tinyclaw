#!/usr/bin/env python3
"""
search_newsnow.py — 向量语义检索 NewsNow 热榜新闻

优先使用 RKLLM embed 服务（http://127.0.0.1:11434）生成向量后做 KNN 搜索。
若 embed 服务不可用或 DB 无向量，降级为关键词 LIKE 匹配。

用法:
  python3 search_newsnow.py --query "芯片股下跌" [--days 7] [--limit 10] [--fresh]
  
  --fresh: 在搜索前先触发一次抓取（调用 fetch_newsnow.py）
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import struct
import sys
import time
import urllib.request
from datetime import date, timedelta
from pathlib import Path

NEWSNOW_DB_DIR = Path(os.environ.get("NEWSNOW_DB_DIR", Path.home() / ".tinyclaw" / "newsnow"))
EMBED_API = "http://127.0.0.1:11434"
EMBED_DIM = 1024
SCRIPT_DIR = Path(__file__).parent.resolve()


def _load_sqlite_vec(conn: sqlite3.Connection) -> bool:
    try:
        import sqlite_vec
        conn.enable_load_extension(True)
        sqlite_vec.load(conn)
        conn.enable_load_extension(False)
        return True
    except Exception:
        return False


def embed_one(text: str) -> list[float] | None:
    """调用 RKLLM embed 服务生成单条文本的向量"""
    try:
        data = json.dumps({"text": text}).encode()
        req = urllib.request.Request(
            f"{EMBED_API}/embed",
            data=data,
            headers={"Content-Type": "application/json"},
        )
        resp = urllib.request.urlopen(req, timeout=10)
        result = json.loads(resp.read())
        emb = result.get("embedding", [])
        return emb if len(emb) == EMBED_DIM else None
    except Exception:
        return None


def get_db_paths(days: int) -> list[Path]:
    """获取最近 days 天中存在的 DB 文件路径"""
    paths = []
    today = date.today()
    for i in range(days):
        d = (today - timedelta(days=i)).isoformat()
        p = NEWSNOW_DB_DIR / f"{d}.db"
        if p.exists():
            paths.append((d, p))
    return paths


def vector_search(
    query: str,
    days: int = 7,
    limit: int = 10,
) -> list[dict]:
    """向量语义检索，跨最近 days 天的 DB"""
    query_emb = embed_one(query)
    if not query_emb:
        return []

    query_blob = struct.pack(f"{EMBED_DIM}f", *query_emb)
    results: list[dict] = []
    db_paths = get_db_paths(days)

    for d_str, db_path in db_paths:
        if len(results) >= limit:
            break

        conn = sqlite3.connect(str(db_path))
        has_vec = _load_sqlite_vec(conn)
        if not has_vec:
            conn.close()
            continue

        try:
            remaining = limit - len(results)
            rows = conn.execute("""
                SELECT n.title, p.name AS platform, n.rank, n.url, v.distance
                FROM vec_news v
                JOIN news_items n ON n.id = v.rowid
                LEFT JOIN platforms p ON p.id = n.platform_id
                WHERE v.title_embedding MATCH ?
                AND k = ?
                ORDER BY v.distance ASC
            """, (query_blob, remaining * 2)).fetchall()  # 多取一些再截断

            for row in rows:
                if len(results) >= limit:
                    break
                results.append({
                    "date": d_str,
                    "title": row[0],
                    "platform": row[1] or "",
                    "rank": row[2],
                    "url": row[3] or "",
                    "distance": round(float(row[4]), 3),
                    "match_type": "vector",
                })
        except Exception as e:
            # vec_news 不存在时降级
            pass
        finally:
            conn.close()

    return results


def keyword_search(
    query: str,
    days: int = 7,
    limit: int = 10,
) -> list[dict]:
    """关键词 LIKE 搜索（降级方案）"""
    results: list[dict] = []
    db_paths = get_db_paths(days)

    for d_str, db_path in db_paths:
        if len(results) >= limit:
            break

        conn = sqlite3.connect(str(db_path))
        conn.row_factory = sqlite3.Row
        try:
            remaining = limit - len(results)
            rows = conn.execute("""
                SELECT n.title, p.name AS platform, n.rank, n.url
                FROM news_items n
                LEFT JOIN platforms p ON p.id = n.platform_id
                WHERE n.title LIKE ?
                ORDER BY n.rank ASC
                LIMIT ?
            """, (f"%{query}%", remaining)).fetchall()
            for row in rows:
                results.append({
                    "date": d_str,
                    "title": row["title"],
                    "platform": row["platform"] or "",
                    "rank": row["rank"],
                    "url": row["url"] or "",
                    "distance": None,
                    "match_type": "keyword",
                })
        except Exception:
            pass
        finally:
            conn.close()

    return results


def do_fetch(platforms: str = "") -> dict:
    """触发一次新闻抓取"""
    import subprocess
    args = [sys.executable, str(SCRIPT_DIR / "fetch_newsnow.py")]
    if platforms:
        args += ["--platforms", platforms]
    result = subprocess.run(args, capture_output=True, text=True, timeout=90)
    if result.returncode != 0:
        return {"error": result.stderr[:500]}
    try:
        return json.loads(result.stdout.strip())
    except Exception:
        return {"raw": result.stdout.strip()}


def main() -> None:
    parser = argparse.ArgumentParser(description="向量语义检索 NewsNow 热榜新闻")
    parser.add_argument("--query", "-q", required=True, help="搜索查询（自然语言，支持中文）")
    parser.add_argument("--days", type=int, default=7, help="搜索最近 N 天（默认 7）")
    parser.add_argument("--limit", type=int, default=10, help="最多返回结果数（默认 10）")
    parser.add_argument("--fresh", action="store_true", help="搜索前先抓取最新热榜")
    parser.add_argument("--fetch-platforms", default="", help="--fresh 时指定抓取的平台")
    args = parser.parse_args()

    output: dict = {}

    if args.fresh:
        print("[INFO] 抓取最新热榜...", file=sys.stderr)
        fetch_result = do_fetch(args.fetch_platforms)
        output["fetch"] = fetch_result
        print(f"[INFO] 抓取完成: {fetch_result}", file=sys.stderr)

    # 优先向量搜索
    results = vector_search(args.query, days=args.days, limit=args.limit)

    # 降级为关键词搜索
    if not results:
        print("[INFO] 向量搜索无结果，降级为关键词搜索", file=sys.stderr)
        results = keyword_search(args.query, days=args.days, limit=args.limit)

    output.update({
        "query": args.query,
        "results": results,
        "count": len(results),
    })
    print(json.dumps(output, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
