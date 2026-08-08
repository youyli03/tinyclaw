/**
 * InboundMessageBus — 用户入站消息统一调度总线
 *
 * 所有需要等待用户回复的操作(MFA 确认、Plan 审批、ask_user、
 * async slave ask_user)都通过此 Bus 注册 Waiter。
 *
 * 用户消息到达时，handleMessage 调用 dispatch()，Bus 按 FIFO 顺序遍历等待队列，
 * 找到第一个 match() 返回 true 的 Waiter 并调用其 handle()，消费该消息。
 *
 * 严格的时间顺序保证无歧义：先注册先匹配，resolved/rejected 的 Waiter 自动移除。
 */

export interface InboundExtras {
  /** 消息中包含的图片本地路径 */
  imagePaths?: string[];
  /** 原始未处理的消息内容(不含附件标签,用于编号/命令解析) */
  rawContent: string;
  /** 拼入附件标签后的完整内容(含 <img>/<file>/<video>/<audio> 标签) */
  enrichedContent?: string;
}

export interface WaiterRemind {
  /** 首次提醒延迟(秒),0 = 不提醒 */
  afterSecs: number;
  /** 提醒间隔(秒) */
  intervalSecs: number;
  /** 最多提醒次数,0 = 不限 */
  maxReminds: number;
  /** 发送提醒消息(由注册方提供,通常用 connector.send) */
  send: () => Promise<void> | void;
}

export interface Waiter {
  /** 唯一标识，如 "session:xxx:mfa"、"skill:bilibili:askuser:1748000000" */
  id: string;
  /** 可选标签，用于日志或向用户展示来源（如 "B站总结"） */
  label?: string;
  /**
   * 若为 true,此 Waiter 不可被 debounce 积压的旧消息消费。
   * 适用于 exit_plan_mode 等需要用户主动看到提示后才回复的场景。
   * debounce flush 时若存在 noBounce waiter,会走 handleMessageCore 而非 dispatch。
   */
  noBounce?: boolean;
  /**
   * 判断这条消息是否可以被本 Waiter 处理。
   * 通常返回 true（等待任意用户回复），或做特定前缀检测。
   */
  match: (content: string, extras: InboundExtras) => boolean;
  /** 处理消息，调用后通常会 resolve 对应的 Promise */
  handle: (content: string, extras: InboundExtras) => void;
  /**
   * 等待提醒配置(可选)。
   * 注册后自动启动提醒定时器:超过 afterSecs 未收到用户回复则调用 send() 发送简短提示,
   * 之后每隔 intervalSecs 提醒一次,最多 maxReminds 次。注销/消费后定时器自动清理。
   */
  remind?: WaiterRemind;
}

export class InboundMessageBus {
  private waiters: Waiter[] = [];
  /** 已注册 waiter 的清理函数集合,clear() 时统一调用,避免 remind 定时器泄漏 */
  private cleanups: Array<() => void> = [];

  /**
   * 注册一个等待者，返回注销函数（调用后从队列中移除该 Waiter）。
   */
  register(waiter: Waiter): () => void {
    this.waiters.push(waiter);

    // 等待提醒:注册时启动定时器,注销时清理
    let remindCleanup: (() => void) | null = null;
    const remind = waiter.remind;
    if (remind && remind.afterSecs > 0 && remind.send) {
      let remindCount = 0;
      let remindTimer: ReturnType<typeof setTimeout> | null = null;
      let remindStopped = false;
      const scheduleRemind = (delayMs: number) => {
        remindTimer = setTimeout(() => {
          if (remindStopped) return;
          if (remind.maxReminds > 0 && remindCount >= remind.maxReminds) {
            remindCleanup?.();
            return;
          }
          remindCount++;
          Promise.resolve()
            .then(() => remind.send())
            .catch((e: unknown) => console.error("[inbound-bus] remind send error:", e));
          scheduleRemind(remind.intervalSecs * 1000);
        }, delayMs);
      };
      scheduleRemind(remind.afterSecs * 1000);
      remindCleanup = () => {
        remindStopped = true;
        if (remindTimer) {
          clearTimeout(remindTimer);
          remindTimer = null;
        }
      };
    }

    const cleanup = () => {
      this.waiters = this.waiters.filter((w) => w.id !== waiter.id);
      remindCleanup?.();
    };
    this.cleanups.push(cleanup);
    return cleanup;
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

  /** 强制清除所有等待者(会话结束或重置时调用),同时清理所有 remind 定时器 */
  clear(): void {
    for (const c of this.cleanups) c();
    this.cleanups = [];
    this.waiters = [];
  }

  /**
   * 检查队列中是否存在 noBounce waiter（不可被 debounce 旧消息消费）。
   * debounce flush 前应先检查此方法，若为 true 则走 handleMessageCore。
   */
  hasNoBounceWaiter(): boolean {
    return this.waiters.some((w) => w.noBounce === true);
  }

  /** 当前队列长度（用于调试） */
  get size(): number {
    return this.waiters.length;
  }

  /** 获取当前队列快照（用于调试） */
  snapshot(): Array<{ id: string; label?: string }> {
    return this.waiters.map((w) => ({
      id: w.id,
      ...(w.label !== undefined ? { label: w.label } : {}),
    }));
  }
}
