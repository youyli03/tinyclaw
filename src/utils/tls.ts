/**
 * Linux TLS 工具
 *
 * Bun 使用自己的 TLS 栈（BoringSSL），在 Linux 上不会自动扫描系统 CA 证书目录，
 * 需调用方通过 `fetch(url, { tls: { ca } })` 显式传入。
 * Node.js 的 undici fetch 会自动使用系统 CA，无需额外注入。
 * 本模块提供 `withCA()` 辅助函数，在 Bun 下将系统 CA 注入任意 fetch RequestInit。
 */

import { readFileSync, existsSync } from "fs";

const CA_CANDIDATES = [
  "/etc/ssl/certs/ca-certificates.crt",  // Debian / Ubuntu
  "/etc/pki/tls/certs/ca-bundle.crt",    // RHEL / CentOS
  "/etc/ssl/ca-bundle.pem",              // openSUSE
  "/etc/ssl/cert.pem",                   // Alpine / macOS
];

let _systemCA: string | null | undefined; // undefined=未初始化, null=找不到

function systemCA(): string | undefined {
  if (_systemCA !== undefined) return _systemCA ?? undefined;
  for (const p of CA_CANDIDATES) {
    if (existsSync(p)) {
      _systemCA = readFileSync(p, "utf-8");
      return _systemCA;
    }
  }
  _systemCA = null;
  return undefined;
}

/** 返回系统根 CA 证书内容（供 undici Agent 等使用）*/
export function getSystemCA(): string | undefined {
  return systemCA();
}

/** 将系统 CA 注入 fetch options（仅 Bun 需要，Node.js undici 自动使用系统 CA） */
export function withCA(init?: RequestInit): RequestInit {
  // Node.js 的 undici fetch 自动使用系统 CA，无需注入
  if (!process.versions.bun) return init ?? {};
  const ca = systemCA();
  if (!ca) return init ?? {};
  return { ...init, tls: { ca } } as RequestInit;
}
