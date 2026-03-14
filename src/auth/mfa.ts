import {
  PublicClientApplication,
  type Configuration,
  type AuthenticationResult,
  type DeviceCodeRequest,
} from "@azure/msal-node";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig } from "../config/loader.js";
import { getDataPath } from "../config/loader.js";

// MFA 鉴权所需的 scope（Azure AD 基础 scope，用于触发 MFA 推送）
const MFA_SCOPES = ["User.Read"];

let pca: PublicClientApplication | null = null;

function getMSALCachePath(): string {
  return path.join(getDataPath("auth"), "msal-cache.json");
}

function getPCA(): PublicClientApplication {
  if (pca) return pca;

  const cfg = loadConfig().auth.mfa;
  if (!cfg) {
    throw new Error(
      "MFA 未配置：请在 config.toml 中填入 [auth.mfa] tenantId 和 clientId（Azure AD App Registration）"
    );
  }
  const cachePath = getMSALCachePath();

  // 持久化 token 缓存：读取已有 cache
  let cacheData = "";
  if (fs.existsSync(cachePath)) {
    cacheData = fs.readFileSync(cachePath, "utf-8");
  }

  const msalConfig: Configuration = {
    auth: {
      clientId: cfg.clientId,
      authority: `https://login.microsoftonline.com/${cfg.tenantId}`,
    },
    cache: {
      cachePlugin: {
        beforeCacheAccess: async (context) => {
          if (cacheData) context.tokenCache.deserialize(cacheData);
        },
        afterCacheAccess: async (context) => {
          if (context.cacheHasChanged) {
            const updated = context.tokenCache.serialize();
            fs.mkdirSync(path.dirname(cachePath), { recursive: true });
            fs.writeFileSync(cachePath, updated, "utf-8");
            cacheData = updated;
          }
        },
      },
    },
  };

  pca = new PublicClientApplication(msalConfig);
  return pca;
}

/**
 * 触发 Microsoft MFA number-matching 推送，等待用户在手机上确认。
 *
 * 流程：
 * 1. 先尝试静默刷新已缓存的 token（已认证过则无需再次推送）
 * 2. 否则发起 Device Code Flow，控制台/QQ 消息显示提示码
 *    （Microsoft Authenticator 会推送同一数字，用户点击确认）
 * 3. 超时或拒绝则 throw MFAError
 *
 * @param displayFn  展示 MFA 提示信息的回调（用于 QQBot / 终端双模式）
 */
export async function requireMFA(
  displayFn: (message: string) => void = console.log
): Promise<AuthenticationResult> {
  const cfg = loadConfig().auth.mfa!;  // getPCA() 已确保 mfa 已配置
  const app = getPCA();

  // 尝试静默获取（缓存中有有效 token 时直接返回）
  const accounts = await app.getTokenCache().getAllAccounts();
  if (accounts.length > 0 && accounts[0]) {
    try {
      const silent = await app.acquireTokenSilent({
        account: accounts[0],
        scopes: MFA_SCOPES,
        forceRefresh: false,
      });
      if (silent) return silent;
    } catch {
      // 静默失败，继续走 Device Code Flow
    }
  }

  // Device Code Flow（触发 number-matching 推送）
  return new Promise((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      reject(new MFAError("MFA 确认超时，操作已取消"));
    }, cfg.timeoutSecs * 1000);

    const request: DeviceCodeRequest = {
      scopes: MFA_SCOPES,
      deviceCodeCallback: (response) => {
        // response.message 包含：「打开 https://microsoft.com/devicelogin 并输入 XXXXX」
        // 同时 Microsoft Authenticator 会推送 number-matching 通知
        displayFn(`🔐 需要 MFA 验证\n${response.message}`);
      },
    };

    app
      .acquireTokenByDeviceCode(request)
      .then((result) => {
        clearTimeout(timeoutHandle);
        if (!result) {
          reject(new MFAError("MFA 认证失败：未获取到 token"));
          return;
        }
        resolve(result);
      })
      .catch((err: unknown) => {
        clearTimeout(timeoutHandle);
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("authorization_declined") || msg.includes("access_denied")) {
          reject(new MFAError("用户拒绝了 MFA 认证，操作已取消"));
        } else {
          reject(new MFAError(`MFA 认证失败：${msg}`));
        }
      });
  });
}

export class MFAError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MFAError";
  }
}

/** 清除本地 token 缓存（注销用） */
export function clearMFACache(): void {
  const cachePath = getMSALCachePath();
  if (fs.existsSync(cachePath)) {
    fs.unlinkSync(cachePath);
  }
  pca = null;
}
