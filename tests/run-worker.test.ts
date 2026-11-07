import assert from "node:assert/strict";
import test from "node:test";

import type {
  ActionBatch,
  BatchResult,
  DeviceAdapter,
  Observation,
  RunTelemetry,
} from "../src/core/contracts.ts";
import type { CoordinatedNodeResult } from "../src/orchestration/coordinated.ts";
import { TapRigStore } from "../src/persistence/store.ts";
import { RunService } from "../src/runs/service.ts";
import { RunWorker } from "../src/runs/worker.ts";

const observation = (generation: string): Observation => ({
  deviceId: "phone-1",
  generation,
  elements: [],
  capturedAt: "2026-10-30T16:00:00.000Z",
});

const readyDevice = (id: string) => ({
  id,
  serial: id,
  state: "ready",
  capabilities: ["semantic-observation", "semantic-action"] as const,
});

test("a worker assigns a ready phone and durably completes a bounded run", async () => {
  const store = new TapRigStore(":memory:");
  const runs = new RunService(store);
  const run = runs.create("Open Settings", "independent", undefined, undefined, true);
  const captured: string[] = [];
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
    devices: { list: async () => [readyDevice("phone-1")] },
    adapter,
    captureArtifact: async (runId, deviceId) => {
      captured.push(`${runId}:${deviceId}`);
    },
    decide:
      (_task, recordUsage) =>
      async ({ decisionNumber }) => {
        recordUsage?.({ inputTokens: 10, outputTokens: 2 });
        return decisionNumber === 0
          ? {
              type: "execute",
              requestId: "request-1",
              steps: [
                { id: "open", action: { type: "element.tap", target: { text: "Settings" } } },
              ],
            }
          : { type: "complete", evidence: "Settings is visible" };
      },
  });
  worker.start(run.id);
  await worker.idle();

  assert.equal(runs.get(run.id)?.status, "completed");
  assert.deepEqual(captured, [`${run.id}:phone-1`]);
  const events = runs.events(run.id).map(({ event }) => event);
  assert.deepEqual(
    events.filter((event) => event.type !== "run.trace").map(({ type }) => type),
    ["run.created", "run.started", "run.completed"],
  );
  assert.deepEqual(
    events.flatMap((event) => (event.type === "run.trace" ? [event.trace.phase] : [])),
    ["observation", "decision", "action", "observation", "decision"],
  );
  const telemetry = runs.telemetry(run.id)?.evidence as RunTelemetry;
  assert.equal(telemetry.executions, 1);
  assert.equal(telemetry.decisionCalls, 2);
  assert.equal(telemetry.modelCalls, 2);
  assert.equal(telemetry.inputTokens, 20);
  assert.equal(telemetry.outputTokens, 4);
  assert.equal(telemetry.attemptedActions, 1);
  assert.ok(telemetry.elapsedMs >= 0);
  const privateRun = runs.create("Do not retain screen pixels");
  worker.start(privateRun.id);
  await worker.idle();
  assert.equal(runs.get(privateRun.id)?.status, "completed");
  assert.deepEqual(captured, [`${run.id}:phone-1`]);
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

test("a worker wakes a locked phone once before giving up", async () => {
  const store = new TapRigStore(":memory:");
  const runs = new RunService(store);
  const woken = runs.create("Open Settings");
  const stuck = runs.create("Open Settings");
  let state = "locked";
  const wakes: string[] = [];
  let unlocks = true;
  const worker = new RunWorker({
    runs,
    devices: { list: async () => [{ ...readyDevice("phone-1"), state }] },
    adapter: { observe: async () => observation("x"), execute: async () => ({}) as BatchResult },
    wake: async (deviceId) => {
      wakes.push(deviceId);
      if (unlocks) state = "ready";
    },
    decide: () => async () => ({ type: "complete", evidence: "done" }),
  });
  worker.start(woken.id);
  await worker.idle();
  assert.equal(runs.get(woken.id)?.status, "completed");

  state = "locked";
  unlocks = false;
  worker.start(stuck.id);
  await worker.idle();
  assert.deepEqual(wakes, ["phone-1", "phone-1"]);
  assert.match(runs.get(stuck.id)?.error?.message ?? "", /phone is locked/);
  store.close();
});

test("a user pause interrupts a model boundary and resumes on the original phone", async () => {
  const store = new TapRigStore(":memory:");
  const runs = new RunService(store);
  const run = runs.create("Wait safely");
  let releaseDecision: (() => void) | undefined;
  let enteredDecision: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    enteredDecision = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    releaseDecision = resolve;
  });
  let calls = 0;
  const observed: string[] = [];
  const worker = new RunWorker({
    runs,
    devices: { list: async () => [readyDevice("phone-1"), readyDevice("phone-2")] },
    adapter: {
      observe: async (deviceId) => {
        observed.push(deviceId);
        return { ...observation("current"), deviceId };
      },
      execute: async () => {
        throw new Error("unused");
      },
    },
    decide: () => async () => {
      calls += 1;
      if (calls === 1) {
        enteredDecision?.();
        await blocked;
      }
      return { type: "complete", evidence: "Done" };
    },
  });
  worker.start(run.id);
  await entered;
  runs.record(run.id, { type: "run.paused", at: "2026-11-04T12:00:01.000Z" });
  releaseDecision?.();
  await worker.idle();
  assert.equal(runs.get(run.id)?.status, "paused");
  worker.resumePaused(run.id);
  await worker.idle();
  assert.equal(runs.get(run.id)?.status, "completed");
  assert.deepEqual(new Set(observed), new Set(["phone-1"]));
  assert.equal(
    runs.events(run.id).some(({ event }) => event.type === "run.failed"),
    false,
  );
  store.close();
});

test("a user stop preserves an action that finished in flight without rewriting the outcome", async () => {
  const store = new TapRigStore(":memory:");
  const runs = new RunService(store);
  const run = runs.create("Stop safely");
  let releaseAction: (() => void) | undefined;
  let enteredAction: (() => void) | undefined;
  const entered = new Promise<void>((resolve) => {
    enteredAction = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    releaseAction = resolve;
  });
  const worker = new RunWorker({
    runs,
    devices: { list: async () => [readyDevice("phone-1")] },
    adapter: {
      observe: async (deviceId) => ({ ...observation("current"), deviceId }),
      execute: async (batch) => {
        enteredAction?.();
        await blocked;
        return {
          requestId: batch.requestId,
          deviceId: batch.deviceId,
          replayed: false,
          steps: [{ stepId: "tap", status: "verified", durationMs: 1 }],
        };
      },
    },
    decide: () => async () => ({
      type: "execute",
      requestId: "tap",
      steps: [{ id: "tap", action: { type: "element.tap", target: { text: "Continue" } } }],
    }),
  });
  worker.start(run.id);
  await entered;
  runs.record(run.id, { type: "run.stopped", at: "2026-11-04T12:00:01.000Z" });
  releaseAction?.();
  await worker.idle();
  assert.equal(runs.get(run.id)?.status, "stopped");
  assert.equal(
    runs.events(run.id).some(({ event }) => event.type === "run.failed"),
    false,
  );
  assert.equal(
    JSON.stringify(runs.recovery(run.id)?.evidence).includes('"status":"verified"'),
    true,
  );
  store.close();
});

test("a worker recovers an interrupted run on its original phone with durable progress", async () => {
  const store = new TapRigStore(":memory:");
  const runs = new RunService(store);
  const run = runs.create("Open Settings");
  runs.record(run.id, { type: "run.started", at: "2026-11-01T12:00:00.000Z" });
  runs.saveRecovery(run.id, {
    deviceIds: ["phone-2"],
    batches: {
      "phone-2": {
        requestId: "open",
        steps: [{ stepId: "open", status: "verified", actionType: "app.launch" }],
      },
    },
  });
  let assigned = "";
  const worker = new RunWorker({
    runs,
    devices: { list: async () => [readyDevice("phone-1"), readyDevice("phone-2")] },
    adapter: {
      observe: async (deviceId) => {
        assigned = deviceId;
        return { ...observation("recovered"), deviceId };
      },
      execute: async () => {
        throw new Error("unused");
      },
    },
    decide: (task) => async () => {
      assert.match(task, /TapRig restarted/);
      assert.match(task, /Previously verified progress/);
      return { type: "complete", evidence: "Settings is visible" };
    },
  });
  worker.recover(run.id);
  await worker.idle();

  assert.equal(assigned, "phone-2");
  assert.equal(runs.get(run.id)?.status, "completed");
  assert.deepEqual(
    runs
      .events(run.id)
      .map(({ event }) => event)
      .filter((event) => event.type !== "run.trace")
      .map(({ type }) => type),
    ["run.created", "run.started", "run.recovered", "run.completed"],
  );
  store.close();
});

test("a worker stops before exceeding its model-call budget", async () => {
  const store = new TapRigStore(":memory:");
  const runs = new RunService(store);
  const run = runs.create("Open Settings", "independent", { maxModelCalls: 1 });
  let current = observation("before");
  const worker = new RunWorker({
    runs,
    devices: { list: async () => [readyDevice("phone-1")] },
    adapter: {
      observe: async () => current,
      execute: async (batch) => {
        current = observation("after");
        return {
          requestId: batch.requestId,
          deviceId: batch.deviceId,
          replayed: false,
          steps: [{ stepId: "open", status: "verified", durationMs: 1 }],
        };
      },
    },
    decide: (_task, recordUsage) => async () => {
      recordUsage?.({ inputTokens: 3, outputTokens: 1 });
      return {
        type: "execute",
        requestId: "open",
        steps: [{ id: "open", action: { type: "key.press", key: "home" } }],
      };
    },
  });
  worker.start(run.id);
  await worker.idle();

  assert.deepEqual(runs.get(run.id)?.error, {
    code: "budget-exhausted",
    message: "model-call budget of 1 exhausted",
    retryable: false,
  });
  const telemetry = runs.telemetry(run.id)?.evidence as RunTelemetry;
  assert.equal(telemetry.modelCalls, 1);
  assert.equal(telemetry.attemptedActions, 1);
  store.close();
});

test("a worker rejects a batch that would exceed its action budget", async () => {
  const store = new TapRigStore(":memory:");
  const runs = new RunService(store);
  const run = runs.create("Do two things", "independent", { maxActions: 1 });
  let executions = 0;
  const worker = new RunWorker({
    runs,
    devices: { list: async () => [readyDevice("phone-1")] },
    adapter: {
      observe: async () => observation("current"),
      execute: async () => {
        executions += 1;
        throw new Error("must not execute");
      },
    },
    decide: () => async () => ({
      type: "execute",
      requestId: "too-large",
      steps: [
        { id: "one", action: { type: "key.press", key: "back" } },
        { id: "two", action: { type: "key.press", key: "home" } },
      ],
    }),
  });
  worker.start(run.id);
  await worker.idle();

  assert.equal(executions, 0);
  assert.equal(runs.get(run.id)?.error?.code, "budget-exhausted");
  const telemetry = runs.telemetry(run.id)?.evidence as RunTelemetry | undefined;
  assert.equal(telemetry?.attemptedActions, 0);
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
      list: async () => [readyDevice("phone-1"), readyDevice("phone-2")],
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

test("an independent run leases only a phone in its resolved affinity", async () => {
  const store = new TapRigStore(":memory:");
  const runs = new RunService(store);
  const run = runs.create("Use social phone", "independent", undefined, {
    group: "social",
    deviceIds: ["phone-2"],
  });
  let assigned = "";
  const worker = new RunWorker({
    runs,
    devices: { list: async () => [readyDevice("phone-1"), readyDevice("phone-2")] },
    adapter: {
      observe: async (deviceId) => {
        assigned = deviceId;
        return { ...observation("current"), deviceId };
      },
      execute: async () => {
        throw new Error("unused");
      },
    },
    decide: () => async () => ({ type: "complete", evidence: "done" }),
  });
  worker.start(run.id);
  await worker.idle();

  assert.equal(assigned, "phone-2");
  assert.equal(runs.get(run.id)?.status, "completed");
  store.close();
});

test("a broadcast run shares actions across leased phones and persists aggregate completion", async () => {
  const store = new TapRigStore(":memory:");
  const runs = new RunService(store);
  const run = runs.create("Open Settings everywhere", "broadcast");
  const executions: string[] = [];
  const worker = new RunWorker({
    runs,
    devices: {
      list: async () => [readyDevice("phone-1"), readyDevice("phone-2")],
    },
    adapter: {
      observe: async (deviceId) => ({ ...observation("current"), deviceId }),
      execute: async (batch) => {
        executions.push(batch.deviceId);
        return {
          requestId: batch.requestId,
          deviceId: batch.deviceId,
          replayed: false,
          steps: [{ stepId: "open", status: "verified", durationMs: 1 }],
        };
      },
    },
    decide: () => {
      let decision = 0;
      return async () =>
        decision++ === 0
          ? {
              type: "execute",
              requestId: "shared",
              steps: [
                { id: "open", action: { type: "app.launch", packageName: "com.android.settings" } },
              ],
            }
          : { type: "complete", evidence: "Settings visible" };
    },
  });
  worker.start(run.id);
  await worker.idle();

  assert.equal(runs.get(run.id)?.status, "completed");
  assert.deepEqual(executions.sort(), ["phone-1", "phone-2", "phone-2"]);
  const completion = runs.completion(run.id)?.evidence as { devices?: string[] } | undefined;
  assert.deepEqual(completion?.devices, ["phone-1", "phone-2"]);
  store.close();
});

test("a broadcast run leases exactly its resolved device group", async () => {
  const store = new TapRigStore(":memory:");
  const runs = new RunService(store);
  const run = runs.create("Use social fleet", "broadcast", undefined, {
    group: "social",
    deviceIds: ["phone-1", "phone-2"],
  });
  const observed = new Set<string>();
  const worker = new RunWorker({
    runs,
    devices: {
      list: async () => [readyDevice("phone-1"), readyDevice("phone-2"), readyDevice("phone-3")],
    },
    adapter: {
      observe: async (deviceId) => {
        observed.add(deviceId);
        return { ...observation("current"), deviceId };
      },
      execute: async () => {
        throw new Error("unused");
      },
    },
    decide: () => async () => ({ type: "complete", evidence: "done" }),
  });
  worker.start(run.id);
  await worker.idle();

  assert.equal(runs.get(run.id)?.status, "completed");
  assert.deepEqual([...observed].sort(), ["phone-1", "phone-2"]);
  store.close();
});

test("broadcast restart retains its original phone cohort", async () => {
  const store = new TapRigStore(":memory:");
  const runs = new RunService(store);
  const run = runs.create("Finish everywhere", "broadcast");
  runs.record(run.id, { type: "run.started", at: "2026-11-01T12:00:00.000Z" });
  runs.saveRecovery(run.id, { deviceIds: ["phone-1", "phone-2"] });
  const observed = new Set<string>();
  const worker = new RunWorker({
    runs,
    devices: {
      list: async () => [readyDevice("phone-1"), readyDevice("phone-2"), readyDevice("phone-3")],
    },
    adapter: {
      observe: async (deviceId) => {
        observed.add(deviceId);
        return { ...observation("current"), deviceId };
      },
      execute: async () => {
        throw new Error("unused");
      },
    },
    decide: () => async () => ({ type: "complete", evidence: "done" }),
  });
  worker.recover(run.id);
  await worker.idle();

  assert.equal(runs.get(run.id)?.status, "completed");
  assert.deepEqual([...observed].sort(), ["phone-1", "phone-2"]);
  store.close();
});

test("a coordinated run leases parallel phones and persists node results", async () => {
  const store = new TapRigStore(":memory:");
  const runs = new RunService(store);
  const run = runs.create("Complete two tasks, then finish", "coordinated");
  const assigned = new Map<string, string>();
  let release!: () => void;
  const rootsStarted = new Promise<void>((resolve) => {
    release = resolve;
  });
  const worker = new RunWorker({
    runs,
    devices: {
      list: async () => [readyDevice("phone-1"), readyDevice("phone-2")],
    },
    adapter: {
      observe: async (deviceId) => ({ ...observation("current"), deviceId }),
      execute: async () => {
        throw new Error("unused");
      },
    },
    planCoordinated: async () => ({
      nodes: [
        { id: "one", task: "One", dependsOn: [] },
        { id: "two", task: "Two", dependsOn: [] },
        { id: "finish", task: "Finish", dependsOn: ["one", "two"] },
      ],
    }),
    decide:
      (task) =>
      async ({ observation: current }) => {
        const name = task.split("\n", 1)[0] as string;
        assigned.set(name, current.deviceId);
        if (assigned.has("One") && assigned.has("Two")) release();
        if (name !== "Finish") await rootsStarted;
        if (name === "Finish") {
          assert.match(task, /one: One done/);
          assert.match(task, /two: Two done/);
        }
        return { type: "complete", evidence: `${name} done` };
      },
  });
  worker.start(run.id);
  await worker.idle();

  assert.equal(runs.get(run.id)?.status, "completed");
  assert.notEqual(assigned.get("One"), assigned.get("Two"));
  const completion = runs.completion(run.id)?.evidence as
    | { summary?: Record<string, string>; nodes?: Array<{ id: string; status: string }> }
    | undefined;
  assert.deepEqual(completion?.summary, {
    one: "One done",
    two: "Two done",
    finish: "Finish done",
  });
  assert.deepEqual(
    completion?.nodes?.map(({ id, status }) => [id, status]),
    [
      ["one", "completed"],
      ["two", "completed"],
      ["finish", "completed"],
    ],
  );
  store.close();
});

test("coordinated branches reserve model budget without oversubscribing it", async () => {
  const store = new TapRigStore(":memory:");
  const runs = new RunService(store);
  const run = runs.create("Do two tasks", "coordinated", { maxModelCalls: 2 });
  let decisions = 0;
  const worker = new RunWorker({
    runs,
    devices: {
      list: async () => [readyDevice("phone-1"), readyDevice("phone-2")],
    },
    adapter: {
      observe: async (deviceId) => ({ ...observation("current"), deviceId }),
      execute: async () => {
        throw new Error("unused");
      },
    },
    planCoordinated: async (_task, recordUsage) => {
      recordUsage?.({ inputTokens: 4, outputTokens: 2 });
      return {
        nodes: [
          { id: "one", task: "One", dependsOn: [] },
          { id: "two", task: "Two", dependsOn: [] },
        ],
      };
    },
    decide: (_task, recordUsage) => async () => {
      decisions += 1;
      recordUsage?.({ inputTokens: 2, outputTokens: 1 });
      return { type: "complete", evidence: "done" };
    },
  });
  worker.start(run.id);
  await worker.idle();

  assert.equal(decisions, 1);
  assert.equal(runs.get(run.id)?.error?.code, "budget-exhausted");
  const telemetry = runs.telemetry(run.id)?.evidence as RunTelemetry | undefined;
  assert.equal(telemetry?.modelCalls, 2);
  store.close();
});

test("coordinated restart reuses its durable plan and completed nodes", async () => {
  const store = new TapRigStore(":memory:");
  const runs = new RunService(store);
  const run = runs.create("Finish the workflow", "coordinated");
  runs.record(run.id, { type: "run.started", at: "2026-11-01T12:00:00.000Z" });
  runs.saveRecovery(run.id, {
    plan: {
      nodes: [
        { id: "done", task: "Done", dependsOn: [] },
        { id: "finish", task: "Finish", dependsOn: ["done"] },
      ],
    },
    nodes: [
      {
        id: "done",
        status: "completed",
        deviceId: "phone-1",
        evidence: "first result",
        actions: [],
      },
    ],
  });
  let plannerCalls = 0;
  const tasks: string[] = [];
  const worker = new RunWorker({
    runs,
    devices: { list: async () => [readyDevice("phone-1")] },
    adapter: {
      observe: async (deviceId) => ({ ...observation("current"), deviceId }),
      execute: async () => {
        throw new Error("unused");
      },
    },
    planCoordinated: async () => {
      plannerCalls += 1;
      throw new Error("must reuse durable plan");
    },
    decide: (task) => async () => {
      tasks.push(task);
      assert.match(task, /done: first result/);
      return { type: "complete", evidence: "finished" };
    },
  });
  worker.recover(run.id);
  await worker.idle();

  assert.equal(plannerCalls, 0);
  assert.equal(tasks.length, 1);
  assert.equal(runs.get(run.id)?.status, "completed");
  const progress = runs.recovery(run.id)?.evidence as { nodes?: CoordinatedNodeResult[] };
  assert.deepEqual(
    progress.nodes?.map(({ id, status }) => [id, status]),
    [
      ["done", "completed"],
      ["finish", "completed"],
    ],
  );
  store.close();
});

test("a coordinated node leases only a phone with its required capabilities", async () => {
  const store = new TapRigStore(":memory:");
  const runs = new RunService(store);
  const run = runs.create("Capture evidence", "coordinated");
  let assigned = "";
  const worker = new RunWorker({
    runs,
    devices: {
      list: async () => [
        readyDevice("phone-1"),
        {
          ...readyDevice("phone-2"),
          capabilities: ["semantic-observation", "semantic-action", "screenshot"] as const,
        },
      ],
    },
    adapter: {
      observe: async (deviceId) => {
        assigned = deviceId;
        return { ...observation("current"), deviceId };
      },
      execute: async () => {
        throw new Error("unused");
      },
    },
    planCoordinated: async () => ({
      nodes: [
        {
          id: "capture",
          task: "Capture evidence",
          dependsOn: [],
          capabilities: ["semantic-observation", "semantic-action", "screenshot"],
        },
      ],
    }),
    decide: () => async () => ({ type: "complete", evidence: "Captured" }),
  });
  worker.start(run.id);
  await worker.idle();

  assert.equal(runs.get(run.id)?.status, "completed");
  assert.equal(assigned, "phone-2");
  store.close();
});

test("a coordinated node cannot escape its run affinity", async () => {
  const store = new TapRigStore(":memory:");
  const runs = new RunService(store);
  const run = runs.create("Stay in group", "coordinated", undefined, {
    group: "social",
    deviceIds: ["phone-1"],
  });
  let decisions = 0;
  const worker = new RunWorker({
    runs,
    devices: { list: async () => [readyDevice("phone-1"), readyDevice("phone-2")] },
    adapter: {
      observe: async (deviceId) => ({ ...observation("current"), deviceId }),
      execute: async () => {
        throw new Error("unused");
      },
    },
    planCoordinated: async () => ({
      nodes: [{ id: "outside", task: "Outside", dependsOn: [], deviceId: "phone-2" }],
    }),
    decide: () => async () => {
      decisions += 1;
      return { type: "complete", evidence: "unused" };
    },
  });
  worker.start(run.id);
  await worker.idle();

  assert.equal(decisions, 0);
  assert.equal(runs.get(run.id)?.status, "failed");
  assert.match(runs.get(run.id)?.error?.message ?? "", /outside the run affinity/);
  store.close();
});

test("a worker resumes a waiting run on the same phone with the durable answer", async () => {
  const store = new TapRigStore(":memory:");
  const runs = new RunService(store);
  const run = runs.create("Choose an account");
  const tasks: string[] = [];
  const worker = new RunWorker({
    runs,
    devices: { list: async () => [readyDevice("phone-1")] },
    adapter: {
      observe: async (deviceId) => ({ ...observation("current"), deviceId }),
      execute: async () => {
        throw new Error("unused");
      },
    },
    decide: (task) => async () => {
      tasks.push(task);
      return task.includes("The user answered")
        ? { type: "complete", evidence: "Personal account selected" }
        : { type: "ask_user", question: "Which account should I use?" };
    },
  });
  worker.start(run.id);
  await worker.idle();

  const question = runs.questions(run.id)[0];
  assert.equal(runs.get(run.id)?.status, "waiting-for-user");
  assert.equal(question?.deviceId, "phone-1");
  assert.ok(question);
  runs.answer(run.id, question.id, "Personal");
  worker.resume(run.id, {
    prompt: question.prompt,
    value: "Personal",
    sensitive: false,
    ...(question.deviceId ? { deviceId: question.deviceId } : {}),
  });
  await worker.idle();

  assert.equal(runs.get(run.id)?.status, "completed");
  assert.match(tasks[1] ?? "", /Personal/);
  assert.deepEqual(
    runs
      .events(run.id)
      .map(({ event }) => event)
      .filter((event) => event.type !== "run.trace")
      .map(({ type }) => type),
    ["run.created", "run.started", "run.waitingForUser", "run.resumed", "run.completed"],
  );
  store.close();
});

test("a resumed run keeps the model-call budget already spent", async () => {
  const store = new TapRigStore(":memory:");
  const runs = new RunService(store);
  const run = runs.create("Choose an account", "independent", { maxModelCalls: 1 });
  let decisions = 0;
  const worker = new RunWorker({
    runs,
    devices: { list: async () => [readyDevice("phone-1")] },
    adapter: {
      observe: async (deviceId) => ({ ...observation("current"), deviceId }),
      execute: async () => {
        throw new Error("unused");
      },
    },
    decide: (_task, recordUsage) => async () => {
      decisions += 1;
      recordUsage?.({ inputTokens: 2, outputTokens: 1 });
      return { type: "ask_user", question: "Which account?" };
    },
  });
  worker.start(run.id);
  await worker.idle();
  const question = runs.questions(run.id)[0];
  assert.ok(question);
  runs.answer(run.id, question.id, "Personal");
  worker.resume(run.id, {
    prompt: question.prompt,
    value: "Personal",
    sensitive: false,
    ...(question.deviceId ? { deviceId: question.deviceId } : {}),
  });
  await worker.idle();

  assert.equal(decisions, 1);
  assert.equal(runs.get(run.id)?.error?.code, "budget-exhausted");
  assert.equal((runs.telemetry(run.id)?.evidence as RunTelemetry | undefined)?.modelCalls, 1);
  store.close();
});

test("a resumed sensitive answer reaches the phone but is redacted from evidence", async () => {
  const store = new TapRigStore(":memory:");
  const runs = new RunService(store);
  const run = runs.create("Enter the one-time code");
  const typed: string[] = [];
  const worker = new RunWorker({
    runs,
    devices: { list: async () => [readyDevice("phone-1")] },
    adapter: {
      observe: async (deviceId) => ({ ...observation("current"), deviceId }),
      execute: async (batch) => {
        const action = batch.steps[0]?.action;
        if (action?.type === "element.text") typed.push(action.value);
        return {
          requestId: batch.requestId,
          deviceId: batch.deviceId,
          replayed: false,
          steps: [{ stepId: "code", status: "verified", durationMs: 1 }],
        };
      },
    },
    decide:
      (task) =>
      async ({ decisionNumber }) => {
        if (!task.includes("The user answered")) {
          return { type: "ask_user", question: "What is the one-time code?" };
        }
        return decisionNumber === 0
          ? {
              type: "execute",
              requestId: "type-code",
              steps: [
                {
                  id: "code",
                  action: {
                    type: "element.text",
                    target: { resourceId: "code" },
                    value: " 123456 ",
                    clear: true,
                  },
                },
              ],
            }
          : { type: "complete", evidence: "Code 123456 accepted" };
      },
  });
  worker.start(run.id);
  await worker.idle();
  const question = runs.questions(run.id)[0];
  assert.ok(question);
  assert.equal(question.deviceId, "phone-1");
  runs.answer(run.id, question.id, " 123456 ", true);
  worker.resume(run.id, {
    prompt: question.prompt,
    value: " 123456 ",
    sensitive: true,
    deviceId: question.deviceId,
  });
  await worker.idle();

  assert.deepEqual(typed, [" 123456 "]);
  const persisted = JSON.stringify(runs.completion(run.id)?.evidence);
  assert.equal(persisted.includes("123456"), false);
  assert.match(persisted, /REDACTED/);
  assert.equal(JSON.stringify(runs.recovery(run.id)?.evidence).includes("123456"), false);
  assert.equal(JSON.stringify(runs.events(run.id)).includes("123456"), false);
  store.close();
});

test("a coordinated resume keeps completed nodes and continues the waiting branch", async () => {
  const store = new TapRigStore(":memory:");
  const runs = new RunService(store);
  const run = runs.create("Coordinate with one answer", "coordinated");
  const calls = new Map<string, number>();
  const worker = new RunWorker({
    runs,
    devices: {
      list: async () => [readyDevice("phone-1"), readyDevice("phone-2")],
    },
    adapter: {
      observe: async (deviceId) => ({ ...observation("current"), deviceId }),
      execute: async () => {
        throw new Error("unused");
      },
    },
    planCoordinated: async () => ({
      nodes: [
        { id: "done", task: "Done", dependsOn: [] },
        { id: "ask", task: "Ask", dependsOn: [] },
        { id: "after", task: "After", dependsOn: ["done", "ask"] },
      ],
    }),
    decide: (task) => async () => {
      const name = task.split("\n", 1)[0] as string;
      calls.set(name, (calls.get(name) ?? 0) + 1);
      if (name === "Ask" && !task.includes("The user answered")) {
        return { type: "ask_user", question: "Which account?" };
      }
      return { type: "complete", evidence: `${name} complete` };
    },
  });
  worker.start(run.id);
  await worker.idle();
  const question = runs.questions(run.id)[0];
  assert.ok(question);
  runs.answer(run.id, question.id, "Personal");
  worker.resume(run.id, {
    prompt: question.prompt,
    value: "Personal",
    sensitive: false,
    ...(question.deviceId ? { deviceId: question.deviceId } : {}),
  });
  await worker.idle();

  assert.equal(runs.get(run.id)?.status, "completed");
  assert.equal(calls.get("Done"), 1);
  assert.equal(calls.get("Ask"), 2);
  assert.equal(calls.get("After"), 1);
  store.close();
});

test("a broadcast resume keeps its original phone cohort", async () => {
  const store = new TapRigStore(":memory:");
  const runs = new RunService(store);
  const run = runs.create("Broadcast after one answer", "broadcast");
  let includeThird = false;
  const observed = new Set<string>();
  const worker = new RunWorker({
    runs,
    devices: {
      list: async () => [
        readyDevice("phone-1"),
        readyDevice("phone-2"),
        ...(includeThird ? [readyDevice("phone-3")] : []),
      ],
    },
    adapter: {
      observe: async (deviceId) => {
        observed.add(deviceId);
        return { ...observation("current"), deviceId };
      },
      execute: async () => {
        throw new Error("unused");
      },
    },
    decide: (task) => async () =>
      task.includes("The user answered")
        ? { type: "complete", evidence: "Broadcast complete" }
        : { type: "ask_user", question: "Continue?" },
  });
  worker.start(run.id);
  await worker.idle();
  const question = runs.questions(run.id)[0];
  assert.ok(question);
  assert.deepEqual(question.deviceIds, ["phone-1", "phone-2"]);
  runs.answer(run.id, question.id, "Yes");
  includeThird = true;
  observed.clear();
  worker.resume(run.id, {
    prompt: question.prompt,
    value: "Yes",
    sensitive: false,
    ...(question.deviceId ? { deviceId: question.deviceId } : {}),
    ...(question.deviceIds ? { deviceIds: question.deviceIds } : {}),
  });
  await worker.idle();

  assert.equal(runs.get(run.id)?.status, "completed");
  assert.deepEqual([...observed].sort(), ["phone-1", "phone-2"]);
  store.close();
});

test("an approved action resumes on the same phone without executing before approval", async () => {
  const store = new TapRigStore(":memory:");
  const runs = new RunService(store);
  const run = runs.create("Ask before sending the message");
  const tasks: string[] = [];
  const worker = new RunWorker({
    runs,
    devices: { list: async () => [readyDevice("phone-1")] },
    adapter: {
      observe: async (deviceId) => ({ ...observation("current"), deviceId }),
      execute: async () => {
        throw new Error("unused");
      },
    },
    decide: (task) => async () => {
      tasks.push(task);
      return task.includes("resolved the approval")
        ? { type: "complete", evidence: "Message sent" }
        : { type: "request_approval", prompt: "Send the drafted message?" };
    },
  });
  worker.start(run.id);
  await worker.idle();
  const approval = runs.approvals(run.id)[0];
  assert.ok(approval);
  assert.equal(runs.questions(run.id).length, 0);
  runs.resolveApproval(run.id, approval.id, "approved");
  worker.resume(run.id, {
    prompt: approval.prompt,
    value: "Approved",
    sensitive: false,
    kind: "approval",
    ...(approval.deviceId ? { deviceId: approval.deviceId } : {}),
  });
  await worker.idle();
  assert.equal(runs.get(run.id)?.status, "completed");
  assert.match(tasks[1] ?? "", /resolved the approval/);
  store.close();
});
