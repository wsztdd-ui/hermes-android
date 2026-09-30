# Release process

The [Android workflow](../.github/workflows/android.yml) runs on `main` pushes,
pull requests, and manual dispatch. It checks out the pinned Hermes renderer,
applies the compatibility patch, runs the theme test, builds Debug and unsigned
Release APKs, generates third-party notices, and uploads candidates as CI
artifacts. It does not create tags or publish GitHub Releases.

Android `versionName` and `versionCode` are set in
`android/app/build.gradle.kts`. The current source is `1.0.1` / `56`, with app
ID `com.hermes.android`. Changing the app ID creates a separate installation;
future updates must increase `versionCode` and use the same signing key.

## Before publishing

1. Verify the exact pinned renderer commit and compatibility patch, then run
   CI and review its build logs.
2. Inspect the generated dependency inventory and bundled notice files under
   `assets/notices/`. Resolve missing license texts and any obligations for
   dependencies actually included in the APK.
3. Scan source, build logs, APK assets, screenshots, and release attachments for
   credentials, personal chats, private URLs, and device identifiers.
4. Sign the Release APK with a stable key kept outside the repository. Verify
   its signature and SHA-256 checksum, then install that exact signed APK and
   test it against a Gateway you are authorized to use.
5. Point the version tag at the reviewed source commit. Publish the APK and
   matching checksum, build information, license, privacy notice, and
   third-party notices. Document any features that were not tested.

Never upload a signing key, password, credential, or private test record.
