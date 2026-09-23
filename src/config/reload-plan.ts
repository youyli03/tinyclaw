/**
 * 配置变更分级：`hot` / `soft` / `restart`
 *
 * 为什么必须分级而不是"一律热重载"：
 * - 全仓有 ~94 处 `loadConfig()` 调用，**绝大多数是"用时现读"** → 换掉缓存即可生效（`hot`）
 * - 但少数模块**启动时取一次存进字段**（`llmRegistry` 的后端客户端、`initLLMConcurrency` 的限流器、
 *   QQBot connector、`web.port` 的监听 socket）→ 换缓存对它们没用，必须重新 init（`soft`）或重启（`restart`）
 * - 还有一类（`sandbox.enabled` / `execShell`）会在**同一次工具调用里被多处读取**，热改会出现"半新半旧"的
 *   进程内不一致 → 宁可归 `restart`
 *
 * 原则：**证明不了"改动会立刻被读取点看到"，就归 restart** —— 宁可不热，不假热。
 */

import type { Config } from "./schema.js";

export type ReloadClass = "none" | "hot" | "soft" | "restart";

export interface ReloadPlan {
  cls: ReloadClass;
  /** 发生变化的配置段（点路径，供人读） */
  sections: string[];
  /** 为什么是这个级别（面向人 / agent） */
  reason: string;
}

/**
 * 需要"重新 init 子系统"的段（provider 客户端 / 限流器 / 记忆阈值）。
 *
 * `providers.` 必须在里面：LLM 客户端在构造时把 `apiKey` 固化进实例
 * （`llm/registry.ts` 的 `new LLMClient({ apiKey })`），只换配置缓存不会换掉它们 ——
 * 按 hot 处理等于"改了 key 却不生效"。归 soft 才会走 `applySoft` 重新 init 后端。
 */
const SOFT_PREFIXES = ["llm.", "providers.", "concurrency.", "memory.embedModel", "memory.enabled"];

/** 必须重启的段（进程级资源或进程内一致性） */
const RESTART_PREFIXES = [
  "channels.",
  "voice.",
  "web.port",
  "sandbox.enabled",
  "sandbox.execShell",
];

/** 深度比较，收集发生变化的点路径（数组按下标逐项比较） */
function diffPaths(a: unknown, b: unknown, prefix: string, out: string[]): void {
  if (Object.is(a, b)) return;

  const aIsArr = Array.isArray(a);
  const bIsArr = Array.isArray(b);
  if (aIsArr && bIsArr) {
    if (a.length !== b.length) {
      out.push(prefix === "" ? "(root)" : prefix);
      return;
    }
    for (let i = 0; i < a.length; i++) {
      diffPaths(a[i], b[i], `${prefix}[${i}]`, out);
    }
    return;
  }

  const bothObjects =
    a !== null &&
    b !== null &&
    typeof a === "object" &&
    typeof b === "object" &&
    !aIsArr &&
    !bIsArr;
  if (!bothObjects) {
    out.push(prefix === "" ? "(root)" : prefix);
    return;
  }

  const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
  for (const k of keys) {
    const av = (a as Record<string, unknown>)[k];
    const bv = (b as Record<string, unknown>)[k];
    if (Object.is(av, bv)) continue;
    diffPaths(av, bv, prefix === "" ? k : `${prefix}.${k}`, out);
  }
}

/** 找出两份配置的变化点（点路径） */
export function diffConfigSections(before: Config, after: Config): string[] {
  const out: string[] = [];
  diffPaths(before, after, "", out);
  return out.sort();
}

function matches(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) =>
    p.endsWith(".") ? path.startsWith(p) : path === p || path.startsWith(`${p}.`)
  );
}

/**
 * 变更分级。
 *
 * 优先级：`restart` > `soft` > `hot`（任一命中就取更重的那级）。
 */
export function classifyConfigChange(before: Config, after: Config): ReloadPlan {
  const sections = diffConfigSections(before, after);
  if (sections.length === 0) {
    return { cls: "none", sections, reason: "配置内容没有变化" };
  }

  const restart = sections.filter((p) => matches(p, RESTART_PREFIXES));
  if (restart.length > 0) {
    return {
      cls: "restart",
      sections,
      reason:
        `涉及进程级资源或进程内一致性（${restart.join(", ")}）：` +
        "channels/voice/web.port 需要重建 connector 与监听 socket，sandbox 开关在一次工具调用内会被多处读取，" +
        "热改会出现半新半旧 —— 走受控重启",
    };
  }

  const soft = sections.filter((p) => matches(p, SOFT_PREFIXES));
  if (soft.length > 0) {
    return {
      cls: "soft",
      sections,
      reason:
        `涉及启动时初始化一次的子系统（${soft.join(", ")}）：` +
        "换缓存不够，需要重新 init（LLM 后端客户端 / 限流器 / 记忆阈值）",
    };
  }

  return {
    cls: "hot",
    sections,
    reason: `这些段都是"用时现读"（${sections.slice(0, 6).join(", ")}${sections.length > 6 ? " …" : ""}），换缓存即可生效`,
  };
}
