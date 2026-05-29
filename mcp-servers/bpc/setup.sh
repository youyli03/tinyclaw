#!/usr/bin/env bash
# bpc-fetch 一键部署脚本
# 运行位置: mcp-servers/bpc/ 目录内
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BPC_DIR="$SCRIPT_DIR/bpc-fetch"

echo "=== [1/4] 克隆 bpc-fetch 源码 ==="
if [ -d "$BPC_DIR" ]; then
  echo "已存在 $BPC_DIR，跳过克隆，拉取最新..."
  git -C "$BPC_DIR" pull
else
  git clone https://github.com/Sophomoresty/bpc-fetch "$BPC_DIR"
fi

echo "=== [2/4] 安装 bpc-fetch ==="
pip install --ignore-requires-python -e "$BPC_DIR"

echo "=== [3/4] 安装依赖补丁 ==="
pip install lxml_html_clean

echo "=== [4/4] 验证安装 ==="
RESULT=$(bpc-fetch doctor 2>&1)
OK=$(echo "$RESULT" | python3 -c "import json,sys; d=json.load(sys.stdin); print('OK' if d.get('ok') else d.get('issues','?'))" 2>/dev/null || echo "parse_error")

if [ "$OK" = "OK" ]; then
  echo "✅ bpc-fetch doctor 通过"
else
  echo "⚠️  doctor 报告: $OK"
  echo "如需 Playwright 浏览器支持，运行: bpc-fetch install-browser"
fi

echo ""
echo "完成！MCP server 启动方式（已在 mcp.toml 中配置）："
echo "  bun run $SCRIPT_DIR/index.ts"
