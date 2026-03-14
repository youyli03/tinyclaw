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

export interface Connector {
  start(): Promise<void>;
  stop(): Promise<void>;
  onMessage(handler: (msg: InboundMessage) => Promise<string>): void;
  send(
    peerId: string,
    type: InboundMessage["type"],
    text: string,
    replyToId?: string
  ): Promise<void>;
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
