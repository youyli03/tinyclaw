/**
 * 工作区指令段（AGENTS.md / CLAUDE.md 及其 local 覆盖）—— 给 prompt 组装用的薄封装。
 *
 * 语义实现全在 `agents-md.ts`（照 DSH `@deepseek-ai/dsh-agent-instructions` 的实测语义：
 * 向上找项目根、同目录多候选、local 覆盖、trim 去重、字节预算与二分截断、三态探测）。
 * 这里只做三件工程化的事：
 *  1. **只在 code / project 模式注入**（chat 模式没有工作区概念，不注入，避免白烧上下文）；
 *  2. **按内容指纹做缓存**：每轮都渲染会重复读几十 KB，这里用「候选文件的 path+mtime+size」
 *     做指纹，指纹没变就复用上一轮的渲染结果（指纹本身只是一堆 stat，成本可忽略）；
 *  3. **绝不抛异常**：任何失败都降级为"不注入"，不能因为读不到 AGENTS.md 就让整个 agent 起不来。
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createHash } from "node:crypto";

import {
  DEFAULT_INSTRUCTION_CONFIG,
  scopeChain,
  renderWorkspaceInstructions,
  type InstructionConfig,
} from "./agents-md.js";
import { runtimeRoot } from "../tools/path-guard.js";

/**
 * 一次注入的 UTF-8 字节上限。
 * 与 DSH 生产 profile 的取值一致（`dsh-base/cordis.patch.yml` 里 `agent-instructions` 配的
 * 就是 `maxBytes: 65536`），不自己发明。
 */
export const WORKSPACE_INSTRUCTION_MAX_BYTES = 65_536;

/** 用户全局指令文件所在目录：tinyclaw 用运行时目录（即 `~/.tinyclaw/AGENTS.md`） */
function userGlobalDir(): string {
  try {
    return runtimeRoot();
  } catch {
    return path.join(os.homedir(), ".tinyclaw");
  }
}

function instructionConfig(): InstructionConfig {
  return {
    ...DEFAULT_INSTRUCTION_CONFIG,
    dshHome: userGlobalDir(),
    // 预算算的是「注入进 prompt 的那段字符串」本身，前面还要补 "\n\n" 两个字节，
    // 所以这里先扣掉，保证「注入段 ≤ WORKSPACE_INSTRUCTION_MAX_BYTES」是硬不变量。
    maxBytes: WORKSPACE_INSTRUCTION_MAX_BYTES - 2,
  };
}

/**
 * 指纹：候选文件的**内容哈希**（+ 存在性）。
 *
 * ⚠️ 这里**不用 mtime**：本机（RK3588 / 该文件系统）实测，对同一文件连续两次写入
 * `statSync(..., {bigint:true}).mtimeNs` **完全相同**（1789219717043616105 vs 1789219717043616105），
 * 即毫秒/纳秒时间戳都分辨不出"刚刚被改写"。用时间戳做指纹会**漏掉更新**，
 * 表现为"改了 AGENTS.md 但 agent 还按旧指令干活"，而且极难排查。
 * 所以老老实实读内容做 sha1 —— 本地 48 KB 的读取+哈希不到 1 ms，
 * 相对于一次 LLM 往返完全可忽略；缓存省下的是**渲染**（预算/截断/字符串拼装）那部分工作。
 */
function fingerprint(cfg: InstructionConfig, cwd: string): string {
  const parts: string[] = [];
  for (const scope of scopeChain(cfg, cwd)) {
    for (const name of [...cfg.instructionFileCandidates, ...cfg.localInstructionFileCandidates]) {
      const abs = path.join(scope.dir, name);
      try {
        const buf = fs.readFileSync(abs);
        parts.push(`${abs}:${buf.length}:${createHash("sha1").update(buf).digest("hex")}`);
      } catch {
        parts.push(`${abs}:-`);
      }
    }
  }
  return parts.join("|");
}

interface CacheEntry {
  fp: string;
  section: string;
}
const cache = new Map<string, CacheEntry>();

/**
 * 渲染工作区指令段，返回可直接拼进 system prompt 的字符串（无内容时返回空串）。
 *
 * @param cwd 会话工作目录（项目根由它向上探测）
 */
export function buildWorkspaceInstructionsSection(cwd: string): string {
  try {
    if (!cwd) return "";
    const cfg = instructionConfig();
    const fp = fingerprint(cfg, cwd);
    const hit = cache.get(cwd);
    if (hit && hit.fp === fp) return hit.section;

    const rendered = renderWorkspaceInstructions(scopeChain(cfg, cwd), cfg);
    // 有意与 DSH 不同：DSH 在"一个文件都没有"时仍会渲染只含 intro 的空基线（约 270 B），
    // tinyclaw 里那纯属噪音（chat/无 AGENTS.md 的目录都会中招），所以零文件时不注入。
    const section =
      rendered.included.length > 0 ? `\n\n${rendered.text}` : "";
    cache.set(cwd, { fp, section });
    return section;
  } catch (err) {
    // 兜底：工作区指令永远不能阻断 agent 启动
    console.warn("[instructions] 工作区指令渲染失败，本次不注入：", err instanceof Error ? err.message : err);
    return "";
  }
}

/** 清空缓存（探针/测试用；正常运行时靠指纹自动失效） */
export function resetWorkspaceInstructionCache(): void {
  cache.clear();
}
