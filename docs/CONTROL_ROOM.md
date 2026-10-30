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
- responsive desktop/mobile layouts and keyboard-visible controls.

The phone frame deliberately says `LIVE VIEW PENDING`: scrcpy browser streaming
and takeover leases are not represented as complete before that transport is
wired.

For a remote phone server, forward the daemon's printed loopback port over SSH,
then open the one-time path on the forwarded localhost origin. The packaged
desktop app will perform this handoff automatically on the machine hosting the
daemon.
