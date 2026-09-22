/**
 * TOML 配置写入工具
 *
 * 采用行级补丁策略，在更新指定字段时保留原始注释和格式。
 * 仅支持以 [section.subsection] 扁平形式声明的 section（项目 config.toml 惯例）。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { atomicWriteText, backupFile, quarantineRejected, DEFAULT_BACKUP_KEEP } from "./safe-write.js";
import { noteConfigWritten } from "./state.js";
import {
  hasConfigErrors,
  validateConfigText,
  type ConfigDiag,
  type ValidateOptions,
} from "./validate.js";

const CONFIG_PATH = path.join(os.homedir(), ".tinyclaw", "config.toml");

export { CONFIG_PATH };

/**
 * 读取 config.toml 原始内容（保留注释）。
 * 若文件不存在则抛出错误。
 *
 * @param filePath 仅供测试注入；默认 `~/.tinyclaw/config.toml`
 */
export function readRawConfig(filePath: string = CONFIG_PATH): string {
  if (!fs.existsSync(filePath)) {
    throw new Error(`配置文件不存在：${filePath}`);
  }
  return fs.readFileSync(filePath, "utf-8");
}

/** 写入选项：校验选项 + 可注入目标路径（测试用） */
export interface ConfigWriteOptions extends ValidateOptions {
  filePath?: string;
}

/** 校验后写入 config.toml 的结果 */
export type ConfigWriteResult =
  | { ok: true; backupPath: string | null; diagnostics: ConfigDiag[] }
  | { ok: false; diagnostics: ConfigDiag[]; rejectedPath: string };

/**
 * **所有 config.toml 写入的唯一入口**：先校验，再备份，再原子写。
 *
 * - 校验有 error → **不落盘**，把被拒文本留证到 `config.toml.rejected-<ts>`（0600）并返回诊断
 * - 通过 → `.bak-<ts>` 备份（保留 5 份）+ `.tmp`/rename 原子写 + chmod 0600
 *
 * 为什么必须统一走这里：`config.toml` 写坏 = 服务再也起不来（`loadConfig()` fail-fast），
 * 而历史上 `patchTomlField` 是裸写。
 */
export function writeConfigText(
  text: string,
  opts: ConfigWriteOptions = {}
): ConfigWriteResult {
  const target = opts.filePath ?? CONFIG_PATH;
  const validation = validateConfigText(text, opts);
  if (hasConfigErrors(validation.diagnostics)) {
    const rejectedPath = quarantineRejected(target, text);
    return { ok: false, diagnostics: validation.diagnostics, rejectedPath };
  }
  const backupPath = backupFile(target, DEFAULT_BACKUP_KEEP);
  atomicWriteText(target, text);
  // 记录状态（current + pending）：supervisor 靠"磁盘 vs LKG 的内容哈希"决定是否自动回退
  noteConfigWritten(text, path.dirname(target));
  return { ok: true, backupPath, diagnostics: validation.diagnostics };
}

/**
 * 在保留注释的前提下，更新 TOML 配置中指定 section 的一个字段并写回磁盘。
 *
 * 示例：`patchTomlField(["llm", "backends", "daily"], "model", '"gpt-4o"')`
 *
 * ⚠️ 写入前会**校验整份文件**：校验不过就不写，返回 `ok:false`（调用方必须处理并告知用户）。
 *
 * @param sectionPath  TOML section 路径（如 ["llm", "backends", "daily"]）
 * @param key          字段名
 * @param rawValue     已格式化的 TOML 值（字符串须带引号，如 `'"gpt-4o"'`；数字直接传 `"1234"`）
 */
export function patchTomlField(
  sectionPath: string[],
  key: string,
  rawValue: string,
  opts: ConfigWriteOptions = {}
): ConfigWriteResult {
  const target = opts.filePath ?? CONFIG_PATH;
  const patched = applyTomlPatch(readRawConfig(target), sectionPath, key, rawValue);
  return writeConfigText(patched, opts);
}

/**
 * 纯函数：对 TOML 文本执行字段补丁，返回新文本（供测试）。
 *
 * 匹配规则：
 * 1. 找到 `[sectionPath.join(".")]` 行（精确匹配）
 * 2. 在该 section 内找第一个 `key =` 行（跳过注释行）
 * 3. 找到则替换，找不到则在该 section 末尾（下一个 section 之前）插入
 * 4. section 整行不存在则追加到文件末尾
 */
export function applyTomlPatch(
  content: string,
  sectionPath: string[],
  key: string,
  rawValue: string
): string {
  const sectionHeader = `[${sectionPath.join(".")}]`;
  const lines = content.split("\n");

  let sectionStart = -1;
  let nextSectionIdx = -1;
  let keyLineIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = (lines[i] ?? "").trim();

    if (sectionStart < 0) {
      // 精确匹配目标 section 头
      if (trimmed === sectionHeader) {
        sectionStart = i;
      }
    } else {
      // 已进入目标 section，查找下一个 section 或目标 key
      if (trimmed.startsWith("[") && !trimmed.startsWith("[#")) {
        nextSectionIdx = i;
        break;
      }
      if (!trimmed.startsWith("#") && trimmed !== "") {
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx > 0) {
          const lineKey = trimmed.slice(0, eqIdx).trim();
          if (lineKey === key) {
            keyLineIdx = i;
            break;
          }
        }
      }
    }
  }

  const newLine = `${key} = ${rawValue}`;

  if (keyLineIdx >= 0) {
    lines[keyLineIdx] = newLine;
  } else if (sectionStart >= 0) {
    const insertAt = nextSectionIdx >= 0 ? nextSectionIdx : lines.length;
    lines.splice(insertAt, 0, newLine);
  } else {
    // section 不存在，追加到末尾
    if (lines[lines.length - 1]?.trim() !== "") lines.push("");
    lines.push(sectionHeader, newLine);
  }

  return lines.join("\n");
}
