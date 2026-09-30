# Hermes Android 1.0.2

Preview of an unofficial Android client for a user-provided Hermes Gateway.
Android `versionCode` is 57 and the app ID is `com.hermes.android`.

## Changes in 1.0.2

- Gateway API redirects stay on the original HTTPS origin. Cross-origin redirects
  are blocked before a request body can be sent to another host.
- Removing the last connection for a Gateway origin clears its stored login
  session and that origin's WebView storage. Other Gateway origins stay signed in.
- Notification previews are off by default; users can opt in from More → Notifications.
- Android CI runs regression tests for redirect origin and method handling.

## Upgrade note

Version 1.0.2 uses a new signing key because the previous private key was not
available. It cannot update a 1.0.1 installation. Uninstall 1.0.1 before
installing this APK; this removes local app data, and you will need to sign in
to your Gateway again.

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
