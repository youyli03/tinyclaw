# Polymarket MCP Server

Polymarket 预测市场的 MCP 服务器，支持行情查询、持仓查看和下单交易。

## API 结构

Polymarket 有三个独立 Base URL：

| Base URL | 职责 | 认证 |
|---|---|---|
| `https://gamma-api.polymarket.com` | 市场/事件元数据、搜索、排行榜 | 只读免认证 |
| `https://clob.polymarket.com` | 订单簿、实时价格、下单/撤单 | 只读免认证；写操作需签名 |
| `https://data-api.polymarket.com` | 成交流水、用户持仓 | 只读免认证 |

## 认证机制（下单）

Polymarket 下单是 HTTP POST API，但 body 和 header 中需要携带签名：

```
Level 0（只读）
  → 直接调 API，无认证
  → GET /markets, /book, /price, /positions 等

Level 1（获取 API Key）
  → POST /auth/api-key
  → Header: POLY_ADDRESS + POLY_SIGNATURE（EIP-712 签名时间戳）
  → 返回 api_key / api_secret / passphrase

Level 2（下单/撤单）
  → POST /order
  → Header: POLY_API_KEY + POLY_SIGNATURE（HMAC）
  → Body: { order: { ..., signature: "0x..." }, orderType: "GTC" }
         其中 order.signature 是对订单结构体的 EIP-712 签名
```

**EIP-712** 是以太坊结构化数据签名标准，需要一个以太坊私钥（Polygon 链）。
`py-clob-client` SDK 已封装全部签名逻辑，调用方只需提供私钥。

### 私钥配置

下单功能需要配置私钥（只读功能无需）：

```bash
# 方式一：环境变量
export POLY_PRIVATE_KEY="0x..."
export POLY_FUNDER="0x..."       # 可选，proxy wallet 地址
export POLY_SIG_TYPE="0"         # 0=EOA(默认), 1=Email/Magic, 2=Browser proxy

# 方式二：文件（推荐）
echo "0x..." > ~/.tinyclaw/polymarket.key
echo "0x..." > ~/.tinyclaw/polymarket_funder.key  # 可选
```

## 计划工具列表（10个）

### 只读工具（无需私钥）

| 工具名 | 说明 | 数据来源 |
|---|---|---|
| `search_markets` | 关键词搜索市场/事件 | gamma-api `/markets?q=` |
| `list_markets` | 列出活跃市场，按 volume/liquidity 排序 | gamma-api `/markets` |
| `get_market` | 按 slug 或 conditionId 获取市场详情 | gamma-api + clob |
| `get_orderbook` | 获取订单簿（bids/asks 深度）| clob `/book` |
| `get_price` | 获取中间价/买卖价/价差 | clob `/midpoint`, `/price`, `/spread` |
| `get_price_history` | 获取价格历史曲线 | clob `/prices-history` |
| `get_trades` | 全局或指定用户的成交记录 | data-api `/trades` |
| `get_positions` | 指定钱包地址的当前/历史持仓 | data-api `/positions` |

### 写操作工具（需要私钥）

| 工具名 | 说明 |
|---|---|
| `place_order` | 下限价单（GTC/GTD）或市价单（FOK） |
| `cancel_order` | 撤销指定订单 |
| `cancel_all` | 撤销所有未成交订单 |
| `get_open_orders` | 查看当前未成交挂单 |

## 关键数据结构

### Market（市场）

```json
{
  "id": "...",
  "question": "Will Bitcoin reach $100k?",
  "slug": "will-bitcoin-reach-100k",
  "conditionId": "0x...",
  "outcomes": "[\"Yes\", \"No\"]",
  "outcomePrices": "[\"0.72\", \"0.28\"]",
  "clobTokenIds": "[\"<yes_token_id>\", \"<no_token_id>\"]",
  "volume24hr": 1234567.89,
  "liquidityNum": 98765.43,
  "active": true,
  "closed": false,
  "endDate": "2025-12-31T00:00:00Z"
}
```

> `clobTokenIds` 中的 token_id 是 CLOB 订单簿/价格查询的关键参数

### 持仓（Position）

```json
{
  "proxyWallet": "0x...",
  "asset": "<token_id>",
  "conditionId": "0x...",
  "title": "Will Bitcoin reach $100k?",
  "outcome": "Yes",
  "size": 150.5,
  "avgPrice": 0.65,
  "currentValue": 108.0,
  "cashPnl": 10.75,
  "percentPnl": 11.0,
  "realizedPnl": 5.0,
  "endDate": "2025-12-31T00:00:00Z"
}
```

### 下单参数

```json
// 限价单
{
  "token_id": "<yes_token_id>",
  "side": "BUY",
  "order_type": "GTC",
  "price": 0.65,
  "size": 100.0
}

// 市价单（按 USDC 金额）
{
  "token_id": "<yes_token_id>",
  "side": "BUY",
  "order_type": "FOK",
  "amount": 50.0
}
```

## 文件结构

```
mcp-servers/polymarket/
├── README.md          ← 本文档
├── package.json
├── index.ts           ← MCP server 主体（待实现）
└── lib/
    └── polymarket.py  ← 下单/撤单 Python helper（已实现，调用 py-clob-client）
```

## 依赖

- **Bun**（运行 index.ts）
- **Python 3.9+** + **py-clob-client**（下单功能）：`pip install py-clob-client`
- **@modelcontextprotocol/sdk**

## 注册到 mcp.toml（待添加）

```toml
[servers.polymarket]
enabled = true
transport = "stdio"
command = "bun"
args = ["/home/lyy/tinyclaw/mcp-servers/polymarket/index.ts"]
description = "Polymarket 预测市场：搜索市场/查询价格订单簿/持仓/下单撤单"
```

## 实现进度

- [x] `lib/polymarket.py` — 下单/撤单 Python helper
- [x] `package.json`
- [x] `README.md`（本文档）
- [ ] `index.ts` — MCP server 主体
- [ ] 注册到 `mcp.toml`
