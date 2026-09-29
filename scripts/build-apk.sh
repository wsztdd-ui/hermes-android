#!/usr/bin/env bash
# 一键构建 Hermes Android APK
#
# 前置依赖：JDK 17、Android SDK（platform/build-tools 34）
#
# 用法：BUILD_TYPE=debug bash scripts/build-apk.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ANDROID_DIR="$ROOT_DIR/android"

if [ -n "${JAVA_HOME:-}" ]; then export PATH="$JAVA_HOME/bin:$PATH"; fi
ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}"
if [ -z "$ANDROID_HOME" ]; then
  echo "Set ANDROID_HOME (or ANDROID_SDK_ROOT) to your Android SDK directory." >&2
  exit 2
fi
export ANDROID_HOME ANDROID_SDK_ROOT="$ANDROID_HOME"

echo "JAVA_HOME: $JAVA_HOME"
echo "ANDROID_HOME: $ANDROID_HOME"

# Keep APK contents in sync with the checked-in mobile bridge and UI. This
# makes the direct local build path safe too; build-all.sh remains compatible
# because injection is idempotent.
node "$SCRIPT_DIR/inject-bridge.mjs" \
  "$ANDROID_DIR/app/src/main/assets/www" \
  "$ROOT_DIR/bridge/hermes-desktop-bridge.js" \
  "$ROOT_DIR/bridge/mobile-touch.css" \
  "$ROOT_DIR/bridge/mobile-ui.js" \
  "$ROOT_DIR/bridge/mobile-view.css" \
  "$ROOT_DIR/bridge/mobile-view.js" \
  "$ROOT_DIR/bridge/mobile-view-pages.js"

# 写入 local.properties，让 AGP 找到 SDK
cat > "$ANDROID_DIR/local.properties" <<EOF
sdk.dir=$ANDROID_HOME
EOF

cd "$ANDROID_DIR"

BUILD_TYPE="${BUILD_TYPE:-debug}"
case "$BUILD_TYPE" in
  debug) GRADLE_TASK=assembleDebug ;;
  release) GRADLE_TASK=assembleRelease ;;
  *) echo "BUILD_TYPE must be debug or release" >&2; exit 2 ;;
esac

echo "using repository-pinned Gradle wrapper"
./gradlew ":app:$GRADLE_TASK" "$@"

echo ""
echo "=== 构建完成，APK 位置：==="
ls -la "$ANDROID_DIR/app/build/outputs/apk/$BUILD_TYPE/" 2>/dev/null || echo "（未找到 APK，检查上方错误）"
