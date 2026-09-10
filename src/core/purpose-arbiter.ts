/**
 * purpose 仲裁器
 *
 * 输入是每个工具调用带来的 `__purpose`（短旁白），输出是"哪一条真的值得占用用户的注意力"。
 *
 * 设计要点（刻意为之，不要加回放/补发逻辑）：
 *   - 只有"用户真的在等"才有意义：跑满 holdMs 的调用才算（instantAsyncTools 例外，见下）
 *   - 每次展示都基于**实时状态**重新选：优先"仍在运行且最晚开始"的候选，否则"最晚结束"的候选
 *   - 一次成功展示后，比它更早开始的候选全部作废（陈旧的旁白永不复播）
 *   - 同一个旁白连续出现只展示一次（dedupe）
 */

import { createLogger } from "../utils/logger.js";

const log = createLogger("purpose-arbiter");

export interface PurposeArbiterOptions {
  /** 工具运行多久才算"用户真的在等"（ms）。<=0 表示开始即展示 */
  holdMs: number;
  /** 两次展示之间的最小间隔（ms） */
  minGapMs: number;
  /** 展示回调（可能返回 Promise；实现方不得 await，需自行 catch 错误） */
  onShow: (purpose: string) => void | Promise<void>;
  /** "秒返回但把活干在后台"的工具：跳过 hold 直接尝试展示 */
  instantAsyncTools?: ReadonlySet<string>;
}

export interface PurposeArbiter {
  onToolStart(toolName: string, purpose: string | undefined): void;
  onToolEnd(toolName: string, durationMs: number): void;
  dispose(): void;
}

/** 池内单个候选（一次工具调用） */
interface Candidate {
  toolName: string;
  /** 归一化后的旁白；undefined / 空串表示该调用不参与展示 */
  purpose?: string;
  startedAt: number;
  endedAt?: number;
  durationMs?: number;
  running: boolean;
  sent: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

/** 只有带非空 purpose 的候选才参与选取 */
function hasPurpose(c: Candidate): boolean {
  return typeof c.purpose === "string" && c.purpose.length > 0;
}

function endTime(c: Candidate): number {
  return c.endedAt ?? -Infinity;
}

export function createPurposeArbiter(opts: PurposeArbiterOptions): PurposeArbiter {
  /** 本轮 run 的候选池（一次 run 一个实例） */
  const pool: Candidate[] = [];
  /** 所有已排期的定时器，dispose 时统一清掉 */
  const timers = new Set<ReturnType<typeof setTimeout>>();

  let dead = false;
  let lastShownAt = 0;
  /** undefined 表示"还没展示过任何旁白" */
  let lastShownPurpose: string | undefined;

  /** 触发一次选取 + 展示（所有触发器最终都走这里） */
  function attemptShow(): void {
    if (dead) return;
    const now = Date.now();
    let selected: Candidate | undefined;

    // 1) 仍在运行的候选里，取开始时间最晚的那个（"最新的一步"）
    for (const c of pool) {
      if (!c.running || !hasPurpose(c)) continue;
      if (!selected || c.startedAt > selected.startedAt) selected = c;
    }

    // 2) 否则取结束时间最晚的已完成候选
    if (!selected) {
      for (const c of pool) {
        if (!hasPurpose(c)) continue;
        if (!selected || endTime(c) > endTime(selected)) selected = c;
      }
    }

    if (!selected) return;

    // 4) 已经展示过（或已被 dedupe 掉）就跳过
    if (selected.sent) return;

    // 5) 距上次展示太近：保留候选池，稍后若有触发器可以再展示
    if (now - lastShownAt < opts.minGapMs) return;

    // 6) 与上一条相同的旁白：标记已处理，不重复打扰用户
    if (selected.purpose === lastShownPurpose) {
      selected.sent = true;
      return;
    }

    // 7) 正式展示
    selected.sent = true;
    lastShownAt = now;
    lastShownPurpose = selected.purpose;
    emit(selected.purpose ?? "");

    // 8) 比它更早开始的候选已经陈旧，直接作废（同刻开始的也一并作废，保留被选中的那个）
    for (let i = pool.length - 1; i >= 0; i--) {
      const c = pool[i];
      if (!c) continue;
      if (c !== selected && c.startedAt <= selected.startedAt) {
        clearTimer(c);
        pool.splice(i, 1);
      }
    }
  }

  /** 调用 onShow，同步抛错与 Promise 拒绝都不得影响工具执行 */
  function emit(purpose: string): void {
    try {
      const ret = opts.onShow(purpose);
      if (ret && typeof (ret as Promise<void>).then === "function") {
        (ret as Promise<void>).then(undefined, (err: unknown) => {
          log.warn("onShow 异步失败（已忽略）", err);
        });
      }
    } catch (err) {
      log.warn("onShow 抛错（已忽略）", err);
    }
  }

  function clearTimer(c: Candidate): void {
    if (!c.timer) return;
    clearTimeout(c.timer);
    timers.delete(c.timer);
    delete c.timer;
  }

  function onToolStart(toolName: string, purpose: string | undefined): void {
    // 即使没有 purpose 也要登记：运行状态必须准确，否则 T2 判定会出错
    const candidate: Candidate = {
      toolName,
      startedAt: Date.now(),
      running: true,
      sent: false,
      ...(typeof purpose === "string" && purpose.length > 0 ? { purpose } : {}),
    };
    pool.push(candidate);

    if (!hasPurpose(candidate)) return;

    // 秒返回 / 后台干活的工具：不等 hold，立刻尝试展示，且不排 hold 定时器
    if (opts.instantAsyncTools?.has(toolName)) {
      attemptShow();
      return;
    }

    const delay = Math.max(0, opts.holdMs);
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (candidate.timer === timer) delete candidate.timer;
      if (dead) return;
      // T1：只有"仍在运行"才算用户还在等
      if (!candidate.running) return;
      attemptShow();
    }, delay);
    timers.add(timer);
    timer.unref?.();
    candidate.timer = timer;
  }

  function onToolEnd(toolName: string, durationMs: number): void {
    // 同一批工具可能是 Promise.all 并发，结束顺序与开始顺序无关：
    // 因此按"最近的同名仍在运行的候选"匹配
    let target: Candidate | undefined;
    for (let i = pool.length - 1; i >= 0; i--) {
      const c = pool[i];
      if (c && c.running && c.toolName === toolName) {
        target = c;
        break;
      }
    }
    if (!target) return;

    clearTimer(target);
    target.running = false;
    target.endedAt = Date.now();
    target.durationMs = durationMs;

    // T2：跑够 holdMs 且当前**没有**带旁白的候选在跑 → 用户刚等到结果，值得展示
    const anyRunning = pool.some((c) => c.running && hasPurpose(c));
    if (durationMs >= opts.holdMs && !anyRunning) attemptShow();
  }

  function dispose(): void {
    if (dead) return;
    dead = true;
    for (const c of pool) clearTimer(c);
    for (const t of timers) clearTimeout(t);
    timers.clear();
    pool.length = 0;
  }

  return { onToolStart, onToolEnd, dispose };
}
