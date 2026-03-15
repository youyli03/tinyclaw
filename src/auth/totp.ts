/**
 * TOTP MFA — Interface C
 *
 * 一次性绑定：生成 TOTP secret，打印 ASCII 二维码供用户扫码注册到
 * 任意 Authenticator App（Google Authenticator、Microsoft Authenticator 等）。
 *
 * 高危命令验证：用户通过 QQ/终端回复当前 6 位 TOTP 码，后端验证后继续执行。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { TOTP, Secret } from "otpauth";
import qrcode from "qrcode-terminal";
import { getDataPath } from "../config/loader.js";
import { MFAError } from "./mfa.js";

const DEFAULT_SECRET_FILENAME = "totp.key";

function getSecretPath(configuredPath?: string): string {
  return configuredPath ?? path.join(getDataPath("auth"), DEFAULT_SECRET_FILENAME);
}

/**
 * 一次性绑定：生成/读取 TOTP secret，在终端打印 QR 码。
 * 若 secret 文件已存在则直接复用（幂等）。
 *
 * @returns  生成的 TOTP URI（otpauth://）
 */
export function setupTOTP(secretPath?: string): string {
  const filePath = getSecretPath(secretPath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  let secret: Secret;
  if (fs.existsSync(filePath)) {
    // 复用已有 secret
    const raw = fs.readFileSync(filePath, "utf-8").trim();
    secret = Secret.fromBase32(raw);
  } else {
    // 生成新 secret
    secret = new Secret({ size: 20 });
    fs.writeFileSync(filePath, secret.base32, { encoding: "utf-8", mode: 0o600 });
  }

  const totp = new TOTP({
    issuer: "tinyclaw",
    label: "tinyclaw MFA",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret,
  });

  const uri = totp.toString();

  // 在终端打印 ASCII QR 码
  console.log("\n扫描以下二维码将 tinyclaw 添加到 Authenticator App：\n");
  qrcode.generate(uri, { small: true });
  console.log(`\n或手动输入密钥（Base32）：${secret.base32}`);
  console.log(`\nSecret 文件：${filePath}\n`);

  return uri;
}

/**
 * 验证用户提供的 6 位 TOTP 码。
 *
 * 支持 ±1 个时间步长（±30 秒）容忍时钟偏差。
 *
 * @throws MFAError  若 secret 未初始化或验证码错误
 */
export function verifyTOTP(code: string, secretPath?: string): boolean {
  const filePath = getSecretPath(secretPath);

  if (!fs.existsSync(filePath)) {
    throw new MFAError(
      "TOTP 未初始化：请先运行 `tinyclaw auth mfa-setup` 进行绑定"
    );
  }

  const raw = fs.readFileSync(filePath, "utf-8").trim();
  const secret = Secret.fromBase32(raw);

  const totp = new TOTP({
    issuer: "tinyclaw",
    label: "tinyclaw MFA",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret,
  });

  // window: 1 = 接受前一个和后一个时间步长（共 3 个窗口，±30 秒）
  const delta = totp.validate({ token: code.replace(/\s/g, ""), window: 1 });
  return delta !== null;
}
