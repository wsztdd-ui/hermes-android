# Third-party notices

This project packages and adapts the Hermes Desktop renderer. The upstream
Hermes Agent project is maintained by Nous Research and is licensed under the
MIT License. Its source is pinned in `.github/workflows/android.yml`; the
Android compatibility changes are maintained in `patches/`.

The Android APK includes the following direct runtime libraries and their
transitive AndroidX / Kotlin / Okio dependencies. They are licensed under
Apache License 2.0; the full license text is included at
`third_party/Apache-2.0.txt` and attached to releases:

- AndroidX AppCompat and Core KTX
- AndroidX WebKit
- OkHttp

Gradle and Android Gradle Plugin are build tools, not packaged in the APK; both
are also Apache-2.0 licensed.

The Web renderer bundles the Visual Studio Code Codicons font and CSS from
`@vscode/codicons` 0.0.45. Copyright Microsoft and contributors; licensed
under CC BY 4.0. The generated `THIRD_PARTY_LICENSES.txt` includes its license
text. Source: https://github.com/microsoft/vscode-codicons. The icons are used
without modifications.

The Web renderer depends on a larger npm dependency tree. Each GitHub Actions
build and Release attaches `THIRD_PARTY_LICENSES.json` and
`THIRD_PARTY_LICENSES.txt`, generated from the pinned renderer's npm v3
lockfile dependency closure for the build platform (including optional
dependencies that resolve for that platform and required peer dependencies;
excluding optional peers). The JSON inventory lists package versions and
license metadata; the text file includes detected license texts with their
package names. License metadata absent from that lockfile is tracked in
`THIRD_PARTY_LICENSE_OVERRIDES.json` with its source.

Some npm tarballs omit a standalone license file even though their package
metadata declares an SPDX license. For those exact package versions, the
generator uses the matching standard license text from `third_party/licenses/`
and a package-specific copyright notice recorded with its source in
`THIRD_PARTY_LICENSE_OVERRIDES.json`. The build fails if any package remains
without a known license or license text.

Release APKs embed the applicable notice documents under
`assets/notices/`, including this project notice, the privacy notice, the
dependency inventory and detected license texts, and the Apache-2.0 license.
The release build workflow verifies that these files are present in the APK.

Generating these files is an inventory step, not legal advice or a legal
approval. Review the generated inventory from the exact pinned upstream commit
used for the APK and verify that the copyright notices and any additional
license obligations match the distributed dependencies.
