/**
 * QQBot Connector — 实现 Connector 接口
 * 胶水层:连接 gateway(收消息) + outbound(发消息) + agent(处理消息)
 */

import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import type { Connector, InboundMessage } from "../base.js";
import { startGateway } from "./gateway.js";
import { sendMessage } from "./outbound.js";
import { initMarkdownSupport } from "./api.js";
import { loadConfig, loadSecretsConfig } from "../../config/loader.js";
import { MFAError } from "../../auth/mfa.js";
import type { QQBotConfig } from "../../config/schema.js";

/**
 * 解析 clientSecret 中的 $KEY 占位符，从 secrets.toml 读取真实值。
 * 若不是 $KEY 格式则原样返回（明文）。
 */
function resolveSecret(raw: string): string {
  const match = /^\$([A-Za-z0-9_]+)$/.exec(raw.trim());
  if (!match) return raw;
  const key = match[1]!;
  const secrets = loadSecretsConfig();
  const entry = secrets[key];
  if (!entry) {
    throw new Error(`[qqbot] secrets.toml 中未找到 key "${key}"，请检查配置`);
  }
  return entry.value;
}

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

export class QQBotConnector implements Connector {
  private handler: ((msg: InboundMessage) => Promise<string>) | null = null;
  private abortController: AbortController | null = null;
  readonly botId: string;
  private readonly botCfg: QQBotConfig;
  private readonly pendingMFAMap = new Map<string, PendingMFA>();
  private readonly pendingInputMap = new Map<string, PendingInput>();

  /** 连接就绪时调用(可在 connector.start() 前设置) */
  onReady?: () => void;

  constructor(botId: string, botCfg: QQBotConfig) {
    this.botId = botId;
    this.botCfg = botCfg;
  }

  onMessage(handler: (msg: InboundMessage) => Promise<string>): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    const cfg = loadConfig();
    const mfaCfg = cfg.auth.mfa;
    const mfaTimeoutMs = (mfaCfg?.timeoutSecs ?? 0) * 1000;

    const resolvedSecret = resolveSecret(this.botCfg.clientSecret);

    initMarkdownSupport(this.botCfg.appId, this.botCfg.markdownSupport);
    this.abortController = new AbortController();

    await startGateway({
      appId: this.botCfg.appId,
      clientSecret: resolvedSecret,
      abortSignal: this.abortController.signal,
      onMessage: async (msg) => {
        if (!this.handler) return "";

        // 如果此 peerId 有待预 MFA 确认,将消息内容视为验证回复
        const pending = this.pendingMFAMap.get(msg.peerId);
        if (pending) {
          const text = msg.content.trim();
          this.pendingMFAMap.delete(msg.peerId);
          clearTimeout(pending.timer ?? undefined);
          if (pending.verifyCode) {
            // TOTP 模式:验证数字码
            const digits = text.replace(/\s/g, "");
            if (/^\d{6}$/.test(digits) && pending.verifyCode(digits)) {
              pending.resolve(true);
              void this.send(msg.peerId, msg.type, "✓ TOTP 验证通过,继续执行", msg.messageId).catch(
                (e: unknown) => console.error("[qqbot] send error:", e)
              );
              return "✓ TOTP 验证通过,继续执行";
            } else {
              pending.resolve(false);
              void this.send(
                msg.peerId,
                msg.type,
                "✗ TOTP 验证失败,操作已取消",
                msg.messageId
              ).catch((e: unknown) => console.error("[qqbot] send error:", e));
              return "✗ TOTP 验证失败,操作已取消";
            }
          } else {
            // simple 模式:匹配 确认/取消
            const yes = /^确认$|^y$|^yes$/i.test(text);
            const no = /^取消$|^n$|^no$/i.test(text);
            if (yes) {
              pending.resolve(true);
              void this.send(msg.peerId, msg.type, "✓ 已确认,继续执行", msg.messageId).catch(
                (e: unknown) => console.error("[qqbot] send error:", e)
              );
              return "✓ 已确认,继续执行";
            }
            if (no) {
              pending.resolve(false);
              void this.send(msg.peerId, msg.type, "✗ 已取消,操作未执行", msg.messageId).catch(
                (e: unknown) => console.error("[qqbot] send error:", e)
              );
              return "✗ 已取消,操作未执行";
            }
            // 无法识别——提示重试
            this.pendingMFAMap.set(msg.peerId, pending);
            return "请回复 **确认** 或 **取消**";
          }
        }

        const pendingInput = this.pendingInputMap.get(msg.peerId);
        if (pendingInput) {
          const text = msg.content.trim();
          this.pendingInputMap.delete(msg.peerId);
          clearTimeout(pendingInput.timer ?? undefined);
          pendingInput.resolve(text);
          void this.send(msg.peerId, msg.type, "已收到,处理中...", msg.messageId).catch(
            (e: unknown) => console.error("[qqbot] send error:", e)
          );
          return "已收到,处理中...";
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
        console.log(`[qqbot:${this.botId}] Ready`);
        this.onReady?.();
      },
      log: {
        info: (m) => console.log(`[qqbot:${this.botId}] ${m}`),
        error: (m) => console.error(`[qqbot:${this.botId}] ${m}`),
        ...(process.env["QQBOT_DEBUG"]
          ? { debug: (m: string) => console.debug(`[qqbot:${this.botId}] ${m}`) }
          : {}),
      },
    });

    // 把 onMFARequest 挂载到 handler,下母过语上不够,通过 startGateway 回调的 onMessage 已处理
    void mfaTimeoutMs; // used in closure above
  }

  /**
   * 启动等待提醒定时器:超过 remindAfterSecs 未回复则发送 message,
   * 之后每隔 remindIntervalSecs 提醒一次,最多 maxReminds 次。
   * 返回清理函数;配置为 0 或读取失败时返回 null(不提醒)。
   */
  private startRemind(
    peerId: string,
    type: InboundMessage["type"],
    message: string
  ): (() => void) | null {
    let remindCleanup: (() => void) | null = null;
    try {
      const icfg = loadConfig().interactive;
      if (icfg.remindAfterSecs > 0) {
        let remindCount = 0;
        let remindTimer: ReturnType<typeof setTimeout> | null = null;
        let stopped = false;
        const scheduleRemind = (delayMs: number) => {
          remindTimer = setTimeout(() => {
            if (stopped) return;
            if (icfg.maxReminds > 0 && remindCount >= icfg.maxReminds) {
              remindCleanup?.();
              return;
            }
            remindCount++;
            void this.send(peerId, type, message).catch((e: unknown) =>
              console.error("[qqbot] send error:", e)
            );
            scheduleRemind(icfg.remindIntervalSecs * 1000);
          }, delayMs);
        };
        scheduleRemind(icfg.remindAfterSecs * 1000);
        remindCleanup = () => {
          stopped = true;
          if (remindTimer) {
            clearTimeout(remindTimer);
            remindTimer = null;
          }
        };
      }
    } catch {
      // 配置读取失败则跳过提醒
    }
    return remindCleanup;
  }

  requestUserInput(
    peerId: string,
    type: InboundMessage["type"],
    prompt: string,
    timeoutMs: number
  ): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      // 等待提醒:超过 remindAfterSecs 未回复则发送简短提示(配置见 [interactive])
      const remindCleanup = this.startRemind(peerId, type, "⏳ 还在等待您的输入...");

      const entry: PendingInput = {
        resolve: (v) => {
          remindCleanup?.();
          resolve(v);
        },
        reject: (e) => {
          remindCleanup?.();
          reject(e);
        },
        timer: null,
      };

      entry.timer =
        timeoutMs > 0
          ? setTimeout(() => {
              // 仅当自己仍是当前 pending 时才清理:若已被新请求覆盖,旧 promise 已由覆盖逻辑 reject,
              // 此处不能再 delete 新 entry(否则新请求会收不到用户回复)
              if (this.pendingInputMap.get(peerId) === entry) {
                this.pendingInputMap.delete(peerId);
                reject(new MFAError("等待用户输入超时,操作已取消"));
                void this.send(peerId, type, "⏰ 等待输入超时,操作已自动取消").catch((e: unknown) =>
                  console.error("[qqbot] send error:", e)
                );
              }
            }, timeoutMs)
          : null;

      // 覆盖保护:同一 peerId 已有 pending 时,先清理旧请求(避免旧 timer 到期误删新 entry)
      const prev = this.pendingInputMap.get(peerId);
      if (prev) {
        clearTimeout(prev.timer ?? undefined);
        prev.reject(new Error("等待被新的请求覆盖,已取消"));
      }

      this.pendingInputMap.set(peerId, entry);
      void this.send(peerId, type, prompt).catch((e: unknown) =>
        console.error("[qqbot] send error:", e)
      );
    });
  }

  /** 对指定 peerId 设置 MFA 请求,等待用户回复 */
  buildMFARequest(
    peerId: string,
    type: InboundMessage["type"],
    warningMessage: string,
    timeoutMs: number,
    verifyCode?: (code: string) => boolean
  ): Promise<boolean> {
    return new Promise<boolean>((resolve, reject) => {
      // 等待提醒:超过 remindAfterSecs 未回复则发送简短提示(配置见 [interactive])
      const remindCleanup = this.startRemind(peerId, type, "⏳ 还在等待您的确认...");

      const entry: PendingMFA = {
        resolve: (v) => {
          remindCleanup?.();
          resolve(v);
        },
        reject: (e) => {
          remindCleanup?.();
          reject(e);
        },
        timer: null,
        ...(verifyCode ? { verifyCode } : {}),
      };

      // timeoutMs === 0 表示不超时,永久等待用户确认
      entry.timer =
        timeoutMs > 0
          ? setTimeout(() => {
              // 仅当自己仍是当前 pending 时才清理(防止误删被新请求覆盖的 entry)
              if (this.pendingMFAMap.get(peerId) === entry) {
                this.pendingMFAMap.delete(peerId);
                reject(new MFAError("MFA 确认超时,操作已取消"));
                void this.send(peerId, type, "⏰ MFA 超时,操作已自动取消").catch((e: unknown) =>
                  console.error("[qqbot] send error:", e)
                );
              }
            }, timeoutMs)
          : null;

      // 覆盖保护:同一 peerId 已有 pending 时,先清理旧请求
      const prev = this.pendingMFAMap.get(peerId);
      if (prev) {
        clearTimeout(prev.timer ?? undefined);
        prev.reject(new Error("MFA 请求被新的请求覆盖,已取消"));
      }

      this.pendingMFAMap.set(peerId, entry);
      void this.send(peerId, type, warningMessage).catch((e: unknown) =>
        console.error("[qqbot] send error:", e)
      );
    });
  }

  async stop(): Promise<void> {
    this.abortController?.abort();
    this.abortController = null;
    // 清理所有挂起的输入/MFA 等待(取消 timer 并 reject,避免泄漏与悬挂 promise)
    for (const [, p] of this.pendingInputMap) {
      clearTimeout(p.timer ?? undefined);
      p.reject(new Error("connector 已停止,等待已取消"));
    }
    this.pendingInputMap.clear();
    for (const [, p] of this.pendingMFAMap) {
      clearTimeout(p.timer ?? undefined);
      p.reject(new Error("connector 已停止,等待已取消"));
    }
    this.pendingMFAMap.clear();
  }

  async send(
    peerId: string,
    type: InboundMessage["type"],
    text: string,
    replyToId?: string
  ): Promise<void> {
    const resolvedSecret = resolveSecret(this.botCfg.clientSecret);
    await sendMessage({
      appId: this.botCfg.appId,
      clientSecret: resolvedSecret,
      peerId,
      type,
      text,
      ...(replyToId !== undefined ? { replyToId } : {}),
    });
  }
}
