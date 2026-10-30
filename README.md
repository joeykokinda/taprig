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
directory with private file permissions. The model-driven run worker, live
control room, and desktop packaging remain in progress.
See [physical hardware results](docs/HARDWARE_VALIDATION.md).

The pre-alpha run shell and its non-interactive equivalents are available now:

```console
npm run taprig --                       # interactive when attached to a TTY
npm run taprig -- run "Open Settings"  # create a durable run
npm run taprig -- runs                  # list runs
npm run taprig -- attach <run-id>       # inspect state and ordered events
```

Runs remain `created` until a configured agent worker is available; TapRig does
not report task execution before verified device evidence exists.

Model profiles are configured without persisting provider secrets:

```console
npm run taprig -- model show
npm run taprig -- model profile economy   # economy | balanced | best
```

See [model routing](docs/MODELS.md) for role budgets and editable targets.

Repeated workflows can run as parameterized, checkpointed scripts without a
model call while the UI remains on the verified path. See
[deterministic scripts](docs/SCRIPTS.md) and the
[Settings example](examples/open-settings-section.script.json).

## License

License selection is part of the foundation milestone and must be completed
before accepting external contributions.
