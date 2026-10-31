import assert from "node:assert/strict";
import test from "node:test";

import { runCoordinated, validateCoordinatedPlan } from "../src/orchestration/coordinated.ts";

test("rejects missing dependencies and cycles before execution", () => {
  assert.throws(
    () =>
      validateCoordinatedPlan({
        nodes: [{ id: "one", task: "One", dependsOn: ["missing"] }],
      }),
    /unknown dependency missing/,
  );
  assert.throws(
    () =>
      validateCoordinatedPlan({
        nodes: [
          { id: "one", task: "One", dependsOn: ["two"] },
          { id: "two", task: "Two", dependsOn: ["one"] },
        ],
      }),
    /dependency cycle/,
  );
});

test("runs ready nodes concurrently and waits before their dependent node", async () => {
  const started: string[] = [];
  let release!: () => void;
  const bothStarted = new Promise<void>((resolve) => {
    release = resolve;
  });
  const result = await runCoordinated({
    plan: {
      nodes: [
        { id: "one", task: "One", dependsOn: [] },
        { id: "two", task: "Two", dependsOn: [] },
        { id: "three", task: "Three", dependsOn: ["one", "two"] },
      ],
    },
    execute: async (node) => {
      started.push(node.id);
      if (started.length === 2) release();
      if (node.id !== "three") await bothStarted;
      if (node.id === "three") assert.deepEqual(started, ["one", "two", "three"]);
      return {
        id: node.id,
        status: "completed",
        deviceId: `phone-${node.id}`,
        evidence: `${node.id} done`,
        actions: [],
      };
    },
  });

  assert.equal(result.status, "completed");
  assert.deepEqual(
    result.nodes.map((node) => node.status),
    ["completed", "completed", "completed"],
  );
});

test("preserves independent results and skips work downstream of a failure", async () => {
  const executed: string[] = [];
  const result = await runCoordinated({
    plan: {
      nodes: [
        { id: "failed", task: "Fail", dependsOn: [] },
        { id: "independent", task: "Finish", dependsOn: [] },
        { id: "blocked", task: "Never run", dependsOn: ["failed"] },
      ],
    },
    execute: async (node) => {
      executed.push(node.id);
      return node.id === "failed"
        ? { id: node.id, status: "failed", deviceId: "phone-1", reason: "not possible" }
        : {
            id: node.id,
            status: "completed",
            deviceId: "phone-2",
            evidence: "done",
            actions: [],
          };
    },
  });

  assert.equal(result.status, "failed");
  assert.deepEqual(executed.sort(), ["failed", "independent"]);
  assert.equal(result.nodes.find((node) => node.id === "blocked")?.status, "skipped");
});

test("resumes from completed dependency results without repeating them", async () => {
  const executed: string[] = [];
  const result = await runCoordinated({
    plan: {
      nodes: [
        { id: "done", task: "Already done", dependsOn: [] },
        { id: "next", task: "Continue", dependsOn: ["done"] },
      ],
    },
    initialResults: [
      {
        id: "done",
        status: "completed",
        deviceId: "phone-1",
        evidence: "saved evidence",
        actions: [],
      },
    ],
    execute: async (node, dependencies) => {
      executed.push(node.id);
      assert.equal(dependencies[0]?.evidence, "saved evidence");
      return {
        id: node.id,
        status: "completed",
        deviceId: "phone-2",
        evidence: "continued",
        actions: [],
      };
    },
  });
  assert.equal(result.status, "completed");
  assert.deepEqual(executed, ["next"]);
});
