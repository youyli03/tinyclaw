import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { parse } from "smol-toml";
import { ConfigSchema, type Config } from "./schema.js";

// ~/.tinyclaw/config.toml
const CONFIG_PATH = path.join(os.homedir(), ".tinyclaw", "config.toml");

// config.example.toml 与本文件同仓库根目录
const EXAMPLE_PATH = path.resolve(
  import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname),
  "../../config.example.toml"
);

let cached: Config | null = null;

/**
 * 加载并验证配置。首次调用读取磁盘，后续返回缓存。
 * 配置不合法时打印友好错误并退出进程（fail-fast）。
 */
export function loadConfig(): Config {
  if (cached) return cached;

  if (!fs.existsSync(CONFIG_PATH)) {
    fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
    if (fs.existsSync(EXAMPLE_PATH)) {
      fs.copyFileSync(EXAMPLE_PATH, CONFIG_PATH);
      console.error(
        `[tinyclaw] 配置文件不存在，已自动复制模板到：${CONFIG_PATH}\n` +
          `请编辑该文件填入真实配置后重新启动。`
      );
    } else {
      console.error(
        `[tinyclaw] 配置文件不存在：${CONFIG_PATH}\n` +
          `请复制 config.example.toml 到 ~/.tinyclaw/config.toml 并填入真实配置。`
      );
    }
    process.exit(1);
  }

  let raw: unknown;
  try {
    const content = fs.readFileSync(CONFIG_PATH, "utf-8");
    raw = parse(content);
  } catch (err) {
    console.error(`[tinyclaw] 配置文件解析失败（TOML 语法错误）：\n${err}`);
    process.exit(1);
  }

  const result = ConfigSchema.safeParse(raw);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    console.error(`[tinyclaw] 配置验证失败：\n${issues}`);
    process.exit(1);
  }

  cached = result.data;
  return cached;
}

/**
 * 返回 ~/.tinyclaw 下的子路径，自动创建目录。
 */
export function getDataPath(...segments: string[]): string {
  const dir = path.join(os.homedir(), ".tinyclaw", ...segments);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * 返回 ~/.tinyclaw 下的文件路径（不创建目录）。
 */
export function getDataFile(...segments: string[]): string {
  return path.join(os.homedir(), ".tinyclaw", ...segments);
}

/** 仅在测试中用于重置单例缓存 */
export function _resetConfigCache(): void {
  cached = null;
}
