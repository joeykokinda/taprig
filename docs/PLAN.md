# TapRig canonical build plan

Status: **accepted product direction; implementation baseline**  
Last updated: 2026-10-28

This document defines what TapRig is, the system boundaries, the first complete
product, and the order in which it will be built. Changes to the product or
architecture belong here before they spread into code.

## 1. Product

TapRig turns Android devices connected to a host computer into execution
surfaces for AI agents. The user can type a task in an interactive terminal or
graphical application, watch it run live, answer questions, take over manually,
and inspect the resulting actions, cost, artifacts, and failures.

TapRig is a separate project from PhoneFarm. PhoneFarm is the first physical
fleet used to develop and demonstrate TapRig.

### Product modes

1. **Independent:** one task and agent session per phone.
2. **Broadcast:** one semantic plan executed and verified across several phones.
3. **Coordinated:** one task graph split into work assigned to several phones.

### Capability policy

TapRig is capability-neutral and owner-controlled. It does not maintain app or
action blocklists. The owner chooses supervised, standard, autonomous, or
custom approval policy. TapRig does not claim to bypass Android locks,
biometrics, CAPTCHAs, DRM, hardware confirmation, Play Integrity, or another
system's security boundary.

The execution guarantee is:

> An action succeeds and is verified, recovers through a typed strategy, or
> stops in an explicit resumable state.

## 2. Product invariants

These are requirements, not aspirations.

1. **One runtime.** CLI, UI, MCP, and SDK call the same daemon services.
2. **Daemon ownership.** Runs survive a closed UI, terminal exit, and SSH loss.
3. **One writer per device.** A device actor serializes mutating actions.
4. **Semantic first.** Accessibility state and Android events precede pixels.
5. **Pixels on demand.** Screenshots and vision are fallbacks, not the default
   observation loop.
6. **Intent before gesture.** Prefer an exact system/app operation when it is
   available; use GUI control when the task requires the GUI.
7. **Verify effects.** A successful transport write is not a successful action.
8. **No stale actions.** Element actions are bound to an observation generation.
9. **Idempotent requests.** Retries cannot silently duplicate a TapRig command.
10. **Evidence over claims.** Every run emits timings, costs, actions, outcomes,
    and enough artifacts to diagnose failure.
11. **Local by default.** No TapRig account, hosted service, or telemetry is
    required.
12. **Explicit degradation.** Missing scrcpy, driver, vision, or model support
    produces a named reduced-capability mode.

## 3. System overview

```text
Desktop UI   Browser UI   Interactive CLI   Commands   MCP/SDK
     \           |              |              |        /
      +----------+--------------+--------------+-------+
                             |
                     authenticated local API
                             |
                    +--------v---------+
                    |   TapRig daemon   |
                    |-------------------|
                    | run service       |
                    | agent runtime     |
                    | model gateway     |
                    | scheduler         |
                    | policy/approvals  |
                    | event log         |
                    | artifact store    |
                    +--------+----------+
                             |
                 +-----------+------------+
                 | device registry/actors |
                 +---+-----------------+---+
                     |                 |
             Android driver      scrcpy adapter
             semantic state      video/raw input
                     \                 /
                      +-------+-------+
                              |
                         Android phone
```

### Technology baseline

- Host/runtime: TypeScript on Node.js.
- UI: React and Vite.
- Desktop packaging: Electron after the browser workspace works.
- Android driver: Kotlin.
- State: SQLite in WAL mode.
- Large artifacts: local filesystem.
- Live events: WebSocket.
- Video/raw input: a pinned scrcpy release behind one adapter.
- Models: provider-neutral interface; OpenAI-compatible provider first.
- Initial supported host: Linux. Windows and macOS follow after the vertical
  slice is reliable.

Keep one repository and one TypeScript package until an independently shipped
component requires a package boundary:

```text
src/
  core/          pure contracts and state transitions
  daemon/        composition root and process lifecycle
  devices/       discovery, actors, capabilities, health
  execution/     observations, selectors, actions, verification
  agents/        loop, planning, recovery, memory
  models/        provider adapters, routing, usage, budgets
  runs/          scheduler, task graphs, checkpoints
  api/           HTTP and WebSocket transport
  cli/           commands and interactive terminal
  mcp/           compact external-agent surface
  ui/            graphical application
android/
  driver/        semantic device-side driver and reliable text input
tests/
```

## 4. Android control plane

No single mechanism covers every Android surface. TapRig composes several.

### 4.1 scrcpy adapter

Responsibilities:

- low-latency H.264 video;
- raw touch, gesture, key, and clipboard transport;
- recording and human manual control;
- optional audio where supported.

Non-responsibilities:

- semantic element discovery;
- action verification;
- task planning or recovery.

The scrcpy wire protocol is internal and version-sensitive. TapRig pins a
supported release, verifies the server/client version pair, and contains all
protocol knowledge in one adapter with fixture tests.

### 4.2 TapRig Android driver

A small ADB-installed driver maintains a persistent device-side session and
exposes a versioned protocol over `adb forward`.

Responsibilities:

- `UiAutomation` connection and accessibility event subscription;
- compact active-window and multi-window node state;
- generation IDs and structural diffs;
- semantic selectors and node actions;
- event-driven waits and stability detection;
- system/app state and capability reporting;
- reliable Unicode text through a TapRig input method when necessary;
- batched local execution with per-step results.

The driver targets a stub application so starting instrumentation does not
restart the application being controlled. Raw `UiAutomation` is the internal
primitive; a changing Android test DSL is not TapRig's public protocol.

### 4.3 Visual fallback

When semantic state is absent or insufficient:

1. sample the already-running scrcpy stream;
2. reject unchanged frames;
3. crop the relevant region when known;
4. try local OCR or task-specific perception;
5. call a vision model only when local perception cannot ground the action.

Continuous games use a local perception/controller plugin. A network LLM is not
placed in a real-time frame-to-input loop.

### 4.4 Action routing

Cheapest reliable surface first:

1. intent, shell, lifecycle, file, or other exact Android operation;
2. semantic node action;
3. known deterministic skill;
4. raw gesture;
5. local OCR or detector;
6. vision model;
7. stronger reasoning model;
8. human input when the platform requires it.

## 5. Device system

The full device digital twin, diagnostics, remediation, cross-app workflow,
credential, and authentication-challenge design is specified in
[DEVICE_RUNTIME.md](DEVICE_RUNTIME.md). This section defines its system-level
ownership.

### Device registry

- Watches ADB devices continuously rather than polling per request.
- Uses serial as hardware identity and a separate stable user-facing ID.
- Tracks authorization, connection, driver, video, battery, screen, network,
  foreground app, and capabilities independently.
- Treats unauthorized, offline, booting, locked, driver-degraded, and ready as
  distinct states.

### Device actor

One actor owns mutable state for one device:

- one mutation queue;
- current lease;
- observation generation;
- warm driver and scrcpy sessions;
- idempotency cache;
- health/reconnect loop;
- current run and manual-control ownership.

Reads may be concurrent when safe. Mutations remain ordered. Human takeover
revokes the agent lease, invalidates the observation generation, and requires a
fresh observation before agent execution resumes.

### Zero-touch preflight and remediation

After one-time enrollment, normal operation should not require touching the
phone. Before assigning work, TapRig checks and, where authorized, repairs:

- ADB/driver/video health;
- awake, unlocked, orientation, and foreground state;
- battery/charging and thermal state;
- Wi-Fi/mobile connectivity, DNS, and internet reachability;
- captive portal and airplane-mode state;
- required app installation/version/permissions;
- keyboard/input-method readiness;
- storage required for task artifacts.

Remediation prefers exact Android operations, then semantic Settings navigation.
If information is missing, TapRig asks one specific question and continues from
the same checkpoint. Example:

```text
Phone 2 has no internet and sees networks Purdue, PAL3.0, and rex-home.
Which network should it join? I will request its password only if required.
```

Credentials are passed as secret values directly to the executor. They are not
placed in model context, event text, screenshots retained by default, or normal
logs. TapRig stores them only when the owner explicitly chooses an encrypted
credential store.

Zero-touch operation cannot precede Android trust enrollment: enabling developer
options/USB debugging, accepting the host RSA key, and satisfying a lock or
biometric challenge may require physical presence. TapRig must name these as
platform trust boundaries rather than looping or pretending to repair them.

## 6. Execution system

### Observation

An observation includes:

- device and generation IDs;
- foreground package/activity;
- windows and compact actionable elements;
- focused element and keyboard state;
- optional screenshot reference;
- capabilities and exceptional state;
- structural fingerprint.

After the initial observation, consumers may request a diff from a known
generation. The system may force a full snapshot when continuity is lost.

### Selectors

Selector preference:

1. stable resource ID or test tag;
2. content description/accessibility label;
3. role plus normalized text;
4. ancestor/descendant context;
5. visual region;
6. coordinate only as a last resort.

Ambiguous selectors fail with candidates. They never silently choose a random
match.

### Action batches

A batch contains typed steps with optional preconditions and required or
optional postconditions. Supported primitives eventually include app lifecycle,
intent, node action, text, key, tap, swipe, drag, pinch, wait, assert, clipboard,
file, notification, shell, screenshot, and recording.

Every step returns transport timing, settling timing, verification evidence,
and a typed result. Batch execution stops at the first unhandled failure.

### Correctness

Transport success is never enough. Verification may use:

- expected accessibility event;
- foreground app/activity;
- element added, removed, or changed;
- field value;
- structural fingerprint change;
- Android/system state;
- file or external side effect;
- visual assertion when no semantic assertion exists.

Exactly-once behavior is guaranteed only for TapRig request handling. Third-party
apps may not provide transactional side effects, so irreversible retries require
evidence or an explicit recovery policy.

### User-built scripts

Repeated workflows are first-class TapRig automations. A user can create one by:

- recording manual phone actions;
- describing the workflow to the built-in agent;
- selecting a successful run and choosing “Make script”; or
- editing the declarative automation directly.

A script declares inputs, compatible apps/device capabilities, typed steps,
checkpoints, outputs, and failure behavior. It is inspectable, versioned, and
testable. Example invocations:

```text
taprig scripts run reply-known-dms --device phone-1
taprig scripts run post-reel --input video=launch.mp4 --fleet social
```

Scripts execute deterministically without model calls while their preconditions
and checkpoints hold. A mismatch can stop, ask the user, or hand control to the
agent according to the script's recovery policy.

Internally, user scripts, bundled skills, and learned candidate skills use one
automation schema and executor. Their origin and trust differ:

- **user script:** owner-authored or explicitly saved; immediately available
  under the owner's policy;
- **bundled skill:** shipped and tested by the project;
- **learned candidate:** proposed from traces and unavailable for automatic use
  until it passes promotion requirements.

The first format is a declarative action graph, not arbitrary plugin code. Shell
actions remain explicit typed steps with their own policy and trace.

## 7. Agent runtime

The reasoning, prompting, knowledge, recovery, and evaluation design is specified
in [AGENT_ARCHITECTURE.md](AGENT_ARCHITECTURE.md). This section defines its
system-level boundary.

### Loop

```text
task -> observe -> decide -> execute batch -> verify
                    ^                         |
                    +---- recover/escalate ---+
```

The agent produces structured plans/actions, not prose that a parser guesses at.
Local execution handles waits, retries, batching, and assertions without another
model call. The model receives compact state, relevant run history, and only the
artifacts required for the current decision.

### Model roles

- **Fast:** routine planning and ordinary recovery.
- **Strong:** ambiguity, decomposition, and escalated recovery.
- **Vision:** inaccessible visual surfaces.
- **Local:** optional private/zero-marginal-cost role.

Profiles:

- Economy: fast model, strict vision/strong budget.
- Balanced: fast default, vision when needed, strong escalation.
- Best: strongest configured planning, recovery, and vision.
- Local: local models only.
- Custom: explicit role models and budgets.

Routing decisions and escalation reasons are persisted. The primary efficiency
metric is cost per verified successful task, not tokens in isolation.

### Questions and approvals

The runtime can suspend a run with a typed question or approval request. UI and
CLI answer through the same run API. Runs remain durable while waiting.

## 8. Orchestration

### Independent mode

Each run receives a device lease and proceeds independently. Scheduling considers
capabilities, availability, user affinity, and task requirements.

### Broadcast mode

One semantic plan is mapped independently on each device. Barriers synchronize
steps when required. Devices that drift leave the synchronized cohort, recover
individually, and rejoin only at a named checkpoint.

### Coordinated mode

A coordinator creates a task DAG with typed inputs, outputs, dependencies, and
device requirements. Work units run on leased devices. Barriers aggregate
results. Failures retry, compensate, reassign, or stop according to task policy.

The coordinator is the sole user-facing agent. It receives compact device and
work-unit summaries rather than full UI state. Each assigned phone has an
isolated lightweight device-agent context, and deterministic execution can
complete known scripts without invoking a device model. See the agent-tree and
orchestrator decision cycle in
[AGENT_ARCHITECTURE.md](AGENT_ARCHITECTURE.md#6-agent-tree-and-context-boundaries).

## 9. Daemon, remote access, and interfaces

### Daemon

The daemon is the sole composition root and run owner. It starts manually for
development and as a user service in normal server installations.

- API binds to loopback by default.
- A local secret authenticates CLI, UI, and MCP adapters.
- No unauthenticated public listener.
- Secrets are excluded from logs and artifacts.
- Runs continue after clients disconnect.

### SSH-first operation

The first remote workflow uses existing SSH trust:

```console
$ ssh phone-server
$ taprig
```

The interactive terminal connects to the local daemon, lists devices and active
runs, accepts natural-language tasks, streams actions/cost, asks questions, and
supports pause, stop, approval, and takeover.

If SSH drops, `taprig attach <run-id>` reconnects to the durable run.

The browser UI remains loopback-only and is reached with SSH port forwarding.
A later `taprig connect <ssh-host>` command may automate the tunnel and client
configuration without creating a new remote-authentication system.

### CLI

Non-interactive commands and the TUI use the same client library:

```text
taprig                         interactive session
taprig doctor                  installation/device diagnosis
taprig devices                 device inventory and health
taprig run <task>              create a run
taprig attach <run-id>         stream/interact with a durable run
taprig runs                    active and historical runs
taprig pause|resume|stop       run control
taprig approve|deny            approval response
taprig takeover <device>       manual-control lease
taprig ui                      open/print the graphical UI
taprig export <run-id>         portable trace and artifacts
taprig scripts list|show       inspect saved automations
taprig scripts run <name>      run a saved automation
taprig scripts create          record/describe/import an automation
```

Interactive slash commands include `/devices`, `/use`, `/fleet`, `/model`,
`/budget`, `/screen`, `/open`, `/pause`, `/resume`, `/takeover`, `/approve`,
`/deny`, `/stop`, `/runs`, and `/exit`.

### MCP

Keep the model-facing surface compact:

- `taprig_devices`
- `taprig_observe`
- `taprig_execute`
- `taprig_runs`
- `taprig_takeover`

The built-in agent is not required for external MCP clients. Both paths share
the same device and execution services.

## 10. Graphical experience

### Onboarding

1. Check host dependencies and permissions.
2. Explain how to enable developer options and USB debugging.
3. Detect the authorization prompt.
4. Install and verify the TapRig driver.
5. Start video/control and run a reversible smoke test.
6. Configure a model provider or select local/manual-only mode.
7. Land in the workspace with a useful first-task suggestion.

`taprig doctor` exposes the same checks without the UI.

### Main workspace

- device/fleet sidebar;
- live phone or multi-phone grid;
- task composer and model profile;
- streaming agent/action cards;
- questions and approvals;
- pause, stop, retry, and takeover;
- cost, latency, and run status.

### Other views

- devices and health;
- fleets/groups;
- active and historical runs;
- run trace/artifacts/replay;
- model providers, profiles, budgets, and usage;
- approval policy;
- installation and diagnostics.

Manual input immediately acquires control and invalidates stale agent state.

## 11. Persistence and event model

SQLite stores configuration metadata, devices, fleets, runs, work units, steps,
model calls, approvals, and append-only normalized events. Large screenshots,
recordings, UI dumps, and exports live under the data directory and are
referenced by content metadata.

Cross-session context is stored by type and authority, not as one growing chat
transcript:

- explicit user preferences and decisions;
- device identity, capabilities, affinity, and health history;
- versioned app cards and compatibility evidence;
- user scripts, bundled skills, candidate skills, and performance history;
- task/run event logs, checkpoints, outputs, and failure classifications;
- model-routing and cost outcomes;
- artifact metadata and retention policy.

Live phone state is always refreshed before action; a previous session's screen
snapshot is historical evidence, never current authority. Secrets are referenced
through a credential store and are not copied into general memory. The context
builder retrieves only records relevant to the current task/app/device and keeps
their provenance.

Materialized run state makes resume fast. The append-only event trace remains the
source for replay, audit, and rebuilding derived state after a crash.

Core event families:

```text
device.discovered / state_changed / disconnected
run.created / started / paused / resumed / completed / failed
lease.acquired / released / revoked
observation.received
plan.created
step.started / verified / failed
model.started / completed / failed
approval.requested / resolved
takeover.started / ended
artifact.created
```

Events drive the CLI and UI and form the diagnostic trace. Current state may be
materialized for fast reads; the trace remains the evidence.

## 12. Security and privacy

- Local-only networking by default.
- No telemetry by default.
- Provider secrets stored outside the repository and redacted from output.
- Artifact retention configurable; sensitive surfaces can disable persistence.
- Every device action is attributable to a run, actor, and policy decision.
- Approval policy is owner-configurable, including autonomous mode.
- Remote access initially relies on SSH rather than a custom exposed service.
- The web UI never receives raw provider secrets.

## 13. Testing and evaluation

### Automated tests

- Pure state-machine and selector unit tests.
- Fake-device contract tests for runs, recovery, and orchestration.
- scrcpy protocol fixtures pinned to the supported version.
- Android driver protocol and serialization tests.
- Emulator integration tests for semantic actions and failure recovery.
- UI tests against a fake daemon.
- Opt-in physical-device smoke suite.

### Fault injection

Test device disconnect, authorization loss, driver death, video death, app crash,
screen rotation, keyboard replacement, modal appearance, selector ambiguity,
stale observation, model timeout, malformed model output, SSH/client disconnect,
daemon restart, and partial broadcast failure.

### Product metrics

- task success rate;
- verified action success rate;
- cost per verified successful task;
- model calls per task/device;
- p50/p95 observation-to-action latency;
- recovery and rejoin rate;
- fleet throughput;
- deterministic versus model-decided actions;
- broadcast savings against independent agents.

All published benchmark claims include task definitions, device/app versions,
model configuration, raw traces, and failure classifications.

### Known weaknesses to measure, not hide

- Device enrollment, locks, biometrics, CAPTCHAs, DRM, and hardware confirmation
  can require a person or remain unavailable.
- Accessibility state is incomplete in games, video, canvas, some WebViews, and
  poorly implemented apps, forcing slower visual perception.
- OEM Android variants and USB/driver/hub behavior create hardware-specific
  failures.
- App updates invalidate selectors, app cards, and scripts until compatibility
  is re-verified.
- External side effects such as a sent message or published post may be hard to
  verify transactionally and unsafe to retry blindly.
- Cheap-model reliability and escalation thresholds are unknown until TapRig's
  eval suite measures them.
- Fleet broadcast can amplify one bad plan, so per-device verification and drift
  isolation are mandatory.
- Stored screens, messages, credentials, and run traces create a sensitive local
  data boundary that needs retention controls and threat modeling.
- Continuous multi-device video can exhaust USB bandwidth, encoder capacity,
  memory, and power before model inference becomes the bottleneck.

## 14. Build roadmap

### M0 — foundation

- [x] Select and add an open-source license.
- [ ] Add TypeScript build/test/lint foundation and CI. (Local checks complete;
  GitHub workflow push requires a credential with `workflow` scope.)
- [x] Define core device, run, event, action, and error contracts.
- [x] Add fake device adapter and contract tests.
- [x] Define daemon lifecycle and authenticated local API boundary.

Exit: clean clone installs and tests; contracts support the first vertical slice
without Android or model dependencies.

### M1 — one-phone control vertical slice

- [x] Discover and classify USB ADB devices.
- [x] Start one device actor with health/reconnect behavior.
- [x] Integrate pinned scrcpy video.
- [ ] Integrate scrcpy raw-input transport (leased manual input currently uses ADB).
- [x] Build the first Android driver observation/action protocol.
- [x] Show one live phone in the browser.
- [x] Support manual control and takeover.
- [ ] Implement `doctor`, `devices`, and deterministic `execute` commands.
  (`doctor`, `devices`, and raw execution complete; integrated postcondition
  verification remains.)

Exit: a new user can connect one phone, see it live, inspect semantic state,
execute and verify reversible actions, and take over manually.

### M2 — complete single-phone agent product

- [x] Durable runs and normalized event stream.
- [x] Interactive CLI and run attachment.
- [x] Provider configuration and model profiles.
- [x] Built-in observe/decide/execute/verify/recover loop.
- [ ] Questions, approvals, budgets, artifacts, and replay.
- [x] User script creation, inspection, testing, and deterministic execution.
- [ ] Full main workspace and onboarding.
- [ ] MCP adapter.

Exit: install, connect one phone, type a task in UI or CLI, watch it finish or
stop explicitly, and inspect cost and evidence.

### M3 — fleet orchestration

- [ ] Device groups and capability scheduling.
- [ ] Independent concurrent runs.
- [ ] Broadcast plans, barriers, drift recovery, and rejoin.
- [ ] Coordinated task DAGs and result aggregation.
- [ ] Fleet UI and CLI controls.

Exit: demonstrate independent, broadcast, and coordinated modes on the physical
PhoneFarm fleet with reproducible traces.

### M4 — efficiency and reliability

- [ ] Compact diffs and progressive context disclosure.
- [ ] Deterministic skill recording/replay.
- [ ] Local OCR and perception plugin boundary.
- [ ] Model routing/evaluation improvements.
- [ ] Restart recovery and long-duration soak testing.
- [ ] Public benchmark suite and comparison methodology.

Exit: publish measured cost, latency, success, and fleet-scaling results.

### M5 — distribution and launch

- [ ] Electron packaging and signed installers where practical.
- [ ] Guided updates and driver compatibility management.
- [ ] Contributor documentation and stable extension contracts.
- [ ] Security review and threat model.
- [ ] Hero demo covering all three orchestration modes.
- [ ] Public launch assets, technical write-up, and benchmark report.

Exit: an unfamiliar developer installs TapRig from the public repository and
completes the documented first task without project-author assistance.

## 15. First hero demo

The launch video should prove the architecture rather than hide it:

1. connect several spare Android phones and discover them automatically;
2. type a task and watch the live action trace;
3. run independent tasks on several phones;
4. broadcast one plan across a fleet;
5. inject a modal on one phone and show drift recovery/rejoin;
6. coordinate one task across several phones;
7. take over manually and return control;
8. compare Economy and Best cost/success;
9. finish on the exported trace and reproducible benchmark.

## 16. Explicitly deferred

Not part of the first complete product:

- hosted cloud-phone inventory;
- iOS control;
- TapRig accounts or multi-tenant cloud service;
- custom ROM or root-only control path;
- marketplace for skills;
- distributed execution across several TapRig hosts;
- a custom remote-access protocol that duplicates SSH.

These are revisited only after the single-host Android product and fleet modes
are reliable.
