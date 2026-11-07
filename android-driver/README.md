# TapRig Android driver

This project builds two local-only APKs:

- `stub`: an inert instrumentation target so TapRig never targets or stops a
  user's foreground app;
- `driver`: a custom instrumentation runner that exposes Android `UiAutomation`
  through the device-local abstract socket `taprig-driver`.

The host installs both APKs with `adb install -t -r`, starts the runner with a
fresh session nonce, and creates a device-scoped `adb forward` to the abstract
socket. The driver has no activity, service, network listener, exported app
component, or persistent accessibility permission.

Build with JDK 17 to 21 (the wrapper pins Gradle 8.14.3 for AGP 8.13.2). From
the repository root, `npm run build:driver` runs the JVM tests, builds both
release APKs, and writes `build/bundle/manifest.json` with their SHA-256 values.
Point the daemon at that directory with `TAPRIG_DRIVER_DIR`; packaged desktop
builds ship it as a resource and set it automatically. Without a bundle every
phone uses the UIAutomator fallback.

Manual run:

```console
./gradlew test assembleRelease
adb install -t -r stub/build/outputs/apk/release/stub-release.apk
adb install -t -r driver/build/outputs/apk/release/driver-release.apk
adb shell am instrument -w -e nonce <32-128-url-safe-characters> \
  dev.taprig.driver/dev.taprig.driver.TapRigInstrumentation
```

Protocol v1 is bounded newline-delimited JSON. Every connection must first send
`hello`; supported requests are `snapshot`, `wait`, `perform`, `health`, and
`stop`. UI generations are monotonic within a random driver session and actions
are rejected when their expected generation is stale. A new window always gets a
new generation; content changes advance it when the serialized tree differs.
`perform` dispatches one action and returns the settled post-action generation,
so the host executes a batch as one generation-bound `perform` per step.
