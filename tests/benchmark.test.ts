import assert from "node:assert/strict";
import test from "node:test";

import { runRuntimeBenchmarks } from "../src/benchmarks/runtime.ts";

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
