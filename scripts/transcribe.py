#!/usr/bin/env python3
"""
语音转文字脚本 — 基于 faster-whisper 本地推理
用法:
  python3 transcribe.py <audio_file> [model_size] [language]
  python3 transcribe.py <audio_file> [model_size] [language] --start <秒> --duration <秒>

参数:
  audio_file  : 音频文件路径(支持 WAV/MP3/OGG/FLAC/MP4 等 ffmpeg 可解码的格式,
                以及 QQ SILK 格式,需安装 pilk:pip install pilk)
  model_size  : 模型大小,默认 "small"(可选:tiny/base/small/medium/large-v3)
  language    : 语言代码,默认 "" 表示自动检测(如 "zh"/"en"/"ja")
  --start     : 从第几秒开始转写(默认 0,用于分段转写)
  --duration  : 转写几秒(默认全部,用于分段转写)

输出:
  转录文本输出到 stdout(UTF-8)
  错误信息输出到 stderr
  成功退出码 0,失败退出码 1
"""

import sys
import os
import argparse
import subprocess
import tempfile


def is_silk(path: str) -> bool:
    """检测文件是否为 QQ SILK 格式(文件头含 #!SILK_V3)。"""
    try:
        with open(path, "rb") as f:
            header = f.read(16)
        return b"#!SILK_V3" in header
    except OSError:
        return False


def silk_to_wav(silk_path: str) -> str:
    """将 SILK 文件转换为临时 WAV 文件,返回 WAV 路径。调用方负责删除。"""
    try:
        import pilk
    except ImportError:
        raise RuntimeError("未安装 pilk,请运行:pip install pilk")

    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    tmp.close()
    pilk.silk_to_wav(silk_path, tmp.name)
    return tmp.name


def clip_audio(src: str, start: float, duration: float) -> str:
    """用 ffmpeg 裁剪音频片段,返回临时文件路径。调用方负责删除。"""
    tmp = tempfile.NamedTemporaryFile(suffix=".mp3", delete=False)
    tmp.close()
    cmd = [
        "ffmpeg", "-y",
        "-ss", str(start),
        "-t", str(duration),
        "-i", src,
        "-q:a", "4",
        tmp.name,
    ]
    result = subprocess.run(cmd, capture_output=True)
    if result.returncode != 0:
        os.unlink(tmp.name)
        raise RuntimeError(f"ffmpeg 裁剪失败: {result.stderr.decode(errors='replace')}")
    return tmp.name


def main():
    # 兼容旧式位置参数: transcribe.py <file> [model] [lang]
    # 新式: transcribe.py <file> [model] [lang] --start X --duration Y
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("audio_file")
    parser.add_argument("model_size", nargs="?", default="small")
    parser.add_argument("language", nargs="?", default="")
    parser.add_argument("--start", type=float, default=None)
    parser.add_argument("--duration", type=float, default=None)

    try:
        args = parser.parse_args()
    except SystemExit:
        print("用法: transcribe.py <audio_file> [model_size] [language] [--start 秒] [--duration 秒]",
              file=sys.stderr)
        sys.exit(1)

    audio_file = args.audio_file
    model_size = args.model_size
    language   = args.language

    if not os.path.exists(audio_file):
        print(f"文件不存在: {audio_file}", file=sys.stderr)
        sys.exit(1)

    try:
        from faster_whisper import WhisperModel
    except ImportError:
        print(
            "未安装 faster-whisper,请运行:pip install faster-whisper",
            file=sys.stderr,
        )
        sys.exit(1)

    silk_tmp: str | None = None
    clip_tmp: str | None = None
    try:
        input_file = audio_file

        # QQ SILK 格式无法被 ffmpeg 直接解码,先用 pilk 转换为 WAV
        if is_silk(audio_file):
            print("检测到 SILK 格式,转换为 WAV...", file=sys.stderr)
            silk_tmp = silk_to_wav(audio_file)
            input_file = silk_tmp

        # 分段裁剪(--start / --duration)
        if args.start is not None or args.duration is not None:
            start    = args.start    or 0.0
            duration = args.duration or 99999.0
            print(f"裁剪片段: start={start}s duration={duration}s", file=sys.stderr)
            clip_tmp   = clip_audio(input_file, start, duration)
            input_file = clip_tmp

        # device="cpu" + compute_type="int8" 兼容无 GPU 环境,速度合理
        model = WhisperModel(model_size, device="cpu", compute_type="int8")

        kwargs: dict = {"beam_size": 5}
        if language:
            kwargs["language"] = language

        segments, _info = model.transcribe(input_file, **kwargs)
        text = "".join(seg.text for seg in segments).strip()
        print(text)
    except Exception as e:
        print(f"转录失败: {e}", file=sys.stderr)
        sys.exit(1)
    finally:
        for tmp in (silk_tmp, clip_tmp):
            if tmp and os.path.exists(tmp):
                os.unlink(tmp)


if __name__ == "__main__":
    main()
