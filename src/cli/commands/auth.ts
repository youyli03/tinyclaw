/**
 * CLI 命令：auth
 *
 * 子命令：
 *   auth github         重新运行 GitHub Device Flow OAuth（Copilot token）
 *   auth status         检查当前 GitHub token 是否有效
 *   auth mfa-setup      生成/绑定 TOTP 密钥，终端显示二维码
 */

import { bold, dim, green, red, yellow, cyan, section } from "../ui.js";
import { loadSavedGitHubToken } from "../../llm/copilotSetup.js";
import { getCopilotToken } from "../../llm/copilot.js";
import { setupTOTP } from "../../auth/totp.js";
import { existsSync } from "node:fs";
import { loadConfig, getDataPath } from "../../config/loader.js";

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
  // ── GitHub Token ──────────────────────────────────────────────────────
  section("GitHub Copilot Token");

  const saved = loadSavedGitHubToken();
  if (saved) {
    const masked = saved.slice(0, 8) + "…" + saved.slice(-4);
    console.log(`${green("✓")} 已保存 Token：${dim(masked)}`);
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

  // ── MFA ──────────────────────────────────────────────────────────────
  section("MFA 配置");

  const mfaCfg = loadConfig().auth?.mfa;
  if (!mfaCfg) {
    console.log(dim("未配置 [auth.mfa]，MFA 关闭"));
    console.log(dim("  · 在 config.toml 中添加 [auth.mfa] 并设置 interface = \"totp\" 可启用"));
  } else {
    const iface = mfaCfg.interface ?? "simple";
    console.log(`  interface    = ${cyan(iface)}`);
    console.log(`  timeoutSecs  = ${dim(String(mfaCfg.timeoutSecs ?? 60))}`);
    if (mfaCfg.tools?.length) {
      console.log(`  tools        = ${dim(JSON.stringify(mfaCfg.tools))}`);
    }
    const shellPatterns = mfaCfg.exec_shell_patterns?.patterns;
    if (shellPatterns?.length) {
      console.log(`  exec_shell   = ${dim(JSON.stringify(shellPatterns))}`);
    }

    if (iface === "totp") {
      const { join } = await import("node:path");
      const secretPath = mfaCfg.totpSecretPath ?? join(getDataPath("auth"), "totp.key");
      const bound = existsSync(secretPath);
      console.log(`  TOTP secret  = ${bound
        ? green("✓ 已绑定 (" + secretPath + ")")
        : red("✗ 未绑定 — 请运行 `tinyclaw auth mfa-setup`")}`);
    } else if (iface === "msal") {
      const hasTenant = !!mfaCfg.tenantId && !mfaCfg.tenantId.includes("xxxx");
      const hasClient = !!mfaCfg.clientId && !mfaCfg.clientId.includes("xxxx");
      console.log(`  tenantId     = ${hasTenant ? green("✓ 已设置") : red("✗ 未设置（含占位符）")}`);
      console.log(`  clientId     = ${hasClient ? green("✓ 已设置") : red("✗ 未设置（含占位符）")}`);
    }
  }
  console.log();
}

async function cmdMFASetup(): Promise<void> {
  console.log(`\n${bold("TOTP MFA 绑定")}`);
  console.log(dim("生成 TOTP 密钥并在终端显示二维码\n"));
  try {
    const secretPath = loadConfig().auth?.mfa?.totpSecretPath;
    setupTOTP(secretPath);
    console.log(green("✓ TOTP 绑定完成"));
    console.log(dim("  如需启用，在 config.toml [auth.mfa] 中设置 interface = \"totp\""));
  } catch (e) {
    console.error(red(`绑定失败：${e}`));
  }
}

// ── 帮助 ──────────────────────────────────────────────────────────────────────────────

function printHelp(): void {
  console.log(`
${bold("用法：")}
  auth github      重新执行 GitHub Device Flow OAuth
  auth status      检查当前 token 有效性
  auth mfa-setup   生成/绑定 TOTP 密钥（终端插入 QR 码）
`);
}

// ── 命令入口 ──────────────────────────────────────────────────────────────────

export const description = "认证管理：GitHub Copilot token 授权与 TOTP MFA 绑定";
export const usage = "auth <github|status|mfa-setup>";

export async function run(args: string[]): Promise<void> {
  const sub = args[0] ?? "status";

  switch (sub) {
    case "github":    return cmdGithub();
    case "status":    return cmdStatus();
    case "mfa-setup": return cmdMFASetup();
    case "--help":
    case "-h":
    case "help":    printHelp(); return;
    default:
      console.error(red(`未知子命令 "${sub}"`));
      printHelp();
  }
}
