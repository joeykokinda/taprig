# Published benchmark results

## Synthetic runtime baseline — `10a8713`

This baseline measures TapRig's in-process orchestration invariants. It uses no
phone, ADB transport, model provider, network, or third-party app. The simulated
adapter verifies actions by construction, so its 100% success rate is a
regression assertion, **not an end-to-end reliability claim**. Model cost is not
applicable.

Environment:

- Commit: `10a8713`
- Date: 2026-11-04
- Node.js: `v26.13.0`
- Host: Linux `7.2.14-arch1-1` x86_64

Commands:

```console
npm run benchmark -- --iterations=200 --json
npm run soak -- --iterations=1000 --fleet=4 --restart-every=250 --json
```

| Scenario       | Iterations | Invariant pass |     Mean |      p95 | Decisions | Actions | Work units |
| -------------- | ---------: | -------------: | -------: | -------: | --------: | ------: | ---------: |
| independent-1  |        200 |        200/200 | 0.012 ms | 0.022 ms |         2 |       1 |          1 |
| independent-4  |        200 |        200/200 | 0.012 ms | 0.016 ms |         8 |       4 |          4 |
| independent-16 |        200 |        200/200 | 0.026 ms | 0.061 ms |        32 |      16 |         16 |
| broadcast-2    |        200 |        200/200 | 0.007 ms | 0.012 ms |         2 |       2 |          2 |
| broadcast-8    |        200 |        200/200 | 0.010 ms | 0.017 ms |         2 |       8 |          8 |
| coordinated-2  |        200 |        200/200 | 0.012 ms | 0.019 ms |         0 |       0 |          3 |
| coordinated-8  |        200 |        200/200 | 0.013 ms | 0.017 ms |         0 |       0 |          9 |

The 1,000-run soak completed all 1,000 runs, executed 1,003 simulated actions,
and recovered three deliberately interrupted runs after SQLite reopen. It took
1,203.476 ms and ended with a 3,768,624-byte heap delta. Heap and sub-millisecond
timings are environment-sensitive; use the raw files for reproducibility, not
as product-speed claims:

- [`runtime.json`](../benchmarks/results/10a8713/runtime.json)
- [`soak.json`](../benchmarks/results/10a8713/soak.json)

## Still required

The public product benchmark remains open. It needs a pinned physical-device,
Android, app, task, provider, and model matrix; repeated trials; trace-backed
task success; latency distributions; token counts; and a dated pricing snapshot.
Those results must not be inferred from this synthetic baseline.
