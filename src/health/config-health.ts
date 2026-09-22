/**
 * 配置健康检查（离线项）
 *
 * 目的：`config.toml` 可以"schema 合法但跑不起来"（bwrap 不在、目录不可写、socket 路径过长…）。
 * 这里做**便宜、无副作用、不花 token** 的检查，供三处复用：
 * - 服务启动后自检（配合 `llm-probe.ts` 的在线探测，决定是否回退到 LKG）
 * - CLI `tinyclaw config check`
 * - 未来的 agent 配置工具
 *
 * 刻意**不 import llmRegistry**（CLI 里不该为了自检拉起整个 LLM 栈）；在线探测在 `llm-probe.ts`。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Config } from "../config/schema.js";
import { hasConfigErrors, validateConfigText, type ValidateOptions } from "../config/validate.js";

export type HealthLevel = "ok" | "warn" | "error";

export interface HealthCheck {
  name: string;
  level: HealthLevel;
  /**
   * 该 error 是否属于**确定性配置错**（允许自动回退到 LKG）。
   * 暂时性故障（上游 5xx / 网络抖动）必须为 false —— 否则会把好配置回退掉。
   */
  deterministic: boolean;
  message: string;
  hint?: string;
}

export interface HealthReport {
  ok: boolean;
  /** 存在确定性 error → 允许自动回退（调用方还要满足"配置与 LKG 不同"等条件） */
  rollbackWorthy: boolean;
  checks: HealthCheck[];
}

function check(
  name: string,
  level: HealthLevel,
  message: string,
  opts: { deterministic?: boolean; hint?: string } = {}
): HealthCheck {
  return {
    name,
    level,
    deterministic: opts.deterministic ?? false,
    message,
    ...(opts.hint !== undefined ? { hint: opts.hint } : {}),
  };
}

/** 目录是否可写（不存在时返回 false，由调用方决定 warn 还是 error） */
function isWritableDir(p: string): boolean {
  try {
    fs.accessSync(p, fs.constants.W_OK);
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export interface OfflineHealthOptions extends ValidateOptions {
  cfg: Config;
  /** 配置原文；给了就顺带跑写前校验（复用同一套诊断） */
  rawText?: string;
  /** 运行时目录（默认 `~/.tinyclaw`，测试可注入） */
  runtimeDir?: string;
  /** 配置里声明的 QQBot id 列表（用于自检提示，可选） */
  qqbotIds?: string[];
}

/** 离线健康检查（同步、无网络、无 token 消耗） */
export function runOfflineHealthChecks(opts: OfflineHealthOptions): HealthReport {
  const checks: HealthCheck[] = [];
  const runtimeDir = opts.runtimeDir ?? path.join(os.homedir(), ".tinyclaw");

  // ── 1. 写前校验（语法 / schema / 交叉引用） ──
  if (opts.rawText !== undefined) {
    const v = validateConfigText(opts.rawText, opts);
    if (hasConfigErrors(v.diagnostics)) {
      const first = v.diagnostics.find((d) => d.level === "error");
      checks.push(
        check(
          "config-validation",
          "error",
          `配置未通过校验：${first?.path ?? "(file)"} ${first?.message ?? ""}`.trim(),
          { deterministic: true, ...(first?.hint !== undefined ? { hint: first.hint } : {}) }
        )
      );
    } else {
      const warns = v.diagnostics.filter((d) => d.level === "warn").length;
      checks.push(
        check(
          "config-validation",
          warns > 0 ? "warn" : "ok",
          warns > 0 ? `配置通过校验，但有 ${warns} 条提示` : "配置通过校验"
        )
      );
    }
  }

  // ── 2. 运行时目录可写 ──
  const dirs: Array<[string, string]> = [
    [runtimeDir, "运行时目录"],
    [path.join(runtimeDir, "logs"), "日志目录"],
    [path.join(runtimeDir, "sessions"), "会话目录"],
  ];
  for (const [dir, label] of dirs) {
    if (fs.existsSync(dir)) {
      if (!isWritableDir(dir)) {
        checks.push(
          check(`dir-writable:${label}`, "error", `${label}不可写：${dir}`, {
            deterministic: true,
            hint: `检查属主与权限：chmod u+w ${dir}`,
          })
        );
      } else {
        checks.push(check(`dir-writable:${label}`, "ok", `${label}可写`));
      }
    } else {
      checks.push(
        check(`dir-writable:${label}`, "warn", `${label}不存在（首次运行会创建）：${dir}`)
      );
    }
  }

  // ── 3. 沙箱可用性 vs 配置要求 ──
  if (opts.cfg.sandbox.enabled && opts.cfg.sandbox.execShell === "sandbox") {
    const bwrapCandidates = ["/usr/bin/bwrap", "/usr/local/bin/bwrap", "/bin/bwrap"];
    const bwrap = bwrapCandidates.find((p) => fs.existsSync(p));
    if (bwrap === undefined) {
      const deny = opts.cfg.sandbox.onUnavailable === "deny";
      checks.push(
        check(
          "sandbox-bwrap",
          deny ? "error" : "warn",
          deny
            ? "沙箱要求 onUnavailable=deny，但本机找不到 bwrap → exec_shell 会被一律拒绝"
            : "本机找不到 bwrap（沙箱不可用，按 onUnavailable 降级）",
          {
            deterministic: deny,
            hint: "安装 bubblewrap，或把 [sandbox].execShell 改回 \"host\" / onUnavailable 改为 \"warn\"",
          }
        )
      );
    } else {
      checks.push(check("sandbox-bwrap", "ok", `bwrap 可用：${bwrap}`));
    }
  }

  // ── 4. Unix socket 路径长度（Linux 上限 108 字节，超了服务起不来） ──
  const sockPath = path.join(runtimeDir, "agent.sock");
  if (Buffer.byteLength(sockPath, "utf-8") > 100) {
    checks.push(
      check("ipc-socket-path", "error", `IPC socket 路径过长（${Buffer.byteLength(sockPath)} 字节）：${sockPath}`, {
        deterministic: true,
        hint: "Unix socket 路径上限 108 字节，$HOME 太深时会失败",
      })
    );
  } else {
    checks.push(check("ipc-socket-path", "ok", "IPC socket 路径长度正常"));
  }

  // ── 5. 记忆索引目录（开了 memory 才有意义） ──
  if (opts.cfg.memory.enabled) {
    const memDir = path.join(runtimeDir, "agents");
    checks.push(
      fs.existsSync(memDir)
        ? check("memory-root", "ok", "记忆根目录存在")
        : check("memory-root", "warn", `记忆根目录不存在：${memDir}`)
    );
  }

  const errors = checks.filter((c) => c.level === "error");
  return {
    ok: errors.length === 0,
    rollbackWorthy: errors.some((c) => c.deterministic),
    checks,
  };
}

/** 展示层：健康检查结果 → 可打印行 */
export function formatHealthReport(report: HealthReport): string[] {
  const icon = (l: HealthLevel) => (l === "ok" ? "✅" : l === "warn" ? "⚠️" : "❌");
  const lines = [`## ${report.ok ? "健康检查通过" : "健康检查发现问题"}（${report.checks.length} 项）`];
  for (const c of report.checks) {
    if (c.level === "ok") continue; // 通过项不刷屏，下面单独汇总
    lines.push(`- ${icon(c.level)} ${c.name}: ${c.message}${c.deterministic ? "（确定性错误）" : ""}`);
    if (c.hint !== undefined) lines.push(`  → ${c.hint}`);
  }
  const okCount = report.checks.filter((c) => c.level === "ok").length;
  lines.push(`（通过 ${okCount} 项）`);
  return lines;
}

/** 追加到 `logs/health-YYYY-MM-DD.jsonl`（落盘留证；不依赖任何 connector） */
export function appendHealthLog(report: HealthReport, runtimeDir?: string): string | null {
  const dir = path.join(runtimeDir ?? path.join(os.homedir(), ".tinyclaw"), "logs");
  const d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const file = path.join(dir, `health-${day}.jsonl`);
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.appendFileSync(
      file,
      JSON.stringify({ at: d.toISOString(), ok: report.ok, checks: report.checks }) + "\n",
      "utf-8"
    );
    return file;
  } catch (err) {
    console.warn(`[health] 写健康日志失败：${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}
