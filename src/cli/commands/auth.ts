/**
 * CLI 命令：auth
 *
 * 子命令：
 *   auth github         重新运行 GitHub Device Flow OAuth（Copilot token）
 *   auth status         检查当前 GitHub token 是否有效
 */

import { bold, dim, green, red, yellow, section } from "../ui.js";
import { loadSavedGitHubToken } from "../../llm/copilotSetup.js";
import { getCopilotToken } from "../../llm/copilot.js";

// ── 子命令 ────────────────────────────────────────────────────────────────────

async function cmdGithub(): Promise<void> {
  console.log(`\n${bold("GitHub Copilot 重新授权")}`);
  console.log(dim("将启动 Device Flow OAuth，需要在浏览器中完成操作\n"));

  // 清理内存缓存（让 copilot.ts 重新走授权流程）
  // 直接调用 setup，强制重走 Device Flow
  const { runCopilotSetup } = await import("../../llm/copilotSetup.js");
  try {
    const token = await runCopilotSetup();
    if (token) {
      console.log(`\n${green("✓")} GitHub token 授权成功`);
    }
  } catch (e) {
    console.error(red(`授权失败：${e}`));
  }
}

async function cmdStatus(): Promise<void> {
  section("GitHub Token 状态");

  const saved = loadSavedGitHubToken();
  if (saved) {
    const masked = saved.slice(0, 8) + "…" + saved.slice(-4);
    console.log(`${green("✓")} 已保存 Token：${dim(masked)}`);

    // 尝试换取 Copilot token 验证有效性
    process.stdout.write("  验证 Copilot API 可达性……");
    try {
      await getCopilotToken(saved);
      console.log(` ${green("有效")}`);
    } catch (e) {
      console.log(` ${red("无效")}`);
      console.log(dim(`  原因：${e}`));
      console.log(yellow("  请运行 `auth github` 重新授权"));
    }
  } else {
    console.log(yellow("未找到已保存的 GitHub Token"));
    console.log(dim("  · 如已配置 `githubToken = \"gh_cli\"`，请确认 `gh auth login` 已完成"));
    console.log(dim("  · 或运行 `auth github` 通过 Device Flow 授权"));
  }
}

// ── 帮助 ──────────────────────────────────────────────────────────────────────

function printHelp(): void {
  console.log(`
${bold("用法：")}
  auth github     重新执行 GitHub Device Flow OAuth
  auth status     检查当前 token 有效性
`);
}

// ── 命令入口 ──────────────────────────────────────────────────────────────────

export const description = "认证管理：GitHub Copilot token 授权与状态检查";
export const usage = "auth <github|status>";

export async function run(args: string[]): Promise<void> {
  const sub = args[0] ?? "status";

  switch (sub) {
    case "github":  return cmdGithub();
    case "status":  return cmdStatus();
    case "--help":
    case "-h":
    case "help":    printHelp(); return;
    default:
      console.error(red(`未知子命令 "${sub}"`));
      printHelp();
  }
}
