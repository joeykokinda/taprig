# Onboarding

TapRig installs from npm and brings its own Android tools: when the machine has
no `adb`, the daemon downloads Google's platform-tools into its data directory on
first start, and the phone driver ships prebuilt inside the package.

## First phone

With Node.js 24.12 or newer:

```console
npm install -g taprig
taprig onboard
```

`onboard` starts the local daemon if needed and prints the same readiness
contract used by the control room. It never prints or stores provider secrets.

1. Connect an Android phone over USB and unlock it.
2. Enable Developer options and USB debugging on the phone.
3. Accept the computer trust prompt. Run `taprig doctor` for an
   exact unauthorized, offline, or missing-device diagnosis.
4. Export the provider environment variable named by `onboard`, then restart
   the daemon so the worker inherits it:

   ```console
   export OPENAI_API_KEY=...
   taprig daemon stop
   taprig daemon start
   ```

   A signed-in `claude` or `codex` CLI needs no key, and any OpenAI-compatible
   server works through `taprig model use compatible --base-url <url> --model <name>`.

5. Re-run `taprig onboard`. When the phone and agent are ready, create a first
   task with `taprig run "Open Settings"` or open the authenticated control room
   with `taprig ui`.

6. If tasks will use Chrome, run `taprig prep chrome` once per phone. It turns off
   Chrome's offer to save passwords and its breach warnings, whose pop-ups
   otherwise interrupt logins mid-run.

The desktop application and CLI use the same loopback daemon, database, model
configuration, and readiness endpoint. A provider key stays in the daemon
process environment and is never returned to either client.

## Remote phone server

Install and run TapRig on the computer physically connected to the phones, SSH
into it, and use the interactive `taprig` shell there. For the browser control
room, forward the daemon's loopback port over SSH and open the one-time session
URL on the forwarded localhost origin. Do not expose the daemon port directly.

### Keep the daemon running (Linux)

A systemd user service survives reboots. The unlock PIN lives in the secret
store (`taprig secret set unlock-pin`, or `unlock-pin.<serial>` per phone), so
the unit needs no secrets. `TAPRIG_UNLOCK_PIN` in `~/.config/taprig/env` still
overrides it if you prefer the environment.

```ini
# ~/.config/systemd/user/taprig.service
[Unit]
Description=TapRig phone-agent daemon

[Service]
EnvironmentFile=-%h/.config/taprig/env
ExecStart=%h/.npm-global/bin/taprig daemon serve
Restart=on-failure
RestartSec=3

[Install]
WantedBy=default.target
```

```console
chmod 600 ~/.config/taprig/env
systemctl --user daemon-reload
systemctl --user enable --now taprig
loginctl enable-linger $USER   # start at boot without a login
```

Adjust `ExecStart` to wherever `taprig` is installed (`which taprig`), or to
`node src/cli.ts daemon serve` with `WorkingDirectory=` set for a checkout.
