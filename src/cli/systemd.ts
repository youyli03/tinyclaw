/**
 * systemd user unit 探测（CLI 共用）
 *
 * tinyclaw 有两种运行方式，CLI 必须能分辨，否则会给出误导性的提示：
 *
 * | 启动方式 | 产出 | 日志去向 |
 * |---|---|---|
 * | `systemctl --user start tinyclaw`（生产用法） | systemd 守护 | **journal**（`journalctl --user -u tinyclaw`） |
 * | `tinyclaw start`（旧的自拉起） | detached 进程 | `~/.tinyclaw/service.log` |
 *
 * 历史坑：`tinyclaw logs` 只 tail `service.log`，而服务是 systemd 起的 ——
 * 于是 `logs -f` 永远没有输出（那个文件是空的），用户只能去翻 journal。
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";

/** systemd user unit 名（对应 ~/.config/systemd/user/tinyclaw.service） */
export const SYSTEMD_UNIT = "tinyclaw.service";

export type UnitState = "active" | "activating" | "reloading" | "inactive" | "failed" | "unknown";

function systemctl(args: string[], timeout = 5_000): string | null {
  try {
    return execFileSync("systemctl", ["--user", ...args], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout,
    }).trim();
  } catch (err) {
    // `is-active` 对 inactive/failed 也返回非 0，但 stdout 里就是答案 —— 别丢掉它
    const stdout = (err as { stdout?: string | Buffer }).stdout;
    const text = typeof stdout === "string" ? stdout : stdout?.toString("utf-8");
    return text && text.trim().length > 0 ? text.trim() : null;
  }
}

/** 查询 unit 当前状态；systemd 不可用或 unit 不存在时返回 `unknown` */
export function systemdUnitState(unit = SYSTEMD_UNIT): UnitState {
  const out = systemctl(["is-active", unit]);
  if (out === null) return "unknown";
  const state = out.toLowerCase();
  if (
    state === "active" ||
    state === "activating" ||
    state === "reloading" ||
    state === "inactive" ||
    state === "failed"
  ) {
    return state;
  }
  return "unknown";
}

/** unit 是否由 systemd 托管（存在 unit 文件） */
export function systemdUnitPath(unit = SYSTEMD_UNIT): string | null {
  const out = systemctl(["show", unit, "-p", "FragmentPath", "--value"]);
  return out && out.length > 0 ? out : null;
}

/**
 * 服务已运行多久（如 "14min" / "2h 13min"）；取不到返回 null。
 *
 * ⚠️ 用 **monotonic** 时间戳 + `/proc/uptime` 相减，不要 `new Date(ActiveEnterTimestamp)`：
 * systemd 打印的是 `Fri 2026-09-11 23:25:59 CST`，而 V8 对 `CST` 的时区解释与本机（UTC+8）不一致，
 * 会算出负值 → 被 clamp 成 "0min"。
 */
export function systemdUptimeText(unit = SYSTEMD_UNIT): string | null {
  const mono = systemctl(["show", unit, "-p", "ActiveEnterTimestampMonotonic", "--value"]);
  if (!mono || mono === "0") return null;
  const startedMicros = Number(mono);
  if (!Number.isFinite(startedMicros) || startedMicros <= 0) return null;

  let bootSecs: number;
  try {
    bootSecs = Number(fs.readFileSync("/proc/uptime", "utf-8").split(/\s+/)[0]);
  } catch {
    return null; // 非 Linux：拿不到 monotonic 基准，宁可不显示
  }
  if (!Number.isFinite(bootSecs)) return null;

  const secs = Math.max(0, Math.floor(bootSecs - startedMicros / 1_000_000));
  const d = Math.floor(secs / 86400);
  const h = Math.floor((secs % 86400) / 3600);
  const m = Math.floor((secs % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}min`;
  if (m > 0) return `${m}min`;
  return `${secs}s`;
}

/** 该机器上能否读 journal（journalctl 可用） */
export function journalctlAvailable(): boolean {
  try {
    execFileSync("journalctl", ["--version"], { stdio: "ignore", timeout: 3_000 });
    return true;
  } catch {
    return false;
  }
}
