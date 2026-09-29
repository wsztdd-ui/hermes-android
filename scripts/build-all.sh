#!/usr/bin/env bash
# 一键构建 Hermes Android APK —— 完整流水线：
#   1. (可选) 重新编译 Desktop renderer 为纯 Web 产物
#   2. 注入「远程网关桥」shim
#   3. 复制产物到 Android assets
#   4. Gradle 打包 debug APK
#
# 前置：
#   - Node.js（编译 renderer）
#   - JDK 17 + Android SDK + Gradle（打 APK）
#   - Desktop renderer 源码（HERMES_SRC，见下）
#
# 用法：
#   HERMES_SRC=/tmp/hermes-agent/apps/desktop bash scripts/build-all.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Desktop renderer 源码路径（apps/desktop 目录）
HERMES_SRC="${HERMES_SRC:-/tmp/hermes-agent/apps/desktop}"
BRIDGE="$ROOT_DIR/bridge/hermes-desktop-bridge.js"
MOBILE_CSS="$ROOT_DIR/bridge/mobile-touch.css"
MOBILE_JS="$ROOT_DIR/bridge/mobile-ui.js"
VIEW_CSS="$ROOT_DIR/bridge/mobile-view.css"
VIEW_JS="$ROOT_DIR/bridge/mobile-view.js"
VIEW_PAGES="$ROOT_DIR/bridge/mobile-view-pages.js"
DIST="$HERMES_SRC/dist"
ASSETS="$ROOT_DIR/android/app/src/main/assets/www"

echo "=============================================="
echo " Hermes Android APK 一键构建"
echo "=============================================="
echo "HERMES_SRC: $HERMES_SRC"
echo "BRIDGE:     $BRIDGE"
echo ""

# 1. 编译 renderer（若 dist 不存在或强制重编）
if [ "${SKIP_VITE:-0}" != "1" ]; then
  echo "[1/4] 编译 Desktop renderer → 纯 Web 产物"
  (cd "$HERMES_SRC" && npx vite build --logLevel warn)
else
  echo "[1/4] 跳过 vite build（SKIP_VITE=1），复用现有 dist"
fi

# 2. 注入桥层
echo "[2/4] 注入远程网关桥 + 独立移动视图"
node "$SCRIPT_DIR/inject-bridge.mjs" "$DIST" "$BRIDGE" "$MOBILE_CSS" "$MOBILE_JS" "$VIEW_CSS" "$VIEW_JS" "$VIEW_PAGES"

# 3. 复制到 android assets
echo "[3/4] 复制产物到 Android assets"
bash "$SCRIPT_DIR/copy-frontend.sh" "$DIST"

echo "[3.5/4] 校验前端产物"
node "$SCRIPT_DIR/validate-frontend.mjs" "$ASSETS"

# 4. 打包 APK
echo "[4/4] Gradle 打包 APK"
bash "$SCRIPT_DIR/build-apk.sh" "$@"

echo ""
echo "=============================================="
echo " ✅ 完成！APK 位置："
echo "    $ROOT_DIR/android/app/build/outputs/apk/debug/app-debug.apk"
echo "=============================================="
