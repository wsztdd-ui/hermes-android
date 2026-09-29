#!/usr/bin/env bash
# 把 Desktop renderer 编译产物（含注入的桥层）复制到 Android assets/www，
# 供 WebViewAssetLoader 加载。
#
# 用法：bash scripts/copy-frontend.sh <distPath>
# 例：  bash scripts/copy-frontend.sh /tmp/hermes-agent/apps/desktop/dist

set -euo pipefail

DIST="${1:?usage: copy-frontend.sh <distPath>}"
ASSETS_DIR="$(cd "$(dirname "$0")/../android/app/src/main/assets" && pwd)"
WWW="$ASSETS_DIR/www"

echo "dist:    $DIST"
echo "target:  $WWW"

if [ ! -d "$DIST" ]; then
  echo "error: dist dir not found: $DIST" >&2
  exit 1
fi

# 清理旧产物，避免残留
rm -rf "$WWW"
mkdir -p "$WWW"

# 复制全部 dist 内容
cp -R "$DIST/." "$WWW/"

echo "=== 复制完成，www 大小：==="
du -sh "$WWW"
echo "=== 关键文件校验：==="
ls -ld "$WWW/index.html" "$WWW/assets" 2>&1

# 校验桥层已注入
if grep -q "hermes-desktop-bridge\|远程网关桥" "$WWW/index.html"; then
  echo "✅ 桥层已注入 index.html"
else
  echo "⚠️  警告：index.html 中未检测到桥层注入标记，请先运行 inject-bridge.mjs"
fi
