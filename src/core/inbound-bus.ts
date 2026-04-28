/**
 * InboundMessageBus — 用户入站消息统一调度总线
 *
 * 所有需要等待用户回复的操作（MFA 确认、Plan 审批、ask_master、ask_user、
 * async slave ask_user）都通过此 Bus 注册 Waiter。
 *
 * 用户消息到达时，handleMessage 调用 dispatch()，Bus 按 FIFO 顺序遍历等待队列，
 * 找到第一个 match() 返回 true 的 Waiter 并调用其 handle()，消费该消息。
 *
 * 严格的时间顺序保证无歧义：先注册先匹配，resolved/rejected 的 Waiter 自动移除。
 */

export interface InboundExtras {
  /** 消息中包含的图片本地路径 */
  imagePaths?: string[];
  /** 原始未处理的消息内容 */
  rawContent: string;
}

export interface Waiter {
  /** 唯一标识，如 "session:xxx:mfa"、"skill:bilibili:askuser:1748000000" */
  id: string;
  /** 可选标签，用于日志或向用户展示来源（如 "B站总结"） */
  label?: string;
  /**
   * 判断这条消息是否可以被本 Waiter 处理。
   * 通常返回 true（等待任意用户回复），或做特定前缀检测。
   */
  match: (content: string, extras: InboundExtras) => boolean;
  /** 处理消息，调用后通常会 resolve 对应的 Promise */
  handle: (content: string, extras: InboundExtras) => void;
}

export class InboundMessageBus {
  private waiters: Waiter[] = [];

  /**
   * 注册一个等待者，返回注销函数（调用后从队列中移除该 Waiter）。
   */
  register(waiter: Waiter): () => void {
    this.waiters.push(waiter);
    return () => {
      this.waiters = this.waiters.filter((w) => w.id !== waiter.id);
    };
  }

  /**
   * 分发消息：找到第一个 match 的 Waiter 并调用其 handle()。
   * @returns true 表示消息已被消费，handleMessage 应 early-return；false 表示无 Waiter 匹配。
   */
  dispatch(content: string, extras: InboundExtras): boolean {
    for (const w of this.waiters) {
      if (w.match(content, extras)) {
        w.handle(content, extras);
        return true;
      }
    }
    return false;
  }

  /** 强制清除所有等待者（会话结束或重置时调用） */
  clear(): void {
    this.waiters = [];
  }

  /** 当前队列长度（用于调试） */
  get size(): number {
    return this.waiters.length;
  }

  /** 获取当前队列快照（用于调试） */
  snapshot(): Array<{ id: string; label?: string }> {
    return this.waiters.map((w) => ({ id: w.id, ...(w.label !== undefined ? { label: w.label } : {}) }));
  }
}
