/**
 * tinyclaw Polymarket MCP Server
 *
 * 只读工具（8个，无需私钥）：
 *   search_markets    — 关键词搜索市场/事件
 *   list_markets      — 列出活跃市场（按 volume/liquidity 排序）
 *   get_market        — 按 slug 或 conditionId 获取市场详情
 *   get_orderbook     — 获取订单簿（bids/asks 深度）
 *   get_price         — 获取中间价/买卖价/价差
 *   get_price_history — 获取价格历史曲线
 *   get_trades        — 全局或指定用户的成交记录
 *   get_positions     — 指定钱包的当前/历史持仓
 *
 * 写操作工具（4个，需要私钥）：
 *   place_order       — 下限价单或市价单
 *   cancel_order      — 撤销指定订单
 *   cancel_all        — 撤销所有未成交订单
 *   get_open_orders   — 查看当前未成交挂单
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { spawnSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";

const GAMMA_API = "https://gamma-api.polymarket.com";
const CLOB_API = "https://clob.polymarket.com";
const DATA_API = "https://data-api.polymarket.com";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PYTHON_HELPER = join(__dirname, "lib", "polymarket.py");

/** Read proxyWallet from ~/.tinyclaw/polymarket.toml, returns undefined if not configured. */
function loadDefaultWallet(): string | undefined {
  const tomlPath = join(homedir(), ".tinyclaw", "polymarket.toml");
  if (!existsSync(tomlPath)) return undefined;
  try {
    const text = readFileSync(tomlPath, "utf-8");
    const m = text.match(/^\s*proxyWallet\s*=\s*"?(0x[0-9a-fA-F]+)"?/m);
    return m?.[1];
  } catch {
    return undefined;
  }
}

const DEFAULT_WALLET = loadDefaultWallet();

async function apiFetch(
  url: string,
  params?: Record<string, string | number | boolean | undefined>
): Promise<unknown> {
  const u = new URL(url);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && String(v) !== "") {
        u.searchParams.set(k, String(v));
      }
    }
  }
  const resp = await fetch(u.toString(), { headers: { Accept: "application/json" } });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status} ${resp.statusText}: ${text.slice(0, 300)}`);
  }
  return resp.json();
}

function callPython(command: string, args: Record<string, unknown>): unknown {
  const result = spawnSync("python3", [PYTHON_HELPER, command, JSON.stringify(args)], {
    encoding: "utf-8",
    timeout: 30000,
  });
  if (result.error) throw new Error(`Python helper 启动失败: ${result.error.message}`);
  const output = result.stdout?.trim();
  if (!output) {
    const stderr = result.stderr?.trim();
    throw new Error(`Python helper 无输出${stderr ? `: ${stderr}` : ""}`);
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(output) as Record<string, unknown>;
  } catch {
    throw new Error(`Python helper 输出非 JSON: ${output.slice(0, 300)}`);
  }
  if (parsed.error) throw new Error(String(parsed.error));
  return parsed;
}

function textResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function errorResult(msg: string) {
  return { content: [{ type: "text" as const, text: `错误: ${msg}` }], isError: true };
}

const server = new Server(
  { name: "polymarket", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "search_markets",
      description:
        "Search Polymarket markets/events by keyword. Returns a market list " +
        "(question, prices, volume, and more).",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search keywords, e.g. \"Bitcoin\" or \"election\"" },
          limit: { type: "number", description: "Maximum number of results, default 20, max 100", default: 20 },
          active: { type: "boolean", description: "Return only active markets, default true", default: true },
        },
        required: ["query"],
      },
    },
    {
      name: "list_markets",
      description: "List active markets, optionally sorted by volume or liquidity.",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Maximum number of results, default 20", default: 20 },
          order: {
            type: "string",
            enum: ["volume24hr", "liquidityNum", "volume"],
            description: "Sort field, default volume24hr",
            default: "volume24hr",
          },
          active: { type: "boolean", description: "Return only active markets, default true", default: true },
          tag: { type: "string", description: "Filter by tag, e.g. \"crypto\", \"politics\"" },
        },
        required: [],
      },
    },
    {
      name: "get_market",
      description:
        "Get one market's details, including clobTokenIds (used for order book queries), " +
        "prices, volume, and more.",
      inputSchema: {
        type: "object",
        properties: {
          slug: { type: "string", description: "Market slug, e.g. \"will-bitcoin-reach-100k\"" },
          condition_id: { type: "string", description: "Market conditionId (starts with 0x)" },
        },
        required: [],
      },
    },
    {
      name: "get_orderbook",
      description:
        "Get the order book (bids/asks depth) of an outcome token. " +
        "token_id comes from clobTokenIds returned by get_market.",
      inputSchema: {
        type: "object",
        properties: {
          token_id: { type: "string", description: "outcome token ID" },
        },
        required: ["token_id"],
      },
    },
    {
      name: "get_price",
      description:
        "Get the current price of an outcome token: midpoint, best_bid, best_ask, spread.",
      inputSchema: {
        type: "object",
        properties: {
          token_id: { type: "string", description: "outcome token ID" },
          side: { type: "string", enum: ["BUY", "SELL"], description: "Optional, restrict to one side" },
        },
        required: ["token_id"],
      },
    },
    {
      name: "get_price_history",
      description: "Get the historical price curve (time series) of an outcome token.",
      inputSchema: {
        type: "object",
        properties: {
          token_id: { type: "string", description: "outcome token ID" },
          interval: {
            type: "string",
            enum: ["1m", "5m", "1h", "6h", "1d", "1w", "max"],
            description: "Time granularity, default 1d",
            default: "1d",
          },
          fidelity: { type: "number", description: "Data point density; only valid when interval=max, e.g. 100" },
          start_ts: { type: "number", description: "Start timestamp (Unix seconds)" },
          end_ts: { type: "number", description: "End timestamp (Unix seconds)" },
        },
        required: ["token_id"],
      },
    },
    {
      name: "get_trades",
      description: `Query trades. Filter by maker_address (wallet address) or market (conditionId). If maker_address is omitted, the configured default wallet is used${DEFAULT_WALLET ? ` (${DEFAULT_WALLET})` : ""}.`,
      inputSchema: {
        type: "object",
        properties: {
          maker_address: { type: "string", description: `Wallet address (0x...); if omitted, the configured default wallet is used${DEFAULT_WALLET ? ` ${DEFAULT_WALLET}` : ""}` },
          market: { type: "string", description: "Market conditionId" },
          limit: { type: "number", description: "Maximum number of results, default 20", default: 20 },
          offset: { type: "number", description: "Pagination offset, default 0", default: 0 },
        },
        required: [],
      },
    },
    {
      name: "get_positions",
      description: `Query the current Polymarket positions of a wallet address (with PnL data). If user is omitted, the wallet address from the config file is used${DEFAULT_WALLET ? ` (${DEFAULT_WALLET})` : " (not configured, pass the user parameter)"}.`,
      inputSchema: {
        type: "object",
        properties: {
          user: { type: "string", description: `Wallet address (0x...); if omitted, the configured default wallet is used${DEFAULT_WALLET ? ` ${DEFAULT_WALLET}` : ""}` },
          market: { type: "string", description: "Filter by market conditionId (optional)" },
          size_threshold: { type: "number", description: "Minimum position size filter (optional)" },
          limit: { type: "number", description: "Maximum number of results, default 50", default: 50 },
          offset: { type: "number", description: "Pagination offset, default 0", default: 0 },
        },
        required: [],
      },
    },
    {
      name: "place_order",
      description:
        "Place an order (limit order GTC/GTD, or market order FOK). Requires a configured " +
        "private key (POLY_PRIVATE_KEY env var or ~/.tinyclaw/polymarket.key).",
      inputSchema: {
        type: "object",
        properties: {
          token_id: { type: "string", description: "outcome token ID (from clobTokenIds)" },
          side: { type: "string", enum: ["BUY", "SELL"], description: "Buy or sell" },
          order_type: {
            type: "string",
            enum: ["GTC", "GTD", "FOK"],
            description: "GTC/GTD are limit orders, FOK is a market order",
          },
          price: { type: "number", description: "Limit order price (between 0 and 1); not used for market orders" },
          size: { type: "number", description: "Limit order size in shares; not used for market orders" },
          amount: { type: "number", description: "Market order amount in USDC (used with FOK)" },
        },
        required: ["token_id", "side", "order_type"],
      },
    },
    {
      name: "cancel_order",
      description: "Cancel one order. Requires a configured private key.",
      inputSchema: {
        type: "object",
        properties: {
          order_id: { type: "string", description: "Order ID" },
        },
        required: ["order_id"],
      },
    },
    {
      name: "cancel_all",
      description: "Cancel all open (unfilled) orders. Requires a configured private key.",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      },
    },
    {
      name: "get_open_orders",
      description: "List the currently open (unfilled) orders. Requires a configured private key.",
      inputSchema: {
        type: "object",
        properties: {
          market: { type: "string", description: "Optional, filter by market conditionId" },
        },
        required: [],
      },
    },
  ],
}));

// ── 工具处理 ───────────────────────────────────────────────────────────────────
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;

  try {
    switch (name) {
      // ── search_markets ──────────────────────────────────────────────────────
      case "search_markets": {
        const { query, limit = 20, active = true } = args as {
          query: string;
          limit?: number;
          active?: boolean;
        };
        const data = await apiFetch(`${GAMMA_API}/markets`, {
          _q: query,
          limit,
          active: active ? "true" : undefined,
          closed: active ? "false" : undefined,
        });
        return textResult(data);
      }

      // ── list_markets ────────────────────────────────────────────────────────
      case "list_markets": {
        const { limit = 20, order = "volume24hr", active = true, tag } = args as {
          limit?: number;
          order?: string;
          active?: boolean;
          tag?: string;
        };
        const data = await apiFetch(`${GAMMA_API}/markets`, {
          limit,
          order,
          ascending: "false",
          active: active ? "true" : undefined,
          closed: active ? "false" : undefined,
          tag,
        });
        return textResult(data);
      }

      // ── get_market ──────────────────────────────────────────────────────────
      case "get_market": {
        const { slug, condition_id } = args as { slug?: string; condition_id?: string };
        if (!slug && !condition_id) {
          return errorResult("slug 或 condition_id 至少提供一个");
        }
        let data: unknown;
        if (slug) {
          data = await apiFetch(`${GAMMA_API}/markets`, { slug });
          // gamma API 返回数组，取第一个
          if (Array.isArray(data) && data.length > 0) data = data[0];
        } else {
          data = await apiFetch(`${GAMMA_API}/markets`, { condition_id });
          if (Array.isArray(data) && data.length > 0) data = data[0];
        }
        return textResult(data);
      }

      // ── get_orderbook ───────────────────────────────────────────────────────
      case "get_orderbook": {
        const { token_id } = args as { token_id: string };
        const data = await apiFetch(`${CLOB_API}/book`, { token_id });
        return textResult(data);
      }

      // ── get_price ───────────────────────────────────────────────────────────
      case "get_price": {
        const { token_id, side } = args as { token_id: string; side?: string };
        // 并发获取 midpoint、spread，以及可选的单方向价格
        const [midpoint, spread] = await Promise.all([
          apiFetch(`${CLOB_API}/midpoint`, { token_id }),
          apiFetch(`${CLOB_API}/spread`, { token_id }),
        ]);
        let sidePrice: unknown = null;
        if (side) {
          sidePrice = await apiFetch(`${CLOB_API}/price`, {
            token_id,
            side: side.toUpperCase(),
          });
        }
        return textResult({ midpoint, spread, side_price: sidePrice, token_id });
      }

      // ── get_price_history ───────────────────────────────────────────────────
      case "get_price_history": {
        const { token_id, interval = "1d", fidelity, start_ts, end_ts } = args as {
          token_id: string;
          interval?: string;
          fidelity?: number;
          start_ts?: number;
          end_ts?: number;
        };
        const data = await apiFetch(`${CLOB_API}/prices-history`, {
          market: token_id,
          interval,
          fidelity,
          startTs: start_ts,
          endTs: end_ts,
        });
        return textResult(data);
      }

      // ── get_trades ──────────────────────────────────────────────────────────
      case "get_trades": {
        const { maker_address, market, limit = 20, offset = 0 } = args as {
          maker_address?: string;
          market?: string;
          limit?: number;
          offset?: number;
        };
        const resolvedAddress = maker_address || DEFAULT_WALLET;
        const data = await apiFetch(`${DATA_API}/trades`, {
          maker_address: resolvedAddress,
          market,
          limit,
          offset,
        });
        return textResult(data);
      }

      // ── get_positions ───────────────────────────────────────────────────────
      case "get_positions": {
        const { user, market, size_threshold, limit = 50, offset = 0 } = args as {
          user?: string;
          market?: string;
          size_threshold?: number;
          limit?: number;
          offset?: number;
        };
        const resolvedUser = user || DEFAULT_WALLET;
        if (!resolvedUser) {
          return errorResult("请传入 user（钱包地址），或在 ~/.tinyclaw/polymarket.toml 配置 proxyWallet");
        }
        const data = await apiFetch(`${DATA_API}/positions`, {
          user: resolvedUser,
          market,
          sizeThreshold: size_threshold,
          limit,
          offset,
        });
        return textResult(data);
      }

      // ── place_order ─────────────────────────────────────────────────────────
      case "place_order": {
        const result = callPython("place_order", args as Record<string, unknown>);
        return textResult(result);
      }

      // ── cancel_order ────────────────────────────────────────────────────────
      case "cancel_order": {
        const result = callPython("cancel_order", args as Record<string, unknown>);
        return textResult(result);
      }

      // ── cancel_all ──────────────────────────────────────────────────────────
      case "cancel_all": {
        const result = callPython("cancel_all", {});
        return textResult(result);
      }

      // ── get_open_orders ─────────────────────────────────────────────────────
      case "get_open_orders": {
        const result = callPython("get_open_orders", args as Record<string, unknown>);
        return textResult(result);
      }

      default:
        return errorResult(`未知工具: ${name}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return errorResult(msg);
  }
});

// ── 启动 ───────────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
