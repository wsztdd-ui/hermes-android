# Testing

## Reproducible checks

The [Android CI workflow](.github/workflows/android.yml) checks out the pinned Hermes Agent renderer, applies the compatibility patch, runs the theme lifecycle regression test, builds the renderer and Android APK, and validates generated assets. A local equivalent is:

```bash
git clone https://github.com/NousResearch/hermes-agent.git /tmp/hermes-agent
git -C /tmp/hermes-agent checkout 26f178e5fa78c691cadf847058ef1d55a707bfb0
git -C /tmp/hermes-agent apply --unidiff-zero "$PWD/patches/hermes-android-theme-async-effect.patch"
(cd /tmp/hermes-agent && npm ci)
(cd /tmp/hermes-agent/apps/desktop && npx vitest run src/themes/context.test.tsx)
HERMES_SRC=/tmp/hermes-agent/apps/desktop bash scripts/build-all.sh
node scripts/validate-frontend.mjs
```

With an Android 8.0+ emulator attached, `./scripts/debug-smoke.sh` installs and launches the Debug APK, checks for a fatal Android exception, and saves a screenshot under the ignored `captures/` directory. This smoke check does not exercise an authenticated Gateway session.

## 1.0.0 device result

The 1.0.0 Debug APK (`versionCode` 55) passed 67/67 regression checks on a vivo Android 16 device connected to a Gateway. The checks covered chat, sessions, search, files, tasks and approvals, skills and MCP, model switching, reconnect and message retry, and notification bridge payloads. Viewports of 390×844, 800×1024, and 1280×800 were checked. This result applies to that Debug APK and device; it does not establish broad device compatibility.

System notification drawer delivery was not verified because the device's app notification switch was off. Voice input was not accepted. The unsigned Release variant compiled with lintVital and R8, but it was not installed or runtime-tested. A production-signed release still needs signature verification and device testing.

Test with your own authorized Gateway. Keep credentials, private Gateway URLs, chat content, device identifiers, and screenshots containing personal data out of public reports and CI logs.
