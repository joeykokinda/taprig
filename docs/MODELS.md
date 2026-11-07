# Model configuration and routing

## Providers

| Provider    | Name in `models.json` | Needs                         |
| ----------- | --------------------- | ----------------------------- |
| Claude API  | `anthropic`           | `ANTHROPIC_API_KEY`           |
| OpenAI API  | `openai`              | `OPENAI_API_KEY`              |
| Claude Code | `claude`              | a signed-in `claude` CLI      |
| Codex       | `codex`               | a signed-in `codex` CLI       |

A fresh install picks the first available in that order, and a daemon whose
configured provider is unusable falls back to an available one and logs it.
`taprig model use <name>` switches presets explicitly. The Claude API adapter uses
the official SDK with structured outputs, effort, and server-side refusal
fallbacks on current Opus and Sonnet. The CLI adapters run each decision as a
one-shot `claude -p` or `codex exec` in an empty temporary directory with no
tools (Claude) or a read-only sandbox (Codex), because phone screens are
untrusted input. CLI decisions take a few seconds each (Claude Haiku about 3 s,
Codex about 9 s) and use the CLI owner's subscription.

## Vision fallback

When a screen has fewer than five labeled elements, or the previous step missed
its target, the decider attaches a PNG screenshot and allows a `tapPoint` action
on a 0-1000 grid, mapped to pixels from the PNG header. All four providers accept
the image. A coordinate tap that changes nothing in the accessibility tree is
reported as dispatched rather than failed, since canvases and games are
invisible to it; the next screenshot is the evidence.

## Profiles

TapRig separates model roles from provider/model IDs. The checked-in defaults
follow the current OpenAI catalog, but every target is editable in the private
OS application-data file `models.json`.

| Profile  | Fast        | Strong      | Vision        | Escalation budget               |
| -------- | ----------- | ----------- | ------------- | ------------------------------- |
| Economy  | GPT-6 Luna  | disabled    | disabled      | zero strong/vision calls        |
| Balanced | GPT-6 Luna  | GPT-6.1 Sol | GPT-6.1 Terra | three calls per escalated role  |
| Best     | GPT-6 Astra | GPT-6 Astra | GPT-6 Astra   | twenty calls per escalated role |

The model names reflect OpenAI's current guidance: Luna is the efficient
high-volume model, Sol balances capability and cost, Terra targets visual and
computer-use reasoning, and Astra is the most capable general model. See the
[official model catalog](https://developers.openai.com/api/docs/models).

```console
taprig model show
taprig model profile economy
taprig model set balanced fast my-provider-model-id
```

Provider credentials are referenced by environment-variable name. They are not
stored in `models.json`, SQLite, run events, prompts, or logs. The OpenAI adapter
uses the Responses API with strict JSON Schema output as documented in
[Structured model outputs](https://developers.openai.com/api/docs/guides/structured-outputs).

The daemon enables its run worker only when the selected provider's key is in
its environment. For the default provider, export `OPENAI_API_KEY` before
starting the daemon. Each decision receives the task, a bounded current semantic
observation, and the previous verified batch result; the model returns only a
typed launch, key, semantic tap/text entry, completion, question, or failure
decision.

Routing is deterministic and budgeted. `fast` handles ordinary semantic
decisions, `strong` is available only for explicit escalation, and `vision` is
available only when semantic/local perception is insufficient. A route returns
no model when its budget is exhausted; callers must recover, ask, or fail rather
than silently spend through the limit.

Every run can also carry hard end-to-end limits. `maxModelCalls` counts the
coordinator and every phone-agent provider attempt; `maxActions` counts action
steps handed to phones. Reservations happen synchronously before concurrent
branches start, and accumulated telemetry keeps the same limits across a
question/resume cycle. A run stops with non-retryable `budget-exhausted` before
the next call or batch would cross either limit.

```console
taprig run --max-model-calls 8 --max-actions 30 "Open Settings"
taprig run --mode=coordinated --max-model-calls=20 "Process the fleet"
```

The same optional limits are available in the control room, the `POST /runs`
API under `budget`, and the `taprig_task` MCP tool.

Device workers use the `fast` route. Independent runs lease distinct ready
devices and execute concurrently; excess runs wait for a lease. Broadcast runs
share one bounded plan, while coordinated runs use the budgeted `strong` route
when available and otherwise fall back to `fast`. Vision escalation remains a
roadmap item.

When a worker asks a question, the answer resumes the durable run against the
same ready phone. Ordinary answers are retained with the question. Answers
marked sensitive are never stored in SQLite: the loopback daemon moves the
exact value through a one-time scoped in-memory credential, sends it to the
configured model provider for the resumed decision, and redacts that exact
value from checkpoints, questions, and errors.

Without the event-driven Android driver, text entry falls back to Android's stock
`input text`/`keycombination` commands. TapRig accepts only a bounded shell-safe
ASCII subset in that fallback and encodes spaces as `%s`, matching the
[AOSP input implementation](https://android.googlesource.com/platform/frameworks/base/+/master/services/core/java/com/android/server/input/InputShellCommand.java).
Unicode and broader punctuation fail closed instead of being interpolated into
a device shell; the accessibility driver remains the path to full text support.
