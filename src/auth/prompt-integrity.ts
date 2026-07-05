import * as fs from "node:fs";
import * as crypto from "node:crypto";
import { getDataFile } from "../config/loader.js";
import type { PromptIntegrityConfig } from "../config/schema.js";

/**
 * Prompt 完整性 / 中转站篡改检测。
 *
 * 提供两种独立机制(均默认关闭,由 config [auth.prompt_integrity] 控制):
 *
 * 1. **本地基线(baselineHash)**:对最终 system prompt 做 SHA-256,
 *    与本地基线文件比对。检测 MEM.md / SYSTEM.md 被 prompt 注入持久化篡改。
 *
 * 2. **中转站 canary**:在 system prompt 末尾注入随机 NONCE 隐藏标记,
 *    要求模型在回复末尾原样回显。若中转站(proxy/relay)删/改了 system prompt,
 *    模型收不到 canary 指令 → 回显缺失 → 判定 prompt 在传输中被篡改。
 *
 *    局限:
 *    - 只能检测"改/删指令",无法检测"只窃听不改写"。
 *    - 小模型指令遵循差可能误报,建议先用 mode="warn" 观察。
 *    - 仅对有 text 输出的轮次有效;纯 tool-call 轮次跳过。
 */

export class PromptIntegrityError extends Error {
  constructor(
    message: string,
    public readonly kind: "baseline" | "canary",
    public readonly backend?: string
  ) {
    super(message);
    this.name = "PromptIntegrityError";
  }
}

// ── 本地基线 ────────────────────────────────────────────────────────────────

interface BaselineEntry {
  hash: string;
  /** prompt 前 80 字符样本(便于人工核对) */
  sample: string;
  updatedAt: string;
}

type BaselineFile = Record<string, BaselineEntry>;

function baselinePath(): string {
  return getDataFile("prompt-baseline.json");
}

function loadBaseline(): BaselineFile {
  try {
    const p = baselinePath();
    if (!fs.existsSync(p)) return {};
    return JSON.parse(fs.readFileSync(p, "utf-8")) as BaselineFile;
  } catch {
    return {};
  }
}

function saveBaseline(data: BaselineFile): void {
  try {
    fs.writeFileSync(baselinePath(), JSON.stringify(data, null, 2), { mode: 0o600 });
  } catch (err) {
    console.warn(`[prompt-integrity] 写入基线失败:${err}`);
  }
}

/** 计算 system prompt 的 SHA-256(hex)。 */
export function computePromptHash(prompt: string): string {
  return crypto.createHash("sha256").update(prompt, "utf-8").digest("hex");
}

export interface BaselineVerifyResult {
  /** 是否首次写入基线(首次信任) */
  firstSeen: boolean;
  /** 基线是否一致(firstSeen 时为 true) */
  match: boolean;
  /** 不一致时的旧 hash(便于日志) */
  oldHash?: string;
  newHash: string;
}

/**
 * 校验 system prompt 与本地基线是否一致。
 *
 * - 基线缺失 → 首次信任,写入基线,返回 { firstSeen: true, match: true }。
 * - 一致 → { match: true }。
 * - 不一致 → { match: false, oldHash };**不自动更新基线**(需用户显式 updateBaseline)。
 *
 * @param key    基线键(建议 `<agentId>:<mode>`)
 * @param prompt 最终 system prompt
 */
export function verifyPromptBaseline(key: string, prompt: string): BaselineVerifyResult {
  const newHash = computePromptHash(prompt);
  const baseline = loadBaseline();
  const existing = baseline[key];

  if (!existing) {
    baseline[key] = {
      hash: newHash,
      sample: prompt.slice(0, 80),
      updatedAt: new Date().toISOString(),
    };
    saveBaseline(baseline);
    return { firstSeen: true, match: true, newHash };
  }

  if (existing.hash === newHash) {
    return { firstSeen: false, match: true, newHash };
  }

  return { firstSeen: false, match: false, oldHash: existing.hash, newHash };
}

/** 显式更新基线(用户确认 prompt 变更合法后调用)。 */
export function updateBaseline(key: string, prompt: string): void {
  const baseline = loadBaseline();
  baseline[key] = {
    hash: computePromptHash(prompt),
    sample: prompt.slice(0, 80),
    updatedAt: new Date().toISOString(),
  };
  saveBaseline(baseline);
}

// ── 中转站 canary ────────────────────────────────────────────────────────────

/** canary 标记正则:<!--ic:NONCE--> */
const CANARY_RE = /<!--ic:([0-9a-f]{16})-->/i;

export interface CanaryInjection {
  /** 注入 canary 指令后的 system prompt */
  prompt: string;
  /** 本轮随机 nonce(16 hex) */
  nonce: string;
}

/**
 * 在 system prompt 末尾注入 canary 指令。
 *
 * 指令要求模型在每次回复的**最末尾**附加隐藏标记 `<!--ic:NONCE-->`。
 * 该标记对用户不可见(HTML 注释),仅用于完整性校验。
 */
export function injectCanary(prompt: string): CanaryInjection {
  const nonce = crypto.randomBytes(8).toString("hex"); // 16 hex chars
  const instruction =
    `\n\n## 完整性校验(系统要求)\n` +
    `在你**每次**回复的最末尾,另起一行原样输出以下标记(这是系统完整性校验,用户不可见,请勿省略、勿改动、勿解释):\n` +
    `<!--ic:${nonce}-->`;
  return { prompt: prompt + instruction, nonce };
}

export interface CanaryCheckResult {
  /** 回复中是否含本轮正确 nonce */
  ok: boolean;
  /** 是否检出了一个 canary 标记(无论 nonce 对错) */
  found: boolean;
  /** 检出的 nonce(found 时有值) */
  gotNonce?: string;
}

/**
 * 校验模型回复中是否含本轮正确的 canary 标记。
 *
 * @param content assistant 完整文本回复
 * @param nonce   本轮注入的 nonce
 */
export function checkCanary(content: string, nonce: string): CanaryCheckResult {
  const m = content.match(CANARY_RE);
  if (!m) return { ok: false, found: false };
  const got = (m[1] ?? "").toLowerCase();
  return { ok: got === nonce.toLowerCase(), found: true, gotNonce: got };
}

/** 从最终展示内容中移除 canary 标记(避免泄露给用户)。 */
export function stripCanary(content: string): string {
  return content
    .replace(new RegExp(CANARY_RE.source, "gi"), "")
    .replace(/\n{3,}$/, "\n")
    .trimEnd();
}

// ── 统一入口 ────────────────────────────────────────────────────────────────

/** 配置启用且至少一种机制开启时返回 true。 */
export function isPromptIntegrityActive(cfg: PromptIntegrityConfig | undefined): boolean {
  return !!cfg?.enabled && (cfg.baselineHash || cfg.canary);
}
