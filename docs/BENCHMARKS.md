# Benchmarks

TapRig separates deterministic runtime overhead from physical-phone and model
quality results. Run the checked-in synthetic regression suite with:

```console
npm run benchmark
npm run benchmark -- --iterations=200 --json
npm run soak -- --iterations=10000 --fleet=8 --restart-every=500 --json
```

The first checked-in result set, including raw JSON and its exact environment,
is published in [benchmark results](BENCHMARK_RESULTS.md).

The harness exercises independent agent loops at 1/4/16 phones, broadcast
barriers at 2/8 phones, and coordinated DAG scheduling at 2/8 phones. Every row
reports iterations, verified success rate, mean and p95 wall time, model-decision
calls, executed device actions, and work units. JSON output includes
`"kind": "synthetic-runtime"` so these numbers cannot be confused with real
phone results.

The synthetic soak command drives complete traced worker runs in fleet-sized
waves against a private temporary SQLite database. At a configurable cadence it
leaves one run active, closes and reopens the database, and verifies recovery on
the original simulated phone. Its JSON reports completions, restart recoveries,
actions, wall time, and process heap delta. It also protects the invariant that
active recovery is not truncated by the dashboard's 100-run recent window.
This is deterministic runtime durability evidence, not a substitute for the
still-open multi-hour test on physical phones, real ADB, apps, and providers.

This suite is for orchestration regressions and fleet-scaling overhead. It does
not use a model provider, physical phone, network, or app, so it deliberately
does not report token cost or claim end-to-end task success. The public product
benchmark remains open until the same result schema is populated by a pinned
device/app/task matrix with provider usage and repeated physical trials.

Real runs already persist the raw inputs needed for that report: provider call
count, input/output tokens, device decision count, attempted action count, and
accumulated runtime. Inspect them with `taprig attach <run-id>` or
`GET /runs/<run-id>/telemetry`. TapRig intentionally stores token counts rather
than a dollar estimate because model prices change; benchmark publication will
join those counts to a dated, cited price snapshot.

## Task benchmark on a real phone

`npm run benchmark:tasks -- --device <serial> --trials 5` repeats a pinned task
matrix through the running daemon and writes
`benchmarks/results/<commit>-<phone model>/tasks.json` with the environment,
every raw trial, and a per-task summary: success rate, median and p95 wall time,
model calls, tokens, list-price cost, and actions.

A trial passes only when the run completed and its report ends with an answer
that matches the phone's real state, read over adb before the run (Android
version from `getprop`, dark theme from `cmd uimode night`) or a fixed fact
(example.com's heading). The model's own claim of completion is never enough.

Cost is reported at list price for API providers. A signed-in `claude` or
`codex` CLI bills the subscription, so its runs report zero dollars and its
token counts cover only what the CLI exposes; publish cost numbers from an API
provider run.

Set `ADB` when adb is not on `PATH`. The phone must be unlocked or have its PIN
stored with `taprig secret set unlock-pin`.
