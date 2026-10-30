import assert from "node:assert/strict";
import test from "node:test";

import type {
  ActionBatch,
  BatchResult,
  DeviceAdapter,
  Observation,
} from "../src/core/contracts.ts";
import { TapRigStore } from "../src/persistence/store.ts";
import { RunService } from "../src/runs/service.ts";
import { RunWorker } from "../src/runs/worker.ts";

const observation = (generation: string): Observation => ({
  deviceId: "phone-1",
  generation,
  elements: [],
  capturedAt: "2026-10-30T16:00:00.000Z",
});

test("a worker assigns a ready phone and durably completes a bounded run", async () => {
  const store = new TapRigStore(":memory:");
  const runs = new RunService(store);
  const run = runs.create("Open Settings");
  let current = observation("before");
  const adapter: DeviceAdapter = {
    observe: async () => current,
    execute: async (batch: ActionBatch): Promise<BatchResult> => {
      current = observation("after");
      return {
        requestId: batch.requestId,
        deviceId: batch.deviceId,
        replayed: false,
        steps: [{ stepId: "open", status: "verified", durationMs: 1 }],
      };
    },
  };
  const worker = new RunWorker({
    runs,
    devices: { list: async () => [{ id: "phone-1", serial: "phone-1", state: "ready" }] },
    adapter,
    decide:
      () =>
      async ({ decisionNumber }) =>
        decisionNumber === 0
          ? {
              type: "execute",
              requestId: "request-1",
              steps: [
                { id: "open", action: { type: "element.tap", target: { text: "Settings" } } },
              ],
            }
          : { type: "complete", evidence: "Settings is visible" },
  });
  worker.start(run.id);
  await worker.idle();

  assert.equal(runs.get(run.id)?.status, "completed");
  assert.deepEqual(
    runs.events(run.id).map(({ event }) => event.type),
    ["run.created", "run.started", "run.completed"],
  );
  store.close();
});

test("a worker records an explicit failure when no phone is ready", async () => {
  const store = new TapRigStore(":memory:");
  const runs = new RunService(store);
  const run = runs.create("Open Settings");
  const worker = new RunWorker({
    runs,
    devices: { list: async () => [] },
    adapter: {
      observe: async () => observation("unused"),
      execute: async () => {
        throw new Error("unused");
      },
    },
    decide: () => async () => ({ type: "fail", reason: "unused" }),
  });
  worker.start(run.id);
  await worker.idle();

  assert.equal(runs.get(run.id)?.status, "failed");
  assert.match(runs.get(run.id)?.error?.message ?? "", /no ready Android device/);
  store.close();
});
