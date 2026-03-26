/**
 * 全局 LLM 并发限流器（FIFO Semaphore）
 *
 * 控制同时进行 LLM 推理的最大并发数。
 * 工具执行期间不占用 slot（由 runAgent ReAct 循环在 streamChat/chat 外层 acquire/release 实现）。
 *
 * 排队策略：FIFO（先调用 acquire 的先得到 slot）。
 * 配置项：config.concurrency.maxConcurrentLLMRequests（0 = 不限制）。
 */

class Semaphore {
  private available: number;
  private readonly queue: Array<{
    resolve: () => void;
    reject: (err: Error) => void;
  }> = [];

  constructor(permits: number) {
    // permits = 0 表示不限制（用 Infinity 表示无限 slot）
    this.available = permits === 0 ? Infinity : permits;
  }

  /**
   * 获取一个 slot。
   * - 有空闲 slot 时立即 resolve。
   * - 无空闲 slot 时加入队列尾部（FIFO），等待 release() 唤醒。
   * - signal 触发 abort 时，从队列移除并 reject（不阻塞其他排队请求）。
   */
  acquire(signal?: AbortSignal): Promise<void> {
    // permits=0（Infinity）时立即通过
    if (this.available > 0) {
      this.available--;
      return Promise.resolve();
    }

    return new Promise<void>((resolve, reject) => {
      const entry = { resolve, reject };
      this.queue.push(entry);

      if (signal) {
        const onAbort = () => {
          // 从队列中移除，让其他请求继续
          const idx = this.queue.indexOf(entry);
          if (idx !== -1) this.queue.splice(idx, 1);
          reject(new Error("LLM slot acquire aborted"));
        };
        signal.addEventListener("abort", onAbort, { once: true });
        // 等 resolve 后清理监听器（防止内存泄漏）
        const origResolve = resolve;
        entry.resolve = () => {
          signal.removeEventListener("abort", onAbort);
          origResolve();
        };
      }
    });
  }

  /**
   * 释放一个 slot。
   * - 若队列中有等待者，立即唤醒队列头部（FIFO）。
   * - 否则增加可用 slot 计数（但不超过初始 permits 上限）。
   */
  release(): void {
    if (this.queue.length > 0) {
      // 唤醒队列头部（FIFO）
      const next = this.queue.shift()!;
      // available 保持不变（slot 从当前直接转给等待者）
      next.resolve();
    } else {
      // 没有等待者，归还 slot（但不超过 Infinity 上限）
      this.available++;
    }
  }

  /** 当前等待中的请求数（调试用） */
  get queueLength(): number {
    return this.queue.length;
  }

  /** 当前可用 slot 数（调试用） */
  get availableSlots(): number {
    return this.available === Infinity ? -1 : this.available;
  }
}

// ── 全局单例 ──────────────────────────────────────────────────────────────────

/** 全局 LLM 并发限流器单例（默认不限制，需调用 initLLMConcurrency 初始化） */
let _semaphore: Semaphore = new Semaphore(0);

/**
 * 初始化全局 LLM 并发限流器。
 * 应在 `llmRegistry.init()` 之后、接受请求之前调用一次。
 *
 * @param limit 最大并发 LLM 推理数（0 = 不限制）
 */
export function initLLMConcurrency(limit: number): void {
  _semaphore = new Semaphore(limit);
  if (limit > 0) {
    console.log(`[concurrency] LLM 并发上限已设置为 ${limit}`);
  } else {
    console.log("[concurrency] LLM 并发不限制（maxConcurrentLLMRequests = 0）");
  }
}

/**
 * 获取一个 LLM 推理 slot（FIFO 排队）。
 * 在 runAgent ReAct 循环中，每次 streamChat/chat 调用前调用。
 * 若被 signal 中断，抛出 Error（调用方应传播给 runAgent 的错误处理链）。
 */
export async function acquireLLMSlot(signal?: AbortSignal): Promise<void> {
  await _semaphore.acquire(signal);
}

/**
 * 释放 LLM 推理 slot。
 * 在 runAgent ReAct 循环中，每次 streamChat/chat 返回后（finally 块）调用。
 * 工具执行期间 slot 已归还，其他会话可立即开始推理。
 */
export function releaseLLMSlot(): void {
  _semaphore.release();
}

/**
 * 读取当前并发状态（用于 /status 命令展示）。
 */
export function getLLMConcurrencyStatus(): { available: number; queued: number } {
  return {
    available: _semaphore.availableSlots,
    queued: _semaphore.queueLength,
  };
}
