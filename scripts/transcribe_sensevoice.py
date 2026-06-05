#!/usr/bin/env python3
"""
SenseVoice 快速语音转文字脚本
用法: python3 transcribe_sensevoice.py <audio_file> [seg_sec] [language]

参数:
  audio_file : 音频文件路径(支持 mp3/mp4/wav/m4a 等 ffmpeg 可解码格式,
               以及 QQ SILK 格式,需安装 pilk:pip install pilk)
  seg_sec    : 每段秒数(默认 120),音频超出则自动分段转写
  language   : 语言代码,默认 zh(中文),支持 en/ja/ko/yue

模型路径: ~/.local/share/asr_models/sensevoice/model.int8.onnx
          ~/.local/share/asr_models/sensevoice/tokens.txt

输出: 完整转写文本到 stdout
"""

import sys
import os
import subprocess
import tempfile
import wave
import array
import ctypes
import math

# 模型路径
HOME = os.path.expanduser("~")
MODEL_DIR = os.path.join(HOME, ".local/share/asr_models/sensevoice")
MODEL_PATH = os.path.join(MODEL_DIR, "model.int8.onnx")
TOKENS_PATH = os.path.join(MODEL_DIR, "tokens.txt")


def check_model():
    if not os.path.exists(MODEL_PATH):
        print(f"模型文件不存在: {MODEL_PATH}", file=sys.stderr)
        print("请运行以下命令下载模型:", file=sys.stderr)
        print(f"  python3 -c \"", file=sys.stderr)
        print(f"    import requests, os; os.makedirs('{MODEL_DIR}', exist_ok=True)", file=sys.stderr)
        print(f"    open('{MODEL_PATH}','wb').write(requests.get(", file=sys.stderr)
        print(f"      'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main/model.int8.onnx',", file=sys.stderr)
        print(f"      stream=True).content)\"", file=sys.stderr)
        sys.exit(1)


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


def clip_wav(audio_file: str, start: float, duration: float) -> str:
    """裁剪音频片段为16kHz单声道WAV,返回临时文件路径"""
    tmp = tempfile.mktemp(suffix=".wav")
    cmd = [
        "ffmpeg", "-y",
        "-ss", str(start),
        "-t", str(duration),
        "-i", audio_file,
        "-ar", "16000",
        "-ac", "1",
        tmp,
    ]
    result = subprocess.run(cmd, capture_output=True)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg 裁剪失败: {result.stderr.decode(errors='replace')}")
    return tmp


def wav_to_float(wav_path: str):
    with wave.open(wav_path) as wf:
        frames = wf.readframes(wf.getnframes())
        sr = wf.getframerate()
        samples = array.array("h", frames)
        samples_float = [s / 32768.0 for s in samples]
    arr = (ctypes.c_float * len(samples_float))(*samples_float)
    return sr, arr


def transcribe_wav(recognizer, wav_path: str) -> str:
    sr, arr = wav_to_float(wav_path)
    s = recognizer.create_stream()
    s.accept_waveform(sr, arr)
    recognizer.decode_stream(s)
    return s.result.text


def main():
    if len(sys.argv) < 2:
        print("用法: transcribe_sensevoice.py <audio_file> [seg_sec] [language]", file=sys.stderr)
        sys.exit(1)

    audio_file = sys.argv[1]
    seg_sec = int(sys.argv[2]) if len(sys.argv) > 2 else 120
    language = sys.argv[3] if len(sys.argv) > 3 else "zh"

    if not os.path.exists(audio_file):
        print(f"文件不存在: {audio_file}", file=sys.stderr)
        sys.exit(1)

    # ── SILK 格式检测与转换 ──────────────────────────────────────────────────
    # QQ 语音实际上是 SILK_V3 格式(文件头 #!SILK_V3),ffmpeg/ffprobe 无法直接处理
    # 用 pilk 转换为标准 WAV 后再处理
    silk_tmp = None
    if is_silk(audio_file):
        print(f"检测到 SILK 格式,转换为 WAV...", file=sys.stderr)
        try:
            silk_tmp = silk_to_wav(audio_file)
            audio_file = silk_tmp
            print(f"SILK 转换完成: {silk_tmp}", file=sys.stderr)
        except Exception as e:
            print(f"SILK 转换失败: {e}", file=sys.stderr)
            sys.exit(1)

    try:
        check_model()

        try:
            import sherpa_onnx
        except ImportError:
            print("请安装 sherpa-onnx: pip install sherpa-onnx", file=sys.stderr)
            sys.exit(1)

        # 获取总时长
        result = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", audio_file],
            capture_output=True, text=True
        )
        total = float(result.stdout.strip())
        print(f"音频时长: {total:.0f}s,每段 {seg_sec}s", file=sys.stderr)

        # 加载模型
        recognizer = sherpa_onnx.OfflineRecognizer.from_sense_voice(
            model=MODEL_PATH,
            tokens=TOKENS_PATH,
            num_threads=min(8, os.cpu_count() or 4),
            language=language,
            use_itn=True,
            debug=False,
        )
        print("模型已加载", file=sys.stderr)

        # 分段转写
        texts = []
        n_segs = math.ceil(total / seg_sec)
        for i, start in enumerate(range(0, int(total), seg_sec)):
            dur = min(seg_sec, total - start)
            print(f"[{i+1}/{n_segs}] 转写 {start}s~{start+dur:.0f}s ...", file=sys.stderr)
            tmp = None
            try:
                tmp = clip_wav(audio_file, start, dur)
                text = transcribe_wav(recognizer, tmp)
                texts.append(text)
            except Exception as e:
                print(f"  转写失败: {e}", file=sys.stderr)
            finally:
                if tmp and os.path.exists(tmp):
                    os.unlink(tmp)

        print("\n".join(texts))

    finally:
        # 清理 SILK 转换的临时文件
        if silk_tmp and os.path.exists(silk_tmp):
            os.unlink(silk_tmp)


if __name__ == "__main__":
    main()
