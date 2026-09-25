/**
 * 文案索引自检（`npm run test:text-index`）
 *
 * 目的：把"索引自己烂掉"变成红灯，而不是悄悄失效。三项（实现见 `scripts/text-index.ts` 的 `check()`）：
 *  1. 主题 id 唯一 + `canonical` 路径真实存在（防手滑写错文件名）；
 *  2. 每个主题"声明了却 0 命中"的层 = 失败 —— 那正是"漏改文案"的机械信号；
 *  3. `docs/architecture/text-index.md` 与 `TOPICS` 表一致（防 md 与表漂移）。
 *
 * 这里只做一层薄壳：真正逻辑在脚本里（它同时是给人用的 CLI），避免两处维护。
 */
import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

try {
  const out = execFileSync(
    process.execPath,
    ["--import", "tsx/esm", path.join(REPO, "scripts", "text-index.ts"), "--check"],
    { cwd: REPO, encoding: "utf-8" }
  );
  process.stdout.write(out);
  console.log("\n1 passed, 0 failed");
} catch (err) {
  const e = err as { stdout?: string; stderr?: string };
  process.stdout.write(e.stdout ?? "");
  process.stderr.write(e.stderr ?? "");
  console.error("\n0 passed, 1 failed");
  process.exit(1);
}
