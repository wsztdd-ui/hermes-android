# Hermes Android 1.0.3

Preview of an unofficial Android client for a user-provided Hermes Gateway.
Android `versionCode` is 58 and the app ID is `com.hermes.android`.

## Changes in 1.0.3

- Long model selection lists now fit within the screen and scroll with vertical
  touch gestures. This covers both provider/subscription choices and model lists.
- Frontend validation checks the model picker height and touch-scroll rules.
- The two-stage model picker was verified on an Android emulator.

## Upgrade note

Version 1.0.3 keeps the signing certificate introduced in 1.0.2 and can update
1.0.2 in place. Version 1.0.1 uses the previous certificate and cannot be
updated directly; uninstall it before installing this APK.

## Included

- Touch-oriented chat, session management, tasks and approvals, skills and MCP controls, file browsing, search, and model selection.
- Multiple Gateway connections with Android Keystore-backed token storage.
- Background notifications and retry of messages queued during connection loss.
- Origin-scoped Gateway sessions and per-Gateway login handling.
- A native WebView bridge restricted to the app's trusted page.

## Verification and limits

CI builds the pinned renderer, runs its theme lifecycle test, and produces
Android Debug and unsigned Release candidates. See [TESTING.md](TESTING.md)
for reproducible checks. Test the exact downloaded APK with your own authorized
Gateway. Voice input, notification delivery, and compatibility across devices
and Gateway versions may vary.

The release page provides the APK, SHA-256 checksum, build information, and
third-party notices. Keep credentials, private URLs, and chat content out of
public reports.
