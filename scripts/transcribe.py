#!/usr/bin/env python3
"""
语音转文字脚本 — 基于 faster-whisper 本地推理
用法：python3 transcribe.py <audio_file> [model_size] [language]

参数：
  audio_file  : 音频文件路径（支持 WAV/MP3/OGG/FLAC/MP4 等 ffmpeg 可解码的格式，
                以及 QQ SILK 格式，需安装 pilk：pip install pilk）
  model_size  : 模型大小，默认 "small"（可选：tiny/base/small/medium/large-v3）
  language    : 语言代码，默认 "" 表示自动检测（如 "zh"/"en"/"ja"）

输出：
  转录文本输出到 stdout（UTF-8）
  错误信息输出到 stderr
  成功退出码 0，失败退出码 1
"""

import sys
import os
import tempfile


def is_silk(path: str) -> bool:
    """检测文件是否为 QQ SILK 格式（文件头含 #!SILK_V3）。"""
    try:
        with open(path, "rb") as f:
            header = f.read(16)
        return b"#!SILK_V3" in header
    except OSError:
        return False


def silk_to_wav(silk_path: str) -> str:
    """将 SILK 文件转换为临时 WAV 文件，返回 WAV 路径。调用方负责删除。"""
    try:
        import pilk
    except ImportError:
        raise RuntimeError("未安装 pilk，请运行：pip install pilk")

    tmp = tempfile.NamedTemporaryFile(suffix=".wav", delete=False)
    tmp.close()
    pilk.silk_to_wav(silk_path, tmp.name)
    return tmp.name


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

    wav_tmp: str | None = None
    try:
        input_file = audio_file

        # QQ SILK 格式无法被 ffmpeg 直接解码，先用 pilk 转换为 WAV
        if is_silk(audio_file):
            print(f"检测到 SILK 格式，转换为 WAV...", file=sys.stderr)
            wav_tmp = silk_to_wav(audio_file)
            input_file = wav_tmp

        # device="cpu" + compute_type="int8" 兼容无 GPU 环境，速度合理
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
        if wav_tmp and os.path.exists(wav_tmp):
            os.unlink(wav_tmp)


if __name__ == "__main__":
    main()
