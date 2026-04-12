/**
 * 内置 ~/.tinyclaw 配置仓库自动提交调度器（TinyclawSubmitter）
 *
 * 进程启动时自动启动，每 N 小时检查 ~/.tinyclaw 仓库的变更，
 * 将有意义的配置/技能/记忆变更自动提交到 git。
 *
 * 设计原则：
 * - 与 memory-maintenance.ts 相同的内置调度模式，不依赖外部 cron job
 * - 启动时若检测到旧的外部 cron job（ftbg5yiv），自动禁用（不删除）
 * - 用 LLM 分析 git diff，生成 Conventional Commits 格式的 subject + body
 * - 只提交白名单文件，严格排除密钥/日志/workspace/sessions 等
 * - 提交成功后可通过注册的 notifyFn 向指定 QQ session 推送通知
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execSync, spawnSync } from "node:child_process";
import { loadConfig } from "../config/loader.js";
import { updateJob, getJob } from "../cron/store.js";
import { cronScheduler } from "../cron/scheduler.js";
import { llmRegistry } from "../llm/registry.js";
import type { Connector } from "../connectors/base.js";
import type { InboundMessage } from "../connectors/base.js";

const TINYCLAW_DIR = path.join(os.homedir(), ".tinyclaw");

// 旧版外部 cron job ID（启动时自动禁用）
const LEGACY_CRON_JOB_ID = "ftbg5yiv";

// 默认间隔（秒）
const DEFAULT_INTERVAL_SECS = 4 * 60 * 60; // 4小时

// LLM 生成 commit message 时 diff 的最大字符数（避免超 token 限制）
const MAX_DIFF_CHARS = 8000;

// ── 白名单：只提交以下路径（前缀匹配）──────────────────────────────────────────

const ALLOW_PREFIXES = [
  "agents/",       // agent 配置/技能/记忆（workspace 在黑名单里排除）
  "cron/jobs/",    // cron 任务配置
  "config.toml",
  "mcp.toml",
  "memstores.toml",
  "polymarket.toml",
  "access.toml",
  "SYSTEM.md",
  ".gitignore",
];

// ── 黑名单：即使匹配白名单也排除 ─────────────────────────────────────────────

const DENY_PATTERNS = [
  /\/workspace\//,
  /\/sessions\//,
  /\/memory\//,
  /\/logs\//,
  /\/news\//,
  /\/__pycache__\//,
  /\.pyc$/,
  /\/node_modules\//,
  /\.bak/,
  /PLAN\.md$/,
  /codedir$/,
  /codesubmode$/,
  /service\.log$/,
  /\.service_pid$/,
  /agent\.sock$/,
  /\.github_token$/,
  /\/auth\//,
  /\.key$/,
  /secrets\.toml$/,
];

// ── 通知目标配置 ──────────────────────────────────────────────────────────────

export interface NotifyTarget {
  peerId: string;
  type: InboundMessage["type"];  // "c2c" | "group" | "guild" | "dm"
}

/** 从 config.submitter.notify 中读取通知目标列表 */
function loadNotifyTargets(): NotifyTarget[] {
  try {
    const cfg = loadConfig();
    const targets = (cfg as Record<string, unknown> & {
      submitter?: { notify?: Array<{ peerId: string; type: string }> };
    }).submitter?.notify ?? [];
    return targets.map((t) => ({
      peerId: t.peerId,
      type: (t.type as InboundMessage["type"]) ?? "c2c",
    }));
  } catch {
    return [];
  }
}

// ── git 工具函数 ──────────────────────────────────────────────────────────────

function isGitRepo(): boolean {
  try {
    execSync("git rev-parse --is-inside-work-tree", {
      cwd: TINYCLAW_DIR, stdio: "pipe",
    });
    return true;
  } catch { return false; }
}

function getChangedFiles(): string[] {
  try {
    // 使用 -z 以 NUL 字符分隔条目，彻底避免含中文/非ASCII路径的引号+八进制转义问题
    const r = spawnSync("git", ["status", "--porcelain", "-z"], {
      cwd: TINYCLAW_DIR, stdio: "pipe", encoding: "utf-8",
    });
    if (r.status !== 0) return [];
    return r.stdout
      .split("\0")
      .filter(Boolean)
      .map((l) => l.slice(3));  // "XY path" 格式，slice(3) 直接得到原始路径（无引号）
  } catch { return []; }
}

function shouldCommit(relPath: string): boolean {
  for (const p of DENY_PATTERNS) if (p.test(relPath)) return false;
  for (const pfx of ALLOW_PREFIXES) if (relPath === pfx || relPath.startsWith(pfx)) return true;
  return false;
}

/** 获取所有待提交文件的完整 diff 文本（含未跟踪文件内容） */
function buildFullDiff(files: string[]): string {
  const parts: string[] = [];

  // 已跟踪文件的 diff — 用参数数组避免 shell 转义问题
  try {
    const r = spawnSync("git", ["diff", "HEAD", "--", ...files], {
      cwd: TINYCLAW_DIR, stdio: "pipe", encoding: "utf-8",
    });
    if (r.stdout?.trim()) parts.push(r.stdout);
  } catch { /* ignore */ }

  // 未跟踪（新）文件：直接读内容
  for (const f of files) {
    const abs = path.join(TINYCLAW_DIR, f);
    try {
      const stat = spawnSync("git", ["ls-files", "--error-unmatch", f], {
        cwd: TINYCLAW_DIR, stdio: "pipe",
      });
      if (stat.status !== 0) {
        // 未跟踪
        const content = fs.readFileSync(abs, "utf-8").slice(0, 1000);
        parts.push(`=== new file: ${f} ===\n${content}`);
      }
    } catch { /* ignore */ }
  }

  return parts.join("\n\n").slice(0, MAX_DIFF_CHARS);
}

/** 用 LLM 分析 diff，生成 Conventional Commits 格式的 subject + body */
async function generateCommitMessage(files: string[], diffText: string): Promise<string> {
  const fileList = files.map((f) => `- ${f}`).join("\n");

  const SYSTEM = `你是 git commit message 生成器。
根据用户提供的变更文件列表和 diff，生成一条符合 Conventional Commits 规范的提交信息。

格式要求：
第一行（subject）：<type>(<scope>): <简洁中文描述>，不超过72字符
  - type 选：feat / fix / chore / refactor / docs / style
  - scope 选：skills / memory / cron / config / agents（取变更最多的类别）
空行
Body（可选，最多5条 bullet）：
  - 每条描述一个具体变更点，说明改了什么/为什么
  - 用中文，简洁明了

只输出 commit message 本身，不要任何解释、代码块或额外文字。`;

  const USER = `变更文件：\n${fileList}\n\n变更内容（diff）：\n${diffText || "(仅新增文件，无 diff)"}`;

  try {
    const client = llmRegistry.get("summarizer");
    const result = await client.chat([
      { role: "system", content: SYSTEM },
      { role: "user", content: USER },
    ]);
    return result.content.trim();
  } catch (e) {
    console.warn("[tinyclaw-submitter] LLM 生成 commit message 失败，使用 fallback:", e);
    // fallback：简单分类 + 文件列表
    const cats = new Set(files.map((f) => {
      if (f.includes("/skills/")) return "skills";
      if (f.includes("/MEM.md") || f.includes("/ACTIVE.md") || f.includes("/cards/")) return "memory";
      if (f.startsWith("cron/")) return "cron";
      if (f.startsWith("agents/")) return "agents";
      return "config";
    }));
    const mainCat = [...cats][0] ?? "config";
    return `chore(${mainCat}): 自动提交 ${files.length} 处变更\n\n${files.map((f) => `- ${f}`).join("\n")}`;
  }
}

// ── 核心提交流程 ──────────────────────────────────────────────────────────────

export interface SubmitResult {
  committed: boolean;
  commitMessage: string;   // 完整 commit message（含 subject + body）
  subject: string;         // 第一行（用于通知）
  files: string[];
}

export async function runTinyclawSubmit(): Promise<SubmitResult> {
  const noChange: SubmitResult = {
    committed: false,
    commitMessage: "无更改",
    subject: "无更改",
    files: [],
  };

  if (!isGitRepo()) {
    console.log("[tinyclaw-submitter] ~/.tinyclaw 不是 git 仓库，跳过");
    return noChange;
  }

  const allChanged = getChangedFiles();
  const toCommit = allChanged.filter(shouldCommit);

  if (toCommit.length === 0) return noChange;

  // git add 白名单文件 — 用 spawnSync 参数数组，避免含中文路径的 shell 转义问题
  for (const f of toCommit) {
    const r = spawnSync("git", ["add", "--", f], { cwd: TINYCLAW_DIR, stdio: "pipe" });
    if (r.status !== 0) {
      console.warn(`[tinyclaw-submitter] git add failed: ${f}`);
    }
  }

  // 获取 staged diff（add 之后）
  let diffText = "";
  try {
    diffText = execSync("git diff --cached", {
      cwd: TINYCLAW_DIR, stdio: "pipe", encoding: "utf-8",
    }).slice(0, MAX_DIFF_CHARS);
  } catch { /* ignore */ }

  // 如果 staged diff 为空（全是新文件），用 buildFullDiff 补充
  if (!diffText.trim()) {
    diffText = buildFullDiff(toCommit);
  }

  // LLM 生成 commit message
  const commitMessage = await generateCommitMessage(toCommit, diffText);
  const subject = commitMessage.split("\n")[0]!.trim();

  // git commit
  const result = spawnSync("git", ["commit", "-m", commitMessage], {
    cwd: TINYCLAW_DIR, encoding: "utf-8",
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.trim() ?? "";
    if (stderr.includes("nothing to commit")) return noChange;
    const errMsg = `提交失败: ${stderr}`;
    console.error(`[tinyclaw-submitter] ${errMsg}`);
    return { committed: false, commitMessage: errMsg, subject: errMsg, files: toCommit };
  }

  console.log(`[tinyclaw-submitter] committed: ${subject}`);
  return { committed: true, commitMessage, subject, files: toCommit };
}

// ── 调度器 ────────────────────────────────────────────────────────────────────

class TinyclawSubmitterScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private connector: Connector | null = null;

  /**
   * 注册 connector（由 main.ts 调用，在 QQBotConnector 就绪后调用）。
   * 通知目标从 config.submitter.notify 动态读取，无需在此传入。
   */
  setConnector(connector: Connector): void {
    this.connector = connector;
  }

  /** 向 config 中配置的所有目标发送通知 */
  private async notify(message: string): Promise<void> {
    if (!this.connector) return;
    const targets = loadNotifyTargets();
    for (const target of targets) {
      try {
        await this.connector.send(target.peerId, target.type, message);
      } catch (e) {
        console.warn(`[tinyclaw-submitter] 通知发送失败 (${target.peerId}):`, e);
      }
    }
  }

  start(): void {
    const cfg = loadConfig();

    // 禁用旧版外部 cron job（如果存在且启用）
    try {
      const legacyJob = getJob(LEGACY_CRON_JOB_ID);
      if (legacyJob?.enabled) {
        updateJob(LEGACY_CRON_JOB_ID, { enabled: false });
        cronScheduler.reschedule(LEGACY_CRON_JOB_ID);
        console.log("[tinyclaw-submitter] 已自动禁用旧版外部 cron job (ftbg5yiv)，由内置调度器接管");
      }
    } catch { /* 旧 job 不存在时忽略 */ }

    const intervalSecs: number =
      (cfg as Record<string, unknown> & { submitter?: { intervalSecs?: number } })
        .submitter?.intervalSecs ?? DEFAULT_INTERVAL_SECS;

    console.log(`[tinyclaw-submitter] Scheduler started, interval=${intervalSecs / 3600}h`);

    const doRun = async () => {
      try {
        const result = await runTinyclawSubmit();
        if (result.committed) {
          const notice =
            `📦 *.tinyclaw* 自动提交\n` +
            `${result.subject}\n` +
            `\n变更文件 (${result.files.length}):\n` +
            result.files.map((f) => `• ${f}`).join("\n");
          await this.notify(notice);
        }
      } catch (e) {
        console.error("[tinyclaw-submitter] run error:", e);
      }
    };

    // warmup：启动 30s 后执行一次，但仅当距上次 git 提交已超过 intervalSecs 时才触发。
    // 避免进程频繁重启（如 restart_tool 触发的热重载）导致每次启动都立即提交。
    const warmup = setTimeout(() => {
      try {
        const lastCommitTs = execSync(
          `git -C ${JSON.stringify(TINYCLAW_DIR)} log -1 --format=%ct`,
          { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] }
        ).trim();
        const elapsedSecs = lastCommitTs
          ? Date.now() / 1000 - parseInt(lastCommitTs, 10)
          : Infinity;
        if (elapsedSecs >= intervalSecs) {
          void doRun();
        } else {
          console.log(
            `[tinyclaw-submitter] warmup 跳过：距上次提交仅 ${Math.round(elapsedSecs / 60)} 分钟，` +
            `未达 ${intervalSecs / 3600}h 间隔`
          );
        }
      } catch {
        // git log 失败（首次无提交）时仍执行一次
        void doRun();
      }
    }, 30_000);
    if (warmup.unref) warmup.unref();

    // 周期执行
    this.timer = setInterval(() => void doRun(), intervalSecs * 1000);
    if (this.timer.unref) this.timer.unref();
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

export const tinyclawSubmitter = new TinyclawSubmitterScheduler();
