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

test("independent runs lease distinct ready phones and execute concurrently", async () => {
  const store = new TapRigStore(":memory:");
  const runs = new RunService(store);
  const first = runs.create("First task");
  const second = runs.create("Second task");
  const assigned = new Set<string>();
  let release!: () => void;
  const bothAssigned = new Promise<void>((resolve) => {
    release = resolve;
  });
  const worker = new RunWorker({
    runs,
    devices: {
      list: async () => [
        { id: "phone-1", serial: "phone-1", state: "ready" },
        { id: "phone-2", serial: "phone-2", state: "ready" },
      ],
    },
    adapter: {
      observe: async (deviceId) => ({ ...observation("current"), deviceId }),
      execute: async () => {
        throw new Error("unused");
      },
    },
    decide:
      () =>
      async ({ observation: current }) => {
        assigned.add(current.deviceId);
        if (assigned.size === 2) release();
        await bothAssigned;
        return { type: "complete", evidence: `${current.deviceId} completed` };
      },
  });
  worker.start(first.id);
  worker.start(second.id);
  await Promise.race([
    worker.idle(),
    new Promise((_, reject) => setTimeout(() => reject(new Error("runs did not overlap")), 2_000)),
  ]);

  assert.deepEqual([...assigned].sort(), ["phone-1", "phone-2"]);
  assert.equal(runs.get(first.id)?.status, "completed");
  assert.equal(runs.get(second.id)?.status, "completed");
  store.close();
});
