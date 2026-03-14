/**
 * TOML 配置写入工具
 *
 * 采用行级补丁策略，在更新指定字段时保留原始注释和格式。
 * 仅支持以 [section.subsection] 扁平形式声明的 section（项目 config.toml 惯例）。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

const CONFIG_PATH = path.join(os.homedir(), ".tinyclaw", "config.toml");

export { CONFIG_PATH };

/**
 * 读取 config.toml 原始内容（保留注释）。
 * 若文件不存在则抛出错误。
 */
export function readRawConfig(): string {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`配置文件不存在：${CONFIG_PATH}`);
  }
  return fs.readFileSync(CONFIG_PATH, "utf-8");
}

/**
 * 在保留注释的前提下，更新 TOML 配置中指定 section 的一个字段并写回磁盘。
 *
 * 示例：patchTomlField(["llm", "backends", "daily"], "model", '"gpt-4o"')
 *
 * @param sectionPath  TOML section 路径（如 ["llm", "backends", "daily"]）
 * @param key          字段名
 * @param rawValue     已格式化的 TOML 值（字符串须带引号，如 `'"gpt-4o"'`；数字直接传 `"1234"`）
 */
export function patchTomlField(sectionPath: string[], key: string, rawValue: string): void {
  const content = readRawConfig();
  const patched = applyTomlPatch(content, sectionPath, key, rawValue);
  fs.writeFileSync(CONFIG_PATH, patched, "utf-8");
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
