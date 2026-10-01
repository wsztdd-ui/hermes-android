# Hermes Android

> **Important:** This is an unofficial community client and is not affiliated with Nous Research. Before using it, you must provide your own reachable Hermes Gateway that you are authorized to access. This project does not provide a Gateway, hosting, accounts, or credentials.
> **重要：** 这是非官方社区客户端，与 Nous Research 无隶属关系。使用前，你必须自行准备一个可从手机访问、并且你有权使用的 **Hermes Gateway**。本项目不提供 Gateway、托管服务、账号或访问凭据。

English · [简体中文](README.md)

Hermes Android is a native Android client. It hosts the Hermes Desktop renderer in Android WebView and adds a touch-friendly mobile interface. The renderer is pinned to an upstream Hermes Agent commit and adapted with patches maintained in this repository; see [`patches/`](patches/) and the [Android CI workflow](.github/workflows/android.yml).

This project was built entirely with AI: AI wrote the code and documentation, while the maintainer supplied requirements and tested the app.

## Status

- Source version: `1.0.3` (Android `versionCode 58`).
- The project is in preview. Compatibility with different Gateway versions, vendor WebViews, and foldable devices still needs validation in users' environments.
- The renderer theme-switching fix is maintained as a reviewable patch and applied by CI to the pinned Hermes upstream commit.
- Voice input, system notifications, and a broad device matrix need further validation. See [testing notes](TESTING.md) and [release instructions](docs/RELEASING.md).

## Features

- **Full client in one interface** (the app uses its own rendered interface at all screen sizes): chat; session pinning, renaming, archiving, and deletion; tasks with approval/question cards and scheduled tasks; skills and tool toggles; MCP management; and file browsing, preview, editing, and download to the phone.
- In-chat search with highlighted navigation and full-text search across sessions; artifact and command centers; messaging platform status; and an overview of Agents processes.
- Background notifications for new replies and execution approvals, with taps returning to the relevant session. Notifications can be disabled under More. Android notification permission and the device manufacturer's notification setting must allow them.
- Per-session model selection and a global default model setting with provider-then-model selection.
- Multi-Bot group chats: create shared rooms with 2–6 Agent profiles, follow each Bot's replies, and continue the conversation (requires Gateway `groups.*` support).
- Automatic retry for messages queued during network outages; sent images appear as thumbnails and open full-screen when tapped.
- Multiple Gateway connections and switching; credentials are encrypted with Android Keystore.
- The desktop renderer remains inside the app for Gateway bridging, authentication, and recovery. The desktop-mode entry point has been removed. StarMap is not in navigation until its mobile page is implemented.

## Build from source

### Requirements

- macOS, Linux, or Windows/WSL (a platform supported by Android Gradle Plugin)
- JDK 17
- Android SDK: Android 14 / API 34 platform and Build Tools
- Node.js 22 and npm
- `git` and network access to the upstream Hermes repository

### Build a debug APK

Clone this repository, then run the following from its root directory:

```bash
git clone https://github.com/NousResearch/hermes-agent.git /tmp/hermes-agent
git -C /tmp/hermes-agent checkout 26f178e5fa78c691cadf847058ef1d55a707bfb0
git -C /tmp/hermes-agent apply --unidiff-zero "$PWD/patches/hermes-android-theme-async-effect.patch"
(cd /tmp/hermes-agent && npm ci)
export ANDROID_HOME="$HOME/Android/Sdk" # set this to your Android SDK path
export JAVA_HOME="/path/to/jdk-17"      # set this to your JDK 17 path
HERMES_SRC=/tmp/hermes-agent/apps/desktop bash scripts/build-all.sh
```

The output is `android/app/build/outputs/apk/debug/app-debug.apk`. `build-all.sh` builds the renderer, injects the Android bridge and mobile styles, validates generated assets, and runs the Gradle Wrapper. The first build downloads dependencies.

If the Android project already has generated `assets/www`, you can package it with `BUILD_TYPE=debug bash scripts/build-apk.sh`. For a fresh clone, use the complete `build-all.sh` flow.

### Install and connect

After installing the APK, go to **More → Gateway Connection Management → Add new connection** and enter your own reachable HTTPS Gateway URL. Sign in using that Gateway's authentication method. See the [getting started guide](docs/QUICKSTART.md) for step-by-step instructions. Do not put passwords, session cookies, access tokens, or private Gateway addresses in source code, issue reports, or screenshots.

### Download APK

Download from [Releases](https://github.com/wsztdd-ui/hermes-android/releases/latest):

| File | Notes |
|---|---|
| `Hermes-Android-v1.0.3-signed.apk` | Release variant; see `BUILD_INFO.txt` for the signing certificate fingerprint. |

Verify integrity with the `SHA256SUMS` file on the Release page; build and version details are in `BUILD_INFO.txt`. The APK was launch-tested on an Android 14 emulator; end-to-end Gateway behavior and a broader device matrix still need validation.

> Note: Version 1.0.3 keeps the signing certificate introduced in 1.0.2 and can update 1.0.2 in place. Version 1.0.1 uses the old certificate and cannot be updated directly; uninstall it first, which clears local app data.

## Tests and CI

```bash
node scripts/validate-frontend.mjs
./scripts/debug-smoke.sh
```

GitHub Actions checks out the pinned upstream version, applies this repository's patch, runs theme regression tests, builds debug and unsigned release APKs, and checks generated assets. A CI smoke test without an Android emulator is not a substitute for real-device acceptance. See [TESTING.md](TESTING.md) for test coverage and limitations.

## Privacy and security

The app connects to the Gateway you configure. The Android app protects connection tokens with Keystore. The Gateway receives chat content, attachments, and API requests needed for normal use. Connect only to services you trust, and read the [privacy notice](PRIVACY.md) and [security policy](SECURITY.md).

## Acknowledgements and licensing

This project reuses and adapts the Hermes Desktop renderer from [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent), pinned to upstream commit [`26f178e`](https://github.com/NousResearch/hermes-agent/tree/26f178e5fa78c691cadf847058ef1d55a707bfb0), which is licensed under the MIT License. The upstream copyright and license notice is retained in this repository's [LICENSE](LICENSE); changes are tracked in [`patches/`](patches/). Android runtime dependencies use Apache-2.0; its full text is in [`third_party/Apache-2.0.txt`](third_party/Apache-2.0.txt). Third-party Android and web dependencies are documented in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md); the web dependency inventory is generated with each build.

The Hermes, Hermes Agent, and Nous Research names and marks belong to their respective owners. This is an unofficial client and does not represent Nous Research.

---

<sub>This README is available in English and Simplified Chinese: English · [简体中文](README.md).</sub>
