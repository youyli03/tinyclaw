/**
 * QQ Bot 官方 API 封装
 * 移植自 openclaw qqbot 插件，去掉框架依赖
 */

import { withCA } from "../../utils/tls.js";

const API_BASE = "https://api.sgroup.qq.com";
const TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";

const tokenCache = new Map<string, { token: string; expiresAt: number }>();
const tokenFetchPromises = new Map<string, Promise<string>>();

const markdownSupportMap = new Map<string, boolean>();

export function initMarkdownSupport(appId: string, enabled: boolean): void {
  markdownSupportMap.set(appId, enabled);
}

/** 每个 msg_id 对应的下一个 msg_seq 值（从 1 开始递增），用于避免去重错误 */
const msgSeqCounter = new Map<string, number>();

function nextMsgSeq(msgId: string): number {
  const seq = (msgSeqCounter.get(msgId) ?? 0) + 1;
  msgSeqCounter.set(msgId, seq);
  return seq;
}

function buildBody(
  content: string,
  extras?: Record<string, unknown>,
  appId?: string
): Record<string, unknown> {
  const mdSupport = appId !== undefined ? (markdownSupportMap.get(appId) ?? true) : true;
  const base = mdSupport
    ? { markdown: { content }, msg_type: 2 }
    : { content, msg_type: 0 };
  return extras ? { ...base, ...extras } : base;
}

export function clearTokenCache(appId?: string): void {
  if (appId) {
    tokenCache.delete(appId);
    tokenFetchPromises.delete(appId);
  } else {
    tokenCache.clear();
    tokenFetchPromises.clear();
  }
}

export async function getAccessToken(appId: string, clientSecret: string): Promise<string> {
  const cached = tokenCache.get(appId);
  if (cached && Date.now() < cached.expiresAt - 5 * 60 * 1000) {
    return cached.token;
  }

  const inflight = tokenFetchPromises.get(appId);
  if (inflight) return inflight;

  const fetchPromise = (async () => {
    const resp = await fetch(TOKEN_URL, withCA({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appId, clientSecret }),
      signal: AbortSignal.timeout(60_000),
    }));
    if (!resp.ok) throw new Error(`Token fetch failed: ${resp.status}`);
    const data = await resp.json() as { access_token: string; expires_in: number };
    tokenCache.set(appId, {
      token: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    });
    tokenFetchPromises.delete(appId);
    return data.access_token;
  })();

  tokenFetchPromises.set(appId, fetchPromise);
  return fetchPromise;
}

export async function getGatewayUrl(token: string): Promise<string> {
  const resp = await fetch(`${API_BASE}/gateway`, withCA({
    headers: { Authorization: `QQBot ${token}` },
    signal: AbortSignal.timeout(60_000),
  }));
  if (!resp.ok) throw new Error(`Gateway fetch failed: ${resp.status}`);
  const data = await resp.json() as { url: string };
  return data.url;
}

// ── 发送消息 ──────────────────────────────────────────────────────────────────

async function post(path: string, token: string, body: unknown): Promise<unknown> {
  const resp = await fetch(`${API_BASE}${path}`, withCA({
    method: "POST",
    headers: {
      Authorization: `QQBot ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  }));
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`API ${path} failed ${resp.status}: ${detail.slice(0, 200)}`);
  }
  return resp.json();
}

/** C2C（私聊）被动回复 */
export async function sendC2CMessage(
  token: string,
  appId: string,
  userOpenid: string,
  content: string,
  msgId: string
): Promise<void> {
  const msg_seq = nextMsgSeq(msgId);
  await post(`/v2/users/${userOpenid}/messages`, token, buildBody(content, { msg_id: msgId, msg_seq }, appId));
}

/** 群消息被动回复 */
export async function sendGroupMessage(
  token: string,
  appId: string,
  groupOpenid: string,
  content: string,
  msgId: string
): Promise<void> {
  const msg_seq = nextMsgSeq(msgId);
  await post(`/v2/groups/${groupOpenid}/messages`, token, buildBody(content, { msg_id: msgId, msg_seq }, appId));
}

/** 频道消息回复 */
export async function sendChannelMessage(
  token: string,
  appId: string,
  channelId: string,
  content: string,
  msgId?: string
): Promise<void> {
  await post(`/channels/${channelId}/messages`, token, {
    content,
    ...(msgId ? { msg_id: msgId } : {}),
  });
}

/** C2C 主动消息（不依赖 msgId，需申请权限） */
export async function sendProactiveC2CMessage(
  token: string,
  appId: string,
  userOpenid: string,
  content: string,
  eventId?: string
): Promise<void> {
  await post(`/v2/users/${userOpenid}/messages`, token,
    buildBody(content, eventId ? { event_id: eventId } : undefined, appId));
}

/** 群主动消息（不依赖 msgId，需申请权限） */
export async function sendProactiveGroupMessage(
  token: string,
  appId: string,
  groupOpenid: string,
  content: string,
  eventId?: string
): Promise<void> {
  await post(`/v2/groups/${groupOpenid}/messages`, token,
    buildBody(content, eventId ? { event_id: eventId } : undefined, appId));
}

// ── 富媒体发送 ─────────────────────────────────────────────────────────────

/** QQ file_type 枚举：1=图片 2=语音 3=视频 4=文件 */
const FILE_TYPE: Record<"img" | "audio" | "video" | "file", 1 | 2 | 3 | 4> = {
  img: 1,
  audio: 2,
  video: 3,
  file: 4,
};

interface MediaSource {
  /** 公网可访问 URL（与 fileData 二选一） */
  url?: string;
  /** base64 编码的文件内容（与 url 二选一） */
  fileData?: string;
}

/** C2C 私聊媒体消息（srv_send_msg=true，上传即发送） */
export async function sendC2CMedia(
  token: string,
  userOpenid: string,
  mediaType: "img" | "audio" | "video" | "file",
  source: MediaSource,
  msgId?: string,
  eventId?: string
): Promise<void> {
  const body: Record<string, unknown> = {
    file_type: FILE_TYPE[mediaType],
    srv_send_msg: true,
  };
  if (source.url) body["url"] = source.url;
  if (source.fileData) body["file_data"] = source.fileData;
  if (msgId) body["msg_id"] = msgId;
  if (eventId) body["event_id"] = eventId;
  await post(`/v2/users/${userOpenid}/files`, token, body);
}

/** 群媒体消息（srv_send_msg=true，上传即发送） */
export async function sendGroupMedia(
  token: string,
  groupOpenid: string,
  mediaType: "img" | "audio" | "video" | "file",
  source: MediaSource,
  msgId?: string,
  eventId?: string
): Promise<void> {
  const body: Record<string, unknown> = {
    file_type: FILE_TYPE[mediaType],
    srv_send_msg: true,
  };
  if (source.url) body["url"] = source.url;
  if (source.fileData) body["file_data"] = source.fileData;
  if (msgId) body["msg_id"] = msgId;
  if (eventId) body["event_id"] = eventId;
  await post(`/v2/groups/${groupOpenid}/files`, token, body);
}
