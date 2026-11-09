# TapRig

**Plug in a phone. Give any agent hands.**

TapRig turns a spare Android phone into something an AI agent can operate with
plain language, from your laptop, with no cloud account. Tell it "post this on
X", "what did Mom just text me", or "log in to the demo site" and it does it,
asks you when only you can act, and shows you what happened.

```console
npm install -g taprig
taprig setup                     # starts the daemon, downloads adb if needed, checks phone + model
taprig run "Open Settings and turn on Dark theme"
```

On the phone: enable Developer options and USB debugging, plug it in, accept the
"Allow USB debugging" prompt. If the phone has a PIN, store it once with
`taprig secret set unlock-pin` and runs unlock the phone themselves, including
past lock-screen overlays such as Glance.

Bring whichever model you already have: a signed-in **Claude Code** or **Codex**
CLI, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or any OpenAI-compatible server
(OpenRouter, Groq, Ollama). Or let your coding agent drive the phone directly:

```console
taprig connect claude            # or: taprig connect codex
claude "Use TapRig to text Sam that I'm running ten minutes late"
```

## Why not screenshots and adb taps

The obvious agent sends a screenshot per step and taps coordinates. TapRig ships
an on-device accessibility driver instead, and the difference is not subtle:

|                      | Screenshot loop                            | TapRig                                                                                                       |
| -------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| Model input per step | one image, vision model required           | text element tree; screenshot only when the tree is thin                                                     |
| Targeting            | guessed pixels, breaks on any layout shift | element ids and bounds from the live tree                                                                    |
| Did the tap land?    | find out from the next screenshot          | verified on the phone per action: touch delivered, text typed, app in foreground                             |
| Model calls          | one per tap                                | several actions batched per call                                                                             |
| Typing               | `adb input text`, ASCII only               | accessibility set-text, unicode and passwords                                                                |
| Passwords            | visible in the screenshot                  | never reach the model: hidden fields, `[SECRET]` placeholders, `{{secret:NAME}}` tokens swapped on the phone |

Vision stays on as a fallback for games, canvases and WebViews with poor trees.
Without the driver TapRig falls back to UIAutomator, which works everywhere but
is slower and cannot type non-ASCII text.

## What works today on real hardware

Validated on a Moto G Play 2024 (Android 14) and in CI on emulators at API 30,
33 and 35; see [hardware validation](docs/HARDWARE_VALIDATION.md).

- Login with credentials asked at run time, typed hidden, zero copies in logs.
- Captcha and 2FA handoff: the run pauses, you tap on the live screen, it resumes.
- Composing a post on X, reading the timeline and notifications, reading Messages.
- Answering "what is my newest notification" with zero taps.
- Unlocking a dozing phone past its PIN and lock-screen overlay, then running.
- Scheduled runs, notification-triggered runs, per-run video, safety gates.

## What a run gets for free

- **Safety gates.** A tap on Send, Post, Pay, Delete, Confirm and similar pauses for
  your approval unless the task itself asked for that action. "Post this on X" taps
  Post; "read my timeline" cannot.
- **App notes.** Each run may save one short UI fact per app (where compose lives, a
  quirk). Later runs on that app read them, so repeat tasks need fewer model calls.
  Plain text under `app-notes/` in the data directory; delete any line you dislike.
- **Notifications.** The shade is read once at the start of every run, so "what did
  Mom text me" is answered without opening Messages. Also `taprig notifications`
  and the `taprig_notifications` MCP tool.
- **Video.** Every run is recorded with the phone's own `screenrecord` and kept as a
  video artifact (`taprig artifacts <run>`); `taprig settings video off` disables it.
- **Schedules.** `taprig schedule add "every 30m" "..."` or `"daily at 08:00"` runs a
  task on its own; `schedule list` and `schedule remove <id>` manage them.
- **Triggers.** `taprig trigger add "messaging.*Mom" "Read me the text and reply that
  I'm driving"` starts a run when a matching notification arrives.
- **Named secrets.** `taprig secret set x_password` (typed hidden) stores a value the
  task references as `{{secret:x_password}}`. The model sees only the token; the value
  is substituted on the way to the phone and redacted from traces. Stored in a
  0600 file in the data directory, never in the database or logs.
- **Doctor.** `taprig doctor` checks the daemon, each phone's lock, authorization and
  driver state, and the model provider, with one fix per failing line.
- **Cleanup.** A failed or stopped run presses home so the next one starts clean.

## Ask the phone a question

A read task ends with the answer printed, because the model's completion evidence
is the result:

```console
$ taprig run "Open X, open Notifications, and tell me what the latest one says"
  ...
The Notifications tab is open in X. The most recent notification, from codila 15m
ago, reads: "REA (reverse engineer anything) ..."

completed
```

The same text shows under the run in the control room and in `taprig_run` over MCP.
By default every decision includes a screenshot so dialogs, toasts, and web pages
the accessibility tree does not describe are still seen; `taprig settings vision
auto` limits screenshots to thin screens and misses.

## Logins, captchas, and anything only you can do

A run stops and asks when it needs you, and `taprig run` prompts right in the
terminal. Questions that look like a password or code are typed hidden and sent
as sensitive: the model never sees the value, it types a `[SECRET]` placeholder
and TapRig swaps in the real text on the phone. Nothing sensitive reaches logs,
evidence, or the model's context.

```console
$ taprig run "Open Chrome, log in to example.com, then open my profile"
  ...
What is the username for example.com?
› me@example.com
What is the password for example.com?
(hidden) ›
  ...
completed
```

For a captcha, a 2FA prompt, or a fingerprint the agent asks you to do it. Open
the control room, press TAKE CONTROL on the phone, tap and type on the live
screen (the text box next to the buttons types into the focused field), then
answer `done` and the run continues. The same works from the CLI with
`taprig answer <run> <question> done` and from the MCP tools.

## More

- [First-phone onboarding](docs/ONBOARDING.md): USB trust, model setup, keeping the daemon running.
- [MCP integration](docs/MCP.md) for Claude Code, Codex and any MCP client.
- [Model routing](docs/MODELS.md), [owner settings](docs/SETTINGS.md), [approvals](docs/APPROVALS.md), [run artifacts](docs/ARTIFACTS.md).
- [Deterministic scripts](docs/SCRIPTS.md): repeat a verified workflow with no model call.
- [Control room](docs/CONTROL_ROOM.md): live screen, take control, run history, settings.
- Fleet: `taprig group set social phone-1 phone-2` then `taprig run --group social --mode broadcast "..."`; coordinated runs split one task across phones.
- [Benchmarks](docs/BENCHMARKS.md), [desktop app](docs/DESKTOP.md), [architecture](docs/AGENT_ARCHITECTURE.md), [plan](docs/PLAN.md), [TODO](docs/TODO.md).

`taprig help` lists every command.

## License

TapRig is open source under the [MIT License](LICENSE).
