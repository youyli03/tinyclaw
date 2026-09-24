/**
 * QQBot WebSocket Gateway
 * 最小化移植：协议管理 + 消息分发，无媒体处理
 */

import WebSocket from "ws";
import { getAccessToken, clearTokenCache, getGatewayUrl } from "./api.js";
import type {
  InboundMessage,
  WSPayload,
  C2CMessageEvent,
  GroupMessageEvent,
  GuildMessageEvent,
} from "../base.js";

// ── QQ Gateway 协议常量 ──────────────────────────────────────────────────────

const INTENTS = {
  GUILDS: 1 << 0,
  GUILD_MEMBERS: 1 << 1,
  PUBLIC_GUILD_MESSAGES: 1 << 30,
  DIRECT_MESSAGE: 1 << 12,
  GROUP_AND_C2C: 1 << 25,
} as const;

/**
 * 三档权限，从高到低。
 *
 * ⚠️ **只有 close code 4013（Invalid intent）才允许降档**。op 9（Invalid session）是
 * 会话层问题，和"意图是否被授权"无关 —— 早期版本在 op 9 时递增档位，于是偶发掉线会把
 * bot 永久砍成"仅频道消息"（不含 `GROUP_AND_C2C`），QQ 不再推单聊/群消息，而发送走
 * REST 不受影响，表现为**只能发不能收**。降档还会被写进 session 文件，重启也救不回来。
 */
const INTENT_LEVELS = [
  {
    name: "full",
    intents: INTENTS.PUBLIC_GUILD_MESSAGES | INTENTS.DIRECT_MESSAGE | INTENTS.GROUP_AND_C2C,
    description: "群聊+私信+频道",
  },
  {
    name: "group+channel",
    intents: INTENTS.PUBLIC_GUILD_MESSAGES | INTENTS.GROUP_AND_C2C,
    description: "群聊+频道",
  },
  {
    name: "channel-only",
    intents: INTENTS.PUBLIC_GUILD_MESSAGES | INTENTS.GUILD_MEMBERS,
    description: "仅频道消息",
  },
] as const;

// ── 重连参数 ─────────────────────────────────────────────────────────────────

const RECONNECT_DELAYS = [1000, 2000, 5000, 10000];
const RATE_LIMIT_DELAY = 60_000;
const MAX_RECONNECT_ATTEMPTS = 100;
const QUICK_DISCONNECT_THRESHOLD = 5000;
const MAX_QUICK_DISCONNECT_COUNT = 3;

/**
 * 降档后的回升节奏。降档的唯一理由是服务端明确拒绝意图（4013），而权限可能被重新授予，
 * 所以降档不是终点：到点先用**最高档**重试，再被拒则退避翻倍（10min → 20min → … → 6h）。
 * 回升只发生在一次新的 Identify 上，连接本身不会因此被打断。
 */
const INTENT_RETRY_BASE_MS = 10 * 60_000;
const INTENT_RETRY_MAX_MS = 6 * 60 * 60_000;

// ── 消息队列参数 ──────────────────────────────────────────────────────────────

const PER_USER_QUEUE_SIZE = 20;
const MAX_CONCURRENT_USERS = 10;

// ── 公开接口 ─────────────────────────────────────────────────────────────────

export type MessageHandler = (msg: InboundMessage) => Promise<string>;

export interface GatewayConfig {
  appId: string;
  clientSecret: string;
  abortSignal: AbortSignal;
  onMessage: MessageHandler;
  onReady?: () => void;
  log?: {
    info: (m: string) => void;
    error: (m: string) => void;
    debug?: (m: string) => void;
  };
}

// ── 持久化 Session（简单 JSON 文件） ─────────────────────────────────────────

import { getDataFile } from "../../config/loader.js";
import * as fs from "node:fs";
import * as path from "node:path";

interface SessionState {
  sessionId: string;
  lastSeq: number | null;
  appId: string;
}

function getSessionPath(appId: string): string {
  return getDataFile("qqbot", `session-${appId}.json`);
}

function loadSession(appId: string): SessionState | null {
  try {
    const p = getSessionPath(appId);
    const raw = fs.readFileSync(p, "utf-8");
    const s = JSON.parse(raw) as SessionState;
    if (s.appId !== appId) return null;
    return s;
  } catch {
    return null;
  }
}

/**
 * ⚠️ 这里**刻意不持久化意图档位**（旧版本写过 `intentLevelIndex` 字段，现在读出来直接忽略，
 * 下次 saveSession 会把它抹掉）：进程启动一律从最高档试起，历史文件里冻结的降档状态
 * 是"重启也恢复不了收消息"的根因。
 */
function saveSession(s: SessionState): void {
  try {
    const p = getSessionPath(s.appId);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(s, null, 2));
  } catch {
    /* non-critical */
  }
}

function clearSession(appId: string): void {
  try {
    const p = getSessionPath(appId);
    fs.rmSync(p, { force: true });
  } catch {
    /* non-critical */
  }
}

// ── 入口 ─────────────────────────────────────────────────────────────────────

export async function startGateway(cfg: GatewayConfig): Promise<void> {
  const { appId, clientSecret, abortSignal, onMessage, onReady, log } = cfg;

  if (!appId || !clientSecret) {
    throw new Error("QQBot not configured (missing appId or clientSecret)");
  }

  let reconnectAttempts = 0;
  let isAborted = false;
  let currentWs: WebSocket | null = null;
  let heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let sessionId: string | null = null;
  let lastSeq: number | null = null;
  let lastConnectTime = 0;
  let quickDisconnectCount = 0;
  let isConnecting = false;
  let shouldRefreshToken = false;
  let intentLevelIndex = 0;
  let lastSuccessfulIntentLevel = -1;
  let intentRetryDelayMs = INTENT_RETRY_BASE_MS;
  let nextIntentRetryAt = 0;

  // 恢复持久化 Session（只恢复 Resume 所需的 sessionId/seq，不含意图档位）
  const saved = loadSession(appId);
  if (saved) {
    sessionId = saved.sessionId;
    lastSeq = saved.lastSeq;
    log?.info(`[qqbot] Restored session: ${sessionId}, seq=${lastSeq}`);
  }

  // ── 每用户串行消息队列 ──────────────────────────────────────────────────────

  const userQueues = new Map<string, InboundMessage[]>();
  const activeUsers = new Set<string>();
  let handleFnRef: MessageHandler | null = null;

  const drainUserQueue = async (peerId: string): Promise<void> => {
    if (activeUsers.has(peerId)) return;
    if (activeUsers.size >= MAX_CONCURRENT_USERS) return;

    const queue = userQueues.get(peerId);
    if (!queue || queue.length === 0) {
      userQueues.delete(peerId);
      return;
    }

    activeUsers.add(peerId);
    try {
      while (queue.length > 0 && !isAborted) {
        const msg = queue.shift()!;
        try {
          if (handleFnRef) await handleFnRef(msg);
        } catch (e) {
          log?.error(`[qqbot] handler error for ${peerId}: ${e}`);
        }
      }
    } finally {
      activeUsers.delete(peerId);
      userQueues.delete(peerId);
      // 唤醒一个等待中的用户
      for (const [wPeer, wQueue] of userQueues) {
        if (wQueue.length > 0 && !activeUsers.has(wPeer)) {
          drainUserQueue(wPeer);
          break;
        }
      }
    }
  };

  const enqueue = (msg: InboundMessage): void => {
    let q = userQueues.get(msg.peerId);
    if (!q) {
      q = [];
      userQueues.set(msg.peerId, q);
    }
    if (q.length >= PER_USER_QUEUE_SIZE) q.shift();
    q.push(msg);
    drainUserQueue(msg.peerId);
  };

  // ── 重连辅助 ────────────────────────────────────────────────────────────────

  const cleanup = () => {
    if (heartbeatInterval) {
      clearInterval(heartbeatInterval);
      heartbeatInterval = null;
    }
    if (
      currentWs?.readyState === WebSocket.OPEN ||
      currentWs?.readyState === WebSocket.CONNECTING
    ) {
      currentWs.close();
    }
    currentWs = null;
  };

  const scheduleReconnect = (delay?: number) => {
    if (isAborted || reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) return;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    const d =
      delay ??
      RECONNECT_DELAYS[Math.min(reconnectAttempts, RECONNECT_DELAYS.length - 1)] ??
      RECONNECT_DELAYS[RECONNECT_DELAYS.length - 1]!;
    reconnectAttempts++;
    log?.debug?.(`[qqbot] Reconnecting in ${d}ms (attempt ${reconnectAttempts})`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (!isAborted) connect();
    }, d);
  };

  // ── WebSocket 连接 ──────────────────────────────────────────────────────────

  const connect = async () => {
    if (isConnecting) return;
    isConnecting = true;

    try {
      cleanup();

      if (shouldRefreshToken) {
        clearTokenCache(appId);
        shouldRefreshToken = false;
      }

      const token = await getAccessToken(appId, clientSecret);
      const gatewayUrl = await getGatewayUrl(token);
      log?.debug?.(`[qqbot] Connecting to ${gatewayUrl}`);

      const ws = new WebSocket(gatewayUrl);
      currentWs = ws;
      handleFnRef = onMessage;

      ws.on("open", () => {
        log?.debug?.("[qqbot] WebSocket connected");
        isConnecting = false;
        reconnectAttempts = 0;
        lastConnectTime = Date.now();
      });

      ws.on("message", async (raw) => {
        try {
          const payload = JSON.parse(raw.toString()) as WSPayload;
          const { op, d, s, t } = payload;

          if (s !== undefined && s !== null) {
            lastSeq = s;
            if (sessionId) {
              saveSession({ sessionId, lastSeq, appId });
            }
          }

          log?.debug?.(`[qqbot] op=${op} t=${t ?? "-"}`);

          switch (op) {
            case 10: {
              // Hello
              const hb = (d as { heartbeat_interval: number }).heartbeat_interval;
              if (heartbeatInterval) clearInterval(heartbeatInterval);
              heartbeatInterval = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ op: 1, d: lastSeq }));
                  log?.debug?.("[qqbot] Heartbeat sent");
                }
              }, hb);

              if (sessionId && lastSeq !== null) {
                log?.debug?.(`[qqbot] Resuming session ${sessionId}`);
                ws.send(
                  JSON.stringify({
                    op: 6,
                    d: { token: `QQBot ${token}`, session_id: sessionId, seq: lastSeq },
                  })
                );
              } else {
                // 降档到点后先回到最高档重试：权限可能已被重新授予
                if (intentLevelIndex > 0 && Date.now() >= nextIntentRetryAt) {
                  log?.info(
                    `[qqbot] Retrying highest intents after downgrade (was: ${INTENT_LEVELS[intentLevelIndex]!.description})`
                  );
                  intentLevelIndex = 0;
                  lastSuccessfulIntentLevel = -1;
                }
                const lvlIdx =
                  lastSuccessfulIntentLevel >= 0 ? lastSuccessfulIntentLevel : intentLevelIndex;
                const lvl = INTENT_LEVELS[Math.min(lvlIdx, INTENT_LEVELS.length - 1)]!;
                log?.info(`[qqbot] Identify with intents: ${lvl.description}`);
                ws.send(
                  JSON.stringify({
                    op: 2,
                    d: { token: `QQBot ${token}`, intents: lvl.intents, shard: [0, 1] },
                  })
                );
              }
              break;
            }

            case 0: {
              // Dispatch
              if (t === "READY") {
                sessionId = (d as { session_id: string }).session_id;
                lastSuccessfulIntentLevel = intentLevelIndex;
                // 最高档跑通 → 回升节奏复位（下次再被 4013 降档时仍从 10min 起算）
                if (intentLevelIndex === 0) intentRetryDelayMs = INTENT_RETRY_BASE_MS;
                const lvl = INTENT_LEVELS[intentLevelIndex]!;
                log?.info(`[qqbot] Ready: ${lvl.description}, session: ${sessionId}`);
                saveSession({ sessionId, lastSeq, appId });
                onReady?.();
              } else if (t === "RESUMED") {
                log?.debug?.("[qqbot] Session resumed");
                if (sessionId) saveSession({ sessionId, lastSeq, appId });
                onReady?.(); // RESUMED 也视为就绪,触发 restart_tool 续接等逻辑
              } else if (t === "C2C_MESSAGE_CREATE") {
                const ev = d as C2CMessageEvent;
                enqueue({
                  type: "c2c",
                  senderId: ev.author.user_openid,
                  peerId: ev.author.user_openid,
                  content: ev.content,
                  messageId: ev.id,
                  timestamp: ev.timestamp,
                  ...(ev.attachments
                    ? {
                        attachments: ev.attachments.map((a) => ({
                          contentType: a.content_type,
                          url: a.url,
                          ...(a.filename !== undefined ? { filename: a.filename } : {}),
                        })),
                      }
                    : {}),
                });
              } else if (t === "AT_MESSAGE_CREATE") {
                const ev = d as GuildMessageEvent;
                enqueue({
                  type: "guild",
                  senderId: ev.author.id,
                  peerId: ev.channel_id,
                  content: ev.content,
                  messageId: ev.id,
                  timestamp: ev.timestamp,
                  channelId: ev.channel_id,
                  guildId: ev.guild_id,
                  ...(ev.attachments
                    ? {
                        attachments: ev.attachments.map((a) => ({
                          contentType: a.content_type,
                          url: a.url,
                          ...(a.filename !== undefined ? { filename: a.filename } : {}),
                        })),
                      }
                    : {}),
                });
              } else if (t === "DIRECT_MESSAGE_CREATE") {
                const ev = d as GuildMessageEvent;
                enqueue({
                  type: "dm",
                  senderId: ev.author.id,
                  peerId: ev.author.id,
                  content: ev.content,
                  messageId: ev.id,
                  timestamp: ev.timestamp,
                  guildId: ev.guild_id,
                  ...(ev.attachments
                    ? {
                        attachments: ev.attachments.map((a) => ({
                          contentType: a.content_type,
                          url: a.url,
                          ...(a.filename !== undefined ? { filename: a.filename } : {}),
                        })),
                      }
                    : {}),
                });
              } else if (t === "GROUP_AT_MESSAGE_CREATE") {
                const ev = d as GroupMessageEvent;
                enqueue({
                  type: "group",
                  senderId: ev.author.member_openid,
                  peerId: ev.group_openid,
                  content: ev.content,
                  messageId: ev.id,
                  timestamp: ev.timestamp,
                  groupOpenid: ev.group_openid,
                  ...(ev.attachments
                    ? {
                        attachments: ev.attachments.map((a) => ({
                          contentType: a.content_type,
                          url: a.url,
                          ...(a.filename !== undefined ? { filename: a.filename } : {}),
                        })),
                      }
                    : {}),
                });
              }
              break;
            }

            case 11: // Heartbeat ACK
              log?.debug?.("[qqbot] Heartbeat ACK");
              break;

            case 7: // Server-requested reconnect
              log?.info("[qqbot] Server requested reconnect");
              cleanup();
              scheduleReconnect(0);
              break;

            case 9: {
              // Invalid session：**会话**层问题（session 过期 / Resume 被拒）。
              // 处理方式只是清掉 session 后重新 Identify —— 与意图权限无关，
              // 因此这里既不动 intentLevelIndex，也不换 token。
              const canResume = d as boolean;
              log?.error(`[qqbot] Invalid session, can resume: ${canResume}`);
              if (!canResume) {
                sessionId = null;
                lastSeq = null;
                clearSession(appId);
              }
              cleanup();
              scheduleReconnect(3000);
              break;
            }
          }
        } catch (e) {
          log?.error(`[qqbot] Message parse error: ${e}`);
        }
      });

      ws.on("close", (code) => {
        if (code === 1005 || code === 1000) {
          log?.debug?.(`[qqbot] WebSocket closed: ${code}`);
        } else {
          log?.info(`[qqbot] WebSocket closed: ${code}`);
        }
        isConnecting = false;

        if (code === 4914) {
          log?.error("[qqbot] Bot offline/sandbox-only. Not reconnecting.");
          return;
        }
        if (code === 4915) {
          log?.error("[qqbot] Bot is banned. Not reconnecting.");
          return;
        }

        if (code === 4004) {
          shouldRefreshToken = true;
        }
        if (code === 4013) {
          // Invalid intent(s)：**唯一**可以降档的判据（凭据/会话都没问题，是权限不够）
          sessionId = null;
          lastSeq = null;
          clearSession(appId);
          if (intentLevelIndex < INTENT_LEVELS.length - 1) {
            intentLevelIndex++;
            lastSuccessfulIntentLevel = -1;
            nextIntentRetryAt = Date.now() + intentRetryDelayMs;
            log?.error(
              `[qqbot] Invalid intent (4013), downgrading to: ${
                INTENT_LEVELS[intentLevelIndex]!.description
              }（${Math.round(intentRetryDelayMs / 60000)} 分钟后重试最高档）`
            );
            intentRetryDelayMs = Math.min(intentRetryDelayMs * 2, INTENT_RETRY_MAX_MS);
          } else {
            log?.error(
              "[qqbot] Invalid intent (4013) even at the lowest level; check the bot's permission settings in the QQ console."
            );
          }
        }
        if (code === 4006 || code === 4007 || code === 4009 || (code >= 4900 && code <= 4913)) {
          sessionId = null;
          lastSeq = null;
          clearSession(appId);
          shouldRefreshToken = true;
        }

        const dur = Date.now() - lastConnectTime;
        if (dur < QUICK_DISCONNECT_THRESHOLD && lastConnectTime > 0) {
          quickDisconnectCount++;
          if (quickDisconnectCount >= MAX_QUICK_DISCONNECT_COUNT) {
            log?.error("[qqbot] Too many quick disconnects. Check AppID/Secret and permissions.");
            quickDisconnectCount = 0;
            cleanup();
            if (!isAborted) scheduleReconnect(RATE_LIMIT_DELAY);
            return;
          }
        } else {
          quickDisconnectCount = 0;
        }

        cleanup();
        if (!isAborted && code !== 1000) {
          scheduleReconnect(code === 4008 ? RATE_LIMIT_DELAY : undefined);
        }
      });

      ws.on("error", (e) => log?.error(`[qqbot] WebSocket error: ${e.message}`));
    } catch (e) {
      isConnecting = false;
      const msg = String(e);
      log?.error(`[qqbot] Connection failed: ${e}`);
      scheduleReconnect(
        msg.includes("Too many requests") || msg.includes("100001") ? RATE_LIMIT_DELAY : undefined
      );
    }
  };

  abortSignal.addEventListener("abort", () => {
    isAborted = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    cleanup();
  });

  await connect();

  return new Promise((resolve) => {
    abortSignal.addEventListener("abort", () => resolve());
  });
}
