# Hardware validation

This file records reproducible physical-device results. It never contains
credentials, account data, or retained screen content.

## 2026-10-29 — Moto G Play 2024 on Brach

Environment:

- host: Brach, Ubuntu 24.04, Linux 6.8;
- transport: USB ADB, Google platform-tools 37.0.1;
- device: Motorola Moto G Play 2024 (`fogona`), Android 14 / API 34;
- display: 720 x 1600;
- TapRig commits: `d5c9fc6` through `d52dfd9`.

Verified results:

1. Linux enumerated the phone over USB.
2. `taprig doctor` classified the authorized ADB transport as passing.
3. `taprig devices` returned the correct serial and model.
4. `taprig execute <serial> key home` sent a typed raw action; Android reported
   Motorola Launcher as `topResumedActivity` afterward.
5. The authenticated local runtime reported the device `ready`, boot complete,
   unlocked, with correct manufacturer/model/product/Android/API identity.
6. Screen-off plus wake produced keyguard `showing=true`.
7. TapRig retrieved a one-time device/purpose-scoped PIN from the in-memory
   credential broker, unlocked locally, and verified fresh keyguard fields
   `showing=false` and `mIsShowing=false`.
8. Credential audit output contained metadata only and did not contain the PIN.
9. The device actor reported `screenState=awake` and Motorola Launcher as the
   foreground package/activity after a TapRig HOME action.
10. TapRig retained a mode-0600 screenshot artifact, validated as a 720 x 1600
    RGBA PNG (750,588 bytes) without overwriting an existing path.
11. TapRig's pinned scrcpy 5.0.1 adapter recorded three seconds of headless video
    to a validated Matroska artifact (786,180 bytes) and hardened its permissions
    from scrcpy's default to mode 0600.
12. The UIAutomator bootstrap observed Android Settings, resolved the visible
    `Navigate up` control by accessibility description, tapped its computed
    bounds, and verified a changed hierarchy generation while Settings remained
    foreground.
13. The Android semantic adapter repeated that flow as an idempotent typed action
    batch, rejecting stale input and marking the step verified only after fresh
    post-action evidence reached the Settings root.
14. From the Settings root, TapRig associated the non-clickable `System` child
    label with its clickable parent row, executed the typed tap batch, and
    verified the System page from fresh `Languages` and `Keyboard` semantics.
    The verified step took 2.75 seconds with UIAutomator polling.
15. At commits `7f44244` through `2c0ccc6`, the authenticated control-room
    endpoint streamed a valid 360 x 800 MJPEG view through scrcpy, FFmpeg, the
    daemon, and an SSH tunnel. Sequential browser reconnects produced fresh
    streams without leaking the previous process.
16. An exclusive takeover lease accepted a normalized control-room tap, after
    which Android reported Desk Clock foreground. A leased HOME action restored
    Motorola Launcher, and explicit lease release succeeded.
17. Two Moto G Play 2024 devices (`ZY22KSF7B2` and `ZY22L2TQM3`) were discovered
    ready and unlocked together. A simultaneous pre-fallback stream attempt
    exposed scrcpy's static Matroska startup buffering on the second phone; the
    automatic screenshot fallback added afterward is covered by a process-level
    regression test but still awaits a repeated two-phone hardware run.

Still unverified on this device:

- reconnect across host/device reboot;
- simultaneous live views and isolated takeover on multiple devices after the
  fallback change.

## 2026-11-06 — instrumentation driver on Moto G Play 2024 (`ZY22L65CK4`) on Brach

Android 14, platform-tools on Brach, Node 24.12.0, driver protocol v1 built with
AGP 8.13.2, Gradle 8.14.3, JDK 21.

1. Host enrollment verified both APK checksums, installed only changed APKs,
   forwarded `localabstract:taprig-driver`, started
   `dev.taprig.driver/.TapRigInstrumentation` with a fresh 64-hex nonce, and
   completed the authenticated hello in 2.8 to 3.4 seconds.
2. A cross-window Settings snapshot returned 223 elements, 192 with resource IDs
   (UIAutomator dumps had none), with Settings reported foreground from the top
   application window rather than System UI.
3. An event-driven wait on an idle screen returned unchanged at its 1.5 second
   bound; navigation produced strictly newer generations, and returning to an
   identical-looking screen produced a new generation.
4. A stale generation was rejected with `stale-observation` before dispatch.
5. Verified actions: semantic tap (0.4 to 1.3 seconds including settle), back
   key, HOME, `app.launch` of Settings, swipe, and full Unicode replacement of
   `Wi‑Fi café 日本` into the Settings search field, read back from the tree.
   A missing long-tap target failed with `target-not-found` and later steps were
   skipped.
6. Force-stopping the driver marked the session dead and routed the phone to the
   UIAutomator fallback; the next sync re-enrolled it. An absent serial failed
   enrollment alone without affecting the healthy phone.
7. `taprig daemon serve` with `TAPRIG_DRIVER_DIR` enrolled the phone
   automatically and, on SIGTERM, removed its forward and stopped the driver.
8. Neither the nonce nor any 64-hex value appeared in TapRig-related logcat lines.

Found during this run: reinstalling the debug-signed APK on every enrollment
raised a Play Protect dialog that blocked later installs. Enrollment now
compares the on-device `sha256sum` and installs only on mismatch.

Still open for the driver: a successful long tap, password-field redaction on a
real password field, settle timing on continuously animating screens, a
second simultaneous phone, and host or device reboot during a session.

## 2026-11-08 — full agent loop on Moto G Play 2024 (`ZY22L2TQM3`) on Brach

Android 14, platform-tools on Brach, Node 24.12.0, driver protocol v1, TapRig
commits `e40b3b8` through `2c318a8`. Every run was created with `taprig run` and
followed to a durable terminal state; model decisions came from the configured
provider with no manual help.

1. Signed-in Codex CLI: "Open the Clock app and start the stopwatch" completed in
   26 s with launch, two verified taps, and a model-verified completion.
2. Claude Code over MCP: Claude Code opened Calculator and tapped 1, 2, ×, 7, =
   using only TapRig tools; the phone showed 84 and the history entry 12×7 (20 s).
3. Signed-in Claude Code CLI: "Open Settings and open the Battery page" completed
   in 14 s; "Open Settings, scroll down and open the About phone page" in 15 s;
   "Open Settings, scroll to the bottom and open the System page" in 20 s
   (4 model calls, 950 tokens, 3 verified actions).
4. Two defects found only on hardware, fixed and re-verified the same day:
   - `monkey`, used to launch apps, injects one random system event that turned
     auto-rotate back on. Settings then rendered landscape (1600 × 720) while
     TapRig swiped at portrait coordinates off screen; the swipe verified as
     unchanged and the run failed. Launch now uses `am start` with the launcher
     intent, and every leased phone is pinned to portrait before its first
     observation. Raw and agent swipes were confirmed to scroll afterwards.
   - A single malformed model decision (an invalid scroll direction) failed the
     whole run as `transport-failed`. The decider now returns the rejection
     reason to the model once before failing.
5. With no human at the phone, the daemon woke it from doze, and the keyguard
   path holds a PIN only in memory from the environment; the phone was unlocked
   by its owner for this session.

Still unverified on this device: a second phone in the same session, and
reconnect across host or device reboot.

## 2026-11-08 (later) — login and human-handoff attempt on `ZY22L2TQM3`

Deployed the login and captcha handoff build (hidden CLI prompts, `[SECRET]`
placeholder substitution, control-room typing, `taprig_answer`) to Brach and
started "Open Chrome, go to the-internet.herokuapp.com/login and log in; ask me
for the username, then the password". The run failed in 2 s with
`transport-failed: the connected phone is locked`: restarting the daemon had
dropped the owner's in-memory `TAPRIG_UNLOCK_PIN`, and the keyguard was up.
Nothing ran on the phone. Rerun once the phone is unlocked or the daemon is
started with the PIN (see the systemd unit in `docs/ONBOARDING.md`).
