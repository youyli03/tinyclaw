/**
 * QQBot Connector — 实现 Connector 接口
 * 胶水层：连接 gateway（收消息） + outbound（发消息） + agent（处理消息）
 */

import type { Connector, InboundMessage } from "../base.js";
import { startGateway } from "./gateway.js";
import { sendMessage } from "./outbound.js";
import { initMarkdownSupport } from "./api.js";
import { loadConfig } from "../../config/loader.js";
import { MFAError } from "../../auth/mfa.js";

const ts = () => new Date().toLocaleTimeString("zh-CN", { hour12: false });

interface PendingMFA {
  resolve: (approved: boolean) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
  verifyCode?: ((code: string) => boolean) | undefined;
}

interface PendingInput {
  resolve: (input: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
}

/** peerId → 待确认的 MFA 请求 */
const pendingMFAMap = new Map<string, PendingMFA>();
/** peerId → 等待用户原始输入（由后台 runtime 经 IPC 请求） */
const pendingInputMap = new Map<string, PendingInput>();

export class QQBotConnector implements Connector {
  private handler: ((msg: InboundMessage) => Promise<string>) | null = null;
  private abortController: AbortController | null = null;

  /** 连接就绪时调用（可在 connector.start() 前设置） */
  onReady?: () => void;

  onMessage(handler: (msg: InboundMessage) => Promise<string>): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    const cfg = loadConfig();
    const qqcfg = cfg.channels.qqbot;
    if (!qqcfg) throw new Error("channels.qqbot not configured");
    const mfaCfg = cfg.auth.mfa;
    const mfaTimeoutMs = (mfaCfg?.timeoutSecs ?? 0) * 1000;

    initMarkdownSupport(qqcfg.markdownSupport);
    this.abortController = new AbortController();

    await startGateway({
      appId: qqcfg.appId,
      clientSecret: qqcfg.clientSecret,
      abortSignal: this.abortController.signal,
      onMessage: async (msg) => {
        if (!this.handler) return "";

        // 如果此 peerId 有待预 MFA 确认，将消息内容视为验证回复
        const pending = pendingMFAMap.get(msg.peerId);
        if (pending) {
          const text = msg.content.trim();
          pendingMFAMap.delete(msg.peerId);
          clearTimeout(pending.timer ?? undefined);
          if (pending.verifyCode) {
            // TOTP 模式：验证数字码
            const digits = text.replace(/\s/g, "");
            if (/^\d{6}$/.test(digits) && pending.verifyCode(digits)) {
              pending.resolve(true);
              void this.send(msg.peerId, msg.type, "✓ TOTP 验证通过，继续执行", msg.messageId).catch((e: unknown) => console.error("[qqbot] send error:", e));
              return "✓ TOTP 验证通过，继续执行";
            } else {
              pending.resolve(false);
              void this.send(msg.peerId, msg.type, "✗ TOTP 验证失败，操作已取消", msg.messageId).catch((e: unknown) => console.error("[qqbot] send error:", e));
              return "✗ TOTP 验证失败，操作已取消";
            }
          } else {
            // simple 模式：匹配 确认/取消
            const yes = /^确认$|^y$|^yes$/i.test(text);
            const no = /^取消$|^n$|^no$/i.test(text);
            if (yes) {
              pending.resolve(true);
              void this.send(msg.peerId, msg.type, "✓ 已确认，继续执行", msg.messageId).catch((e: unknown) => console.error("[qqbot] send error:", e));
              return "✓ 已确认，继续执行";
            }
            if (no) {
              pending.resolve(false);
              void this.send(msg.peerId, msg.type, "✗ 已取消，操作未执行", msg.messageId).catch((e: unknown) => console.error("[qqbot] send error:", e));
              return "✗ 已取消，操作未执行";
            }
            // 无法识别——提示重试
            pendingMFAMap.set(msg.peerId, pending);
            return "请回复 **确认** 或 **取消**";
          }
        }

        const pendingInput = pendingInputMap.get(msg.peerId);
        if (pendingInput) {
          const text = msg.content.trim();
          pendingInputMap.delete(msg.peerId);
          clearTimeout(pendingInput.timer ?? undefined);
          pendingInput.resolve(text);
          void this.send(msg.peerId, msg.type, "已收到，处理中...", msg.messageId).catch((e: unknown) => console.error("[qqbot] send error:", e));
          return "已收到，处理中...";
        }

        try {
          const reply = await this.handler(msg);
          if (reply) {
            await this.send(msg.peerId, msg.type, reply, msg.messageId);
          }
          return reply;
        } catch (e) {
          console.error("[qqbot] handler error:", e);
          return "";
        }
      },
      onReady: () => {
        console.log(`[${ts()}] [qqbot] Ready`);
        this.onReady?.();
      },
      log: {
        info:  (m) => console.log(`[${ts()}] ${m}`),
        error: (m) => console.error(`[${ts()}] ${m}`),
        ...(process.env["QQBOT_DEBUG"] ? { debug: (m: string) => console.debug(`[${ts()}] ${m}`) } : {}),
      },
    });

    // 把 onMFARequest 挂载到 handler，下母过语上不够，通过 startGateway 回调的 onMessage 已处理
    void mfaTimeoutMs; // used in closure above
  }

  requestUserInput(
    peerId: string,
    type: InboundMessage["type"],
    prompt: string,
    timeoutMs: number,
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
            pendingInputMap.delete(peerId);
            reject(new MFAError("等待用户输入超时，操作已取消"));
            void this.send(peerId, type, "⏰ 等待输入超时，操作已自动取消").catch((e: unknown) => console.error("[qqbot] send error:", e));
          }, timeoutMs)
        : null;
      pendingInputMap.set(peerId, { resolve, reject, timer });
      void this.send(peerId, type, prompt).catch((e: unknown) => console.error("[qqbot] send error:", e));
    });
  }

  /** 对指定 peerId 设置 MFA 请求，等待用户回复 */
  buildMFARequest(
    peerId: string,
    type: InboundMessage["type"],
    warningMessage: string,
    timeoutMs: number,
    verifyCode?: (code: string) => boolean
  ): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      // timeoutMs === 0 表示不超时，永久等待用户确认
      const timer = timeoutMs > 0
        ? setTimeout(() => {
            pendingMFAMap.delete(peerId);
            reject(new MFAError("MFA 确认超时，操作已取消"));
            void this.send(peerId, type, "⏰ MFA 超时，操作已自动取消").catch((e: unknown) => console.error("[qqbot] send error:", e));
          }, timeoutMs)
        : null;
      pendingMFAMap.set(peerId, { resolve, reject, timer, ...(verifyCode ? { verifyCode } : {}) });
      void this.send(peerId, type, warningMessage).catch((e: unknown) => console.error("[qqbot] send error:", e));
    });
  }

  async stop(): Promise<void> {
    this.abortController?.abort();
    this.abortController = null;
  }

  async send(
    peerId: string,
    type: InboundMessage["type"],
    text: string,
    replyToId?: string
  ): Promise<void> {
    const cfg = loadConfig();
    const qqcfg = cfg.channels.qqbot;
    if (!qqcfg) throw new Error("channels.qqbot not configured");
    await sendMessage({
      appId: qqcfg.appId,
      clientSecret: qqcfg.clientSecret,
      peerId,
      type,
      text,
      ...(replyToId !== undefined ? { replyToId } : {}),
    });
  }
}
