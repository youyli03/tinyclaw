#!/usr/bin/env python3
"""
语音转文字脚本 — 基于 faster-whisper 本地推理
用法：python3 transcribe.py <audio_file> [model_size] [language]

参数：
  audio_file  : 音频文件路径（支持 WAV/MP3/OGG/FLAC/MP4 等 ffmpeg 可解码的格式）
  model_size  : 模型大小，默认 "small"（可选：tiny/base/small/medium/large-v3）
  language    : 语言代码，默认 "" 表示自动检测（如 "zh"/"en"/"ja"）

输出：
  转录文本输出到 stdout（UTF-8）
  错误信息输出到 stderr
  成功退出码 0，失败退出码 1
"""

import sys
import os

def main():
    if len(sys.argv) < 2:
        print("用法: transcribe.py <audio_file> [model_size] [language]", file=sys.stderr)
        sys.exit(1)

    audio_file = sys.argv[1]
    model_size = sys.argv[2] if len(sys.argv) > 2 else "small"
    language   = sys.argv[3] if len(sys.argv) > 3 else ""

    if not os.path.exists(audio_file):
        print(f"文件不存在: {audio_file}", file=sys.stderr)
        sys.exit(1)

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print(
            "未安装 faster-whisper，请运行：pip install faster-whisper",
            file=sys.stderr,
        )
        sys.exit(1)

    try:
        # device="cpu" + compute_type="int8" 兼容无 GPU 环境，速度合理
        model = WhisperModel(model_size, device="cpu", compute_type="int8")

        kwargs = {"beam_size": 5}
        if language:
            kwargs["language"] = language

        segments, _info = model.transcribe(audio_file, **kwargs)
        text = "".join(seg.text for seg in segments).strip()
        print(text)
    except Exception as e:
        print(f"转录失败: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
