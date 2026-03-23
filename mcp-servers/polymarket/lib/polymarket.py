#!/usr/bin/env python3
"""
polymarket.py — Polymarket 下单 / 撤单 helper（由 MCP server 的 place_order / cancel_order 调用）

用法（由 index.ts spawnSync 调用）：
  python3 polymarket.py place_order   <json_args>
  python3 polymarket.py cancel_order  <json_args>
  python3 polymarket.py cancel_all    <json_args>
  python3 polymarket.py get_api_creds <json_args>

所有输出均为 JSON（stdout），错误时 {"error": "..."}

认证：
  私钥从 POLY_PRIVATE_KEY 环境变量读取，或从 ~/.tinyclaw/polymarket.key 读取。
  funder 地址（proxy wallet）从 POLY_FUNDER 环境变量或 ~/.tinyclaw/polymarket_funder.key 读取（可选）。
  signature_type 从 POLY_SIG_TYPE 环境变量读取，默认 0（EOA）。
"""

import sys
import json
import os
from pathlib import Path

HOST = "https://clob.polymarket.com"
CHAIN_ID = 137  # Polygon mainnet


def load_private_key() -> str | None:
    key = os.environ.get("POLY_PRIVATE_KEY")
    if key:
        return key.strip()
    key_file = Path.home() / ".tinyclaw" / "polymarket.key"
    if key_file.exists():
        return key_file.read_text().strip()
    return None


def load_funder() -> str | None:
    funder = os.environ.get("POLY_FUNDER")
    if funder:
        return funder.strip()
    funder_file = Path.home() / ".tinyclaw" / "polymarket_funder.key"
    if funder_file.exists():
        return funder_file.read_text().strip()
    return None


def load_sig_type() -> int:
    return int(os.environ.get("POLY_SIG_TYPE", "0"))


def build_client():
    from py_clob_client.client import ClobClient

    pk = load_private_key()
    if not pk:
        raise ValueError(
            "未找到私钥。请设置 POLY_PRIVATE_KEY 环境变量，"
            "或将私钥写入 ~/.tinyclaw/polymarket.key"
        )

    funder = load_funder()
    sig_type = load_sig_type()

    client = ClobClient(
        HOST,
        key=pk,
        chain_id=CHAIN_ID,
        signature_type=sig_type,
        funder=funder,
    )
    client.set_api_creds(client.create_or_derive_api_creds())
    return client


def cmd_get_api_creds(args: dict) -> dict:
    """获取/派生 API 凭证（用于验证私钥配置是否正确）"""
    client = build_client()
    creds = client.create_or_derive_api_creds()
    return {
        "address": client.get_address(),
        "api_key": creds.api_key,
        "ok": True,
    }


def cmd_place_order(args: dict) -> dict:
    """
    下限价单或市价单。
    args:
      token_id   : str   — outcome token ID
      side       : "BUY" | "SELL"
      order_type : "GTC" | "GTD" | "FOK" | "market"
      price      : float — 限价单必填（0~1），市价单忽略
      size       : float — shares 数量（限价单）
      amount     : float — USDC 金额（市价单，FOK）
    """
    from py_clob_client.clob_types import OrderArgs, MarketOrderArgs, OrderType
    from py_clob_client.order_builder.constants import BUY, SELL

    client = build_client()

    token_id = args["token_id"]
    side_str = args["side"].upper()
    side = BUY if side_str == "BUY" else SELL
    order_type_str = args.get("order_type", "GTC").upper()

    if order_type_str in ("FOK", "MARKET"):
        amount = float(args["amount"])
        order_args = MarketOrderArgs(token_id=token_id, amount=amount, side=side)
        signed = client.create_market_order(order_args)
        resp = client.post_order(signed, OrderType.FOK)
    else:
        price = float(args["price"])
        size = float(args["size"])
        order_type = OrderType.GTC if order_type_str == "GTC" else OrderType.GTD
        order_args = OrderArgs(token_id=token_id, price=price, size=size, side=side)
        signed = client.create_order(order_args)
        resp = client.post_order(signed, order_type)

    return {"success": True, "response": resp}


def cmd_cancel_order(args: dict) -> dict:
    """撤销单个订单。args: order_id"""
    client = build_client()
    resp = client.cancel(args["order_id"])
    return {"success": True, "response": resp}


def cmd_cancel_all(args: dict) -> dict:
    """撤销所有订单。"""
    client = build_client()
    resp = client.cancel_all()
    return {"success": True, "response": resp}


def cmd_get_open_orders(args: dict) -> dict:
    """获取未成交订单列表。args: market(optional conditionId)"""
    client = build_client()
    params = {}
    if args.get("market"):
        params["market"] = args["market"]
    orders = client.get_orders(**params)
    return {"orders": orders}


COMMANDS = {
    "get_api_creds": cmd_get_api_creds,
    "place_order": cmd_place_order,
    "cancel_order": cmd_cancel_order,
    "cancel_all": cmd_cancel_all,
    "get_open_orders": cmd_get_open_orders,
}

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print(json.dumps({"error": "用法: polymarket.py <command> [json_args]"}))
        sys.exit(1)

    command = sys.argv[1]
    raw_args = sys.argv[2] if len(sys.argv) > 2 else "{}"

    try:
        args = json.loads(raw_args)
    except json.JSONDecodeError as e:
        print(json.dumps({"error": f"JSON 解析失败: {e}"}))
        sys.exit(1)

    if command not in COMMANDS:
        print(json.dumps({"error": f"未知命令: {command}，可用: {list(COMMANDS.keys())}"}))
        sys.exit(1)

    try:
        result = COMMANDS[command](args)
        print(json.dumps(result, default=str))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
        sys.exit(1)
