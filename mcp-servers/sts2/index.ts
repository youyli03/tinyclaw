/**
 * tinyclaw STS2 MCP Server
 *
 * 将 STS2AIAgent Mod 暴露的 HTTP API 包装成 MCP 工具（guided profile）：
 *   health_check          — 检查 Mod 是否在线
 *   get_game_state        — 获取精简游戏状态（agent_view）
 *   get_raw_game_state    — 获取完整原始状态（调试用）
 *   get_available_actions — 列出当前可用操作
 *   act                   — 执行一个游戏操作（核心工具）
 *   get_game_data_item    — 查询单个游戏实体（卡牌/遗物/怪物等）
 *   get_game_data_items   — 批量查询游戏实体
 *   get_relevant_game_data — 按当前场景返回精简字段（节省 token）
 *   wait_for_event        — 等待指定游戏事件（SSE）
 *   wait_until_actionable — 等待游戏进入可操作状态（轮询）
 *
 * 启动方式：bun run /home/lyy/tinyclaw/mcp-servers/sts2/index.ts
 * 配置文件：~/.tinyclaw/mcp-configs/sts2.toml（优先）
 * 环境变量 fallback：STS2_API_BASE_URL / STS2_GAME_DATA_DIR / STS2_API_TIMEOUT_MS / STS2_ACTION_TIMEOUT_MS
 * 配置路径覆盖：STS2_CONFIG_FILE
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ── CONFIG ────────────────────────────────────────────────────────────────────

interface Sts2Config {
  apiBaseUrl: string;
  gameDataDir: string;
  apiTimeoutMs: number;
  actionTimeoutMs: number;
}

/** 极简 TOML 解析（仅支持 key = value，忽略 section 和复杂类型） */
function parseTrivialToml(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("[")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const rawVal = trimmed.slice(eq + 1).trim();
    const val = rawVal.replace(/#.*$/, "").trim().replace(/^"(.*)"$/, "$1");
    result[key] = val;
  }
  return result;
}

function loadConfig(): Sts2Config {
  const configPath =
    process.env["STS2_CONFIG_FILE"] ??
    path.join(os.homedir(), ".tinyclaw", "mcp-configs", "sts2.toml");

  let toml: Record<string, string> = {};
  try {
    if (fs.existsSync(configPath)) {
      toml = parseTrivialToml(fs.readFileSync(configPath, "utf-8"));
    }
  } catch {
    // 读取失败静默 fallback
  }

  const get = (tomlKey: string, envKey: string, defaultVal: string): string =>
    toml[tomlKey] ?? process.env[envKey] ?? defaultVal;

  return {
    apiBaseUrl: get("api_base_url", "STS2_API_BASE_URL", "http://localhost:18080").replace(/\/$/, ""),
    gameDataDir: get(
      "game_data_dir",
      "STS2_GAME_DATA_DIR",
      path.join(os.homedir(), "STS2-Agent", "mcp_server", "data", "eng"),
    ),
    apiTimeoutMs: parseInt(get("api_timeout_ms", "STS2_API_TIMEOUT_MS", "10000"), 10),
    actionTimeoutMs: parseInt(get("action_timeout_ms", "STS2_ACTION_TIMEOUT_MS", "30000"), 10),
  };
}

const CONFIG = loadConfig();

// ── CLIENT ────────────────────────────────────────────────────────────────────

class Sts2ApiError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    public readonly msg: string,
    public readonly details?: unknown,
    public readonly retryable = false,
  ) {
    super(`${code}: ${msg} | http=${statusCode}`);
    this.name = "Sts2ApiError";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sts2Request(
  method: "GET" | "POST",
  urlPath: string,
  payload?: Record<string, unknown>,
  isAction = false,
): Promise<Record<string, unknown>> {
  const timeoutMs = isAction ? CONFIG.actionTimeoutMs : CONFIG.apiTimeoutMs;
  const maxRetries = 2;
  let lastError: Sts2ApiError | null = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      await sleep(500 * Math.pow(2, attempt - 1));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(`${CONFIG.apiBaseUrl}${urlPath}`, {
        method,
        headers: {
          Accept: "application/json",
          ...(payload ? { "Content-Type": "application/json; charset=utf-8" } : {}),
        },
        body: payload ? JSON.stringify(payload) : undefined,
        signal: controller.signal,
      });

      clearTimeout(timer);
      const body = (await res.json()) as Record<string, unknown>;

      if (!res.ok) {
        const err = (body["error"] as Record<string, unknown>) ?? {};
        const apiErr = new Sts2ApiError(
          res.status,
          (err["code"] as string) ?? "http_error",
          (err["message"] as string) ?? `HTTP ${res.status}`,
          err["details"],
          Boolean(err["retryable"]),
        );
        if (!apiErr.retryable || attempt >= maxRetries) throw apiErr;
        lastError = apiErr;
        continue;
      }

      if (!body["ok"]) {
        const err = (body["error"] as Record<string, unknown>) ?? {};
        throw new Sts2ApiError(
          200,
          (err["code"] as string) ?? "unknown_error",
          (err["message"] as string) ?? "Request failed.",
          err["details"],
          Boolean(err["retryable"]),
        );
      }

      const data = body["data"];
      if (data === undefined || data === null) return body;
      if (typeof data !== "object" || Array.isArray(data)) return { result: data };
      return data as Record<string, unknown>;
    } catch (e) {
      clearTimeout(timer);
      if (e instanceof Sts2ApiError) throw e;

      const connErr = new Sts2ApiError(
        0,
        "connection_error",
        `Cannot reach STS2 mod at ${CONFIG.apiBaseUrl}. Ensure the game is running and the mod is loaded. (${String(e)})`,
        { path: urlPath },
        true,
      );
      if (attempt >= maxRetries) throw connErr;
      lastError = connErr;
    }
  }

  throw lastError ?? new Sts2ApiError(0, "unknown_error", "Unknown error");
}

async function getAgentState(): Promise<Record<string, unknown>> {
  const state = await sts2Request("GET", "/state");
  const agentView = state["agent_view"];
  if (agentView && typeof agentView === "object" && !Array.isArray(agentView)) {
    const av = agentView as Record<string, unknown>;
    if (!("available_actions" in av) && Array.isArray(av["actions"])) {
      return { ...av, available_actions: av["actions"] };
    }
    return av;
  }
  return state;
}

// ── GAME DATA ─────────────────────────────────────────────────────────────────

const gameDataIndexCache = new Map<string, Map<string, unknown>>();

function buildGameDataIndex(collection: string): Map<string, unknown> {
  const filePath = path.join(CONFIG.gameDataDir, `${collection}.json`);
  if (!fs.existsSync(filePath)) {
    throw new Error(
      `Unknown game data collection: "${collection}" (file not found: ${filePath})`,
    );
  }

  const raw = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
  const index = new Map<string, unknown>();

  const addItem = (id: string, item: unknown) => {
    const normalized = id.trim();
    if (!normalized) return;
    index.set(normalized, item);
    index.set(normalized.toUpperCase(), item);
    index.set(normalized.toLowerCase(), item);
  };

  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (typeof item !== "object" || item === null) continue;
      const obj = item as Record<string, unknown>;
      const id = obj["id"] ?? obj["ID"] ?? obj["Id"];
      if (id) addItem(String(id), item);
    }
  } else if (typeof raw === "object" && raw !== null) {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      addItem(k, v);
    }
  }

  return index;
}

function getGameDataIndex(collection: string): Map<string, unknown> {
  if (!gameDataIndexCache.has(collection)) {
    gameDataIndexCache.set(collection, buildGameDataIndex(collection));
  }
  return gameDataIndexCache.get(collection)!;
}

function lookupItem(collection: string, itemId: string): unknown | null {
  const index = getGameDataIndex(collection);
  return (
    index.get(itemId) ??
    index.get(itemId.toUpperCase()) ??
    index.get(itemId.toLowerCase()) ??
    null
  );
}

function filterFields(item: unknown, fields: string[]): unknown {
  if (!item || typeof item !== "object" || Array.isArray(item)) return item;
  const obj = item as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const f of fields) {
    if (f in obj) result[f] = obj[f];
  }
  return result;
}

// ── SCENE ─────────────────────────────────────────────────────────────────────

const SCENE_COMBAT_KEYWORDS = ["combat"];
const SCENE_COMBAT_NAMES = new Set(["combat_reward", "combat_victory"]);
const SCENE_SHOP_KEYWORDS = ["shop", "merchant"];
const SCENE_EVENT_KEYWORDS = ["event"];
const SCENE_EVENT_NAMES = new Set(["event_room", "ancient_event"]);

function detectScene(screen: string): "combat" | "shop" | "event" | "menu" {
  const s = screen.toLowerCase();
  if (SCENE_COMBAT_NAMES.has(s) || SCENE_COMBAT_KEYWORDS.some((k) => s.includes(k))) return "combat";
  if (SCENE_SHOP_KEYWORDS.some((k) => s.includes(k))) return "shop";
  if (SCENE_EVENT_NAMES.has(s) || SCENE_EVENT_KEYWORDS.some((k) => s.includes(k))) return "event";
  return "menu";
}

type SceneFieldSets = Record<string, Record<string, string[]>>;

const SCENE_FIELD_SETS: SceneFieldSets = {
  combat: {
    cards: ["id","name","description","type","rarity","target","cost","is_x_cost","star_cost","is_x_star_cost","damage","block","keywords","tags","vars","upgrade"],
    monsters: ["id","name","type","min_hp","max_hp","moves","damage_values","block_values"],
    powers: ["id","name","description","type","stack_type"],
  },
  shop: {
    cards: ["id","name","description","type","rarity","cost"],
    relics: ["id","name","description","rarity","pool"],
    potions: ["id","name","description","rarity"],
  },
  event: {
    events: ["id","name","description","options"],
  },
};

// ── TOOLS ─────────────────────────────────────────────────────────────────────

function wrapError(e: unknown): { content: Array<{ type: string; text: string }>; isError: true } {
  const msg = e instanceof Sts2ApiError ? e.message : String(e);
  return { content: [{ type: "text", text: msg }], isError: true };
}

function wrapOk(data: unknown): { content: Array<{ type: string; text: string }> } {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

const TOOLS = [
  {
    name: "health_check",
    description: "Check whether the STS2 AI Agent Mod is loaded and reachable.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_game_state",
    description: "Read the compact agent-facing game state snapshot (agent_view).",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_raw_game_state",
    description: "Read the full raw /state snapshot for debugging or schema inspection.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "get_available_actions",
    description: "List currently executable actions with requires_index and requires_target hints.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "act",
    description: `Execute one currently available game action through the compact tool surface.

Usage loop:
  1. Call get_game_state() or get_available_actions().
  2. Branch on state.session.mode and state.session.phase.
  3. Pick an action that is currently available.
  4. Pass only the indices required by that action from the latest state.
  5. Read state again after the action completes.

Rules:
  - Only call action names present in state.available_actions.
  - Use card_index for play_card.
  - Use option_index for map, reward, shop, event, rest, selection actions.
  - Use target_index only when the latest state marks a card or potion as requires_target=true.
  - run_console_command is not available in this tool.`,
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", description: "Action name from available_actions." },
        card_index: { type: "number", description: "Card index for play_card." },
        target_index: { type: "number", description: "Target index when requires_target=true." },
        option_index: { type: "number", description: "Option index for map/reward/shop/event/rest/selection actions." },
      },
      required: ["action"],
    },
  },
  {
    name: "get_game_data_item",
    description: `Return a single item from a game metadata collection by id.
Example: get_game_data_item(collection='cards', item_id='ABRASIVE')
Available collections: cards, relics, monsters, potions, powers, events, keywords, characters, acts, encounters, epochs, stories, enchantments, afflictions, orbs, modifiers, intents, ascensions, achievements, translations`,
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string", description: "Collection name, e.g. 'cards', 'relics', 'monsters'." },
        item_id: { type: "string", description: "Item id (case-insensitive)." },
      },
      required: ["collection", "item_id"],
    },
  },
  {
    name: "get_game_data_items",
    description: "Return multiple items (by comma-separated ids) from a collection.",
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string", description: "Collection name." },
        item_ids: { type: "string", description: "Comma-separated item ids." },
      },
      required: ["collection", "item_ids"],
    },
  },
  {
    name: "get_relevant_game_data",
    description: `Return items with only the most relevant fields for the current game context.
Automatically detects the current scene (combat/shop/event/menu) and returns only the fields most
useful for AI decision-making in that context, minimizing token usage.
Recommended for most queries instead of get_game_data_items.`,
    inputSchema: {
      type: "object",
      properties: {
        collection: { type: "string", description: "Collection name, e.g. 'cards', 'monsters'." },
        item_ids: { type: "string", description: "Comma-separated item ids." },
      },
      required: ["collection", "item_ids"],
    },
  },
  {
    name: "wait_for_event",
    description: `Wait for one matching game event from /events/stream (SSE).
- event_names: comma-separated event names. Empty means accept any event.
- timeout_seconds: maximum wait time before returning matched=false.`,
    inputSchema: {
      type: "object",
      properties: {
        event_names: { type: "string", description: "Comma-separated event names to match. Empty = any event.", default: "" },
        timeout_seconds: { type: "number", description: "Max wait time in seconds.", default: 20 },
      },
      required: [],
    },
  },
  {
    name: "wait_until_actionable",
    description: "Poll /state until available_actions is non-empty or timeout expires.",
    inputSchema: {
      type: "object",
      properties: {
        timeout_seconds: { type: "number", description: "Max wait time in seconds.", default: 20 },
      },
      required: [],
    },
  },
] as const;

// ── TOOL HANDLERS ─────────────────────────────────────────────────────────────

async function handleHealthCheck() {
  try {
    return wrapOk(await sts2Request("GET", "/health"));
  } catch (e) {
    return wrapError(e);
  }
}

async function handleGetGameState() {
  try {
    return wrapOk(await getAgentState());
  } catch (e) {
    return wrapError(e);
  }
}

async function handleGetRawGameState() {
  try {
    return wrapOk(await sts2Request("GET", "/state"));
  } catch (e) {
    return wrapError(e);
  }
}

async function handleGetAvailableActions() {
  try {
    const payload = await sts2Request("GET", "/actions/available");
    const actions = Array.isArray(payload["actions"]) ? payload["actions"] : [];
    return wrapOk(actions);
  } catch (e) {
    return wrapError(e);
  }
}

async function handleAct(args: Record<string, unknown>) {
  const action = String(args["action"] ?? "").trim().toLowerCase();
  if (!action) return wrapError("action is required");
  if (action === "run_console_command") {
    return wrapError("run_console_command is not available in this tool surface.");
  }
  try {
    const result = await sts2Request(
      "POST",
      "/action",
      {
        action,
        card_index: args["card_index"] !== undefined ? Number(args["card_index"]) : null,
        target_index: args["target_index"] !== undefined ? Number(args["target_index"]) : null,
        option_index: args["option_index"] !== undefined ? Number(args["option_index"]) : null,
        command: null,
        client_context: { source: "mcp", tool_name: "act", tool_profile: "guided" },
      },
      true,
    );
    return wrapOk(result);
  } catch (e) {
    return wrapError(e);
  }
}

function handleGetGameDataItem(args: Record<string, unknown>) {
  const collection = String(args["collection"] ?? "").trim();
  const itemId = String(args["item_id"] ?? "").trim();
  if (!collection || !itemId) return wrapError("collection and item_id are required");
  try {
    const item = lookupItem(collection, itemId);
    if (item === null) return wrapOk(null);
    return wrapOk(item);
  } catch (e) {
    return wrapError(e);
  }
}

function handleGetGameDataItems(args: Record<string, unknown>) {
  const collection = String(args["collection"] ?? "").trim();
  const itemIds = String(args["item_ids"] ?? "").trim();
  if (!collection || !itemIds) return wrapError("collection and item_ids are required");
  try {
    const ids = itemIds.split(",").map((s) => s.trim()).filter(Boolean);
    const result: Record<string, unknown> = {};
    for (const id of ids) {
      result[id] = lookupItem(collection, id);
    }
    return wrapOk(result);
  } catch (e) {
    return wrapError(e);
  }
}

async function handleGetRelevantGameData(args: Record<string, unknown>) {
  const collection = String(args["collection"] ?? "").trim();
  const itemIds = String(args["item_ids"] ?? "").trim();
  if (!collection || !itemIds) return wrapError("collection and item_ids are required");
  try {
    // 检测当前场景
    let scene: "combat" | "shop" | "event" | "menu" = "menu";
    try {
      const state = await sts2Request("GET", "/state");
      const screen = String(state["screen"] ?? "");
      scene = detectScene(screen);
    } catch {
      // 场景检测失败时 fallback 到全量返回
    }

    const fieldSet = SCENE_FIELD_SETS[scene]?.[collection];
    const ids = itemIds.split(",").map((s) => s.trim()).filter(Boolean);
    const result: Record<string, unknown> = {};

    for (const id of ids) {
      const item = lookupItem(collection, id);
      result[id] = fieldSet ? filterFields(item, fieldSet) : item;
    }
    return wrapOk(result);
  } catch (e) {
    return wrapError(e);
  }
}

async function handleWaitForEvent(args: Record<string, unknown>) {
  const eventNamesRaw = String(args["event_names"] ?? "").trim();
  const timeoutSecs = Math.max(0.1, Number(args["timeout_seconds"] ?? 20));
  const targetNames = new Set(
    eventNamesRaw ? eventNamesRaw.split(",").map((s) => s.trim()).filter(Boolean) : [],
  );

  const deadline = Date.now() + timeoutSecs * 1000;

  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(remaining + 500, CONFIG.actionTimeoutMs));

    try {
      const res = await fetch(`${CONFIG.apiBaseUrl}/events/stream`, {
        headers: { Accept: "text/event-stream", "Cache-Control": "no-cache" },
        signal: controller.signal,
      });

      clearTimeout(timer);
      if (!res.ok || !res.body) break;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let eventName: string | null = null;
      let dataLines: string[] = [];

      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        for (const line of chunk.split("\n")) {
          const trimmed = line.trimEnd();

          if (trimmed === "") {
            // Dispatch event
            if (eventName !== null || dataLines.length > 0) {
              const name = eventName ?? "message";
              const rawData = dataLines.join("\n");
              let parsedData: unknown = rawData;
              try { parsedData = JSON.parse(rawData); } catch { /* keep string */ }

              if (targetNames.size === 0 || targetNames.has(name)) {
                reader.cancel();
                return wrapOk({ matched: true, event: name, data: parsedData });
              }
              eventName = null;
              dataLines = [];
            }
            continue;
          }

          if (trimmed.startsWith(":")) continue; // comment

          const colonIdx = trimmed.indexOf(":");
          if (colonIdx === -1) continue;
          const field = trimmed.slice(0, colonIdx);
          const val = trimmed.slice(colonIdx + 1).replace(/^ /, "");

          if (field === "event") eventName = val;
          else if (field === "data") dataLines.push(val);
        }
      }
      reader.cancel();
    } catch {
      clearTimeout(timer);
      await sleep(500);
    }
  }

  return wrapOk({ matched: false, timeout: true });
}

async function handleWaitUntilActionable(args: Record<string, unknown>) {
  const timeoutSecs = Math.max(0.1, Number(args["timeout_seconds"] ?? 20));
  const deadline = Date.now() + timeoutSecs * 1000;
  const pollIntervalMs = 500;

  while (Date.now() < deadline) {
    try {
      const state = await getAgentState();
      const actions = state["available_actions"];
      if (Array.isArray(actions) && actions.length > 0) {
        return wrapOk({ actionable: true, state });
      }
    } catch {
      // 继续轮询
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(pollIntervalMs, remaining));
  }

  return wrapOk({ actionable: false, timeout: true });
}

// ── SERVER ────────────────────────────────────────────────────────────────────

const server = new Server(
  { name: "sts2", version: "0.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  const a = args as Record<string, unknown>;

  switch (name) {
    case "health_check":          return handleHealthCheck();
    case "get_game_state":        return handleGetGameState();
    case "get_raw_game_state":    return handleGetRawGameState();
    case "get_available_actions": return handleGetAvailableActions();
    case "act":                   return handleAct(a);
    case "get_game_data_item":    return handleGetGameDataItem(a);
    case "get_game_data_items":   return handleGetGameDataItems(a);
    case "get_relevant_game_data":return handleGetRelevantGameData(a);
    case "wait_for_event":        return handleWaitForEvent(a);
    case "wait_until_actionable": return handleWaitUntilActionable(a);
    default:
      return { content: [{ type: "text", text: `Unknown tool: ${name}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
