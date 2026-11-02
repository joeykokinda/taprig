import assert from "node:assert/strict";
import test from "node:test";

import { TapRigStore } from "../src/persistence/store.ts";
import { RunService } from "../src/runs/service.ts";

test("creates and reads durable runs with ordered events", () => {
  const store = new TapRigStore(":memory:");
  const runs = new RunService(
    store,
    () => "2026-10-29T12:00:00.000Z",
    () => "run-1",
  );

  const created = runs.create("  Open System settings  ");

  assert.equal(created.task, "Open System settings");
  assert.deepEqual(runs.list(), [created]);
  assert.deepEqual(runs.get(created.id), created);
  assert.equal(runs.events(created.id)[0]?.event.type, "run.created");
  store.close();
});

test("rejects empty and unbounded run requests", () => {
  const store = new TapRigStore(":memory:");
  const runs = new RunService(store);
  assert.throws(() => runs.create("  "), /1 to 10000/);
  assert.throws(() => runs.create("x".repeat(10_001)), /1 to 10000/);
  store.close();
});

test("persists validated hard run budgets", () => {
  const store = new TapRigStore(":memory:");
  const runs = new RunService(store);
  const run = runs.create("Open Settings", "independent", {
    maxModelCalls: 4,
    maxActions: 12,
  });

  assert.deepEqual(run.budget, { maxModelCalls: 4, maxActions: 12 });
  assert.throws(
    () => runs.create("Bad budget", "independent", { maxActions: 0 }),
    /integer from 1/,
  );
  assert.throws(
    () => runs.create("Unknown budget", "independent", { other: 1 } as never),
    /unknown field/,
  );
  store.close();
});
