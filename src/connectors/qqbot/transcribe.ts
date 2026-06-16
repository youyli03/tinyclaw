/**
 * 本地语音转文字封装
 *
 * 优先使用 SenseVoice（transcribe_sensevoice.py），速度比 faster-whisper 快 10 倍以上。
 * SenseVoice 失败时自动降级到 faster-whisper（transcribe.py）。
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import * as url from "node:url";

const execFileAsync = promisify(execFile);

const SCRIPTS_DIR = path.join(
  path.dirname(url.fileURLToPath(import.meta.url)),
  "../../../scripts"
);

const SENSEVOICE_SCRIPT = path.join(SCRIPTS_DIR, "transcribe_sensevoice.py");
const WHISPER_SCRIPT = path.join(SCRIPTS_DIR, "transcribe.py");

const TIMEOUT_MS = 180_000; // 3 分钟

/**
 * 使用本地 SenseVoice（优先）或 faster-whisper（降级）转录音频文件。
 *
 * @param audioPath  本地音频文件绝对路径
 * @param modelSize  Whisper 模型大小（仅降级到 faster-whisper 时生效，默认 "small"）
 * @param language   语言代码，空字符串表示自动检测（默认 ""）
 * @returns          转录文本（空字符串表示无可识别内容）
 */
export async function transcribeAudio(
  audioPath: string,
  modelSize = "small",
  language = ""
): Promise<string> {
  // ── 1. 尝试 SenseVoice（快，约 1/10 的时间）────────────────────────────
  try {
    const svLang = language || "zh"; // SenseVoice 默认中文（不支持空字符串自动检测）
    const { stdout } = await execFileAsync(
      "python3",
      [SENSEVOICE_SCRIPT, audioPath, "120", svLang],
      { timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 }
    );
    const text = stdout.trim();
    if (text) {
      console.log("[transcribe] SenseVoice 成功");
      return text;
    }
  } catch (svErr) {
    console.warn("[transcribe] SenseVoice 失败，降级到 faster-whisper:", svErr instanceof Error ? svErr.message : svErr);
  }

  // ── 2. 降级到 faster-whisper ─────────────────────────────────────────────
  const args = [WHISPER_SCRIPT, audioPath, modelSize];
  if (language) args.push(language);

  const { stdout } = await execFileAsync("python3", args, {
    timeout: TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });

  return stdout.trim();
}
