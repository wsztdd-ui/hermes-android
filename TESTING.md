# Testing

## Reproducible checks

The [Android CI workflow](.github/workflows/android.yml) checks out the pinned Hermes Agent renderer, applies the compatibility patch, runs the theme lifecycle regression test and Android unit tests (including same-origin redirect policy), builds the renderer and Android APK, and validates generated assets. A local equivalent is:

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

## Release checks

Before distribution, verify the exact APK's signing certificate fingerprint and checksum,
install it on an Android 8.0+ device or emulator, and test connection,
authentication, chat, attachments, microphone permission, and notifications
against an authorized Gateway. Record any unverified features in the release
notes. CI compilation alone does not establish runtime compatibility.

Test with your own authorized Gateway. Keep credentials, private Gateway URLs, chat content, device identifiers, and screenshots containing personal data out of public reports and CI logs.
