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

/** 供流式会话复用同一个 msg_seq（官方要求同一 StreamSession 复用） */
export function reserveMsgSeq(msgId: string): number {
  return nextMsgSeq(msgId);
}

function buildBody(
  content: string,
  extras?: Record<string, unknown>,
  appId?: string
): Record<string, unknown> {
  const mdSupport = appId !== undefined ? (markdownSupportMap.get(appId) ?? false) : false;
  const base = mdSupport ? { markdown: { content }, msg_type: 2 } : { content, msg_type: 0 };
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
    const resp = await fetch(
      TOKEN_URL,
      withCA({
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appId, clientSecret }),
        signal: AbortSignal.timeout(60_000),
      })
    );
    if (!resp.ok) throw new Error(`Token fetch failed: ${resp.status}`);
    const data = (await resp.json()) as { access_token: string; expires_in: number };
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
  const resp = await fetch(
    `${API_BASE}/gateway`,
    withCA({
      headers: { Authorization: `QQBot ${token}` },
      signal: AbortSignal.timeout(60_000),
    })
  );
  if (!resp.ok) throw new Error(`Gateway fetch failed: ${resp.status}`);
  const data = (await resp.json()) as { url: string };
  return data.url;
}

// ── 发送消息 ──────────────────────────────────────────────────────────────────

async function post(path: string, token: string, body: unknown): Promise<unknown> {
  const resp = await fetch(
    `${API_BASE}${path}`,
    withCA({
      method: "POST",
      headers: {
        Authorization: `QQBot ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    })
  );
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
  await post(
    `/v2/users/${userOpenid}/messages`,
    token,
    buildBody(content, { msg_id: msgId, msg_seq }, appId)
  );
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
  await post(
    `/v2/groups/${groupOpenid}/messages`,
    token,
    buildBody(content, { msg_id: msgId, msg_seq }, appId)
  );
}

// ── C2C 流式消息（POST /v2/users/{openid}/stream_messages）────────────────────

/** 流式接口抛出的错误，携带 HTTP 状态与 QQ err_code 供重试判定 */
export class StreamApiError extends Error {
  constructor(
    readonly status: number,
    readonly errCode: number | undefined,
    message: string
  ) {
    super(message);
    this.name = "StreamApiError";
  }
}

export interface C2CStreamChunk {
  /** 累计正文；`input_mode=replace` 时必须是已下发正文的超集 */
  contentRaw: string;
  /** 1 = 生成中；10 = 生成结束 */
  inputState: 1 | 10;
  /** 分片序号，必须在**每次请求前**递增（含重试） */
  index: number;
  contentType: "text" | "markdown";
  /** 首个分片成功后由服务端返回，后续分片必须携带 */
  streamMsgId?: string;
  /** 被动回复 ID */
  msgId?: string;
  /** 同一 StreamSession 复用同一个 msg_seq */
  msgSeq: number;
}

/**
 * 发送一个流式分片。
 * @returns 首片返回 stream_msg_id；后续分片返回服务端回显的 id
 * @throws StreamApiError 非 2xx（含 40007 前缀不可修改 / 50002 频率限制）
 */
export async function streamC2CMessage(
  token: string,
  userOpenid: string,
  chunk: C2CStreamChunk
): Promise<string | undefined> {
  const body: Record<string, unknown> = {
    input_mode: "replace",
    input_state: chunk.inputState,
    index: chunk.index,
    content_type: chunk.contentType,
    content_raw: chunk.contentRaw,
    msg_seq: chunk.msgSeq,
  };
  if (chunk.streamMsgId) body["stream_msg_id"] = chunk.streamMsgId;
  if (chunk.msgId) body["msg_id"] = chunk.msgId;

  const resp = await fetch(
    `${API_BASE}/v2/users/${userOpenid}/stream_messages`,
    withCA({
      method: "POST",
      headers: {
        Authorization: `QQBot ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    })
  );

  const text = await resp.text().catch(() => "");
  if (!resp.ok) {
    let errCode: number | undefined;
    try {
      const parsed = JSON.parse(text) as { code?: number; err_code?: number };
      errCode = parsed.err_code ?? parsed.code;
    } catch {
      /* 非 JSON 响应 */
    }
    throw new StreamApiError(resp.status, errCode, `stream_messages ${resp.status}: ${text.slice(0, 200)}`);
  }
  try {
    return (JSON.parse(text) as { id?: string }).id;
  } catch {
    return undefined;
  }
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
  await post(
    `/v2/users/${userOpenid}/messages`,
    token,
    buildBody(content, eventId ? { event_id: eventId } : undefined, appId)
  );
}

/** 群主动消息（不依赖 msgId，需申请权限） */
export async function sendProactiveGroupMessage(
  token: string,
  appId: string,
  groupOpenid: string,
  content: string,
  eventId?: string
): Promise<void> {
  await post(
    `/v2/groups/${groupOpenid}/messages`,
    token,
    buildBody(content, eventId ? { event_id: eventId } : undefined, appId)
  );
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
  /** 文件名(type=file 时建议传入,QQ 客户端用于显示) */
  filename?: string;
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
  if (source.filename) body["file_name"] = source.filename;
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
  if (source.filename) body["file_name"] = source.filename;
  if (msgId) body["msg_id"] = msgId;
  if (eventId) body["event_id"] = eventId;
  await post(`/v2/groups/${groupOpenid}/files`, token, body);
}
