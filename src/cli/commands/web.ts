/**
 * CLI 命令: web
 *
 * 管理 Dashboard Web 服务。
 *
 * 子命令:
 *   web info          显示当前访问地址（本地 IP + Wi-Fi IP + 端口 + token）
 *   web token         刷新 token（生成新随机 token 并写入配置）
 *   web token <value> 手动设置指定 token
 */

import * as os from "node:os";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import { parse as parseToml } from "smol-toml";
import { bold, dim, green, red, cyan, yellow, section, closeRl } from "../ui.js";
import { CONFIG_PATH, patchTomlField } from "../../config/writer.js";

export const subcommands = ["info", "token", "help"] as const;
export const description = "管理 Dashboard Web 访问（地址、token）";
export const usage = `tinyclaw web <subcommand> [args]

子命令:
  info              显示所有可访问的 URL（本地 IP + Wi-Fi IP + 端口 + token）
  token             生成新随机 token 并写入配置（重启后生效）
  token <value>     手动设置指定 token（重启后生效）

示例:
  tinyclaw web info
  tinyclaw web token
  tinyclaw web token mySecretToken123`;

// ── 读取当前 web 配置 ─────────────────────────────────────────────────────────

interface WebCfg {
  enabled: boolean;
  port: number;
  token?: string;
}

function readWebCfg(): WebCfg {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return { enabled: false, port: 4096 };
    const raw = parseToml(fs.readFileSync(CONFIG_PATH, "utf-8")) as Record<string, unknown>;
    const w = (raw["web"] ?? {}) as Record<string, unknown>;
    return {
      enabled: Boolean(w["enabled"] ?? false),
      port:    typeof w["port"] === "number" ? (w["port"] as number) : 4096,
      ...(typeof w["token"] === "string" ? { token: w["token"] as string } : {}),
    };
  } catch {
    return { enabled: false, port: 4096 };
  }
}

// ── 获取本机 IP 列表 ──────────────────────────────────────────────────────────

interface IfaceInfo {
  name: string;
  address: string;
  label: string;
}

function getLocalIPs(): IfaceInfo[] {
  const result: IfaceInfo[] = [];
  const ifaces = os.networkInterfaces();

  for (const [name, addrs] of Object.entries(ifaces)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family !== "IPv4" || addr.internal) continue;

      // 根据网卡名猜测类型
      const n = name.toLowerCase();
      let label = "局域网";
      if (n.includes("wlan") || n.includes("wifi") || n.includes("wlp") || n.includes("wl0") || n.includes("en0")) {
        label = "Wi-Fi";
      } else if (n.includes("eth") || n.includes("enp") || n.includes("eno") || n.includes("em")) {
        label = "有线";
      } else if (n.includes("tailscale") || n.includes("tun") || n.includes("vpn")) {
        label = "VPN";
      }

      result.push({ name, address: addr.address, label });
    }
  }

  // 回环 localhost 也加上
  result.push({ name: "lo", address: "127.0.0.1", label: "本机" });
  return result;
}

// ── 构造带 token 的 URL ───────────────────────────────────────────────────────

function buildUrl(host: string, port: number, token?: string): string {
  const base = `http://${host}:${port}/`;
  return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}

// ── 子命令: info ──────────────────────────────────────────────────────────────

function cmdInfo(): void {
  const cfg = readWebCfg();
  section("Dashboard Web 访问信息");

  if (!cfg.enabled) {
    console.log(yellow("  ⚠ Dashboard 未启用") + dim("  (在 config.toml 设置 [web] enabled = true)"));
    console.log();
  }

  // 状态行
  console.log(`  状态   ${cfg.enabled ? green("已启用") : red("未启用")}`);
  console.log(`  端口   ${bold(String(cfg.port))}`);
  if (cfg.token) {
    console.log(`  Token  ${dim(cfg.token)}`);
  } else {
    console.log(`  Token  ${yellow("未设置（无需认证）")}`);
  }
  console.log();

  // 所有可访问 URL
  const ifaces = getLocalIPs();
  if (!ifaces.length) {
    console.log(dim("  未检测到网络接口"));
  } else {
    console.log(bold("  可访问地址："));
    for (const iface of ifaces) {
      const url = buildUrl(iface.address, cfg.port, cfg.token);
      const tag = cyan(`[${iface.label} / ${iface.name}]`);
      console.log(`    ${tag.padEnd(30)}  ${bold(url)}`);
    }
  }

  console.log();
  if (cfg.token) {
    console.log(dim("  提示：首次访问带 ?token= 后浏览器自动保存 cookie，后续无需重复输入"));
    console.log(dim("  使用 tinyclaw web token 可刷新 token（重启后生效）"));
  }
}

// ── 子命令: token ─────────────────────────────────────────────────────────────

function cmdToken(args: string[]): void {
  const newToken = args[0]?.trim() || crypto.randomBytes(24).toString("hex");

  try {
    patchTomlField(["web"], "token", JSON.stringify(newToken));
    section("Token 已更新");
    console.log(`  新 Token  ${bold(newToken)}`);
    console.log();
    console.log(dim("  配置已写入 config.toml，重启 tinyclaw 后生效。"));
    console.log(dim("  旧 token cookie 将自动失效，需用新 URL 重新访问。"));
    console.log();

    // 读取当前端口，打印新 URL
    const cfg = readWebCfg();
    const ifaces = getLocalIPs();
    if (ifaces.length) {
      console.log(bold("  新访问地址："));
      for (const iface of ifaces) {
        const url = buildUrl(iface.address, cfg.port, newToken);
        const tag = cyan(`[${iface.label} / ${iface.name}]`);
        console.log(`    ${tag.padEnd(30)}  ${url}`);
      }
    }
  } catch (e) {
    console.error(red(`写入失败: ${String(e)}`));
    process.exit(1);
  }
}

// ── 入口 ──────────────────────────────────────────────────────────────────────

export async function run(args: string[]): Promise<void> {
  const sub = args[0]?.toLowerCase();

  if (!sub || sub === "info") {
    cmdInfo();
    closeRl();
    return;
  }

  if (sub === "token") {
    cmdToken(args.slice(1));
    closeRl();
    return;
  }

  if (sub === "help" || sub === "--help" || sub === "-h") {
    console.log(usage);
    closeRl();
    return;
  }

  console.error(red(`未知子命令: ${sub}`));
  console.error(dim("用法: tinyclaw web info | token [value]"));
  process.exit(1);
}
