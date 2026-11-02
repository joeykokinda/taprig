# TapRig execution queue

This is the ordered product queue. The canonical architecture remains in
[PLAN.md](PLAN.md); this file answers what gets built next.

## Current estimate

- Foundation/runtime: **97%**
- Physical Android control: **60%**
- Agent loop: **80%**
- Fleet orchestration: **65%**
- Desktop application: **45%**
- Public website/distribution: **45%**
- Complete launch-ready product: **71%**

Percentages describe demonstrated functionality, not lines of code.

## P0 — first complete single-phone loop

- [x] Discover and authorize a real Android phone.
- [x] Track identity, boot, keyguard, disconnect, and reconnect state.
- [x] Execute raw key, tap, swipe, and app-launch actions.
- [x] Unlock a real PIN-protected phone through the scoped credential broker.
- [x] Add foreground activity and screen-state observations to the device actor.
- [x] Add screenshot capture and artifact retention.
- [x] Integrate pinned, checksum-verified scrcpy video transport.
- [x] Stream scrcpy video to the control room and implement manual takeover leases.
- [x] Bootstrap semantic observation and selector taps through UIAutomator.
- [x] Execute and verify a semantic action batch on physical hardware.
- [ ] Replace polling with the event-driven TapRig Android accessibility driver.
- [x] Implement the bounded observe → decide → execute → verify → recover core loop.
- [ ] Calibrate the complete loop on physical hardware after the device reconnects.

## P1 — usable local product

- [x] Persist devices, runs, events, questions, and checkpoints in SQLite.
- [x] Add daemon lifecycle command and local token persistence.
- [x] Make CLI commands clients of the daemon instead of direct ADB callers.
- [x] Build interactive `taprig` task session and `attach` flow.
- [x] Add model-provider configuration and Economy/Balanced/Best routing.
- [x] Persist provider calls, tokens, decisions, actions, and runtime per run.
- [x] Enforce durable per-run model-call and attempted-action budgets.
- [x] Recover interrupted runs and fleet plans after daemon restart.
- [x] Replay durable secret-safe observation, decision, and action traces.
- [x] Connect independent natural-language runs to the bounded ready-device worker.
- [x] Answer and resume durable agent questions without persisting sensitive values.
- [x] Build scripts: create, inspect, run, verify, and emit a typed recovery handoff.
- [x] Connect script mismatch recovery and successful-run promotion to the agent worker.
- [x] Serve the control-room web UI from the local daemon.
- [x] Package the daemon and UI as an Electron desktop application.

## P2 — fleet and launch

- [ ] Validate simultaneous live view and isolated takeover across two physical phones.
- [x] Independent parallel device runs with leases.
- [x] Broadcast plan, barriers, drift recovery, and rejoin.
- [x] Coordinated task DAGs and result aggregation.
- [x] Capability-aware phone assignment for agent and coordinated work.
- [x] MCP adapter over the same daemon API.
- [ ] Signed macOS, Windows, and Linux installers.
- [ ] GitHub Release download automation and checksums.
- [x] First public website design and interactive product preview.
- [ ] Connect website download buttons to signed releases.
- [x] Add a repeatable synthetic orchestration regression harness.
- [ ] Publish repeatable cost, latency, and success benchmarks.
- [ ] Record the hero demo and launch the public repository.
