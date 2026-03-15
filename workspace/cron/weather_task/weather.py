#!/usr/bin/env python3
"""上海张江天气提醒脚本（定时任务专用）

每天 08:30 运行，输出：
- 温度范围（最低/最高）
- 体感温度
- 天气（白天/夜间）
- 是否有雨（带图标显示）

该脚本使用心知天气（Seniverse）API，需要在脚本中设置私钥。
"""

import json
import subprocess
import sys

# 心知天气私钥（请确保此处为有效私钥）
KEY = "Szer-_lf_7LP5karX"
# 查询地点（可支持 city name / 经纬度 / 具体位置）
LOCATION = "shanghai"

# 今天的天气（start=0 表示今天）
url_daily = (
    f"https://api.seniverse.com/v3/weather/daily.json?"
    f"key={KEY}&location={LOCATION}&language=zh-Hans&unit=c&start=0&days=1"
)
# 当前天气，用于体感参考
url_now = (
    f"https://api.seniverse.com/v3/weather/now.json?"
    f"key={KEY}&location={LOCATION}&language=zh-Hans&unit=c"
)


def fetch(url: str) -> dict:
    out = subprocess.check_output(["curl", "-s", url], stderr=subprocess.DEVNULL).decode("utf-8")
    return json.loads(out)


try:
    d_daily = fetch(url_daily)
    d_now = fetch(url_now)
except Exception as e:
    print(f"⚠️ 天气获取失败：{e}")
    sys.exit(1)

try:
    results_daily = d_daily.get("results", [])
    if not results_daily or not results_daily[0].get("daily"):
        raise ValueError("未获取到 daily 数据")
    daily = results_daily[0]["daily"][0]
    now = d_now["results"][0]["now"]
except Exception as e:
    print(f"⚠️ 天气解析失败：{e}")
    sys.exit(1)

low = int(daily.get("low", "0"))
high = int(daily.get("high", "0"))
feel = now.get("temperature")
text_day = daily.get("text_day", "")
text_night = daily.get("text_night", "")
rainfall = daily.get("rainfall", "0")
precip = daily.get("precip", "0")

# 是否有雨/雪/雷等天气
rain_flag = any(k in (text_day + text_night) for k in ["雨", "雪", "雷"])

# 选择图标
if rain_flag:
    icon = "🌧️"
elif "晴" in text_day:
    icon = "☀️"
elif "云" in text_day or "阴" in text_day:
    icon = "☁️"
else:
    icon = "🌈"

change = f"白天{text_day}、夜间{text_night}"

msg = (
    f"{icon} 上海张江天气：{change}；\n"
    f"🌡️ 温度：{low}~{high}°C（体感 {feel}°C）；\n"
    f"💧 降水：{rainfall}mm / {precip}%；\n"
    f"{('☔ 有雨，请带伞。' if rain_flag else '☀️ 无明显降雨。')}"
)

print(msg)
