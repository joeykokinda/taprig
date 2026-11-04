# Run control

TapRig runs can be paused, resumed, stopped, or retried from the CLI, control
room, authenticated API, or `taprig_run_control` MCP tool.

```console
taprig pause <run-id>
taprig resume <run-id>
taprig stop <run-id>
taprig retry <run-id>
```

Pause and stop are cooperative boundaries. TapRig checks durable run state
before and after every observation, model decision, and device action. An
already-running external call cannot be undone, but its result is handled
safely: a model result is discarded, while a phone action that finishes is
saved to recovery evidence before the worker exits. A user stop is never
rewritten as a runtime failure.

Resume reuses the original phone or fleet recovery state, refreshes current
phone state, and does not blindly repeat verified work. Retry creates a new run
with the original task, mode, budget, immutable affinity, and screenshot policy;
the original failed/stopped run remains unchanged for auditability.

TapRig does not currently cancel an in-flight provider HTTP request or ADB
command. Pause/stop takes effect at the next boundary. True transport-level
cancellation can be added later without changing the durable control contract.
