# Onboarding

TapRig is pre-alpha. Contributors currently run it from the repository; the
normal-user path will be a signed desktop installer once release packaging is
complete.

## First phone

From a TapRig checkout with Node.js 24.12 or newer:

```console
npm install
npm run taprig -- onboard
```

`onboard` starts the local daemon if needed and prints the same readiness
contract used by the control room. It never prints or stores provider secrets.

1. Connect an Android phone over USB and unlock it.
2. Enable Developer options and USB debugging on the phone.
3. Accept the computer trust prompt. Run `npm run taprig -- doctor` for an
   exact unauthorized, offline, or missing-device diagnosis.
4. Export the provider environment variable named by `onboard`, then restart
   the daemon so the worker inherits it:

   ```console
   export OPENAI_API_KEY=...
   npm run taprig -- daemon stop
   npm run taprig -- daemon start
   ```

5. Re-run `npm run taprig -- onboard`. When the phone and agent are ready,
   create a first task with `npm run taprig -- run "Open Settings"` or open the
   authenticated control room with `npm run taprig -- ui`.

The desktop application and CLI use the same loopback daemon, database, model
configuration, and readiness endpoint. A provider key stays in the daemon
process environment and is never returned to either client.

## Remote phone server

Install and run TapRig on the computer physically connected to the phones, SSH
into it, and use the interactive `taprig` shell there. For the browser control
room, forward the daemon's loopback port over SSH and open the one-time session
URL on the forwarded localhost origin. Do not expose the daemon port directly.
