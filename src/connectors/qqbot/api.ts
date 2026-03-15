/**
 * QQ Bot 官方 API 封装
 * 移植自 openclaw qqbot 插件，去掉框架依赖
 */

const API_BASE = "https://api.sgroup.qq.com";
const TOKEN_URL = "https://bots.qq.com/app/getAppAccessToken";

let cachedToken: { token: string; expiresAt: number; appId: string } | null = null;
let tokenFetchPromise: Promise<string> | null = null;

let markdownSupport = true;

export function initMarkdownSupport(enabled: boolean): void {
  markdownSupport = enabled;
}

function buildBody(
  content: string,
  extras?: Record<string, unknown>
): Record<string, unknown> {
  const base = markdownSupport
    ? { markdown: { content }, msg_type: 2 }
    : { content, msg_type: 0 };
  return extras ? { ...base, ...extras } : base;
}

export function clearTokenCache(): void {
  cachedToken = null;
  tokenFetchPromise = null;
}

export async function getAccessToken(appId: string, clientSecret: string): Promise<string> {
  if (
    cachedToken &&
    Date.now() < cachedToken.expiresAt - 5 * 60 * 1000 &&
    cachedToken.appId === appId
  ) {
    return cachedToken.token;
  }

  if (cachedToken && cachedToken.appId !== appId) {
    cachedToken = null;
    tokenFetchPromise = null;
  }

  if (tokenFetchPromise) return tokenFetchPromise;

  tokenFetchPromise = (async () => {
    const resp = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appId, clientSecret }),
    });
    if (!resp.ok) throw new Error(`Token fetch failed: ${resp.status}`);
    const data = await resp.json() as { access_token: string; expires_in: number };
    cachedToken = {
      token: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
      appId,
    };
    tokenFetchPromise = null;
    return cachedToken.token;
  })();

  return tokenFetchPromise;
}

export async function getGatewayUrl(token: string): Promise<string> {
  const resp = await fetch(`${API_BASE}/gateway`, {
    headers: { Authorization: `QQBot ${token}` },
  });
  if (!resp.ok) throw new Error(`Gateway fetch failed: ${resp.status}`);
  const data = await resp.json() as { url: string };
  return data.url;
}

// ── 发送消息 ──────────────────────────────────────────────────────────────────

async function post(path: string, token: string, body: unknown): Promise<unknown> {
  const resp = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `QQBot ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    throw new Error(`API ${path} failed ${resp.status}: ${detail.slice(0, 200)}`);
  }
  return resp.json();
}

/** C2C（私聊）被动回复 */
export async function sendC2CMessage(
  token: string,
  userOpenid: string,
  content: string,
  msgId: string
): Promise<void> {
  await post(`/v2/users/${userOpenid}/messages`, token, buildBody(content, { msg_id: msgId }));
}

/** 群消息被动回复 */
export async function sendGroupMessage(
  token: string,
  groupOpenid: string,
  content: string,
  msgId: string
): Promise<void> {
  await post(`/v2/groups/${groupOpenid}/messages`, token, buildBody(content, { msg_id: msgId }));
}

/** 频道消息回复 */
export async function sendChannelMessage(
  token: string,
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
  userOpenid: string,
  content: string,
  eventId?: string
): Promise<void> {
  await post(`/v2/users/${userOpenid}/messages`, token,
    buildBody(content, eventId ? { event_id: eventId } : undefined));
}

/** 群主动消息（不依赖 msgId，需申请权限） */
export async function sendProactiveGroupMessage(
  token: string,
  groupOpenid: string,
  content: string,
  eventId?: string
): Promise<void> {
  await post(`/v2/groups/${groupOpenid}/messages`, token,
    buildBody(content, eventId ? { event_id: eventId } : undefined));
}
