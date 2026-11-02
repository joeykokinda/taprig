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

The project is in architecture and foundation work. See
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
npm run taprig --                       # interactive when attached to a TTY
npm run taprig -- run "Open Settings"  # create a durable run
npm run taprig -- run --mode coordinated "Split this workflow across the fleet"
npm run taprig -- run --max-model-calls 8 --max-actions 30 "Open Settings"
npm run taprig -- runs                  # list runs
npm run taprig -- attach <run-id>       # inspect state and ordered events
npm run taprig -- replay <run-id>       # replay secret-safe agent activity
npm run taprig -- answer <run-id> <question-id> "Personal account"
npm run taprig -- answer <run-id> <question-id> --sensitive "123456"
```

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
```

See [model routing](docs/MODELS.md) for role budgets, hard per-run spend guards,
and editable targets.

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
documented in [BENCHMARKS.md](docs/BENCHMARKS.md).

The same experience is packaged in a sandboxed Electron shell. See the
[desktop application](docs/DESKTOP.md) for development and packaging commands.

## License

TapRig is open source under the [MIT License](LICENSE).
