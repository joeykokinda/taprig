import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  ActionBatch,
  BatchResult,
  DeviceAdapter,
  Observation,
} from "../src/core/contracts.ts";
import type { TapRigScript } from "../src/scripts/contracts.ts";
import { runScript } from "../src/scripts/engine.ts";
import { ScriptStore } from "../src/scripts/store.ts";

const script: TapRigScript = {
  schemaVersion: 1,
  id: "open-section",
  name: "Open a Settings section",
  version: 1,
  origin: "user",
  parameters: [{ name: "section", required: true }],
  steps: [
    {
      id: "tap-section",
      action: { type: "element.tap", target: { text: "{{section}}" } },
      checkpoint: { selector: { text: "Languages" } },
    },
  ],
};

test("stores private versioned scripts and validates loaded actions", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "taprig-scripts-"));
  context.after(() => rm(directory, { recursive: true }));
  const store = new ScriptStore(directory);

  store.save(script);
  store.save({ ...script, version: 2, name: "Open a Settings section (updated)" });

  assert.equal(store.get(script.id)?.version, 2);
  assert.equal(store.list()[0]?.id, script.id);
  assert.equal((await stat(join(directory, `${script.id}.v1.json`))).mode & 0o777, 0o600);
  assert.equal((await stat(join(directory, `${script.id}.v2.json`))).mode & 0o777, 0o600);
  assert.throws(() => store.save(script), /already exists/);
});

test("runs parameterized actions and requires a fresh checkpoint", async () => {
  let current: Observation = {
    deviceId: "phone-1",
    generation: "before",
    elements: [],
    capturedAt: "2026-10-30T12:00:00.000Z",
  };
  let executed: ActionBatch | undefined;
  const device: DeviceAdapter = {
    observe: async () => current,
    execute: async (batch): Promise<BatchResult> => {
      executed = batch;
      current = {
        ...current,
        generation: "after",
        elements: [{ id: "node-1", role: "TextView", text: "Languages", actionable: false }],
      };
      return {
        requestId: batch.requestId,
        deviceId: batch.deviceId,
        steps: [{ stepId: "tap-section", status: "verified", durationMs: 1 }],
        replayed: false,
      };
    },
  };

  const result = await runScript(script, { section: "System" }, device, "phone-1", "run-1");

  assert.deepEqual(executed?.steps[0]?.action, {
    type: "element.tap",
    target: { text: "System" },
  });
  assert.deepEqual(result, { status: "completed", completedSteps: 1 });
});

test("hands a checkpoint mismatch back to recovery", async () => {
  const observation: Observation = {
    deviceId: "phone-1",
    generation: "same",
    elements: [],
    capturedAt: "2026-10-30T12:00:00.000Z",
  };
  const device: DeviceAdapter = {
    observe: async () => observation,
    execute: async (batch) => ({
      requestId: batch.requestId,
      deviceId: batch.deviceId,
      steps: [{ stepId: "tap-section", status: "verified", durationMs: 1 }],
      replayed: false,
    }),
  };

  const result = await runScript(script, { section: "System" }, device, "phone-1", "run-2");
  assert.equal(result.status, "recovery-needed");
  assert.match(result.status === "recovery-needed" ? result.reason : "", /checkpoint/);
});
