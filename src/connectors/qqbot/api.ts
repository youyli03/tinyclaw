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

/** 单个流式分片的响应 */
export interface StreamChunkResult {
  /** 消息 ID：首片即后续分片必须携带的 `stream_msg_id` */
  id?: string;
  /**
   * 平台回报的**流式消息剩余长度（字符数）**。
   *
   * ⚠️ 这是**硬约束**：整条流式消息有长度上限，超过之后平台**不再应用**后续分片
   * （请求仍返回 200，不会报错），消息会永久停在"生成中"，最后一片 `input_state=10` 也丢掉。
   * 因此必须读它、按它截断，并把装不下的部分改用普通发送（见 `C2CStreamSession`）。
   * 响应未带该字段时为 undefined。
   */
  remainMsgLen?: number;
}

/**
 * 发送一个流式分片。
 * @returns 首片返回 `stream_msg_id`；同时带回平台的剩余长度回报
 * @throws StreamApiError 非 2xx（含 40007 前缀不可修改 / 50002 频率限制）
 */
export async function streamC2CMessage(
  token: string,
  userOpenid: string,
  chunk: C2CStreamChunk
): Promise<StreamChunkResult> {
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
    const parsed = JSON.parse(text) as { id?: string; remain_msg_len?: number };
    return {
      ...(typeof parsed.id === "string" ? { id: parsed.id } : {}),
      ...(typeof parsed.remain_msg_len === "number" ? { remainMsgLen: parsed.remain_msg_len } : {}),
    };
  } catch {
    return {};
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

/**
 * QQ 官方 `file_type` 枚举（**顺序容易记错，勿凭直觉改**）。
 *
 * 官方文档（富媒体消息概述 / 单聊富媒体上传）：
 * | file_type | 类型 | 格式 | 软限制 | 硬限制 |
 * |---|---|---|---|---|
 * | 1 | 图片 | png/jpg | 20 MB | 200 MB |
 * | 2 | **视频** | mp4 | 30 MB | 200 MB |
 * | 3 | **语音** | silk | 20 MB | 200 MB |
 * | 4 | 文件 | 任意 | 200 MB | 200 MB |
 *
 * 历史 bug：这里曾是 `{img:1, audio:2, video:3}`，把**音频与视频的值弄反了** ——
 * mp3 被按"视频(mp4)"校验，服务端直接 400「富媒体文件格式不支持」(850019/40034002)。
 */
const FILE_TYPE: Record<"img" | "audio" | "video" | "file", 1 | 2 | 3 | 4> = {
  img: 1,
  video: 2,
  audio: 3,
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

// ── 分片上传（大文件；内联 base64 上限 ~10 MB 时的唯一出路）────────────────────
//
// 官方流程（单聊/群聊端点一致，仅路径前缀不同，见 rich-media 文档）：
//   1. POST /{base}/upload_prepare       → upload_id + block_size + 各片预签名 URL
//   2. PUT  {presigned_url}              逐片上传分片数据
//   3. POST /{base}/upload_part_finish   通知服务端某片完成（带上该片 md5）
//   4. POST /{base}/files  携带 upload_id 合并 → 返回 file_info
//   5. POST /{base}/messages  msg_type=7 + media.file_info 真正发出
//
// 注意 `file_size` / `block_size` 在协议里都是**字符串**，md5_10m 是**前 10,002,432 字节**
// （约 9.54 MB）的 MD5，不是整个文件的 MD5。

/** 单聊 = user（openid），群聊 = group（group_openid） */
export type MediaTarget = { kind: "user" | "group"; id: string };

function mediaBase(target: MediaTarget): string {
  return target.kind === "user" ? `/v2/users/${target.id}` : `/v2/groups/${target.id}`;
}

export interface UploadPrepareOptions {
  mediaType: "img" | "audio" | "video" | "file";
  fileSize: number;
  fileName: string;
  md5: string;
  sha1: string;
  md5_10m: string;
}

export interface UploadPartRef {
  index: number;
  presignedUrl: string;
  blockSize: number;
}

export interface UploadPrepareResult {
  uploadId: string;
  blockSize: number;
  parts: UploadPartRef[];
  concurrency: number;
}

/** 第一步：预上传，拿 upload_id 与分片预签名 URL */
export async function uploadPrepare(
  token: string,
  target: MediaTarget,
  opts: UploadPrepareOptions
): Promise<UploadPrepareResult> {
  const raw = (await post(`${mediaBase(target)}/upload_prepare`, token, {
    file_type: FILE_TYPE[opts.mediaType],
    file_size: String(opts.fileSize),
    file_name: opts.fileName,
    md5: opts.md5,
    sha1: opts.sha1,
    md5_10m: opts.md5_10m,
  })) as {
    upload_id?: string;
    block_size?: string;
    parts?: Array<{ index?: number; presigned_url?: string; block_size?: string }>;
    upload_config?: { concurrency?: number };
  };

  const uploadId = raw.upload_id;
  if (!uploadId) throw new Error("upload_prepare 未返回 upload_id");

  const parts: UploadPartRef[] = (raw.parts ?? [])
    .filter((p) => p.presigned_url)
    .map((p) => ({
      index: p.index ?? 0,
      presignedUrl: p.presigned_url!,
      blockSize: Number(p.block_size ?? raw.block_size ?? 0),
    }));
  if (parts.length === 0) throw new Error("upload_prepare 未返回任何分片预签名 URL");
  parts.sort((a, b) => a.index - b.index);

  const fallbackBlock = Number(raw.block_size ?? 0);
  for (const p of parts) {
    if (!Number.isFinite(p.blockSize) || p.blockSize <= 0) p.blockSize = fallbackBlock;
  }

  return {
    uploadId,
    blockSize: fallbackBlock,
    parts,
    concurrency: raw.upload_config?.concurrency ?? 1,
  };
}

/**
 * 第二步：把一片数据 PUT 到预签名 URL。
 * 预签名 URL 自带鉴权（COS），**不要**带 Authorization 头。
 */
export async function putUploadPart(
  presignedUrl: string,
  data: Buffer,
  timeoutMs = 120_000
): Promise<void> {
  const resp = await fetch(presignedUrl, {
    method: "PUT",
    body: new Uint8Array(data),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`分片 PUT 失败 ${resp.status}: ${detail.slice(0, 200)}`);
  }
}

/** 第三步：通知服务端该分片完成 */
export async function uploadPartFinish(
  token: string,
  target: MediaTarget,
  opts: { uploadId: string; partIndex: number; blockSize: number; md5: string }
): Promise<void> {
  await post(`${mediaBase(target)}/upload_part_finish`, token, {
    upload_id: opts.uploadId,
    part_index: opts.partIndex,
    block_size: String(opts.blockSize),
    md5: opts.md5,
  });
}

/** 第四步：携带 upload_id 合并，返回可用于发消息的 file_info */
export async function mergeChunkedUpload(
  token: string,
  target: MediaTarget,
  opts: { mediaType: "img" | "audio" | "video" | "file"; fileName?: string; uploadId: string }
): Promise<{ fileInfo: string; ttl: number }> {
  const raw = (await post(`${mediaBase(target)}/files`, token, {
    file_type: FILE_TYPE[opts.mediaType],
    srv_send_msg: false, // false → 只返回 file_info，由我们单独发消息
    ...(opts.fileName ? { file_name: opts.fileName } : {}),
    upload_id: opts.uploadId,
  })) as { file_info?: string; ttl?: number };

  if (!raw.file_info) throw new Error("分片上传合并未返回 file_info");
  return { fileInfo: raw.file_info, ttl: raw.ttl ?? 0 };
}

/**
 * 第五步：用 file_info 发送富媒体消息（`msg_type=7`）。
 *
 * `msg_id` + `msg_seq` 同时给出时走**被动回复**（不占主动消息频次），
 * 否则为主动消息。
 */
export async function sendMediaByFileInfo(
  token: string,
  target: MediaTarget,
  fileInfo: string,
  opts?: { msgId?: string; msgSeq?: number }
): Promise<void> {
  const body: Record<string, unknown> = {
    content: "",
    msg_type: 7,
    media: { file_info: fileInfo },
  };
  if (opts?.msgId) {
    body["msg_id"] = opts.msgId;
    body["msg_seq"] = opts.msgSeq ?? nextMsgSeq(opts.msgId);
  }
  await post(`${mediaBase(target)}/messages`, token, body);
}
