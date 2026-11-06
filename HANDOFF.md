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

## Current uncommitted work

The event-driven Android instrumentation driver is partially implemented and
must not be described as working yet:

```text
?? android-driver/
?? src/android/driver-adapter.ts
?? src/android/driver/
?? tests/driver-adapter.test.ts
?? tests/driver-protocol.test.ts
?? tests/driver-session.test.ts
```

Current test result is **143 pass / 1 fail**. The committed tree remains green;
the failure comes from this unfinished driver work:

```text
manager enrolls new phones and closes removed phones
expected nonce: aaaaaaaaaa...
actual nonce: randomly generated value
```

Reproduce with:

```console
npm test
node --test tests/driver-session.test.ts
```

No Android device was visible in `adb devices -l` at handoff time.

### Pieces already present

- `android-driver/`: inert target APK and custom `Instrumentation` scaffold using
  `UiAutomation` and a device-local `LocalServerSocket`.
- `src/android/driver/protocol.ts`: bounded newline-JSON codec/parser.
- `src/android/driver/session.ts`: APK checksum/install/forward/process/session
  lifecycle scaffold.
- `src/android/driver-adapter.ts`: tested per-phone driver routing with the
  existing `AndroidSemanticAdapter` as fallback.

These came from interrupted parallel work. Review every line; do not assume the
halves share a valid protocol.

## Critical incompatibilities to fix first

The Java driver and TypeScript host currently disagree:

1. **Enrollment constants**
   - Android target: `dev.taprig.driver.stub`
   - Android instrumentation package: `dev.taprig.driver`
   - Runner: `dev.taprig.driver.TapRigInstrumentation`
   - Nonce argument: `nonce`
   - `session.ts` currently uses different AndroidX test-package constants and
     `taprig_nonce`.

2. **Hello response**
   - TypeScript expects `{version, nonce}`.
   - Java currently returns health fields `{version, sessionId, generation}`.
   - Choose one exact schema. Prefer returning the nonce only for the authenticated
     hello proof, then use `health` for session/generation data.

3. **Wait response**
   - TypeScript expects `{changed, snapshot}`.
   - Java currently appends `changed` directly to the snapshot object.

4. **Perform response**
   - TypeScript expects one action and `{generation, evidence}`.
   - Java accepts one action but returns `{generation, changed}`.
   - `session.ts` incorrectly sends an entire `steps` batch and expects a complete
     `BatchResult`. The host session should iterate steps, call one generation-bound
     `perform` per step, stop after failure, and construct `BatchResult`.

5. **Stop response**
   - TypeScript expects `{stopped: true}`.
   - Java returns `{stopping: true}`.

6. **Observation identity**
   - Driver snapshots intentionally omit `deviceId`.
   - The session must attach its known serial when constructing `Observation`.

7. **Missing real transport**
   - `DriverHost.connect` is only an injected interface. Implement a real loopback
     TCP client with request IDs, frame decoding, response correlation, bounded
     timeouts, disconnect rejection, hello authentication, and clean close.

8. **Fleet-safe degradation**
   - `AndroidDriverManager.sync()` currently throws on the first enrollment
     failure. One incompatible/offline phone must remain on UIAutomator fallback
     without preventing other devices or daemon refresh.

Fix the contract once in shared schema/tests. Do not add translation hacks for
both incompatible versions.

## Ordered next implementation plan

### 1. Make the driver unit coherent

- Align Java and TypeScript protocol v1 exactly.
- Fix the random-nonce test by injecting a nonce for deterministic tests or by
  making the fake host validate shape rather than one hard-coded value.
- Add tests for malformed/oversized frames, wrong nonce/version, fragmented and
  multiple frames, timeout/disconnect, stale generation, step failure/skip,
  cleanup, and per-device enrollment failure.
- Run:

```console
npm run format
npm run check
```

Do not proceed while the Node suite is red.

### 2. Make the Android project reproducible

- Add and pin a Gradle wrapper. The current scaffold pins AGP `8.13.2`; either
  keep it with a documented compatible Gradle/JDK pair or deliberately update
  it. Do not use dynamic dependency versions.
- Build the inert stub and instrumentation APK and run JVM tests on a GitHub
  Android runner if the local SDK is unavailable.
- Add Android tests for bounded tree serialization, password redaction, selector
  ambiguity, generation monotonicity, and action/error mapping.
- Produce a private bundle manifest containing filenames, protocol version, and
  SHA-256 values. The host must verify both APKs before any ADB mutation.

### 3. Integrate with the daemon

- Construct an `AndroidDriverManager` only when a verified driver bundle exists.
- During device refresh, enroll ready/authorized phones and close sessions for
  removed phones. Enrollment errors degrade only that phone to fallback.
- Route scripts and agent workers through `AndroidDriverAdapter`; do not create a
  second execution path.
- Close sessions/forwards/instrumentation during daemon shutdown.
- Bundle the two APKs and manifest in Electron packages and set their absolute
  resource path from `desktop/main.ts`.
- Keep `AndroidSemanticAdapter` as the honest fallback for devices that prohibit
  instrumentation.

### 4. Validate correctly

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
