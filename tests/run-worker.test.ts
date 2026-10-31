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

test("a broadcast run shares actions across leased phones and persists aggregate completion", async () => {
  const store = new TapRigStore(":memory:");
  const runs = new RunService(store);
  const run = runs.create("Open Settings everywhere", "broadcast");
  const executions: string[] = [];
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

test("a worker resumes a waiting run on the same phone with the durable answer", async () => {
  const store = new TapRigStore(":memory:");
  const runs = new RunService(store);
  const run = runs.create("Choose an account");
  const tasks: string[] = [];
  const worker = new RunWorker({
    runs,
    devices: { list: async () => [{ id: "phone-1", serial: "phone-1", state: "ready" }] },
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
    deviceId: question.deviceId,
  });
  await worker.idle();

  assert.equal(runs.get(run.id)?.status, "completed");
  assert.match(tasks[1] ?? "", /Personal/);
  assert.deepEqual(
    runs.events(run.id).map(({ event }) => event.type),
    ["run.created", "run.started", "run.waitingForUser", "run.resumed", "run.completed"],
  );
  store.close();
});

test("a resumed sensitive answer reaches the phone but is redacted from evidence", async () => {
  const store = new TapRigStore(":memory:");
  const runs = new RunService(store);
  const run = runs.create("Enter the one-time code");
  const typed: string[] = [];
  const worker = new RunWorker({
    runs,
    devices: { list: async () => [{ id: "phone-1", serial: "phone-1", state: "ready" }] },
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
        { id: "phone-1", serial: "phone-1", state: "ready" },
        { id: "phone-2", serial: "phone-2", state: "ready" },
        ...(includeThird ? [{ id: "phone-3", serial: "phone-3", state: "ready" }] : []),
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
