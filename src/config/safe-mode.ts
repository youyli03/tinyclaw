/**
 * SAFE MODE：当"上一份可用配置"（LKG）本身也起不来时的最后一层
 *
 * 背景：`loadConfig()` 是 fail-fast —— 语法/schema 一坏就 `process.exit(1)`，于是"配置坏 + LKG 也坏"
 * （密钥被轮换、盘满、`$HOME` 路径被删）会让服务彻底起不来，只能人工修。这里给它一条"**能起来**"的路：
 *
 * - 开关是 `~/.tinyclaw/.safe_config` 文件（或环境变量 `TINYCLAW_SAFE_CONFIG=1`）
 * - 命中时 `loadConfig()` **不做 fail-fast**，改用"最小可用配置"启动：只保留 `providers` 与 `llm.backends`
 *   （从坏文件里尽力捞），其余段全部用 schema 默认值
 * - 主进程在 safe mode 下**不接 QQBot、不跑 cron/loop、不装配置监听、不提升 LKG**
 *   （否则会把"安全配置"写成新的可用版本，把线索引坏）
 * - 全程大声告警：日志、通知、CLI 都明说"**本次不是用你的 config.toml 启动的**"
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parse } from "smol-toml";
import { ConfigSchema, type Config } from "./schema.js";

/** 安全模式标记文件（存在 = 开启） */
export function safeModeFlagPath(dir?: string): string {
  return path.join(dir ?? path.join(os.homedir(), ".tinyclaw"), ".safe_config");
}

/** 是否处于安全模式（文件标记 或 环境变量） */
export function isSafeModeEnabled(dir?: string): boolean {
  if (process.env["TINYCLAW_SAFE_CONFIG"] === "1") return true;
  try {
    return fs.existsSync(safeModeFlagPath(dir));
  } catch {
    return false;
  }
}

/** 开/关安全模式（写/删标记文件）。返回是否写入成功 */
export function setSafeMode(on: boolean, dir?: string): boolean {
  const p = safeModeFlagPath(dir);
  try {
    if (on) {
      fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 });
      fs.writeFileSync(
        p,
        `# tinyclaw SAFE MODE：服务会忽略 config.toml 里除 providers / llm 之外的段启动\n` +
          `# 开启于 ${new Date().toISOString()}\n` +
          `# 修好 config.toml 后：tinyclaw config safe-mode off && tinyclaw restart\n`,
        { encoding: "utf-8", mode: 0o600 }
      );
    } else if (fs.existsSync(p)) {
      fs.unlinkSync(p);
    }
    return true;
  } catch (err) {
    console.warn(`[safe-mode] 切换失败：${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
}

/**
 * 构造"最小可用配置"：只保留 providers 与 llm.backends（含别名），其余走 schema 默认值。
 *
 * **不会抛错**：坏文件解析不了就退化为"默认后端符号"（服务能起来、IPC/CLI 可用，LLM 调用会失败并报错）。
 */
export function buildSafeConfig(rawText?: string): Config {
  const minimal: Record<string, unknown> = {
    providers: {},
    llm: {},
    // 最小配置**不带特权面**：即使 schema 里 allowDelete / exemptMfa 默认宽松，这里显式收紧。
    // 安全模式下服务仍会跑 IPC/CLI，没必要把"整树可写 / 免 MFA / 真删"一起带起来。
    selfAccess: {
      grantedAgents: [],
      wideWriteAccess: false,
      allowDelete: false,
      exemptMfa: false,
    },
  };
  if (rawText !== undefined) {
    try {
      const raw = parse(rawText) as { providers?: unknown; llm?: unknown };
      if (raw.providers !== undefined) minimal["providers"] = raw.providers;
      if (raw.llm !== undefined) minimal["llm"] = raw.llm;
    } catch {
      /* 连语法都坏了：直接用默认 */
    }
  }
  // 先试"只带 providers/llm"的完整解析（其余段由 schema 默认值补齐）
  const attempt = ConfigSchema.safeParse(minimal);
  if (attempt.success) return attempt.data;

  // 再退一步：LLM 段本身也不合法 → 用 schema 默认值 + 占位后端
  console.warn("[safe-mode] providers/llm 段也无法解析，退化到占位配置（LLM 调用会失败）");
  return ConfigSchema.parse({
    ...minimal,
    providers: {},
    llm: { backends: { daily: { model: "deepseek/deepseek-chat" } } },
  });
}
