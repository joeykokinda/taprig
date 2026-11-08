# TapRig execution queue

This is the ordered product queue. The canonical architecture remains in
[PLAN.md](PLAN.md); this file answers what gets built next.

## Current estimate

- Foundation/runtime: **98%**
- Physical Android control: **80%**
- Agent loop: **88%**
- Fleet orchestration: **72%**
- Desktop application: **64%**
- Public website/distribution: **60%**
- Complete launch-ready product: **84%**

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
- [x] Replace polling with the event-driven TapRig Android accessibility driver.
  Physically validated on 2026-11-06 (`docs/HARDWARE_VALIDATION.md`); UIAutomator
  stays as the per-phone fallback.
- [x] Implement the bounded observe → decide → execute → verify → recover core loop.
- [x] Calibrate the complete loop on physical hardware after the device reconnects.
  Emulator calibration done 2026-11-07 (Settings search, Dark theme, Clock), which
  drove the live-screen stale-check and stable-selector fixes. Physical calibration
  done 2026-11-08 on the Moto G Play 2024 with the Claude CLI, Codex CLI, and
  Claude Code over MCP; it found and fixed the monkey auto-rotate defect and the
  fatal malformed-decision path (`docs/HARDWARE_VALIDATION.md`).

## P1 — usable local product

- [x] Persist devices, runs, events, questions, and checkpoints in SQLite.
- [x] Add daemon lifecycle command and local token persistence.
- [x] Make CLI commands clients of the daemon instead of direct ADB callers.
- [x] Build interactive `taprig` task session and `attach` flow.
- [x] Add model-provider configuration and Economy/Balanced/Best routing.
- [x] Support the Claude API, signed-in Claude Code and Codex CLIs, and OpenAI, with
  automatic detection. Validated end to end on an Android 34 emulator.
- [x] Vision fallback: screenshots on thin screens with normalized coordinate taps.
- [x] Persist provider calls, tokens, decisions, actions, and runtime per run.
- [x] Enforce durable per-run model-call and attempted-action budgets.
- [x] Recover interrupted runs and fleet plans after daemon restart.
- [x] Replay durable secret-safe observation, decision, and action traces.
- [x] Connect independent natural-language runs to the bounded ready-device worker.
- [x] Answer and resume durable agent questions without persisting sensitive values.
- [x] Request, persist, approve, or deny typed action approvals across fleet modes.
- [x] Retain, inspect, and portably export run artifacts with the durable trace.
- [x] Build scripts: create, inspect, run, verify, and emit a typed recovery handoff.
- [x] Connect script mismatch recovery and successful-run promotion to the agent worker.
- [x] Serve the control-room web UI from the local daemon.
- [x] Add one canonical guided-readiness flow to CLI and control room.
- [x] Persist owner approval and artifact defaults with CLI/control-room editing.
- [x] Add cooperative pause/resume/stop and immutable failed-run retry controls.
- [x] Package the daemon and UI as an Electron desktop application.
- [x] Logins and human handoff: hidden terminal prompts for passwords and codes, a
  `[SECRET]` placeholder so the model never sees the value, control-room typing
  during TAKE CONTROL for captchas, `taprig_answer` over MCP, installed-app hints.
- [x] Validate a real login with human-supplied credentials on the Moto
  (the-internet.herokuapp.com/login, 31 s, no secret in logs or export).
- [x] Validate a captcha-style human handoff on the Moto: agent pauses, human types
  through the manual text path, answers done, agent finishes the login (37 s).
- [x] Per-action verification in the driver; screenshot every decision by default;
  tell the model when the screen did not move; dismiss interruptions.
- [x] Resolve launcher activities before `am start`; 8 s launch window; hot-reload
  a rebuilt driver bundle without a daemon restart.
- [x] Surface the run's answer in `taprig run`, `attach`, the control room, and MCP.
- [x] Real apps validated on the Moto: X compose (draft), X timeline and
  notifications questions, Messages inbox.
- [x] Safety gates on consequential taps (Send, Post, Pay, Delete, ...) unless the task asked.
- [x] Per-app UI notes carried across runs.
- [x] Notification shade: CLI, MCP tool, daemon route, and the first decision of each run.
- [x] Scheduled runs (every N minutes, daily at HH:MM) fired from the daemon poll.
- [x] Run video via the phone's screenrecord, stored as an artifact; setting to disable.
- [x] `taprig doctor` backed by the daemon setup report, one fix per failure.
- [x] Press home after a failed or stopped run.
- [x] Emulator smoke matrix in CI (API 30, 33, 35).
- [ ] Named per-app secrets so "log in to X" needs no question on repeat runs.
- [ ] Chrome rig profile: password saving and breach warnings off once per phone.
- [ ] Notification-triggered runs ("when Mom texts, read it to me").
- [ ] Landing page with install buttons and a 60-second demo clip.

## P2 — fleet and launch

- [ ] Validate simultaneous live view and isolated takeover across two physical phones.
- [x] Independent parallel device runs with leases.
- [x] Broadcast plan, barriers, drift recovery, and rejoin.
- [x] Coordinated task DAGs and result aggregation.
- [x] Capability-aware phone assignment for agent and coordinated work.
- [x] Persist named device groups and enforce immutable per-run affinity.
- [x] MCP adapter over the same daemon API.
- [x] Agent-facing MCP observe/act/screenshot and `taprig connect claude|codex`.
  Validated by Claude Code setting a Clock alarm on the emulator.
- [x] Publish `taprig` to npm as a compiled CLI bundle with the prebuilt driver.
- [x] Download Android platform-tools on first daemon start when `adb` is missing.
- [x] Any OpenAI-compatible server as a provider (OpenRouter, Ollama, Groq, Gemini).
- [x] Price every run at list rates and show the dollar cost in CLI and control room.
- [ ] Signed macOS, Windows, and Linux installers.
- [x] Build unsigned Linux, Windows, and Intel macOS previews in GitHub Actions.
- [ ] GitHub Release download automation and checksums.
- [x] First public website design and interactive product preview.
- [ ] Connect website download buttons to signed releases.
- [x] Add a repeatable synthetic orchestration regression harness.
- [x] Add a repeatable fleet/SQLite/restart soak harness.
- [x] Publish a repeatable synthetic runtime/soak baseline with raw results.
- [ ] Publish physical/provider cost, latency, and task-success benchmarks.
- [ ] Record the hero demo and launch the public repository.
