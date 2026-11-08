# TapRig

**Plug in phones. Give agents hands.**

TapRig is an open-source, local-first control plane and runtime for phone agents.
Connect a spare Android device to a computer, describe a task, and watch the
agent operate it. Run one agent on one phone, independent agents across a fleet,
or one coordinated workflow across many devices.

TapRig is being built around four promises:

- **Easy:** discover connected phones automatically and start from a CLI or UI.
- **Fast:** use semantic Android state and event-driven actions before vision.
- **Efficient:** batch and verify actions locally instead of calling a model for
  every tap.
- **Inspectable:** stream the live phone, agent activity, cost, failures, and
  recovery in one place.

## Quickstart

You need Node 24.12+ and one model: a signed-in **Claude Code** or **Codex**
CLI, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or any OpenAI-compatible server.
TapRig picks whichever it finds, downloads Android platform-tools (`adb`) when
the machine has none, and ships the phone driver prebuilt.

```console
npm install -g taprig          # or from source: git clone … && npm ci && npm link
```

On the phone, enable Developer options and USB debugging, plug it in, unlock
it, and accept the "Allow USB debugging" prompt. Then:

```console
taprig setup                                          # starts the daemon, checks everything
taprig run "Open Settings and turn on Dark theme"     # follows the run until it is done
```

To let Claude Code or Codex drive the phones themselves, register TapRig as an
MCP server and ask in plain language:

```console
taprig connect claude     # or: taprig connect codex
claude "Use TapRig to set an alarm for 7:30 AM on my phone"
```

`taprig help` lists every command; `taprig model use anthropic|openai|claude|codex`
switches providers. Any OpenAI-compatible server works too, so a cheap or local
model is one command away:

```console
taprig model use compatible --base-url https://openrouter.ai/api/v1 --model qwen/qwen3-235b-a22b --api-key-env OPENROUTER_API_KEY
taprig model use compatible --base-url http://localhost:11434/v1 --model qwen3   # Ollama, no key
```
Without the driver bundle TapRig falls back to UIAutomator,
which works everywhere but is slower and cannot type non-ASCII text.

The project is in active pre-alpha development. See
[the canonical build plan](docs/PLAN.md) and
[the built-in agent architecture](docs/AGENT_ARCHITECTURE.md). Device modeling,
diagnostics, remediation, and cross-app authentication are specified in the
[device runtime design](docs/DEVICE_RUNTIME.md). The ordered implementation queue
is tracked in [TODO.md](docs/TODO.md).

## Intended experience

```console
$ ssh phone-server
$ taprig

TapRig · 3 devices connected · Balanced

› Reply to my unread messages from people I already know.
```

The same daemon will power the interactive CLI, browser/desktop application,
MCP integration, and programmatic API.

## Status

TapRig is pre-alpha. It discovers and diagnoses USB ADB devices, maintains
durable device/run state, performs raw and semantic actions, verifies action
batches, and has a bounded agent loop. The authenticated daemon has secure
background lifecycle commands:

```console
npm run taprig -- daemon start
npm run taprig -- daemon status
npm run taprig -- daemon stop
```

The token, state, log, and SQLite database stay in the OS application-data
directory with private file permissions. A configured model worker now assigns
an available phone and durably records verified completion, user questions, or
typed failure. Interrupted runs automatically recover on their original phones
after a daemon restart, using redacted verified progress and the saved fleet
plan. Independent, broadcast, and dependency-ordered coordinated runs share
capability-aware device leases and durable evidence. The Electron
application has local Linux packages; signed cross-platform releases remain in
progress.
See [physical hardware results](docs/HARDWARE_VALIDATION.md).

The pre-alpha run shell and its non-interactive equivalents are available now:

```console
npm run taprig -- onboard                # start daemon + guided readiness check
npm run taprig --                       # interactive when attached to a TTY
npm run taprig -- run "Open Settings"  # create a durable run
npm run taprig -- run --mode coordinated "Split this workflow across the fleet"
npm run taprig -- run --max-model-calls 8 --max-actions 30 "Open Settings"
npm run taprig -- run --retain-screenshots "Open Settings"
npm run taprig -- group set social phone-1 phone-2
npm run taprig -- run --group social --mode broadcast "Post on both phones"
npm run taprig -- runs                  # list runs
npm run taprig -- attach <run-id>       # inspect state and ordered events
npm run taprig -- replay <run-id>       # replay secret-safe agent activity
npm run taprig -- artifacts <run-id>    # list retained run evidence
npm run taprig -- export <run-id>       # private portable JSON bundle
npm run taprig -- answer <run-id> <question-id> "Personal account"
npm run taprig -- answer <run-id> <question-id> --sensitive "123456"
npm run taprig -- approve <run-id> <approval-id>
npm run taprig -- deny <run-id> <approval-id>
npm run taprig -- pause <run-id>
npm run taprig -- resume <run-id>
npm run taprig -- stop <run-id>
npm run taprig -- retry <run-id>
```

See [first-phone onboarding](docs/ONBOARDING.md) for USB trust, model setup,
the local UI, and the SSH-first server workflow.

### What a run gets for free

- **Safety gates.** A tap on Send, Post, Pay, Delete, Confirm and similar pauses for
  your approval unless the task itself asked for that action. "Post this on X" taps
  Post; "read my timeline" cannot.
- **App notes.** Each run may save one short UI fact per app (where compose lives, a
  quirk). Later runs on that app read them, so repeat tasks need fewer model calls.
  Plain text under `app-notes/` in the data directory; delete any line you dislike.
- **Notifications.** The shade is read once at the start of every run, so "what did
  Mom text me" is answered without opening Messages. Also `taprig notifications`
  and the `taprig_notifications` MCP tool.
- **Video.** Every run is recorded with the phone's own `screenrecord` and kept as a
  video artifact (`taprig artifacts <run>`); `taprig settings video off` disables it.
- **Schedules.** `taprig schedule add "every 30m" "..."` or `"daily at 08:00"` runs a
  task on its own; `schedule list` and `schedule remove <id>` manage them.
- **Triggers.** `taprig trigger add "messaging.*Mom" "Read me the text and reply that
  I'm driving"` starts a run when a matching notification arrives.
- **Named secrets.** `taprig secret set x_password` (typed hidden) stores a value the
  task references as `{{secret:x_password}}`. The model sees only the token; the value
  is substituted on the way to the phone and redacted from traces. Stored in a
  0600 file in the data directory, never in the database or logs.
- **Doctor.** `taprig doctor` checks the daemon, each phone's lock, authorization and
  driver state, and the model provider, with one fix per failing line.
- **Cleanup.** A failed or stopped run presses home so the next one starts clean.

### Ask the phone a question

A read task ends with the answer printed, because the model's completion evidence
is the result:

```console
$ taprig run "Open X, open Notifications, and tell me what the latest one says"
  ...
The Notifications tab is open in X. The most recent notification, from codila 15m
ago, reads: "REA (reverse engineer anything) ..."

completed
```

The same text shows under the run in the control room and in `taprig_run` over MCP.
By default every decision includes a screenshot so dialogs, toasts, and web pages
the accessibility tree does not describe are still seen; `taprig settings vision
auto` limits screenshots to thin screens and misses.

### Logins, captchas, and anything only you can do

A run stops and asks when it needs you, and `taprig run` prompts right in the
terminal. Questions that look like a password or code are typed hidden and sent
as sensitive: the model never sees the value, it types a `[SECRET]` placeholder
and TapRig swaps in the real text on the phone. Nothing sensitive reaches logs,
evidence, or the model's context.

```console
$ taprig run "Open Chrome, log in to example.com, then open my profile"
  ...
What is the username for example.com?
› me@example.com
What is the password for example.com?
(hidden) ›
  ...
completed
```

For a captcha, a 2FA prompt, or a fingerprint the agent asks you to do it. Open
the control room, press TAKE CONTROL on the phone, tap and type on the live
screen (the text box next to the buttons types into the focused field), then
answer `done` and the run continues. The same works from the CLI with
`taprig answer <run> <question> done` and from the MCP tools.

Set the provider key in the daemon environment, restart it, and new runs execute
through the bounded semantic workers. Without a configured key,
runs remain `created`; TapRig never reports execution before verified device
evidence exists.

```console
export OPENAI_API_KEY=...
npm run taprig -- daemon stop
npm run taprig -- daemon start
```

Model profiles are configured without persisting provider secrets:

```console
npm run taprig -- model show
npm run taprig -- model profile economy   # economy | balanced | best
npm run taprig -- settings                # owner approval/artifact defaults
npm run taprig -- settings approval autonomous
```

See [model routing](docs/MODELS.md) for role budgets, hard per-run spend guards,
and editable targets.
See [owner settings](docs/SETTINGS.md) for durable approval and artifact defaults.

Typed approvals can suspend a run before an explicitly confirmation-gated
action and resume or stop it from CLI, UI, API, or MCP. See
[approval behavior and current policy boundary](docs/APPROVALS.md).

Opted-in terminal phone screenshots are retained privately and can be inspected
or exported with the full durable trace. Screen pixels are off by default. See
[run artifacts](docs/ARTIFACTS.md).

Repeated workflows can run as parameterized, checkpointed scripts without a
model call while the UI remains on the verified path. See
[deterministic scripts](docs/SCRIPTS.md) and the
[Settings example](examples/open-settings-section.script.json).

Launch the authenticated local dashboard with `npm run taprig -- ui`. See the
[control-room security and remote-access notes](docs/CONTROL_ROOM.md).

External agents can launch `taprig mcp` for the official stdio MCP surface. See
[MCP integration](docs/MCP.md).

Run `npm run benchmark` for the clearly labeled synthetic orchestration
regression suite. Its scope and the still-open physical/model benchmark are
documented in [BENCHMARKS.md](docs/BENCHMARKS.md), with raw results in the
[published synthetic baseline](docs/BENCHMARK_RESULTS.md).

Run `npm run soak -- --iterations=1000 --fleet=4 --restart-every=250 --json`
to stress durable runs, fleet leases, trace persistence, and SQLite restart
recovery without claiming physical-device reliability.

The same experience is packaged in a sandboxed Electron shell. See the
[desktop application](docs/DESKTOP.md) for development and packaging commands.

## License

TapRig is open source under the [MIT License](LICENSE).
