import assert from "node:assert/strict";
import test from "node:test";

import { AndroidDriverAdapter } from "../src/android/driver-adapter.ts";
import type { ActionBatch, DeviceAdapter, Observation } from "../src/core/contracts.ts";

const observation = (deviceId: string, source: string): Observation => ({
  deviceId,
  generation: source,
  elements: [],
  capturedAt: "2026-11-04T22:00:00.000Z",
});

const batch: ActionBatch = {
  requestId: "request-1",
  deviceId: "phone-1",
  observationGeneration: "driver",
  steps: [{ id: "home", action: { type: "key.press", key: "home" } }],
};

function adapter(source: string, calls: string[]): DeviceAdapter {
  return {
    observe: async (deviceId) => {
      calls.push(`${source}:observe:${deviceId}`);
      return observation(deviceId, source);
    },
    execute: async (value) => {
      calls.push(`${source}:execute:${value.deviceId}`);
      return { requestId: value.requestId, deviceId: value.deviceId, steps: [], replayed: false };
    },
  };
}

test("routes each phone through a healthy driver and keeps the polling fallback", async () => {
  const calls: string[] = [];
  const driver = adapter("driver", calls);
  const routed = new AndroidDriverAdapter(
    { get: (deviceId) => (deviceId === "phone-1" ? driver : undefined) },
    adapter("fallback", calls),
  );

  assert.equal((await routed.observe("phone-1")).generation, "driver");
  assert.equal((await routed.observe("phone-2")).generation, "fallback");
  await routed.execute(batch);
  await routed.execute({ ...batch, deviceId: "phone-2" });

  assert.deepEqual(calls, [
    "driver:observe:phone-1",
    "fallback:observe:phone-2",
    "driver:execute:phone-1",
    "fallback:execute:phone-2",
  ]);
});
