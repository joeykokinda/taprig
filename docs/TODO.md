# TapRig execution queue

This is the ordered product queue. The canonical architecture remains in
[PLAN.md](PLAN.md); this file answers what gets built next.

## Current estimate

- Foundation/runtime: **70%**
- Physical Android control: **35%**
- Agent loop: **5%**
- Fleet orchestration: **5%**
- Desktop application: **5%**
- Public website/distribution: **45%**
- Complete launch-ready product: **25%**

Percentages describe demonstrated functionality, not lines of code.

## P0 — first complete single-phone loop

- [x] Discover and authorize a real Android phone.
- [x] Track identity, boot, keyguard, disconnect, and reconnect state.
- [x] Execute raw key, tap, swipe, and app-launch actions.
- [x] Unlock a real PIN-protected phone through the scoped credential broker.
- [x] Add foreground activity and screen-state observations to the device actor.
- [x] Add screenshot capture and artifact retention.
- [ ] Integrate pinned scrcpy video and manual takeover.
- [ ] Build the TapRig Android semantic/accessibility driver.
- [ ] Execute and verify a semantic action batch on physical hardware.
- [ ] Implement bounded observe → decide → execute → verify → recover.

## P1 — usable local product

- [ ] Persist devices, runs, events, questions, and checkpoints in SQLite.
- [ ] Add daemon lifecycle command and local token persistence.
- [ ] Make CLI commands clients of the daemon instead of direct ADB callers.
- [ ] Build interactive `taprig` task session and `attach` flow.
- [ ] Add model-provider configuration and Economy/Balanced/Best routing.
- [ ] Build scripts: create, inspect, run, verify, and recover.
- [ ] Serve the control-room web UI from the local daemon.
- [ ] Package the daemon and UI as an Electron desktop application.

## P2 — fleet and launch

- [ ] Independent parallel device runs with leases.
- [ ] Broadcast plan, barriers, drift recovery, and rejoin.
- [ ] Coordinated task DAGs and result aggregation.
- [ ] MCP adapter over the same daemon API.
- [ ] Signed macOS, Windows, and Linux installers.
- [ ] GitHub Release download automation and checksums.
- [x] First public website design and interactive product preview.
- [ ] Connect website download buttons to signed releases.
- [ ] Publish repeatable cost, latency, and success benchmarks.
- [ ] Record the hero demo and launch the public repository.
