# Hermes Android 1.0.4

Preview of an unofficial Android client for a user-provided Hermes Gateway.
Android `versionCode` is 59 and the app ID is `com.hermes.android`.

## Changes in 1.0.4

- Added multi-Bot group chat with 2–6 Agent profiles, room management, and
  replies from multiple Bots in one conversation. Requires Gateway `groups.*`
  support.
- Preserved the two-stage provider/model picker and its touch scrolling fix.

## Upgrade note

Version 1.0.4 uses the same signing certificate as 1.0.2 and 1.0.3, so it can
update either version in place. Version 1.0.1 used a different certificate;
upgrading from it requires uninstalling the old app, which clears local data.

## Verification and limits

Multi-Bot group chat was exercised on an Android 14 emulator with an authorized
Gateway: two Bots replied in a temporary room, and the room was then disbanded.
Other devices and Gateway versions still need validation. Voice input and
notification delivery remain device-dependent.

The release page provides the signed APK, SHA-256 checksum, build information,
license, privacy notice, and third-party notices. Keep credentials, private
URLs, and chat content out of public reports.
