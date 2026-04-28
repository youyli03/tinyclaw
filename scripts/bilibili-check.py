#!/usr/bin/env python3
"""检查 B 站 UP 主是否有新视频，输出新视频列表（JSON）。
状态文件: ~/.tinyclaw/bilibili-seen.json
用法: python3 bilibili-check.py
输出: JSON 数组（新视频）或 NO_NEW
"""
import json, asyncio, sys
from pathlib import Path

STATE_FILE = Path.home() / ".tinyclaw" / "bilibili-seen.json"

# 订阅的 UP 主 mid 列表
UP_MIDS = [1975011153, 131580584]

def load_seen() -> set:
    if STATE_FILE.exists():
        return set(json.loads(STATE_FILE.read_text()))
    return set()

def save_seen(seen: set):
    STATE_FILE.write_text(json.dumps(sorted(seen)))

async def fetch_videos(mid: int):
    from bilibili_api import user
    u = user.User(mid)
    try:
        info = await u.get_user_info()
        name = info.get("name", str(mid))
    except Exception:
        name = str(mid)
    await asyncio.sleep(2)
    try:
        videos = await u.get_videos(ps=10)
        return name, videos["list"]["vlist"]
    except Exception as e:
        print(f"[WARN] UID={mid} 获取失败: {e}", file=sys.stderr)
        return name, []

async def main():
    seen = load_seen()
    new_videos = []

    for mid in UP_MIDS:
        name, vlist = await fetch_videos(mid)
        for v in vlist:
            bvid = v["bvid"]
            if bvid not in seen:
                new_videos.append({
                    "bvid": bvid,
                    "title": v["title"],
                    "url": f"https://www.bilibili.com/video/{bvid}",
                    "up": name,
                    "created": v["created"],
                })
        await asyncio.sleep(2)

    if not new_videos:
        print("NO_NEW")
        return

    print(json.dumps(new_videos, ensure_ascii=False))

    # 标记为已见
    for v in new_videos:
        seen.add(v["bvid"])
    save_seen(seen)

asyncio.run(main())
