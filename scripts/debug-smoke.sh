#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ANDROID_DIR="$ROOT_DIR/android"
SDK_ROOT="${ANDROID_HOME:-/opt/homebrew/share/android-commandlinetools}"
export ANDROID_HOME="$SDK_ROOT"
export PATH="$SDK_ROOT/platform-tools:$PATH"

ADB="${ADB:-adb}"
PKG="com.hermes.android"
APK="$ANDROID_DIR/app/build/outputs/apk/debug/app-debug.apk"

"$ADB" wait-for-device
test -f "$APK" || { echo "missing $APK; run ./gradlew :app:assembleDebug first" >&2; exit 1; }
"$ADB" install -r "$APK" >/dev/null
"$ADB" shell am force-stop "$PKG"
"$ADB" shell am start -n "$PKG/.MainActivity" >/dev/null
sleep 3

if ! "$ADB" shell dumpsys activity activities | grep -q "$PKG/.MainActivity"; then
  echo "Hermes Activity did not stay in foreground" >&2
  exit 1
fi

if "$ADB" logcat -d -t 400 | grep -Eq 'FATAL EXCEPTION|AndroidRuntime: FATAL'; then
  echo "fatal Android exception detected" >&2
  exit 1
fi

mkdir -p "$ROOT_DIR/captures"
"$ADB" exec-out screencap -p > "$ROOT_DIR/captures/debug-smoke.png"
echo "debug smoke OK: $PKG; screenshot=$ROOT_DIR/captures/debug-smoke.png"
