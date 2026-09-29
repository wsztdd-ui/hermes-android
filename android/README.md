# Android application module

This folder contains the Android WebView host. The web renderer is generated
into `app/src/main/assets/www/` by the repository build script and is ignored
by Git to keep the source checkout small and reproducible.

From the repository root, build the complete app as described in the top-level
[README](../README.md). For a Gradle-only rebuild after assets exist:

```bash
export JAVA_HOME=/path/to/jdk-17
export ANDROID_HOME=/path/to/android-sdk
./gradlew :app:assembleDebug
```

The Gradle Wrapper pins Gradle. The project targets API 34 and supports
Android API 26 and newer. `local.properties` is generated locally and must not
be committed.
