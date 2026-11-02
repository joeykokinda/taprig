# Benchmarks

TapRig separates deterministic runtime overhead from physical-phone and model
quality results. Run the checked-in synthetic regression suite with:

```console
npm run benchmark
npm run benchmark -- --iterations=200 --json
npm run soak -- --iterations=10000 --fleet=8 --restart-every=500 --json
```

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
