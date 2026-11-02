# Benchmarks

TapRig separates deterministic runtime overhead from physical-phone and model
quality results. Run the checked-in synthetic regression suite with:

```console
npm run benchmark
npm run benchmark -- --iterations=200 --json
```

The harness exercises independent agent loops at 1/4/16 phones, broadcast
barriers at 2/8 phones, and coordinated DAG scheduling at 2/8 phones. Every row
reports iterations, verified success rate, mean and p95 wall time, model-decision
calls, executed device actions, and work units. JSON output includes
`"kind": "synthetic-runtime"` so these numbers cannot be confused with real
phone results.

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
