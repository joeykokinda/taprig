import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { DeviceActorState } from "../src/android/device-actor.ts";
import type { RunState } from "../src/core/contracts.ts";
import { TapRigStore } from "../src/persistence/store.ts";

const created: RunState = {
  id: "run-1",
  mode: "independent",
  task: "Open System settings",
  status: "created",
  createdAt: "2026-10-29T12:00:00.000Z",
  updatedAt: "2026-10-29T12:00:00.000Z",
};

test("persists private devices, run events, questions, and checkpoints", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "taprig-store-"));
  const path = join(directory, "taprig.db");
  context.after(async () => {
    await rm(directory, { recursive: true });
  });
  const device: DeviceActorState = {
    id: "phone-1",
    serial: "phone-1",
    state: "ready",
    capabilities: ["semantic-observation", "semantic-action", "raw-input", "screenshot", "shell"],
    transportState: "device",
    identity: { model: "Test phone" },
    observedAt: "2026-10-29T12:00:00.000Z",
  };

  let store = new TapRigStore(path);
  store.saveDevice(device);
  let run = store.recordRunEvent(undefined, { type: "run.created", run: created });
  run = store.recordRunEvent(run, { type: "run.started", at: "2026-10-29T12:00:01.000Z" });
  store.saveQuestion({
    id: "question-1",
    runId: run.id,
    prompt: "Which account?",
    status: "open",
    createdAt: "2026-10-29T12:00:02.000Z",
  });
  assert.equal(store.listQuestions(run.id)[0]?.prompt, "Which account?");
  store.answerQuestion(run.id, "question-1", "Personal", false, "2026-10-29T12:00:02.500Z");
  assert.equal(store.listQuestions(run.id)[0]?.answer, "Personal");
  store.saveCheckpoint({
    id: "checkpoint-1",
    runId: run.id,
    deviceId: device.id,
    name: "settings-open",
    evidence: { packageName: "com.android.settings" },
    createdAt: "2026-10-29T12:00:03.000Z",
  });
  assert.equal(store.getCheckpoint("run-1", "settings-open")?.deviceId, "phone-1");
  store.close();

  assert.equal((await stat(path)).mode & 0o777, 0o600);
  store = new TapRigStore(path);
  assert.deepEqual(store.getDevice(device.id), device);
  assert.equal(store.getRun(run.id)?.status, "running");
  assert.equal(store.eventCount(run.id), 2);
  store.close();
});

test("active-run recovery is not limited to the recent dashboard window", () => {
  const store = new TapRigStore(":memory:");
  store.recordRunEvent(undefined, { type: "run.created", run: created });
  for (let index = 0; index < 105; index += 1) {
    const at = `2026-10-30T12:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`;
    const terminal = store.recordRunEvent(undefined, {
      type: "run.created",
      run: { ...created, id: `terminal-${index}`, createdAt: at, updatedAt: at },
    });
    const running = store.recordRunEvent(terminal, { type: "run.started", at });
    store.recordRunEvent(running, { type: "run.completed", at });
  }

  assert.equal(
    store.listRuns().some((run) => run.id === created.id),
    false,
  );
  assert.deepEqual(
    store.listActiveRuns().map(({ id }) => id),
    [created.id],
  );
  store.close();
});
