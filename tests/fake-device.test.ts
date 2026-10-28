import assert from "node:assert/strict";
import test from "node:test";

import type { ActionBatch, Observation } from "../src/core/contracts.ts";
import { FakeDeviceAdapter } from "../src/devices/fake-device.ts";

const observation: Observation = {
  deviceId: "phone-1",
  generation: "generation-1",
  foregroundPackage: "com.android.settings",
  elements: [],
  capturedAt: "2026-10-28T00:00:00.000Z",
};

const batch: ActionBatch = {
  requestId: "request-1",
  deviceId: "phone-1",
  observationGeneration: "generation-1",
  steps: [{ id: "step-1", action: { type: "key.press", key: "back" } }],
};

test("the fake device verifies a current batch and replays duplicate requests", async () => {
  const device = new FakeDeviceAdapter();
  device.setObservation(observation);

  const first = await device.execute(batch);
  const replay = await device.execute(batch);

  assert.equal(first.replayed, false);
  assert.equal(first.steps[0]?.status, "verified");
  assert.equal(replay.replayed, true);
});

test("the fake device rejects actions against stale observations", async () => {
  const device = new FakeDeviceAdapter();
  device.setObservation(observation);

  await assert.rejects(
    device.execute({ ...batch, requestId: "request-2", observationGeneration: "old" }),
    /stale observation/,
  );
});
