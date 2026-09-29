# Release process

The `v*` tag workflow builds the renderer from the pinned upstream commit,
applies this repository's compatibility patch, runs the theme regression
test, and creates a **draft** GitHub Release with the APK. Review the draft,
test the APK, and publish it manually.

The first public release is `v1.0.0` (Android `versionName` 1.0.0
and `versionCode` 55). Its Debug build, including origin-scoped OAuth
cookies and per-Gateway login-flow handling, passed 67/67 live-Gateway
regression checks on a vivo Android 16 device over wireless adb. System
notification delivery was not verified because the device-wide app
notification switch is off. The workflow does not publish the release
automatically: it creates a draft for review.

The 1.0.0 Release variant builds locally as version 1.0.0 / versionCode 55
and passes lintVital and R8 minification, but the APK is unsigned and has not
been runtime-tested. The 67/67 physical-device regression applies to the
Debug APK.

## Signing

Without signing secrets, Gradle produces `app-release-unsigned.apk`. It is a
review/build artifact and cannot update an existing installation signed with
another key. For a distributable release, configure these GitHub Actions
secrets:

- `ANDROID_KEYSTORE_BASE64`: base64 encoded upload/release keystore
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

The workflow decodes the keystore into the ephemeral runner's temp directory;
it never writes it into the repository or artifact separately. Keep a secure
offline backup of the keystore. Losing it prevents upgrading installs signed
with that key. Rotate/revoke credentials if they are exposed.

Before tagging, update `versionName` and `versionCode` in
`android/app/build.gradle.kts`, update `RELEASE_NOTES.md`, run the tests in
`TESTING.md`, and confirm the draft APK is signed as expected. Use monotonically
increasing Android `versionCode` values. The current app id is
`com.hermes.android`; changing it creates a separate Android app installation.

## Release checklist

1. Confirm the pinned renderer SHA and patch apply cleanly.
2. Run the theme test, frontend validation, emulator smoke test and a device
   check for the target release.
3. Review generated third-party notices and scan the source and build logs for
   credentials, private URLs, device identifiers and user content.
   Inspect `THIRD_PARTY_LICENSES.json`, resolve unknown entries and missing
   texts, and verify license obligations for dependencies included in the APK.
   Draft releases must attach the app MIT license, Android Apache-2.0 license,
   notices, and renderer dependency inventory.
4. Create a `vX.Y.Z` tag. Verify the Actions run and APK signature/checksum.
5. Install and exercise the draft APK, then publish the draft with accurate
   notes and known limitations. The workflow attaches renderer/app build
   provenance, dependency inventory, and an APK SHA-256 file for review.
