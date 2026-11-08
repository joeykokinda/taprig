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

## 2026-11-08 (later) — real login with human-supplied credentials on `ZY22L2TQM3`

Task: "Open Chrome, go to the-internet.herokuapp.com/login and log in. The task does
not include the credentials: ask me for the username, then the password." Signed-in
Claude Code CLI, run `ea7ddbe7`.

Result: completed in 31 s, 6 model calls, 1512 tokens, 5 verified actions. The agent
asked "What username should I use to log in?", then "What password should I use to
log in? (This is a password.)". The password was answered as sensitive: the model
received only the `[SECRET]` placeholder, the phone showed 20 masked characters, and
the exported run bundle and daemon log contain zero occurrences of the value. The
final screen read "You logged into a secure area!" and "Logged in as tomsmith".

Three defects found only on this hardware, each fixed and re-verified:

1. **PIN unlock never reached the keypad.** The unlock swipe was swallowed by
   Moto's Glance lock-screen overlay, and with Glance stopped the same swipe
   opened the notification shade. The keyguard reported `bouncerShowing: false`
   throughout. `KEYCODE_MENU` opens the PIN pad directly; unlock now sends
   wake, MENU, PIN, ENTER.
2. **Typing into a password field failed verification.** Password nodes hide
   their text from the accessibility tree, so the generation did not change and
   the driver reported `verification-failed`; the agent retyped until its budget
   ran out. A successful set-text on a password node is now the evidence, and
   elements carry `password: true` so the model moves on to submit.
3. **Tapping the Login button did nothing.** Chrome's web button accepted
   `ACTION_CLICK` and reported it handled without submitting the form, while a
   plain coordinate tap logged in. Driver taps now inject a real touch at the
   element's center and use the accessibility click only for nodes without
   bounds.

Operational notes: the daemon loads the driver manifest once at start, so a
rebuilt bundle needs a daemon restart before the phone is updated. Restarting the
daemon also drops the in-memory unlock PIN; the systemd unit in
`docs/ONBOARDING.md` keeps it across restarts.

Human handoff (captcha-style), run `66d23e4e`, completed in 37 s, 7 model calls:
the task declared the username field a human-only step. The agent tapped the
field, asked "Please type the username yourself into the focused username field
on the phone, then reply done when you have", and waited. The username was typed
through the control room's manual text path (`input text` with shell quoting),
`done` was answered, the agent then asked for the password, entered it from the
sensitive answer, tapped Login, and completed on the secure area. No secret in
the export.

Still unverified on this device: a second phone in the same session, and
reconnect across host or device reboot.

## 2026-11-08 (night) — real apps on `ZY22L2TQM3`: X, Messages, questions

Build: per-action verification in the driver, screenshot every decision, launcher
resolution before `am start`, run results surfaced. All runs on the signed-in Claude
Code CLI.

| Task                                                                  | Result                                               |
| --------------------------------------------------------------------- | ---------------------------------------------------- |
| Open Messages, report the latest text (phone has no SIM, empty inbox) | completed, 24 s, 4 actions, reported an empty inbox  |
| Open X, compose "I like turtles", stop before Post                    | completed, 39 s; draft on screen, Post untouched     |
| Open X, report the first Home timeline author                         | completed, 19 s, 2 actions                           |
| Open X, open Notifications, report the latest one                     | completed, 2 actions; answer printed by `taprig run` |

Defects found on hardware and fixed:

1. **`am start -p` cannot launch X.** Its launcher activity is
   `com.x.android.main.MainActivity`, outside the `com.twitter.android` package,
   so the intent did not resolve and two launches "failed"; the agent recovered by
   going home and tapping the icon. Launch now resolves the activity with
   `cmd package resolve-activity` and starts it by component, in both the driver
   and the adb path. Launches also get 8 s instead of 2 s for cold starts.
2. **Nothing surfaced the answer.** A read task ended with `completed` and the
   model's evidence stayed in the checkpoint table. `taprig run`, `attach`, the
   control room, and `taprig_run` now show it.
3. **Verification by tree change** was replaced with per-action checks (touch
   delivered, key delivered, field shows the typed text, app in the foreground,
   swipe moved something), so focused fields, web buttons, and hidden keyboards no
   longer burn the recovery budget. The decider is told whether the screen moved.

Hot reload of a rebuilt driver bundle was confirmed: the running daemon installed
the new APK within seconds of the rsync, no restart.

Left for the owner: tapping Post on the drafted X post, which this session did not
publish.

## 2026-11-08 (late) — launch features on `ZY22L2TQM3`

- `taprig doctor`: PASS daemon, PASS phone (unlocked, authorized, driver enrolled), PASS model.
- `taprig notifications`: listed the shade newest first (Google, Moto actions, charging, ...).
- "What is the most recent notification and which app is it from?": answered in one
  model call with zero actions from the shade read.
- Run video: "Open Settings and open the Battery page" produced a 1.7 MB, 17 s, 720×1600
  H.264 artifact pulled from the phone's `screenrecord`.
- Schedule: `schedule add "every 1m" ...` fired a run within the first poll; removed after.
- Safety gate and app notes covered by unit tests; the X compose run earlier today was
  the kind of task the gate protects (the task named "post", so Post would be allowed).
