import assert from "node:assert/strict";
import test from "node:test";

import { runAgentLoop } from "../src/agents/loop.ts";
import type {
  ActionBatch,
  BatchResult,
  DeviceAdapter,
  Observation,
} from "../src/core/contracts.ts";

const observation = (generation: string): Observation => ({
  deviceId: "phone-1",
  generation,
  elements: [],
  capturedAt: "2026-10-29T03:00:00.000Z",
});

test("observes, decides, executes, and completes from verified fresh state", async () => {
  let current = observation("before");
  const device: DeviceAdapter = {
    observe: async () => current,
    execute: async (batch: ActionBatch): Promise<BatchResult> => {
      current = observation("after");
      return {
        requestId: batch.requestId,
        deviceId: batch.deviceId,
        steps: [{ stepId: "open", status: "verified", durationMs: 1 }],
        replayed: false,
      };
    },
  };

  const result = await runAgentLoop({
    device,
    deviceId: "phone-1",
    decide: async () => ({
      type: "execute",
      requestId: "request-1",
      steps: [{ id: "open", action: { type: "element.tap", target: { text: "System" } } }],
    }),
    verifyCompletion: async (state) =>
      state.generation === "after" ? "System settings are visible" : undefined,
  });

  assert.deepEqual(result, {
    status: "completed",
    evidence: "System settings are visible",
    decisions: 1,
    actions: [{ id: "open", action: { type: "element.tap", target: { text: "System" } } }],
  });
});

test("refuses to repeat a failed action against unchanged state", async () => {
  let executions = 0;
  const device: DeviceAdapter = {
    observe: async () => observation("unchanged"),
    execute: async (batch) => {
      executions += 1;
      return {
        requestId: batch.requestId,
        deviceId: batch.deviceId,
        steps: [{ stepId: "open", status: "failed", durationMs: 1 }],
        replayed: false,
      };
    },
  };
  const result = await runAgentLoop({
    device,
    deviceId: "phone-1",
    decide: async ({ decisionNumber }) => ({
      type: "execute",
      requestId: `request-${decisionNumber}`,
      steps: [{ id: "open", action: { type: "element.tap", target: { text: "System" } } }],
    }),
    verifyCompletion: async () => undefined,
  });

  assert.equal(executions, 1);
  assert.equal(result.status, "failed");
  assert.match(result.status === "failed" ? result.reason : "", /repeated a failed action/);
});

test("accepts model-provided visible completion evidence", async () => {
  const device: DeviceAdapter = {
    observe: async () => observation("done"),
    execute: async () => {
      throw new Error("completion must not execute another action");
    },
  };
  const result = await runAgentLoop({
    device,
    deviceId: "phone-1",
    decide: async () => ({ type: "complete", evidence: "Settings title is visible" }),
    verifyCompletion: async () => undefined,
  });
  assert.deepEqual(result, {
    status: "completed",
    evidence: "Settings title is visible",
    decisions: 1,
    actions: [],
  });
});
