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

- live one-second device readiness and foreground-package updates;
- durable run counts and recent trace state;
- natural-language task creation with independent, broadcast, or coordinated
  run mode;
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
