import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AdbDevice } from "../src/android/adb-discovery.ts";
import { DeviceRegistry } from "../src/android/device-actor.ts";
import { scheduleDurableRuns, startRuntime } from "../src/daemon/runtime.ts";
import { TapRigStore } from "../src/persistence/store.ts";
import { RunService } from "../src/runs/service.ts";

const token = "runtime-test-token";
const headers = { authorization: `Bearer ${token}` };
const device: AdbDevice = { serial: "phone-1", transportState: "device" };
const properties = `[ro.product.model]: [Test Phone]
[sys.boot_completed]: [1]
`;

test("runtime composes discovery, device actors, and authenticated inventory", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "taprig-runtime-"));
  const databasePath = join(directory, "taprig.db");
  let discovered: readonly AdbDevice[] = [device];
  const registry = new DeviceRegistry(async (_serial, command) =>
    command === "getprop" ? properties : "keyguardShowing=false",
  );
  const runtime = await startRuntime({
    token,
    registry,
    discover: async () => discovered,
    pollIntervalMs: 60_000,
    databasePath,
  });
  context.after(async () => {
    await runtime.stop();
    const store = new TapRigStore(databasePath);
    assert.equal(store.getDevice(device.serial)?.state, "offline");
    store.close();
    await rm(directory, { recursive: true });
  });

  const readyResponse = await fetch(`${runtime.url}/devices`, { headers });
  const ready = (await readyResponse.json()) as { devices: Array<{ state: string }> };
  assert.equal(ready.devices[0]?.state, "ready");

  discovered = [];
  await runtime.refresh();
  const offlineResponse = await fetch(`${runtime.url}/devices`, { headers });
  const offline = (await offlineResponse.json()) as { devices: Array<{ state: string }> };
  assert.equal(offline.devices[0]?.state, "offline");
});

test("a discovery failure fails closed to offline", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "taprig-runtime-"));
  let fail = false;
  const registry = new DeviceRegistry(async (_serial, command) =>
    command === "getprop" ? properties : "keyguardShowing=false",
  );
  const runtime = await startRuntime({
    token,
    registry,
    discover: async () => {
      if (fail) throw new Error("ADB unavailable");
      return [device];
    },
    pollIntervalMs: 60_000,
    databasePath: join(directory, "taprig.db"),
  });
  context.after(async () => {
    await runtime.stop();
    await rm(directory, { recursive: true });
  });

  fail = true;
  await assert.rejects(runtime.refresh(), /ADB unavailable/);
  const response = await fetch(`${runtime.url}/devices`, { headers });
  const body = (await response.json()) as { devices: Array<{ state: string }> };
  assert.equal(body.devices[0]?.state, "offline");

  fail = false;
  await runtime.refresh();
  const recoveredResponse = await fetch(`${runtime.url}/devices`, { headers });
  const recovered = (await recoveredResponse.json()) as { devices: Array<{ state: string }> };
  assert.equal(recovered.devices[0]?.state, "ready");
});

test("durable run scheduling starts new work and recovers only when its phones are ready", () => {
  const store = new TapRigStore(":memory:");
  const runs = new RunService(store);
  const created = runs.create("New work");
  const running = runs.create("Interrupted work");
  runs.record(running.id, { type: "run.started", at: "2026-11-01T12:00:00.000Z" });
  runs.saveRecovery(running.id, { deviceIds: ["phone-2"] });
  const coordinated = runs.create("Pinned work", "coordinated");
  runs.record(coordinated.id, { type: "run.started", at: "2026-11-01T12:00:00.000Z" });
  runs.saveRecovery(coordinated.id, {
    plan: { nodes: [{ id: "pending", task: "Pending", dependsOn: [], deviceId: "phone-3" }] },
    nodes: [],
  });
  const started: string[] = [];
  const recovered: string[] = [];
  const worker = {
    start: (runId: string) => {
      if (!started.includes(runId)) started.push(runId);
    },
    recover: (runId: string) => {
      if (!recovered.includes(runId)) recovered.push(runId);
    },
  };

  scheduleDurableRuns(runs, worker, [{ id: "phone-1", state: "ready" }]);
  assert.deepEqual(started, [created.id]);
  assert.deepEqual(recovered, []);
  scheduleDurableRuns(runs, worker, [
    { id: "phone-1", state: "ready" },
    { id: "phone-2", state: "ready" },
  ]);
  assert.deepEqual(recovered, [running.id]);
  scheduleDurableRuns(runs, worker, [
    { id: "phone-1", state: "ready" },
    { id: "phone-2", state: "ready" },
    { id: "phone-3", state: "ready" },
  ]);
  assert.deepEqual(recovered, [running.id, coordinated.id]);
  store.close();
});
