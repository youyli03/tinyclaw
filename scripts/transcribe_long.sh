#!/usr/bin/env bash
# transcribe_long.sh — 自动拆段转写长音频
# 用法: bash transcribe_long.sh <audio_file> [model_size] [language] [max_seg_sec]
#
# 参数:
#   audio_file   : 音频文件路径
#   model_size   : faster-whisper 模型大小,默认 small
#   language     : 语言代码,默认 zh
#   max_seg_sec  : 每段最大秒数,默认 180
#
# 输出: 完整转写文本到 stdout
# 错误: 写到 stderr

set -euo pipefail

AUDIO_FILE="${1:?用法: transcribe_long.sh <audio_file> [model_size] [language] [max_seg_sec]}"
MODEL="${2:-small}"
LANG="${3:-zh}"
MAX_SEC="${4:-180}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TRANSCRIBE="$SCRIPT_DIR/transcribe.py"

if [[ ! -f "$AUDIO_FILE" ]]; then
    echo "文件不存在: $AUDIO_FILE" >&2
    exit 1
fi

# 获取音频总时长(秒,浮点)
TOTAL=$(ffprobe -v error -show_entries format=duration \
        -of default=noprint_wrappers=1:nokey=1 "$AUDIO_FILE" 2>/dev/null)
if [[ -z "$TOTAL" ]]; then
    echo "ffprobe 获取时长失败" >&2
    exit 1
fi

TOTAL_INT=$(python3 -c "import math; print(math.ceil(float('$TOTAL')))")
echo "音频总时长: ${TOTAL_INT}s，每段 ${MAX_SEC}s" >&2

START=0
SEG=1
RESULT=""

while (( START < TOTAL_INT )); do
    echo "转写第 ${SEG} 段: start=${START}s ..." >&2
    PART=$(python3 "$TRANSCRIBE" "$AUDIO_FILE" "$MODEL" "$LANG" \
               --start "$START" --duration "$MAX_SEC" 2>/dev/null || true)
    RESULT="${RESULT}${PART}"$'\n'
    START=$(( START + MAX_SEC ))
    SEG=$(( SEG + 1 ))
done

# 输出合并文本
echo "$RESULT" | sed '/^[[:space:]]*$/d'
