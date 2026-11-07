# MCP adapter

TapRig exposes the same local daemon through an official MCP stdio server:

```console
taprig mcp
```

Register that command in Claude Code, Codex, VS Code, Cursor, or another MCP
host. The adapter uses the official TypeScript SDK's `serveStdio` entry so it
negotiates current and legacy protocol eras. Standard output is reserved for
MCP JSON-RPC; diagnostics go to standard error.

The compact tool surface is:

- `taprig_devices`: current phone inventory and readiness;
- `taprig_task`: create a durable natural-language run, optionally constrained
  to a named group or explicit device IDs;
- `taprig_run`: inspect run state, ordered events, approvals, and artifact metadata;
- `taprig_approval`: approve or deny one open typed approval;
- `taprig_run_control`: pause, resume, stop, or retry a durable run;
- `taprig_action`: send one schema-validated raw action to one phone.
- `taprig_observe`: one ready phone's semantic screen (elements, foreground
  package, generation);
- `taprig_act`: 1-10 verified raw or semantic actions against an observed
  generation, returning the result and a fresh observation; refused while a run
  holds the phone;
- `taprig_screenshot`: the screen as a PNG image for visual surfaces.

With `taprig_observe`, `taprig_act`, and `taprig_screenshot`, Claude Code or
Codex can be the agent itself, with no TapRig model configured. Register this
install with `taprig connect claude` or `taprig connect codex`.

Every tool calls the loopback daemon. MCP does not open a second ADB connection,
bypass leases, expose the daemon token, or duplicate execution logic.
