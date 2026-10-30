import assert from "node:assert/strict";
import test from "node:test";

import { AndroidSemanticAdapter } from "../src/android/semantic-adapter.ts";
import type { ActionBatch, Observation } from "../src/core/contracts.ts";

const observation = (generation: string): Observation => ({
  deviceId: "phone-1",
  generation,
  elements: [],
  capturedAt: "2026-10-29T03:00:00.000Z",
});

const batch: ActionBatch = {
  requestId: "request-1",
  deviceId: "phone-1",
  observationGeneration: "before",
  steps: [{ id: "open", action: { type: "element.tap", target: { text: "System" } } }],
};

test("executes, observes, verifies, and deduplicates a semantic tap batch", async () => {
  const observations = [observation("before"), observation("after")];
  let taps = 0;
  const adapter = new AndroidSemanticAdapter(
    async () => observations.shift() ?? observation("after"),
    async () => {
      taps += 1;
    },
  );

  const result = await adapter.execute(batch);
  const replay = await adapter.execute(batch);

  assert.equal(taps, 1);
  assert.equal(result.steps[0]?.status, "verified");
  assert.equal(replay.replayed, true);
});

test("rejects stale input and fails closed when postcondition evidence is unchanged", async () => {
  const stale = new AndroidSemanticAdapter(async () => observation("current"));
  await assert.rejects(stale.execute(batch), /stale observation before/);

  const unchanged = new AndroidSemanticAdapter(
    async () => observation("before"),
    async () => {},
  );
  const result = await unchanged.execute(batch);
  assert.equal(result.steps[0]?.status, "failed");
  assert.equal(result.steps[0]?.error?.code, "verification-failed");
});

test("executes a typed raw action and verifies the semantic state changed", async () => {
  const observations = [observation("before"), observation("after")];
  const actions: ActionBatch["steps"][number]["action"][] = [];
  const adapter = new AndroidSemanticAdapter(
    async () => observations.shift() ?? observation("after"),
    async () => {},
    async (_deviceId, action) => {
      actions.push(action);
    },
  );
  const result = await adapter.execute({
    ...batch,
    requestId: "raw-request",
    steps: [
      { id: "settings", action: { type: "app.launch", packageName: "com.android.settings" } },
    ],
  });
  assert.deepEqual(actions, [{ type: "app.launch", packageName: "com.android.settings" }]);
  assert.equal(result.steps[0]?.status, "verified");
});
