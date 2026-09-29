# Hermes Android 1.0.0

First public preview of the unofficial Android client for a user-provided Hermes Gateway. Android `versionCode` is 55.

## Included

- Touch-oriented chat, session management, tasks and approvals, skills and MCP controls, file browsing, search, and model selection.
- Multiple Gateway connections with Android Keystore-backed token storage.
- Background notification bridge and retry of messages queued during connection loss.
- Origin-scoped OAuth cookies and per-Gateway login flow handling.

## Verification and limits

The Debug APK passed 67/67 regression checks on one vivo Android 16 device connected to a Gateway. The system notification drawer was not verified because notifications were disabled at the device level. Voice input, a broader device matrix, and a production-signed APK remain unverified. The unsigned Release build passed build checks but was not installed or runtime-tested. See [TESTING.md](TESTING.md).

Install only the Debug APK linked on the [release page](https://github.com/wsztdd-ui/hermes-android/releases/tag/v1.0.0). It uses a debug signing key and cannot upgrade an installation signed with another key.
