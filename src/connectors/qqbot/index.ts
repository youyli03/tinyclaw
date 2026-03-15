/**
 * QQBot Connector — 实现 Connector 接口
 * 胶水层：连接 gateway（收消息） + outbound（发消息） + agent（处理消息）
 */

import type { Connector, InboundMessage } from "../base.js";
import { startGateway } from "./gateway.js";
import { sendMessage } from "./outbound.js";
import { initMarkdownSupport } from "./api.js";
import { loadConfig } from "../../config/loader.js";

const ts = () => new Date().toLocaleTimeString("zh-CN", { hour12: false });

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

    initMarkdownSupport(qqcfg.markdownSupport);
    this.abortController = new AbortController();

    await startGateway({
      appId: qqcfg.appId,
      clientSecret: qqcfg.clientSecret,
      abortSignal: this.abortController.signal,
      onMessage: async (msg) => {
        if (!this.handler) return "";
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
