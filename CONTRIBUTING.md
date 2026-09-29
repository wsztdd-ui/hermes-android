# Contributing

1. Install JDK 17, Android SDK API 34, Node.js 22, npm, and Git.
2. Clone Hermes Agent and check out the exact commit documented in
   `.github/workflows/android.yml`.
3. Apply `patches/hermes-android-theme-async-effect.patch` with
   `git apply --unidiff-zero`, then run `npm ci`
   in the Hermes Agent repository.
4. Set `JAVA_HOME`, `ANDROID_HOME`, and `HERMES_SRC`, then run
   `bash scripts/build-all.sh` from this repository.
5. Run the relevant tests in `TESTING.md` and include the command/output in
   your pull request.

For UI changes, include the Android version, screen size/density, navigation
mode, and whether a physical or virtual device was used. Keep private gateway
configuration, credentials, keystores, device identifiers, and personal
content out of commits and screenshots.
