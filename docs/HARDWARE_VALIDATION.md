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

Still unverified on this device:

- event-driven accessibility transport and parent/child label association;
- browser live-stream transport and manual takeover leases;
- reliable text entry beyond numeric PIN;
- app launch, taps, and swipes through task-level postcondition verification;
- reconnect across host/device reboot;
- multiple simultaneous devices.
