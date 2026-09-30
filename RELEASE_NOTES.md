# Hermes Android 1.0.1

Preview of an unofficial Android client for a user-provided Hermes Gateway.
Android `versionCode` is 56 and the app ID is `com.hermes.android`.

## Changes in 1.0.1

- Native requests follow redirects manually (up to 5 hops): session cookies and
  auth headers are sent only to the request's declared cookie scope origin and
  stripped on any cross-origin hop; https-to-http downgrades are not followed.
  Login POST requests still do not follow redirects.
- Logout clears only the connection it targets, not every stored Gateway session.

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
