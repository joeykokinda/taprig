# TapRig handoff

Last verified: 2026-11-06, America/New_York

## Read this first

TapRig is an open-source, local-first Android agent runtime. It turns USB-connected
Android phones into durable agent workers controlled through one daemon, CLI,
browser/desktop control room, API, and MCP surface. PhoneFarm is only the first
planned deployment; it is not this repository.

Before working:

```console
cd /home/rex/Projects/taprig
aimem project
git status --short
sed -n '1,140p' docs/TODO.md
```

Do not read Obby's private folders. Preserve unrelated or uncommitted work. Use
`apply_patch` for edits. Do not save secrets in source, SQLite, prompts, logs, or
aimem.

## Product architecture

```text
CLI / control room / API / MCP
              |
      authenticated local daemon
              |
       session orchestrator
              |
   +----------+-----------+
   |                      |
known script       per-phone agent loop
(zero model calls) observe -> decide -> execute -> verify
                          |
          event driver, with UIAutomator fallback
                          |
                       Android
```

The model makes short, typed decisions. Deterministic code owns device leases,
execution, verification, waits, retries, budgets, scripts, persistence, and
recovery. Fleet orchestration keeps each phone's UI context isolated and gives
the top-level orchestrator only compact results.

Canonical design documents:

- `docs/PLAN.md`
- `docs/AGENT_ARCHITECTURE.md`
- `docs/DEVICE_RUNTIME.md`
- `docs/TODO.md`

## Committed and working on `main`

Current committed HEAD before this handoff: `0011a89`.

The committed tree has 134 passing tests. It includes:

- ADB discovery, doctor diagnostics, durable device actors, boot/keyguard/screen/
  foreground state, typed raw actions, scoped PIN unlock, screenshots, and
  semantic UIAutomator observation/action.
- Physically validated Moto G Play control: HOME, semantic Settings navigation,
  labeled clickable rows, PIN unlock, screenshots, scrcpy recording, MJPEG live
  view, and exclusive manual takeover.
- A bounded observe/decide/execute/verify/recover agent loop with model routing,
  token/action telemetry, per-run budgets, durable restart recovery, questions,
  typed approvals, artifacts/export, and pause/resume/stop/immutable retry.
- Parameterized deterministic scripts and explicit successful-run promotion.
- Independent, broadcast, and coordinated fleet modes with device leases,
  capability scheduling, named groups, affinity, barriers, recovery, and DAGs.
- Authenticated daemon-backed CLI, control room, API, and MCP.
- Electron packaging and a successful unsigned x64 GitHub Actions matrix for
  Linux, Windows, and Intel macOS:
  https://github.com/joeykokinda/taprig/actions/runs/41918799082
- Published, clearly synthetic runtime/soak results under
  `benchmarks/results/10a8713/`.

Recent commits:

```text
0011a89 record cross-platform preview build
573fae9 publish synthetic baseline and release previews
10a8713 add durable run controls
7b6f0ce add durable owner settings
ea0bb85 add private run artifacts and export
```

## Plug-and-play agent paths (2026-11-07)

- `taprig setup` detects a model: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, then a
  signed-in `claude` or `codex` CLI (`src/models/providers.ts`). No key is needed
  for subscription users.
- `taprig run` follows the run; `--detach` returns immediately.
- Claude Code/Codex can be the agent themselves through MCP `taprig_observe`,
  `taprig_act`, and `taprig_screenshot`; `taprig connect claude|codex` registers it.
- Emulator end-to-end: `~/Android/Sdk` has an `taprig34` AVD (Android 34 x86_64);
  start it with `emulator -avd taprig34 -no-window -gpu swiftshader_indirect`.
  Unset `CLAUDECODE*` env vars when launching the daemon from inside Claude Code.
- Live-screen lessons: whole-screen generation checks rejected most model actions
  because screens change during the model's think time. Only coordinate taps and
  positional element IDs need the exact screen now; the decider swaps element IDs
  for unique semantic selectors and sees its recent actions.

## Android instrumentation driver

The event driver is implemented and physically validated on the Brach Moto G Play
2024 (`docs/HARDWARE_VALIDATION.md`, 2026-11-06). Java and TypeScript share one
protocol v1 contract in `src/android/driver/protocol.ts`; `session.ts` owns
enrollment, the loopback transport, per-step `perform` batches, and the fleet-safe
`AndroidDriverManager`. The daemon enables it when `TAPRIG_DRIVER_DIR` points at a
verified bundle (`npm run build:driver`), and packaged desktop builds ship it.

Gotchas found on hardware:

- Instrumentation targets must contain code, so the inert stub has one empty class.
- Reinstalling unchanged sideloaded APKs trips Play Protect dialogs that block
  later installs; enrollment installs only when the device `sha256sum` differs.
- Each build machine's debug key differs; enrollment uninstalls and reinstalls on
  `INSTALL_FAILED_UPDATE_INCOMPATIBLE`.
- `getWindows()` includes System UI, so foreground comes from the top application
  window, and actions return a settled generation so batch steps are not stale.
- Only one `UiAutomation` can exist per phone, so driver phones must never also
  receive `uiautomator dump`; all observation routes through `AndroidDriverAdapter`.

Brach: `ssh brach`, adb at `~/.local/bin/adb`, Node at
`~/.nvm/versions/node/v24.12.0/bin`. `~/taprig` there is an older clean checkout;
`~/taprig-dev` is a synced scratch copy used for hardware runs.

## Next implementation plan

### 1. Driver follow-ups

- Prove a successful long tap and password redaction on hardware.
- Bound settle behavior on continuously animating screens.
- Validate a second simultaneous phone and host/device reboot mid-session.
- Optionally drop the stub by self-targeting the driver package.

### 2. Hardware gates

Host gates:

```console
npm run format
npm run check
git diff --check
```

Android gates:

```console
cd android-driver
./gradlew test assembleRelease
```

Then connect an authorized Android phone and prove:

- automatic install/enrollment and authenticated hello;
- cross-app Settings snapshot;
- event-driven wait and monotonically newer generation after navigation;
- returning to an identical-looking screen still produces a new generation;
- stale actions fail before dispatch;
- tap, long tap, Unicode text replacement, key, swipe, and app launch;
- driver kill/reconnect and UIAutomator fallback;
- no password text or nonce in normal logs.

Only after physical evidence should the event-driver TODO be checked.

## Remaining product/launch work after the driver

Keep the active goal intact. Major unchecked work in `docs/TODO.md` remains:

- complete-loop physical calibration;
- simultaneous two-phone live view and isolated takeover validation;
- signed/notarized macOS, Windows, and Linux installers;
- tag-path GitHub Release checksums and published downloads;
- website download wiring only after signed releases exist;
- physical/provider cost, latency, and task-success benchmarks;
- hero demo and launch assets.

Also preserve the documented boundaries: vision remains necessary for Canvas,
games, inaccessible custom views, and some WebViews; biometrics, CAPTCHAs, DRM,
USB trust, and hardware-backed confirmations are not bypassed.

## Git and truthfulness rules

- Work on `main` unless the user says otherwise; remote is
  `https://github.com/joeykokinda/taprig.git`.
- The prior OAuth token could not push workflow-file changes without `workflow`
  scope; SSH push worked for commit `573fae9`. Ordinary later HTTPS pushes worked.
- Do not discard the current untracked driver files.
- Do not check a roadmap item merely because scaffolding or mocks exist.
- Do not call unsigned previews consumer downloads.
- Update `docs/TODO.md`, relevant architecture docs, and `aimem remember` only
  after durable, verified facts change.
