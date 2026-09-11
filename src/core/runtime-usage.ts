/**
 * 运行时目录（`~/.tinyclaw`）占用统计 —— "自指"能力的共用内核。
 *
 * 被 `self_status`（报告自身磁盘占用）与 `self_runtime_scan`（规划清理）共用。
 * 纯只读：只做 stat / readdir，不修改任何东西。
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { isRuntimeSecretPath, runtimeRoot } from "../tools/path-guard.js";

export interface DirUsage {
  /** 相对运行时根的路径（根自身为 "."） */
  path: string;
  bytes: number;
  files: number;
}

export interface RuntimeUsage {
  root: string;
  totalBytes: number;
  totalFiles: number;
  /** 顶层条目占用（按大小降序） */
  entries: DirUsage[];
  /** 全局最大的若干文件 */
  biggestFiles: Array<{ path: string; bytes: number; mtimeMs: number }>;
  /** 密钥类条目的**体积合计**（只统计，不暴露路径） */
  secretBytes: number;
  /** 超过阈值的异常大文件（附清理建议文案） */
  cleanupCandidates: CleanupCandidate[];
}

export interface CleanupCandidate {
  path: string;
  bytes: number;
  /** 为什么可以清理 */
  reason: string;
  /** `safe` = 删了不影响运行；`caution` = 需用户确认语义 */
  level: "safe" | "caution";
}

/** 单次遍历允许的最大文件数，防止在超大目录上卡住 */
const MAX_WALK_FILES = 200_000;

/**
 * 一次递归遍历，同时产出：总占用、按 `topLevel` 聚合的占用、最大文件 Top-N。
 *
 * 密钥文件只计入 `secretBytes`，**路径不会出现在任何列表里**。
 */
export function scanRuntime(root = runtimeRoot(), topN = 12): RuntimeUsage {
  const entries = new Map<string, DirUsage>();
  const biggest: Array<{ path: string; bytes: number; mtimeMs: number }> = [];
  let totalBytes = 0;
  let totalFiles = 0;
  let secretBytes = 0;

  const stack: string[] = [root];
  while (stack.length > 0 && totalFiles < MAX_WALK_FILES) {
    const dir = stack.pop()!;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of dirents) {
      const full = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!dirent.isFile()) continue;
      let st: fs.Stats;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      totalFiles++;
      totalBytes += st.size;

      if (isRuntimeSecretPath(full)) {
        secretBytes += st.size;
        continue; // 密钥：只计体积，不进任何清单
      }

      const rel = path.relative(root, full).split(path.sep).join("/");
      const top = rel.includes("/") ? rel.slice(0, rel.indexOf("/")) : rel;
      const agg = entries.get(top) ?? { path: top, bytes: 0, files: 0 };
      agg.bytes += st.size;
      agg.files++;
      entries.set(top, agg);

      biggest.push({ path: rel, bytes: st.size, mtimeMs: st.mtimeMs });
      if (biggest.length > topN * 20) {
        biggest.sort((a, b) => b.bytes - a.bytes);
        biggest.length = topN * 5;
      }
    }
  }

  biggest.sort((a, b) => b.bytes - a.bytes);

  return {
    root,
    totalBytes,
    totalFiles,
    entries: [...entries.values()].sort((a, b) => b.bytes - a.bytes),
    biggestFiles: biggest.slice(0, topN),
    secretBytes,
    cleanupCandidates: findCleanupCandidates(root),
  };
}

/** 判断相对路径是否匹配某个 glob 形态（仅支持 `**` / `*` 两种简单形态） */
function matchesGlob(rel: string, pattern: string): boolean {
  if (pattern.endsWith("/**")) return rel.startsWith(pattern.slice(0, -2));
  if (pattern.startsWith("**/")) return rel.includes("/" + pattern.slice(3));
  if (pattern.includes("*")) {
    const re = new RegExp(`^${pattern.split("*").map(escapeRe).join(".*")}$`);
    return re.test(rel);
  }
  return rel === pattern;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

interface CandidateRule {
  pattern: string;
  reason: string;
  level: "safe" | "caution";
  /** 只报告超过该体积的条目（字节） */
  minBytes?: number;
  minAgeDays?: number;
}

const CANDIDATE_RULES: CandidateRule[] = [
  { pattern: "service.log", reason: "服务日志，可轮转/截断（运行中可直接清空）", level: "safe", minBytes: 10 * 1024 * 1024 },
  { pattern: "cache/**", reason: "缓存目录，删后自动重建", level: "safe", minBytes: 1024 * 1024 },
  { pattern: "tmp/**", reason: "运行时临时目录", level: "safe", minBytes: 1024 * 1024 },
  { pattern: "newsnow/**", reason: "资讯缓存", level: "safe", minBytes: 1024 * 1024 },
  { pattern: "**/*.bak", reason: "备份副本（保留最新一份即可）", level: "safe", minBytes: 1024 * 1024 },
  { pattern: "**/*.jsonl.bak", reason: "会话备份副本", level: "safe", minBytes: 1024 * 1024 },
  { pattern: "cron/**", reason: "cron 运行日志，超过 30 天的可清理", level: "safe", minBytes: 1024 * 1024, minAgeDays: 30 },
  { pattern: "slaves/**", reason: "子 agent 轨迹，超过 30 天的可归档/清理", level: "caution", minBytes: 1024 * 1024, minAgeDays: 30 },
  { pattern: "agents/**/workspace/downloads/**", reason: "下载的素材，确认不再需要后可清理", level: "caution", minBytes: 10 * 1024 * 1024 },
  { pattern: "agents/**/workspace/output/**", reason: "Agent 产出的文件，确认后可清理", level: "caution", minBytes: 10 * 1024 * 1024 },
  { pattern: "agents/**/memory/transcript/**", reason: "逐字层归档，属长期记忆，慎删", level: "caution", minBytes: 10 * 1024 * 1024 },
];

/**
 * 扫描"可以清理"的候选（按目录聚合，附原因与风险等级）。
 *
 * 只做建议，不删任何东西；是否执行由调用方（或被授权的 agent）决定。
 */
export function findCleanupCandidates(root = runtimeRoot()): CleanupCandidate[] {
  const out: CleanupCandidate[] = [];
  const matched = new Set<string>();

  const stack: string[] = [root];
  let scanned = 0;
  while (stack.length > 0 && scanned < MAX_WALK_FILES) {
    const dir = stack.pop()!;
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const dirent of dirents) {
      const full = path.join(dir, dirent.name);
      if (dirent.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!dirent.isFile() || isRuntimeSecretPath(full)) continue;
      scanned++;
      const rel = path.relative(root, full).split(path.sep).join("/");
      let st: fs.Stats;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      for (const rule of CANDIDATE_RULES) {
        if (!matchesGlob(rel, rule.pattern)) continue;
        if (rule.minBytes !== undefined && st.size < rule.minBytes) continue;
        if (rule.minAgeDays !== undefined) {
          const ageDays = (Date.now() - st.mtimeMs) / 86_400_000;
          if (ageDays < rule.minAgeDays) continue;
        }
        // 同一目录下的同规则匹配聚合，避免刷屏
        const key = `${rule.pattern}::${rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : rel}`;
        const existing = out.find((c) => `${c.reason}::${c.path}` === `${rule.reason}::${key}`);
        if (existing) {
          existing.bytes += st.size;
        } else {
          matched.add(key);
          out.push({ path: key, bytes: st.size, reason: rule.reason, level: rule.level });
        }
        break;
      }
    }
  }

  return out.sort((a, b) => b.bytes - a.bytes).slice(0, 25);
}

export const fmtBytes = (n: number): string =>
  n >= 1024 * 1024 * 1024
    ? `${(n / 1024 / 1024 / 1024).toFixed(2)}GB`
    : n >= 1024 * 1024
      ? `${(n / 1024 / 1024).toFixed(1)}MB`
      : n >= 1024
        ? `${(n / 1024).toFixed(1)}KB`
        : `${n}B`;

/** 目录（或文件）占用多少字节 / 多少文件 */
export function measure(target: string): { bytes: number; files: number } {
  let bytes = 0;
  let files = 0;
  const stack = [target];
  while (stack.length > 0 && files < MAX_WALK_FILES) {
    const cur = stack.pop()!;
    let st: fs.Stats;
    try {
      st = fs.statSync(cur);
    } catch {
      continue;
    }
    if (st.isFile()) {
      bytes += st.size;
      files++;
      continue;
    }
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of dirents) stack.push(path.join(cur, d.name));
  }
  return { bytes, files };
}

/** 某个路径是否属于"绝不允许自指工具删除"的保护清单 */
export function isProtectedFromDelete(absPath: string): string | null {
  const root = path.resolve(runtimeRoot());
  const abs = path.resolve(absPath);
  if (abs === root) return "运行时根目录本身不能被删除";
  if (path.basename(abs) === ".git" && path.dirname(abs) === root) {
    return "运行时目录的 .git 是配置备份仓库，删除会丢失历史";
  }
  if (abs === path.join(root, "agents")) return "agents 目录包含全部记忆与会话，不能整体删除";
  return null;
}
