import assert from "node:assert/strict";
import test from "node:test";

import { runRuntimeBenchmarks } from "../src/benchmarks/runtime.ts";
import { runRuntimeSoak } from "../src/benchmarks/soak.ts";

test("the synthetic runtime benchmark reports all modes without claiming model cost", async () => {
  const results = await runRuntimeBenchmarks(2);
  assert.deepEqual(
    [...new Set(results.map((result) => result.mode))],
    ["independent", "broadcast", "coordinated"],
  );
  assert.equal(
    results.every((result) => result.successRate === 1),
    true,
  );
  assert.equal(results.find((result) => result.scenario === "independent-4")?.meanDecisionCalls, 8);
  assert.equal(results.find((result) => result.scenario === "broadcast-8")?.meanDecisionCalls, 2);
});

test("the synthetic soak exercises fleet waves and durable restart recovery", async () => {
  const result = await runRuntimeSoak({ iterations: 8, fleetSize: 2, restartEvery: 3 });

  assert.equal(result.kind, "synthetic-runtime-soak");
  assert.equal(result.completed, 8);
  assert.equal(result.recoveredAfterRestart, 2);
  assert.equal(result.actions, 10);
});

test("task benchmark summary judges success per task and averages telemetry", async () => {
  const { summarize } = await import("../src/benchmarks/tasks.ts");
  const trial = (success: boolean, wallMs: number, costUsd: number) => ({
    task: "t",
    runId: "r",
    status: success ? "completed" : "failed",
    success,
    wallMs,
    result: "",
    telemetry: { costUsd, inputTokens: 10, outputTokens: 5 },
  });
  const [row] = summarize([trial(true, 100, 0.01), trial(false, 300, 0.03)]);
  assert.equal(row?.successRate, 0.5);
  assert.equal(row?.medianMs, 100);
  assert.equal(row?.p95Ms, 300);
  assert.equal(row?.meanTokens, 15);
  assert.ok(Math.abs((row?.meanCostUsd ?? 0) - 0.02) < 1e-9);
});
