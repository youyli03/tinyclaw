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

const GAMMA_API = "https://gamma-api.polymarket.com";
const CLOB_API = "https://clob.polymarket.com";
const DATA_API = "https://data-api.polymarket.com";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PYTHON_HELPER = join(__dirname, "lib", "polymarket.py");

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
      description: "按关键词搜索 Polymarket 市场/事件。返回市场列表（包含问题、价格、成交量等）。",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "搜索关键词，如 \"Bitcoin\" 或 \"election\"" },
          limit: { type: "number", description: "返回数量上限，默认 20，最大 100", default: 20 },
          active: { type: "boolean", description: "只返回活跃市场，默认 true", default: true },
        },
        required: ["query"],
      },
    },
    {
      name: "list_markets",
      description: "列出活跃市场，可按 volume（成交量）或 liquidity（流动性）排序。",
      inputSchema: {
        type: "object",
        properties: {
          limit: { type: "number", description: "返回数量上限，默认 20", default: 20 },
          order: {
            type: "string",
            enum: ["volume24hr", "liquidityNum", "volume"],
            description: "排序字段，默认 volume24hr",
            default: "volume24hr",
          },
          active: { type: "boolean", description: "只返回活跃市场，默认 true", default: true },
          tag: { type: "string", description: "按标签筛选，如 \"crypto\"、\"politics\"" },
        },
        required: [],
      },
    },
    {
      name: "get_market",
      description: "获取单个市场详情，包括 clobTokenIds（订单簿查询用）、价格、成交量等。",
      inputSchema: {
        type: "object",
        properties: {
          slug: { type: "string", description: "市场 slug，如 \"will-bitcoin-reach-100k\"" },
          condition_id: { type: "string", description: "市场 conditionId（0x 开头）" },
        },
        required: [],
      },
    },
    {
      name: "get_orderbook",
      description: "获取指定 outcome token 的订单簿（bids/asks 深度）。token_id 来自 get_market 的 clobTokenIds。",
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
      description: "获取指定 outcome token 的当前价格：中间价(midpoint)、买价(best_bid)、卖价(best_ask)、价差(spread)。",
      inputSchema: {
        type: "object",
        properties: {
          token_id: { type: "string", description: "outcome token ID" },
          side: { type: "string", enum: ["BUY", "SELL"], description: "可选，指定方向" },
        },
        required: ["token_id"],
      },
    },
    {
      name: "get_price_history",
      description: "获取指定 outcome token 的历史价格曲线（时间序列）。",
      inputSchema: {
        type: "object",
        properties: {
          token_id: { type: "string", description: "outcome token ID" },
          interval: {
            type: "string",
            enum: ["1m", "5m", "1h", "6h", "1d", "1w", "max"],
            description: "时间粒度，默认 1d",
            default: "1d",
          },
          fidelity: { type: "number", description: "数据点密度，interval=max 时可指定，如 100" },
          start_ts: { type: "number", description: "开始时间戳（Unix 秒）" },
          end_ts: { type: "number", description: "结束时间戳（Unix 秒）" },
        },
        required: ["token_id"],
      },
    },
    {
      name: "get_trades",
      description: "查询成交记录。可按 maker_address（钱包地址）或 market（conditionId）筛选。",
      inputSchema: {
        type: "object",
        properties: {
          maker_address: { type: "string", description: "钱包地址（0x...）" },
          market: { type: "string", description: "市场 conditionId" },
          limit: { type: "number", description: "返回数量上限，默认 20", default: 20 },
          offset: { type: "number", description: "分页偏移量，默认 0", default: 0 },
        },
        required: [],
      },
    },
    {
      name: "get_positions",
      description: "查询指定钱包地址在 Polymarket 的当前持仓（含盈亏数据）。",
      inputSchema: {
        type: "object",
        properties: {
          user: { type: "string", description: "钱包地址（0x...）" },
          market: { type: "string", description: "按市场 conditionId 筛选（可选）" },
          size_threshold: { type: "number", description: "最小持仓量筛选（可选）" },
          limit: { type: "number", description: "返回数量上限，默认 50", default: 50 },
          offset: { type: "number", description: "分页偏移量，默认 0", default: 0 },
        },
        required: ["user"],
      },
    },
    {
      name: "place_order",
      description: "下单（限价单 GTC/GTD 或市价单 FOK）。需要配置私钥（POLY_PRIVATE_KEY 环境变量或 ~/.tinyclaw/polymarket.key）。",
      inputSchema: {
        type: "object",
        properties: {
          token_id: { type: "string", description: "outcome token ID（来自 clobTokenIds）" },
          side: { type: "string", enum: ["BUY", "SELL"], description: "买入或卖出" },
          order_type: {
            type: "string",
            enum: ["GTC", "GTD", "FOK"],
            description: "GTC/GTD 为限价单，FOK 为市价单",
          },
          price: { type: "number", description: "限价单价格（0~1 之间），市价单不需要" },
          size: { type: "number", description: "限价单份数（shares），市价单不需要" },
          amount: { type: "number", description: "市价单 USDC 金额（FOK 时使用）" },
        },
        required: ["token_id", "side", "order_type"],
      },
    },
    {
      name: "cancel_order",
      description: "撤销指定订单。需要配置私钥。",
      inputSchema: {
        type: "object",
        properties: {
          order_id: { type: "string", description: "订单 ID" },
        },
        required: ["order_id"],
      },
    },
    {
      name: "cancel_all",
      description: "撤销所有未成交挂单。需要配置私钥。",
      inputSchema: {
        type: "object",
        properties: {},
        required: [],
      },
    },
    {
      name: "get_open_orders",
      description: "查看当前未成交挂单列表。需要配置私钥。",
      inputSchema: {
        type: "object",
        properties: {
          market: { type: "string", description: "可选，按市场 conditionId 筛选" },
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
        const data = await apiFetch(`${DATA_API}/trades`, {
          maker_address,
          market,
          limit,
          offset,
        });
        return textResult(data);
      }

      // ── get_positions ───────────────────────────────────────────────────────
      case "get_positions": {
        const { user, market, size_threshold, limit = 50, offset = 0 } = args as {
          user: string;
          market?: string;
          size_threshold?: number;
          limit?: number;
          offset?: number;
        };
        const data = await apiFetch(`${DATA_API}/positions`, {
          user,
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
