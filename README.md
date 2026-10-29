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
[device runtime design](docs/DEVICE_RUNTIME.md).

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

TapRig is pre-alpha. It can discover and classify USB ADB devices with
`npm run taprig -- devices` and diagnose connection setup with
`npm run taprig -- doctor`. Its authenticated local daemon now maintains basic
identity, boot, keyguard, disconnect, and reconnect state. Raw key/gesture/app
actions and verified PIN unlock are implemented; semantic control and the agent
loop are not yet built. See [physical hardware results](docs/HARDWARE_VALIDATION.md).

## License

License selection is part of the foundation milestone and must be completed
before accepting external contributions.
