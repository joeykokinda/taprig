# Local control room

The control room is served by the same loopback-only daemon as the CLI:

```console
taprig ui
```

The command prints a one-time URL. Opening it consumes the nonce, sets a
24-hour HttpOnly `SameSite=Strict` session cookie, and redirects to `/`. The
long-lived daemon bearer token never enters the URL, browser storage, HTML, or
JavaScript. Reusing or waiting more than 60 seconds to open the handoff URL is
rejected. UI assets use a restrictive Content Security Policy and cannot be
framed.

The current control room provides:

- a live first-run checklist driven by the daemon's canonical phone, agent,
  model-profile, and first-run readiness status;
- live one-second device readiness and foreground-package updates;
- durable run counts and an incremental replay of secret-safe observation,
  decision, and action events;
- natural-language task creation with independent, broadcast, or coordinated
  run mode and optional named-device-group affinity;
- named device-group creation, updates, deletion, and run selection;
- durable agent questions with answer-and-resume controls; sensitive answers
  use a password field, pass through one-time scoped memory, and are redacted
  from persisted evidence;
- typed approval requests with explicit approve/deny controls; denial stops the
  run before the gated action, while approval resumes its pinned phone cohort;
- authenticated run-artifact inventory with direct private evidence viewing;
- versioned deterministic-script inventory;
- per-phone scrcpy live video with an automatic screenshot fallback for static
  streams;
- exclusive renewable takeover leases with direct tap, Home, and Back controls;
- responsive desktop/mobile layouts and keyboard-visible controls.

The video path prefers scrcpy for low latency. If scrcpy's recording muxer does
not emit an initial frame within 1.5 seconds, that phone switches to bounded ADB
screenshots so a static display never leaves the control room blank. Takeover
input remains serialized through the daemon rather than scrcpy's uncontrolled
input channel.

For a remote phone server, forward the daemon's printed loopback port over SSH,
then open the one-time path on the forwarded localhost origin. The packaged
desktop app will perform this handoff automatically on the machine hosting the
daemon.
