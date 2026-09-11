export interface Attachment {
  contentType: string;
  url: string;
  filename?: string;
  /** 语音消息的 WAV 直链（QQ 官方提供，可跳过 SILK→WAV 转换） */
  voiceWavUrl?: string;
}

export interface InboundMessage {
  type: "c2c" | "group" | "guild" | "dm";
  senderId: string;
  /** 路由 key：私聊=senderId，群=groupOpenid，频道=channelId */
  peerId: string;
  content: string;
  messageId: string;
  timestamp: string;
  attachments?: Attachment[];
  /** 群 openid（type=group 时有值） */
  groupOpenid?: string;
  /** 频道 ID（type=guild 时有值） */
  channelId?: string;
  /** 频道服务器 ID */
  guildId?: string;
}

/**
 * 一次发送的结果。
 *
 * 存在的理由：文本 + 富媒体标签可能**部分成功**——正文发出去了，但某个 `<audio>` /
 * `<file>` 标签因为类型不匹配或体积超限失败，被静默降级成纯文本。
 * 调用方（`main.ts` 的流式路径）据此打**真实**日志，而不是无脑宣称送达。
 */
export interface SendOutcome {
  /** 原始内容里是否含媒体标签 */
  hadMedia: boolean;
  /** 是否有媒体标签发送失败（已降级为文本） */
  mediaFailed: boolean;
  /** 首个失败原因摘要，仅在 mediaFailed 时有值 */
  mediaError?: string;
}

export interface Connector {
  start(): Promise<void>;
  stop(): Promise<void>;
  onMessage(handler: (msg: InboundMessage) => Promise<string>): void;
  send(
    peerId: string,
    type: InboundMessage["type"],
    text: string,
    replyToId?: string
  ): Promise<SendOutcome>;
}

// ── QQ 官方 API 原始类型 ──────────────────────────────────────────────────────

export interface WSPayload {
  op: number;
  d?: unknown;
  s?: number;
  t?: string;
}

export interface C2CMessageEvent {
  id: string;
  author: { id: string; user_openid: string };
  content: string;
  timestamp: string;
  attachments?: Array<{ content_type: string; url: string; filename?: string }>;
}

export interface GroupMessageEvent {
  id: string;
  author: { member_openid: string };
  group_openid: string;
  content: string;
  timestamp: string;
  attachments?: Array<{ content_type: string; url: string; filename?: string }>;
}

export interface GuildMessageEvent {
  id: string;
  author: { id: string; username: string };
  channel_id: string;
  guild_id: string;
  content: string;
  timestamp: string;
  attachments?: Array<{ content_type: string; url: string; filename?: string }>;
}
