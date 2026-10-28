# TapRig device runtime, diagnostics, and cross-app execution

Status: **canonical design for device understanding and remediation**  
Parent plans: [PLAN.md](PLAN.md) · [AGENT_ARCHITECTURE.md](AGENT_ARCHITECTURE.md)

TapRig must understand enough of a connected Android device to prepare it for a
task, diagnose failures, repair ordinary conditions, execute across apps, and
prove the requested outcome. A screenshot and an action list are not a device
model.

## 1. Reliability contract

After one-time Android trust enrollment, TapRig attempts to complete tasks
without requiring physical interaction with the handset. It may ask the user for
missing information through TapRig, then continue from the same checkpoint.

Every failure path produces one of four outcomes:

1. repaired deterministically and resumed;
2. recovered by the device agent and resumed;
3. suspended on one precise user/platform dependency;
4. stopped with a typed diagnosis, evidence, and next possible action.

No indefinite spinner, repeated blind tap, silent device drop, or false success.

Android trust and application security boundaries remain real. Developer-mode
enrollment, host RSA authorization, lock credentials, biometric confirmation,
CAPTCHAs, DRM, and hardware-backed approval may require a person or may not be
automatable. TapRig identifies these boundaries rather than disguising them as
generic agent failure.

## 2. Device digital twin

Each connected device has a durable identity and a continuously refreshed,
partially observed state graph. Every fact records its source, observed time,
freshness policy, and confidence where applicable.

```text
Device
├── Identity
│   ├── TapRig ID, ADB serial, model, manufacturer, product
│   ├── Android/API/build/security patch, ABI
│   └── enrollment and driver protocol versions
├── Hardware
│   ├── battery, charging, thermal, storage, memory
│   ├── displays, rotation, resolution, density
│   ├── camera, microphone, sensors, SIM/telephony capability
│   └── USB transport/topology and connection quality
├── Network
│   ├── Wi-Fi/mobile/airplane state, SSID, IP, routes
│   ├── DNS and internet reachability
│   ├── captive portal/VPN/proxy
│   └── last failure and remediation
├── Android runtime
│   ├── boot, awake, keyguard, user/profile
│   ├── input method, clipboard, notification access
│   ├── accessibility/UiAutomation/driver/scrcpy health
│   └── foreground app/activity, windows, semantic generation
├── Software
│   ├── packages, versions, enabled state, permissions
│   ├── processes/crashes/ANRs and bounded diagnostic logs
│   └── app compatibility/app-card status
├── TapRig control
│   ├── capabilities and last capability smoke test
│   ├── current lease, run, work unit, checkpoint
│   └── actor queue, idempotency/reconnect state
└── History
    ├── material health transitions
    ├── faults and repairs
    └── task/automation outcomes and compatibility evidence
```

The graph is not assumed complete. Facts expire by domain: a model number is
stable; foreground activity and connectivity expire immediately; installed app
versions refresh on relevant package events and task preflight.

Previous screen state is historical evidence. It never authorizes a current
action without a fresh observation generation.

## 3. Capability registry

TapRig describes what a device can currently do, not merely what Android usually
supports.

Examples:

- semantic observation/action;
- raw touch/key/gesture input;
- reliable Unicode text;
- video/audio/screenshot/recording;
- intent and bounded shell execution;
- install/uninstall/package inspection;
- clipboard and file transfer;
- notification access;
- SMS/telephony access;
- camera/microphone/sensor bridge;
- authenticated email connector available to this run;
- local OCR/vision/model availability.

Each capability has:

- provider/transport;
- version;
- permission/trust requirement;
- last verified time and result;
- limitations;
- repair or setup path.

The scheduler assigns work by verified capability. The agent never discovers
mid-task that “this phone probably cannot do that” when preflight could know.

## 4. Task prerequisite planning

The orchestrator compiles each work unit into prerequisites before giving it to a
device:

```text
Task outcome
  |
  +-- device capability requirements
  +-- app/package/version requirements
  +-- network requirements
  +-- account/session requirements
  +-- credential/challenge channels
  +-- input/output artifact requirements
  `-- completion verifier requirements
```

Example for “post this video to TikTok”:

```text
TikTok installed and compatible
TikTok authenticated
internet reachable
video file available on device or transferable
storage sufficient
reliable text and raw/semantic input
visual fallback available for inaccessible editor controls
post-publication verifier available
```

Prerequisites form a dependency graph. TapRig satisfies and verifies them in
order, then begins the requested workflow. The user sees preparation as part of
the same run, not as unrelated setup errors.

## 5. Diagnostic engine

Diagnosis is evidence-driven. A failed action first becomes a typed symptom, then
the diagnostic engine evaluates likely faults against live probes.

### Probe classes

- host: executable/version/permission/port/process/resource checks;
- USB/ADB: enumeration, authorization, transport, reconnect, latency;
- driver/scrcpy: version handshake, sockets, heartbeat, frame/action smoke test;
- Android: boot/keyguard/input/window/package/permission state;
- network: interface, association, IP, route, DNS, TLS/internet, captive portal;
- app: installed/enabled/version/launch/foreground/crash/ANR/UI availability;
- task: required account/session/artifact/capability/completion verifier.

### Fault record

```ts
interface Fault {
  code: string;
  scope: "host" | "device" | "network" | "app" | "account" | "task";
  evidence: EvidenceRef[];
  affectedCapabilities: string[];
  repairability: "automatic" | "needs-information" | "needs-user" | "unsupported";
  remediationIds: string[];
  firstSeenAt: string;
  lastSeenAt: string;
}
```

The engine may rank hypotheses, but it does not call something repaired until
the original failed probe and task precondition pass.

## 6. Remediation graphs

A remediation is a typed, versioned graph with:

- fault/precondition match;
- required permissions and user information;
- reversible and irreversible steps;
- checkpoints and final verifier;
- retry/rollback/escalation policy;
- device/OEM/Android compatibility;
- secrets consumed, never logged;
- measured success history.

Example: no internet.

```text
probe interfaces
  -> disable airplane mode if authorized
  -> enable Wi-Fi
  -> inspect saved/visible networks
  -> reconnect saved compatible network
  -> if credentials missing, request SSID/password once
  -> connect using exact Android operation or semantic Settings flow
  -> verify association, IP, route, DNS, and internet
  -> detect/handle captive portal when permitted
  -> resume original work checkpoint
```

Safe deterministic repairs run without a model. The device agent handles novel
OEM UI or ambiguous state. Repeated unchanged state terminates the remediation
instead of looping.

Device unlock is a remediation, not an agent prompt. During enrollment, the
owner may configure a PIN/password as a scoped secret reference for one device.
The executor wakes the display, opens the credential surface, dereferences and
enters the secret locally, then verifies keyguard dismissal. The agent and event
log see only whether an unlock credential is available and whether verification
succeeded. TapRig does not automate biometrics, and some devices may require
physical presence before ADB is available after reboot.

## 7. Cross-app workflows

A work unit may span multiple applications and system surfaces. The device agent
maintains a local workflow graph rather than treating an app switch as task loss.

Each cross-app step declares:

- source and target app/surface;
- value or artifact being transferred;
- sensitivity and redaction class;
- expected return checkpoint;
- completion evidence.

Examples:

- receive a link in Messages, inspect it in the browser, reply in Messages;
- obtain an email verification code, return to TikTok, submit it;
- download a video, open TikTok, publish, and verify the post;
- read task inputs from a file and distribute work across several phones.

App switching invalidates assumptions tied to the prior window. The device agent
keeps workflow state but always observes the new foreground surface.

## 8. Authentication challenge resolver

Authentication is modeled explicitly rather than as arbitrary UI text.

```ts
interface AuthChallenge {
  id: string;
  accountRef?: string;
  destinationHint?: string;
  kind:
    | "email-code"
    | "sms-code"
    | "notification"
    | "totp"
    | "link"
    | "passkey"
    | "captcha"
    | "biometric";
  issuer?: string;
  createdAt: string;
  expiresAt?: string;
  returnCheckpoint: string;
}
```

Available resolvers depend on explicit user authorization:

1. Android notification access on the controlled device;
2. SMS access where device/permissions permit it;
3. an authorized email provider connector;
4. semantic automation of an already authenticated email app;
5. local TOTP secret reference where the owner configured it;
6. a user question through CLI/UI;
7. human takeover for passkey, CAPTCHA, biometric, or provider-required review.

Challenge resolution matches issuer, destination/account hint, recency, task
correlation, and expiry. It does not grab the newest arbitrary number from an
inbox. The resolver returns a secret value directly to the executor. The model
sees challenge type and resolution status, not the credential/code unless no
safer route exists and policy explicitly permits it.

## 9. Authorized TikTok login example

Assumptions: the user owns/controls the account and authorizes TapRig to use the
provided Google email and its verification channel.

```text
Orchestrator: task requires authenticated TikTok session
  |
  v
Device preflight
  - ready/unlocked
  - internet verified
  - compatible TikTok installed
  - secret input channel available
  |
  v
Device agent launches TikTok and selects authorized login method
  |
  v
Credential broker supplies email by reference directly to executor
  |
  v
TikTok produces email-code challenge
  |
  v
Challenge resolver
  - inspect authorized notification/email channel
  - match TikTok sender/issuer, destination, recency, expiry
  - extract code locally and redact trace
  |
  v
Executor submits code
  |
  v
Verifier confirms authenticated TikTok state/account identity
  |
  v
Original task resumes
```

If Google/TikTok requires a CAPTCHA, passkey, biometric, device approval, or
suspicious-login review, TapRig suspends at that exact challenge. It does not
claim that more taps or a stronger model can bypass the provider's trust policy.

## 10. Credential broker

Secrets are capabilities, not ordinary strings in agent memory.

- The user enters a secret through a masked UI/CLI channel.
- The run receives a scoped secret reference, not the plaintext value.
- Only an authorized executor/resolver can dereference it for a declared use.
- Values are excluded from model context, event text, normal logs, exports, and
  screenshots retained by default.
- Persistence is opt-in and encrypted using an OS keychain or dedicated local
  secret store.
- Access records run, device, purpose, time, and result without recording value.
- Secret references expire or are revoked according to policy.

The web UI never owns provider/account secrets merely because it renders a run.

## 11. Device-agent responsibilities

The device agent reasons about local task state. It does not replace diagnostics
or invent low-level repair procedures already represented by probes/runbooks.

It receives:

- assigned outcome and completion condition;
- prerequisite and current fault summaries;
- live semantic/visual observation;
- verified capabilities;
- relevant app cards, scripts, and remediations;
- recent local evidence;
- secret references only as opaque available capabilities;
- local budget and escalation policy.

It chooses among execute, invoke remediation, invoke challenge resolver, replan,
ask user, escalate, or fail. Deterministic services execute and verify.

## 12. Failure classes

- host dependency/configuration;
- USB power/cable/hub/topology;
- ADB authorization/transport;
- driver/scrcpy protocol/process;
- device boot/keyguard/thermal/storage;
- input method/gesture/display;
- network association/routing/DNS/internet/captive portal;
- package/version/permission/process/crash/ANR;
- semantic accessibility/selector;
- visual grounding;
- account/session/credential/challenge;
- external service/rate/platform policy;
- task planning/completion verification;
- model decision/schema/recovery;
- unsupported security boundary.

Every terminal run names a primary class, evidence, attempted remediations, and
the minimal condition needed to continue.

## 13. Evaluation

### Device readiness suite

- discover/authorize/reconnect/reboot;
- wake/unlock boundary detection;
- driver and scrcpy restart;
- text/clipboard/gesture smoke tests;
- network loss, wrong password, DNS failure, captive portal;
- missing/outdated/disabled/crashing app;
- permission and keyboard repair;
- low storage/battery/thermal conditions.

### Cross-app suite

- switch apps and return to checkpoint;
- transfer normal and secret values without leakage;
- notification/SMS/email challenge correlation;
- expired and competing OTP messages;
- app process death during challenge;
- SSH/UI disconnect while waiting for user;
- verifier distinguishes tapped-login from authenticated-session.

### Required metrics

- prerequisite detection recall/precision;
- diagnosis accuracy and time;
- automatic remediation success;
- unnecessary user questions;
- resume success after repair;
- secret leakage tests;
- end-to-end task success/cost/latency;
- false-success rate;
- repeated-state-loop rate.

The zero-touch objective is measured as user interventions per verified task,
split into missing-information questions, policy approvals, and unavoidable
platform-presence requirements.

## 14. Implementation order

1. Device fact/provenance/freshness contracts.
2. Capability and readiness-probe contracts.
3. Fake digital twin with fault injection.
4. Deterministic diagnosis and remediation state machine.
5. ADB identity, package, network, battery, screen, and runtime probes.
6. Driver/scrcpy health and smoke probes.
7. Task prerequisite compiler.
8. Secret-reference boundary and redaction tests.
9. Cross-app workflow checkpoints.
10. Notification/email/SMS challenge interfaces and fake resolvers.
11. Authorized real-device login integration tests.
12. OEM/app-specific remediations promoted only from measured evidence.
