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
  timer: ReturnType<typeof setTimeout>;
  verifyCode?: ((code: string) => boolean) | undefined;
}

/** peerId → 待确认的 MFA 请求 */
const pendingMFAMap = new Map<string, PendingMFA>();

export class QQBotConnector implements Connector {
  private handler: ((msg: InboundMessage) => Promise<string>) | null = null;
  private abortController: AbortController | null = null;

  onMessage(handler: (msg: InboundMessage) => Promise<string>): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    const cfg = loadConfig();
    const qqcfg = cfg.channels.qqbot;
    if (!qqcfg) throw new Error("channels.qqbot not configured");
    const mfaCfg = cfg.auth.mfa;
    const mfaTimeoutMs = (mfaCfg?.timeoutSecs ?? 60) * 1000;

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
          clearTimeout(pending.timer);
          if (pending.verifyCode) {
            // TOTP 模式：验证数字码
            const digits = text.replace(/\s/g, "");
            if (/^\d{6}$/.test(digits) && pending.verifyCode(digits)) {
              pending.resolve(true);
              void this.send(msg.peerId, msg.type, "✓ TOTP 验证通过，继续执行", msg.messageId);
              return "✓ TOTP 验证通过，继续执行";
            } else {
              pending.resolve(false);
              void this.send(msg.peerId, msg.type, "✗ TOTP 验证失败，操作已取消", msg.messageId);
              return "✗ TOTP 验证失败，操作已取消";
            }
          } else {
            // simple 模式：匹配 确认/取消
            const yes = /^确认$|^y$|^yes$/i.test(text);
            const no = /^取消$|^n$|^no$/i.test(text);
            if (yes) {
              pending.resolve(true);
              void this.send(msg.peerId, msg.type, "✓ 已确认，继续执行", msg.messageId);
              return "✓ 已确认，继续执行";
            }
            if (no) {
              pending.resolve(false);
              void this.send(msg.peerId, msg.type, "✗ 已取消，操作未执行", msg.messageId);
              return "✗ 已取消，操作未执行";
            }
            // 无法识别——提示重试
            pendingMFAMap.set(msg.peerId, pending);
            return "请回复 **确认** 或 **取消**";
          }
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
      onReady: () => console.log(`[${ts()}] [qqbot] Ready`),
      log: {
        info:  (m) => console.log(`[${ts()}] ${m}`),
        error: (m) => console.error(`[${ts()}] ${m}`),
        ...(process.env["QQBOT_DEBUG"] ? { debug: (m: string) => console.debug(`[${ts()}] ${m}`) } : {}),
      },
    });

    // 把 onMFARequest 挂载到 handler，下母过语上不够，通过 startGateway 回调的 onMessage 已处理
    void mfaTimeoutMs; // used in closure above
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
      const timer = setTimeout(() => {
        pendingMFAMap.delete(peerId);
        reject(new MFAError("MFA 确认超时，操作已取消"));
        void this.send(peerId, type, "⏰ MFA 超时，操作已自动取消");
      }, timeoutMs);
      pendingMFAMap.set(peerId, { resolve, reject, timer, ...(verifyCode ? { verifyCode } : {}) });
      void this.send(peerId, type, warningMessage);
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
