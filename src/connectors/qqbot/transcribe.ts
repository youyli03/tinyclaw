/**
 * 本地语音转文字封装 — 调用 scripts/transcribe.py（faster-whisper）
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import * as url from "node:url";

const execFileAsync = promisify(execFile);

const SCRIPT_PATH = path.join(
  path.dirname(url.fileURLToPath(import.meta.url)),
  "../../../scripts/transcribe.py"
);

const TIMEOUT_MS = 180_000; // 3 分钟，大模型首次推理较慢

/**
 * 使用本地 faster-whisper 转录音频文件。
 *
 * @param audioPath  本地音频文件绝对路径
 * @param modelSize  Whisper 模型大小（默认 "small"）
 * @param language   语言代码，空字符串表示自动检测（默认 ""）
 * @returns          转录文本（空字符串表示无可识别内容）
 */
export async function transcribeAudio(
  audioPath: string,
  modelSize = "small",
  language = ""
): Promise<string> {
  const args = [SCRIPT_PATH, audioPath, modelSize];
  if (language) args.push(language);

  const { stdout } = await execFileAsync("python3", args, {
    timeout: TIMEOUT_MS,
    maxBuffer: 1024 * 1024, // 1 MB，转录文本不会超出
  });

  return stdout.trim();
}
