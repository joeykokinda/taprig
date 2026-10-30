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
- `taprig_task`: create a durable natural-language run;
- `taprig_run`: inspect run state and ordered events;
- `taprig_action`: send one schema-validated raw action to one phone.

Every tool calls the loopback daemon. MCP does not open a second ADB connection,
bypass leases, expose the daemon token, or duplicate execution logic.
