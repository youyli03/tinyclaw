/**
 * GitHub Copilot token 首次引导流程（Device Authorization Flow）
 *
 * 实现 RFC 8628 OAuth 2.0 Device Authorization Grant：
 * 1. 向 GitHub 请求设备码和用户码
 * 2. 显示短码（如 ABCD-1234）并打开浏览器到 https://github.com/login/device
 * 3. 后台轮询，用户在浏览器授权后自动获取 access_token
 * 4. 将 token 写回 ~/.tinyclaw/config.toml
 *
 * 使用 VS Code GitHub Authentication 扩展的 OAuth App（与 vscode-copilot-chat 相同）。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execSync } from "child_process";
import { parse, stringify } from "smol-toml";

// VS Code GitHub Authentication 扩展的 OAuth App（public client_id，无 secret）
// 同一个 app 被 vscode-copilot-chat 用于设备授权流程
const CLIENT_ID = "01ab8ac9400c4e429b23";
const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
// Copilot API 需要 read:user 即可换取 Copilot token
const SCOPE = "read:user";

const CONFIG_PATH = path.join(os.homedir(), ".tinyclaw", "config.toml");

// ── 浏览器打开 ────────────────────────────────────────────────────────────────

function openBrowser(url: string): void {
  try {
    if (process.platform === "linux") {
      execSync(`xdg-open "${url}"`, { stdio: "ignore" });
    } else if (process.platform === "darwin") {
      execSync(`open "${url}"`, { stdio: "ignore" });
    } else if (process.platform === "win32") {
      execSync(`start "" "${url}"`, { stdio: "ignore" });
    }
  } catch {
    // 忽略打开失败，用户可手动复制链接
  }
}

// ── 写回 config.toml ──────────────────────────────────────────────────────────

/**
 * 将 token 写入 config.toml 中所有 provider=copilot 且 githubToken 为占位符的 backend。
 */
export function persistTokenToConfig(token: string): void {
  if (!fs.existsSync(CONFIG_PATH)) return;

  const content = fs.readFileSync(CONFIG_PATH, "utf-8");
  let doc: Record<string, unknown>;
  try {
    doc = parse(content) as Record<string, unknown>;
  } catch {
    return;
  }

  let changed = false;
  const backends = (
    (doc["llm"] as Record<string, unknown> | undefined)?.["backends"] as
      | Record<string, unknown>
      | undefined
  );
  if (!backends) return;

  for (const [name, backend] of Object.entries(backends)) {
    const b = backend as Record<string, unknown> | undefined;
    if (!b || b["provider"] !== "copilot") continue;
    const src = b["githubToken"];
    if (src === "gh_cli" || src === "env" || src == null) {
      backends[name] = { ...b, githubToken: token };
      changed = true;
    }
  }

  if (!changed) return;

  try {
    fs.writeFileSync(CONFIG_PATH, stringify(doc), "utf-8");
    console.log(`[tinyclaw] ✓ Token 已写入 ${CONFIG_PATH}`);
  } catch (e) {
    console.warn(`[tinyclaw] 警告：无法写入配置文件：${e}`);
  }
}

// ── Device Flow 接口类型 ──────────────────────────────────────────────────────

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;   // 秒
  interval: number;     // 轮询间隔（秒）
}

interface TokenPollResponse {
  access_token?: string;
  error?: string;
  error_description?: string;
}

// ── Device Flow 主流程 ────────────────────────────────────────────────────────

/**
 * 通过 GitHub OAuth Device Flow 授权并返回 access_token。
 * 成功后自动将 token 写回 config.toml。
 */
export async function runCopilotSetup(): Promise<string> {
  console.log("\n" + "─".repeat(60));
  console.log("  GitHub Copilot 授权（Device Flow）");
  console.log("─".repeat(60) + "\n");

  // 1. 请求设备码
  const codeResp = await fetch(DEVICE_CODE_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID, scope: SCOPE }),
  });

  if (!codeResp.ok) {
    throw new Error(`GitHub Device Flow 初始化失败：${codeResp.status} ${codeResp.statusText}`);
  }

  const codes = (await codeResp.json()) as DeviceCodeResponse;

  // 2. 显示验证码并打开浏览器
  console.log(`请在浏览器中访问：\n  ${codes.verification_uri}\n`);
  console.log(`然后输入验证码：\n\n  ✦  ${codes.user_code}  ✦\n`);
  console.log("正在打开浏览器……（若未自动打开，请手动复制上方链接）\n");

  // 短暂延迟让控制台信息先打印完再开浏览器
  await new Promise((r) => setTimeout(r, 500));
  openBrowser(codes.verification_uri);

  // 3. 轮询等待用户在浏览器完成授权
  console.log("等待授权中……（在浏览器完成操作后将自动继续）");

  const intervalMs = (codes.interval ?? 5) * 1000;
  let remaining = codes.expires_in;

  while (remaining > 0) {
    await new Promise((r) => setTimeout(r, intervalMs));
    remaining -= codes.interval ?? 5;

    const pollResp = await fetch(ACCESS_TOKEN_URL, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: CLIENT_ID,
        device_code: codes.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });

    const data = (await pollResp.json()) as TokenPollResponse;

    if (data.access_token) {
      console.log("\n✓ 授权成功！\n");
      persistTokenToConfig(data.access_token);
      return data.access_token;
    }

    // authorization_pending → 继续等待；slow_down → 延迟更长
    if (data.error === "slow_down") {
      await new Promise((r) => setTimeout(r, 5000));
    } else if (data.error && data.error !== "authorization_pending") {
      throw new Error(`授权失败：${data.error} - ${data.error_description ?? ""}`);
    }
  }

  throw new Error("授权超时，请重新启动 tinyclaw 再试");
}
