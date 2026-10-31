import assert from "node:assert/strict";
import test from "node:test";

import { runBroadcast } from "../src/orchestration/broadcast.ts";

test("broadcast executes one plan behind a barrier and recovers drift before rejoin", async () => {
  const generations = new Map([
    ["phone-1", "before"],
    ["phone-2", "before"],
  ]);
  const executions: string[] = [];
  let plans = 0;
  let recoveries = 0;
  const result = await runBroadcast({
    deviceIds: ["phone-1", "phone-2"],
    device: {
      observe: async (deviceId) => ({
        deviceId,
        generation: generations.get(deviceId) ?? "missing",
        elements: [],
        capturedAt: "2026-10-31T18:00:00.000Z",
      }),
      execute: async (batch) => {
        executions.push(batch.deviceId);
        const drifted =
          batch.deviceId === "phone-2" && generations.get(batch.deviceId) === "before";
        generations.set(batch.deviceId, "after");
        return {
          requestId: batch.requestId,
          deviceId: batch.deviceId,
          replayed: false,
          steps: [
            {
              stepId: "open",
              status: drifted ? "failed" : "verified",
              durationMs: 1,
            },
          ],
        };
      },
    },
    decide: async () => {
      plans += 1;
      return plans === 1
        ? {
            type: "execute",
            requestId: "shared",
            steps: [
              { id: "open", action: { type: "app.launch", packageName: "com.android.settings" } },
            ],
          }
        : { type: "complete", evidence: "Settings visible" };
    },
    recover: async (deviceId) => {
      recoveries += 1;
      return {
        status: "completed",
        evidence: `${deviceId} recovered`,
        decisions: 1,
        actions: [],
      };
    },
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(executions.sort(), ["phone-1", "phone-2"]);
  assert.equal(recoveries, 2);
  assert.equal(
    result.status === "completed" ? result.evidence["phone-2"] : undefined,
    "phone-2 recovered",
  );
});
